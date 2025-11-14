/**
 * ai-auto-trading - AI 加密货币自动交易系统
 * Copyright (C) 2025 losesky
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 平仓并重置数据库脚本
 * 用于在运行时快速重置系统状态
 */
import { createClient } from "@libsql/client";
import { parsePositionSize } from "../utils";
import { createLogger } from "../utils/logger";
import { getExchangeClient } from "../exchanges";
import { CREATE_TABLES_SQL } from "./schema";
import "dotenv/config";

const logger = createLogger({
  name: "close-and-reset",
  level: "info",
});

/**
 * 取消所有条件单（止损止盈订单）
 */
async function cancelAllConditionalOrders(): Promise<void> {
  const exchangeClient = getExchangeClient();
  
  try {
    logger.info("📊 取消所有条件单（止损止盈订单）...");
    
    const exchangeName = exchangeClient.getExchangeName();
    
    if (exchangeName === 'gate') {
      // Gate.io: 取消所有合约的条件单
      try {
        await exchangeClient.cancelAllOrders(); // 不传contract参数，取消所有
        logger.info("✅ Gate.io 所有条件单已取消");
      } catch (error: any) {
        // 如果没有条件单，API可能返回错误，这是正常的
        if (error.message?.includes('ORDER_NOT_FOUND') || error.response?.status === 404) {
          logger.info("✅ 当前无条件单需要取消");
        } else {
          logger.warn(`⚠️  取消条件单时出现警告: ${error.message}`);
        }
      }
    } else if (exchangeName === 'binance') {
      // Binance: 需要先获取所有未成交订单，然后逐个合约取消
      // 🔥 关键修复：不依赖持仓信息，而是直接获取所有未成交订单
      try {
        // 获取所有未成交订单（不传contract参数会获取所有）
        const openOrders = await exchangeClient.getOpenOrders();
        
        if (openOrders.length === 0) {
          logger.info("✅ 当前无未成交订单");
          return;
        }
        
        // 按合约分组
        const contractOrders = new Map<string, any[]>();
        for (const order of openOrders) {
          const contract = order.contract;
          if (!contractOrders.has(contract)) {
            contractOrders.set(contract, []);
          }
          contractOrders.get(contract)!.push(order);
        }
        
        logger.info(`🔄 发现 ${contractOrders.size} 个合约有未成交订单，共 ${openOrders.length} 个订单`);
        
        // 逐个合约取消所有订单
        for (const [contract, orders] of contractOrders) {
          try {
            logger.info(`   取消 ${contract} 的 ${orders.length} 个订单...`);
            await exchangeClient.cancelAllOrders(contract);
            logger.info(`   ✅ ${contract} 订单已取消`);
          } catch (error: any) {
            // 如果订单已经不存在，这是正常的
            if (error.code === -2011 || error.message?.includes('Unknown order')) {
              logger.debug(`   ${contract} 订单已不存在`);
            } else {
              logger.warn(`   ⚠️  取消 ${contract} 订单时出现警告: ${error.message}`);
            }
          }
        }
        
        logger.info("✅ Binance 所有未成交订单已取消");
      } catch (error: any) {
        logger.warn(`⚠️  获取未成交订单失败: ${error.message}，尝试备用方案...`);
        
        // 备用方案：从持仓信息获取合约列表
        const positions = await exchangeClient.getPositions();
        const activeContracts = new Set(positions.map((p: any) => p.contract));
        
        if (activeContracts.size === 0) {
          logger.info("✅ 无持仓也无法获取订单，假设无订单需要取消");
          return;
        }
        
        logger.info(`🔄 使用备用方案：从 ${activeContracts.size} 个持仓合约取消订单...`);
        
        for (const contract of activeContracts) {
          try {
            await exchangeClient.cancelAllOrders(contract);
            logger.info(`✅ 已取消 ${contract} 的订单`);
          } catch (error: any) {
            if (error.code === -2011 || error.message?.includes('Unknown order')) {
              logger.debug(`   ${contract} 无订单`);
            } else {
              logger.warn(`⚠️  取消 ${contract} 订单时出现警告: ${error.message}`);
            }
          }
        }
      }
    } else {
      logger.warn(`⚠️  未知交易所: ${exchangeName}，跳过取消条件单`);
    }
    
  } catch (error: any) {
    logger.error(`❌ 取消条件单过程出错: ${error.message}`);
    // 不抛出错误，允许继续执行平仓流程
  }
}

/**
 * 平仓所有持仓
 */
async function closeAllPositions(): Promise<void> {
  const exchangeClient = getExchangeClient();
  
  try {
    logger.info("📊 获取当前持仓...");
    
    const positions = await exchangeClient.getPositions();
    
    // 使用 parseFloat 而不是 parseInt，并检查原始数据
    logger.info(`原始持仓数据: ${JSON.stringify(positions.map(p => ({
      contract: p.contract,
      size: p.size,
      entryPrice: p.entryPrice
    })))}`);
    
    const activePositions = positions.filter((p: any) => {
      const size = parseFloat(p.size || "0");
      return size !== 0 && !isNaN(size);
    });
    
    if (activePositions.length === 0) {
      logger.info("✅ 当前无持仓，跳过平仓");
      return;
    }
    
    logger.warn(`⚠️  发现 ${activePositions.length} 个持仓，开始平仓...`);
    
    for (const pos of activePositions) {
      const sizeStr = pos.size || "0";
      const size = parseFloat(sizeStr);
      const contract = pos.contract;
      const symbol = exchangeClient.extractSymbol(contract);
      
      // 判断方向：size 为正=多头，为负=空头
      const side = size > 0 ? "多头" : "空头";
      const absSize = Math.abs(size);
      
      // 获取合约类型以显示正确的单位
      const contractType = exchangeClient.getContractType();
      const unit = contractType === 'inverse' ? '张' : symbol; // Binance 显示币种
      
      try {
        logger.info(`🔄 平仓中: ${symbol} ${side} ${absSize} ${unit}, 合约: ${contract}`);
        
        // 对于 Binance，平仓需要反向下单
        // 通过 reduceOnly 参数确保只平仓不开新仓
        await exchangeClient.placeOrder({
          contract,
          size: -size, // 反向平仓：多头用负数，空头用正数
          reduceOnly: true, // 仅减仓
        });
        
        logger.info(`✅ 已平仓: ${symbol} ${side} ${absSize} ${unit}`);
        
        // 等待一下确保订单执行
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error: any) {
        logger.error(`❌ 平仓失败: ${symbol} - ${error.message}`);
        logger.error(`错误详情: ${JSON.stringify(error)}`);
        
        // 即使失败也继续尝试平其他仓位
        continue;
      }
    }
    
    logger.info("✅ 所有持仓平仓完成");
  } catch (error: any) {
    logger.error(`❌ 平仓过程出错: ${error.message}`);
    throw error;
  }
}

/**
 * 重置数据库
 */
async function resetDatabase(): Promise<void> {
  try {
    const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
    const initialBalance = Number.parseFloat(process.env.INITIAL_BALANCE || "1000");

    logger.info("🗄️  开始重置数据库...");
    logger.info(`数据库路径: ${dbUrl}`);
    logger.info(`初始资金: ${initialBalance} USDT`);

    const client = createClient({
      url: dbUrl,
    });

    // 删除所有表
    logger.info("🗑️  删除现有表...");
    await client.execute("DROP TABLE IF EXISTS trades");
    await client.execute("DROP TABLE IF EXISTS agent_decisions");
    await client.execute("DROP TABLE IF EXISTS trading_signals");
    await client.execute("DROP TABLE IF EXISTS positions");
    await client.execute("DROP TABLE IF EXISTS account_history");
    await client.execute("DROP TABLE IF EXISTS price_orders");
    await client.execute("DROP TABLE IF EXISTS position_close_events");
    await client.execute("DROP TABLE IF EXISTS partial_take_profit_history");
    await client.execute("DROP TABLE IF EXISTS system_config");
    await client.execute("DROP TABLE IF EXISTS inconsistent_states");
    logger.info("✅ 现有表已删除");

    // 重新创建表
    logger.info("📦 创建新表...");
    await client.executeMultiple(CREATE_TABLES_SQL);
    logger.info("✅ 表创建完成");

    // 插入初始资金记录
    logger.info(`💰 插入初始资金记录: ${initialBalance} USDT`);
    await client.execute({
      sql: `INSERT INTO account_history 
            (timestamp, total_value, available_cash, unrealized_pnl, realized_pnl, return_percent) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        new Date().toISOString(),
        initialBalance,
        initialBalance,
        0,
        0,
        0,
      ],
    });

    // 验证初始化结果
    const latestAccount = await client.execute(
      "SELECT * FROM account_history ORDER BY timestamp DESC LIMIT 1"
    );

    if (latestAccount.rows.length > 0) {
      const account = latestAccount.rows[0] as any;
      logger.info("\n" + "=".repeat(60));
      logger.info("✅ 数据库重置成功！");
      logger.info("=".repeat(60));
      logger.info("\n📊 初始账户状态:");
      logger.info(`  总资产: ${account.total_value} USDT`);
      logger.info(`  可用资金: ${account.available_cash} USDT`);
      logger.info(`  未实现盈亏: ${account.unrealized_pnl} USDT`);
      logger.info(`  已实现盈亏: ${account.realized_pnl} USDT`);
      logger.info(`  总收益率: ${account.return_percent}%`);
      logger.info("\n当前无持仓");
      logger.info("\n" + "=".repeat(60));
    }

    client.close();
    
  } catch (error) {
    logger.error("❌ 数据库重置失败:", error as any);
    throw error;
  }
}

/**
 * 同步持仓数据
 */
async function syncPositions(): Promise<void> {
  const exchangeClient = getExchangeClient();
  const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
  
  try {
    const exchangeName = exchangeClient.getExchangeName();
    logger.info(`🔄 从 ${exchangeName} 同步持仓...`);
    
    const client = createClient({
      url: dbUrl,
    });
    
    // 从交易所获取持仓（兼容 Gate.io 和 Binance）
    const positions = await exchangeClient.getPositions();
    const activePositions = positions.filter((p: any) => parsePositionSize(p.size) !== 0);
    
    logger.info(`📊 ${exchangeName} 当前持仓数: ${activePositions.length}`);
    
    // 清空本地持仓表
    await client.execute("DELETE FROM positions");
    logger.info("✅ 已清空本地持仓表");
    
    // 获取合约类型以显示正确的单位
    const contractType = exchangeClient.getContractType();
    const unit = contractType === 'inverse' ? ' 张' : ''; // Gate.io 显示"张"，Binance 不显示
    
    // 同步持仓到数据库
    if (activePositions.length > 0) {
      logger.info(`🔄 同步 ${activePositions.length} 个持仓到数据库...`);
      
      for (const pos of activePositions) {
        const size = parsePositionSize(pos.size);
        if (size === 0) continue;
        
        const symbol = exchangeClient.extractSymbol(pos.contract);
        const entryPrice = Number.parseFloat(pos.entryPrice || "0");
        const currentPrice = Number.parseFloat(pos.markPrice || "0");
        const leverage = Number.parseInt(pos.leverage || "1");
        const side = size > 0 ? "long" : "short";
        const quantity = Math.abs(size);
        const pnl = Number.parseFloat(pos.unrealisedPnl || "0");
        const liqPrice = Number.parseFloat(pos.liqPrice || "0");
        
        await client.execute({
          sql: `INSERT INTO positions 
                (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
                 leverage, side, entry_order_id, opened_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            symbol,
            quantity,
            entryPrice,
            currentPrice,
            liqPrice,
            pnl,
            leverage,
            side,
            "synced",
            new Date().toISOString(),
          ],
        });
        
        logger.info(`   ✅ ${symbol}: ${quantity}${unit} (${side}) @ ${entryPrice} | 盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
      }
    } else {
      logger.info("✅ 当前无持仓");
    }
    
    client.close();
    logger.info("✅ 持仓同步完成");
    
  } catch (error: any) {
    logger.error(`❌ 持仓同步失败: ${error.message}`);
    throw error;
  }
}

/**
 * 主执行函数
 */
async function closeAndReset() {
  logger.info("=".repeat(80));
  logger.info("🔄 开始执行平仓并重置数据库");
  logger.info("=".repeat(80));
  logger.info("");
  
  try {
    // 步骤1：取消所有条件单
    logger.info("【步骤 1/4】取消所有条件单（止损止盈订单）");
    logger.info("-".repeat(80));
    await cancelAllConditionalOrders();
    logger.info("");
    
    // 等待1秒确保条件单取消完成
    logger.info("⏱️  等待1秒确保条件单取消完成...");
    await new Promise(resolve => setTimeout(resolve, 1000));
    logger.info("");
    
    // 步骤2：平仓所有持仓
    logger.info("【步骤 2/4】平仓所有持仓");
    logger.info("-".repeat(80));
    await closeAllPositions();
    logger.info("");
    
    // 等待2秒确保平仓完成
    logger.info("⏱️  等待2秒确保平仓完成...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    logger.info("");
    
    // 步骤3：重置数据库
    logger.info("【步骤 3/4】重置数据库");
    logger.info("-".repeat(80));
    await resetDatabase();
    logger.info("");
    
    // 步骤4：同步持仓数据
    const exchangeClient = getExchangeClient();
    const exchangeName = exchangeClient.getExchangeName();
    logger.info(`【步骤 4/4】从 ${exchangeName} 同步持仓数据`);
    logger.info("-".repeat(80));
    await syncPositions();
    logger.info("");
    
    logger.info("=".repeat(80));
    logger.info("🎉 平仓并重置完成！系统已恢复到初始状态");
    logger.info("=".repeat(80));
    logger.info("");
    logger.info("💡 提示：可以重新启动交易系统开始新的交易");
    
  } catch (error) {
    logger.error("=".repeat(80));
    logger.error("❌ 执行失败:", error as any);
    logger.error("=".repeat(80));
    process.exit(1);
  }
}

// 执行主函数
closeAndReset();


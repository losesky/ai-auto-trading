/**
 * ai-auto-trading - AI 加密货币自动交易系统
 * Copyright (C) 2025 losesky
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Found      const checkContract = this.exchangeClient.normalizeContract(order.symbol);
      const positions = await this.exchangeClient.getPositions();
      const positionExists = positions.some(p => 
        p.contract === checkContract && Math.abs(parseFloat(p.size || '0')) > 0
      );, either version 3 of the License, or
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
 * 条件单监控服务
 * 定期检测条件单触发情况，更新数据库状态，记录平仓交易
 */
import { createLogger } from "../utils/logger";
import { getChinaTimeISO } from "../utils/timeUtils";
import { getQuantoMultiplier } from "../utils/contractUtils";
import type { Client } from "@libsql/client";
import type { IExchangeClient } from "../exchanges/IExchangeClient";

/**
 * 统一格式化成交数据，兼容币安和Gate.io
 */
function formatTradeRecord(trade: any): {
  id: string;
  price: string;
  size: string;
  fee: string;
  timestamp: number;
} {
  return {
    id: trade.id?.toString() || trade.orderId?.toString() || trade.tradeId?.toString() || '',
    price: trade.price?.toString() || trade.avgPrice?.toString() || trade.deal_price?.toString() || '0',
    size: trade.size?.toString() || trade.qty?.toString() || trade.amount?.toString() || '0',
    fee: trade.fee?.toString() || trade.commission?.toString() || trade.fee_amount?.toString() || '0',
    timestamp: Number(trade.timestamp || trade.time || trade.create_time || Date.now()),
  };
}

const logger = createLogger({
  name: "price-order-monitor",
  level: "info",
});

interface DBPriceOrder {
  id: number;
  order_id: string;
  symbol: string;
  side: 'long' | 'short';
  type: 'stop_loss' | 'take_profit';
  trigger_price: string;
  quantity: string;
  created_at: string;
}

export class PriceOrderMonitor {
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  
  constructor(
    private dbClient: Client,
    private exchangeClient: IExchangeClient
  ) {}

  /**
   * 启动监控服务
   */
  async start() {
    if (this.checkInterval) {
      logger.warn('条件单监控服务已在运行');
      return;
    }

    const intervalSeconds = parseInt(process.env.PRICE_ORDER_CHECK_INTERVAL || '30');
    logger.info(`启动条件单监控服务，检测间隔: ${intervalSeconds}秒`);

    // 立即执行第一次检测，捕获系统离线期间触发的条件单
    logger.info('立即执行首次检测，捕获系统离线期间的平仓事件...');
    await this.checkTriggeredOrders();

    // 定期执行
    this.checkInterval = setInterval(async () => {
      await this.checkTriggeredOrders();
    }, intervalSeconds * 1000);
  }

  /**
   * 停止监控服务
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('条件单监控服务已停止');
    }
  }

  /**
   * 检测已触发的条件单
   */
  private async checkTriggeredOrders() {
    if (this.isRunning) {
      logger.debug('上一次检测尚未完成，跳过本次检测');
      return;
    }

    this.isRunning = true;
    try {
      // 1. 获取数据库中active的条件单
      const activeOrders = await this.getActiveOrdersFromDB();
      if (activeOrders.length === 0) {
        logger.debug('没有活跃的条件单需要检测');
        return;
      }

      logger.debug(`检测本地端 ${activeOrders.length} 个活跃条件单`);

      // 2. 获取交易所的条件单
      let exchangeOrders: any[] = [];
      try {
        exchangeOrders = await this.exchangeClient.getPriceOrders();
      } catch (error: any) {
        logger.warn('⚠️ 无法从交易所获取条件单列表，跳过本次检测（可能是API错误）:', error.message);
        return;
      }
      
      // 构建交易所订单映射表，统一使用 id 字段作为 key
      // Gate.io API返回的对象格式: { id: number, ... }
      // Binance API返回的对象格式可能不同，需要兼容
      const exchangeOrderMap = new Map<string, any>(
        exchangeOrders
          .map(o => {
            const orderId = (o.id || o.orderId || o.order_id)?.toString();
            return [orderId, o] as [string, any];
          })
          .filter(([id]) => id) // 过滤掉没有ID的订单
      );

      // 3. 同时获取交易所实际持仓状态（关键补充）
      let exchangePositions: any[] = [];
      try {
        exchangePositions = await this.exchangeClient.getPositions();
      } catch (error: any) {
        logger.warn('⚠️ 无法获取交易所持仓信息:', error.message);
      }
      
      // 建立持仓映射：contract -> position
      const exchangePositionMap = new Map(
        exchangePositions
          .filter(p => Math.abs(parseFloat(p.size || '0')) > 0)
          .map(p => [p.contract, p])
      );

      // 4. 识别已触发的条件单
      for (const dbOrder of activeOrders) {
        try {
          const contract = this.exchangeClient.normalizeContract(dbOrder.symbol);
          let orderInExchange = exchangeOrderMap.has(dbOrder.order_id);
          const positionInExchange = exchangePositionMap.has(contract);
          
          // 🔧 智能修复：如果数据库中的条件单ID在交易所不存在，
          // 但交易所有该合约的条件单，尝试同步更新数据库ID
          if (!orderInExchange && positionInExchange) {
            // 查找交易所中该合约的条件单
            const exchangeContractOrders = exchangeOrders.filter((o: any) => {
              const oContract = this.exchangeClient.normalizeContract(o.contract || o.symbol || '');
              return oContract === contract;
            });
            
            // 尝试根据类型匹配（stop_loss 或 take_profit）
            const matchingOrder = exchangeContractOrders.find((o: any) => {
              // Gate.io: rule=1表示>=触发(多单止盈/空单止损), rule=2表示<=触发(多单止损/空单止盈)
              // 从trigger规则推断订单类型
              if (o.trigger && o.trigger.rule !== undefined) {
                const isSellOrder = o.initial && parseFloat(o.initial.size || '0') < 0;
                const isLongPosition = dbOrder.side === 'long';
                
                if (dbOrder.type === 'stop_loss') {
                  // 止损: 多单用rule=2(<=), 空单用rule=1(>=)
                  return isLongPosition ? o.trigger.rule === 2 : o.trigger.rule === 1;
                } else if (dbOrder.type === 'take_profit') {
                  // 止盈: 多单用rule=1(>=), 空单用rule=2(<=)
                  return isLongPosition ? o.trigger.rule === 1 : o.trigger.rule === 2;
                }
              }
              return false;
            });
            
            if (matchingOrder) {
              const newOrderId = (matchingOrder.id || matchingOrder.orderId || matchingOrder.order_id)?.toString();
              if (newOrderId && newOrderId !== dbOrder.order_id) {
                logger.info(`🔄 检测到条件单ID不匹配，自动同步: ${dbOrder.order_id} → ${newOrderId}`);
                
                // 更新数据库中的条件单ID
                try {
                  await this.dbClient.execute({
                    sql: 'UPDATE price_orders SET order_id = ?, updated_at = ? WHERE order_id = ?',
                    args: [newOrderId, new Date().toISOString(), dbOrder.order_id]
                  });
                  
                  // 更新本地对象
                  dbOrder.order_id = newOrderId;
                  orderInExchange = true; // 现在在交易所中了
                  
                  logger.info(`✅ 条件单ID已同步更新到数据库`);
                } catch (updateError: any) {
                  logger.error(`❌ 更新条件单ID失败: ${updateError.message}`);
                }
              }
            }
          }
          
          // 判断条件单是否触发的逻辑：
          // 1. 订单不在交易所 + 持仓不存在 = 确定触发
          // 2. 订单不在交易所 + 持仓存在 = 可能触发（需要查成交记录）
          
          if (!orderInExchange) {
            if (!positionInExchange) {
              // 情况1：订单没了，持仓也没了 - 确定触发
              logger.info(`🔍 ${dbOrder.symbol} 条件单和持仓均不存在，确认触发: ${dbOrder.order_id}`);
              await this.handleTriggeredOrder(dbOrder);
            } else {
              // 情况2：订单没了，但持仓还在 - 可能是订单被取消或其他原因
              // 检查成交记录确认
              logger.debug(`🔍 ${dbOrder.symbol} 条件单不存在但持仓存在，检查成交记录: ${dbOrder.order_id}`);
              const closeTrade = await this.findCloseTrade(dbOrder);
              if (closeTrade) {
                // 确实有平仓交易，说明条件单触发了
                await this.handleTriggeredOrder(dbOrder);
              } else {
                // 没有平仓交易，可能是条件单被取消了
                logger.debug(`${dbOrder.symbol} 条件单 ${dbOrder.order_id} 未触发，可能被取消`);
              }
            }
          }
        } catch (error: any) {
          logger.error(`处理条件单 ${dbOrder.order_id} 失败:`, error);
        }
      }
    } catch (error: any) {
      logger.error('检测条件单触发失败:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 从数据库获取活跃的条件单
   */
  private async getActiveOrdersFromDB(): Promise<DBPriceOrder[]> {
    const result = await this.dbClient.execute({
      sql: `SELECT id, order_id, symbol, side, type, trigger_price, quantity, created_at
            FROM price_orders
            WHERE status = 'active'
            ORDER BY symbol, created_at DESC`
    });

    return result.rows.map(row => ({
      id: row.id as number,
      order_id: String(row.order_id), // 确保 order_id 是字符串
      symbol: row.symbol as string,
      side: row.side as 'long' | 'short',
      type: row.type as 'stop_loss' | 'take_profit',
      trigger_price: row.trigger_price as string,
      quantity: row.quantity as string,
      created_at: row.created_at as string
    }));
  }

  /**
   * 处理已触发的条件单
   */
  private async handleTriggeredOrder(order: DBPriceOrder) {
    logger.debug(`🔍 检查条件单: ${order.symbol} ${order.type} ${order.order_id}`);

    // 🔧 关键优化：先快速查找平仓交易，判断价格是否匹配此条件单
    // 这样可以避免在多个条件单都active时，误判到底哪个触发了
    const checkContract = this.exchangeClient.normalizeContract(order.symbol);
    const orderCreateTime = new Date(order.created_at).getTime();
    const timeToleranceMs = 5000;
    const searchStartTime = orderCreateTime - timeToleranceMs;
    
    try {
      // 先获取最近的平仓交易（轻量查询，只取100条）
      const recentTrades = await this.exchangeClient.getMyTrades(checkContract, 100, searchStartTime);
      
      // 筛选出平仓方向的交易
      const closeTrades = recentTrades.filter(t => {
        const tradeTime = t.timestamp || t.create_time || 0;
        if (tradeTime < searchStartTime) return false;
        
        const tradeSize = typeof t.size === 'number' ? t.size : parseFloat(t.size || '0');
        return (order.side === 'long' && tradeSize < 0) || (order.side === 'short' && tradeSize > 0);
      });
      
      // 如果有平仓交易，检查价格是否匹配此条件单
      if (closeTrades.length > 0) {
        const latestCloseTrade = closeTrades.reduce((latest, current) => {
          const currentTime = current.timestamp || current.create_time || 0;
          const latestTime = latest.timestamp || latest.create_time || 0;
          return currentTime > latestTime ? current : latest;
        });
        
        const tradePrice = parseFloat(latestCloseTrade.price);
        const triggerPrice = parseFloat(order.trigger_price);
        const priceTolerancePercent = 0.2; // 0.2% 价格容差
        const priceTolerance = triggerPrice * (priceTolerancePercent / 100);
        
        let priceMatches = false;
        
        if (order.type === 'stop_loss') {
          // 止损：多单价格应该低于或接近触发价，空单价格应该高于或接近触发价
          if (order.side === 'long') {
            priceMatches = tradePrice <= triggerPrice + priceTolerance;
          } else {
            priceMatches = tradePrice >= triggerPrice - priceTolerance;
          }
        } else {
          // 止盈：多单价格应该高于或接近触发价，空单价格应该低于或接近触发价
          if (order.side === 'long') {
            priceMatches = tradePrice >= triggerPrice - priceTolerance;
          } else {
            priceMatches = tradePrice <= triggerPrice + priceTolerance;
          }
        }
        
        // 如果价格不匹配，说明不是这个条件单触发的，跳过
        if (!priceMatches) {
          logger.debug(`⏭️ ${order.symbol} ${order.type} 价格不匹配，跳过: 平仓价=${tradePrice}, 触发价=${triggerPrice}, 类型=${order.type}, 方向=${order.side}`);
          return;
        }
        
        logger.debug(`✅ ${order.symbol} ${order.type} 价格匹配: 平仓价=${tradePrice}, 触发价=${triggerPrice}`);
      }
    } catch (error: any) {
      logger.warn(`价格预检查失败，继续执行: ${error.message}`);
    }

    // 阶段1: 查询持仓信息（用于计算PnL）- 提前查询，避免后面找不到
    let position = await this.getPositionInfo(order.symbol, order.side);
    
    // 如果数据库中没有持仓记录，尝试从开仓交易记录中查找
    if (!position) {
      logger.warn(`数据库中未找到 ${order.symbol} ${order.side} 的持仓信息，尝试从交易记录查找开仓信息...`);
      const openTrade = await this.findOpenTrade(order.symbol, order.side);
      if (openTrade) {
        // 使用开仓交易信息构建持仓对象
        position = {
          symbol: openTrade.symbol,
          side: openTrade.side,
          entry_price: openTrade.price,
          quantity: openTrade.quantity,
          leverage: openTrade.leverage,
        };
        logger.info(`✅ 从交易记录恢复持仓信息: ${order.symbol} @ ${position.entry_price}`);
      }
    }

    // 阶段2: 查找平仓交易（从交易所查询实际的成交记录）
    const closeTrade = await this.findCloseTrade(order);
    
    // ⚠️ 关键修复：如果交易所没有平仓记录，需要判断是真的触发还是被取消
    //    判断依据：检查交易所持仓是否还存在
    if (!closeTrade) {
      logger.warn(`⚠️ 未找到 ${order.symbol} 的平仓交易记录，检查交易所持仓状态...`);
      
      // 检查持仓是否还存在
      const checkContract = this.exchangeClient.normalizeContract(order.symbol);
      const positions = await this.exchangeClient.getPositions();
      const positionExists = positions.some(p => 
        p.contract === checkContract && Math.abs(parseFloat(p.size || '0')) > 0
      );
      
      if (positionExists) {
        // 持仓还在，说明条件单只是被取消了，不是触发
        logger.info(`${order.symbol} 持仓仍存在，条件单可能被手动取消`);
        
        await this.dbClient.execute('BEGIN TRANSACTION');
        try {
          await this.updateOrderStatus(order.order_id, 'cancelled');
          await this.dbClient.execute('COMMIT');
          logger.info(`✅ 条件单状态已更新为cancelled`);
        } catch (error: any) {
          await this.dbClient.execute('ROLLBACK');
          logger.error('❌ 更新条件单状态失败，已回滚:', error);
        }
        return;
      }
      
      // 🚨 严重错误：持仓不存在但未找到平仓交易记录
      // 这说明系统存在严重问题，不应该用估算数据掩盖
      logger.error(`🚨 严重错误: ${order.symbol} 条件单触发但未找到成交记录`);
      logger.error(`   - 条件单ID: ${order.order_id}`);
      logger.error(`   - 类型: ${order.type}`);
      logger.error(`   - 触发价: ${order.trigger_price}`);
      logger.error(`   - 创建时间: ${order.created_at}`);
      
      // 记录不一致状态到数据库，供后续人工排查
      const timestamp = new Date().toISOString();
      
      await this.dbClient.execute('BEGIN TRANSACTION');
      try {
        // 更新条件单状态为triggered（但标注为异常）
        await this.updateOrderStatus(order.order_id, 'triggered');
        await this.cancelOppositeOrderInDB(order);
        
        // 删除持仓记录（持仓已在交易所不存在）
        await this.dbClient.execute({
          sql: 'DELETE FROM positions WHERE symbol = ? AND side = ?',
          args: [order.symbol, order.side]
        });
        
        // 记录到不一致状态表
        await this.dbClient.execute({
          sql: `INSERT INTO inconsistent_states 
                (operation, symbol, side, exchange_success, db_success, 
                 exchange_order_id, error_message, created_at, resolved)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            'price_order_triggered_no_trade',
            order.symbol,
            order.side,
            1,  // 交易所端已平仓（持仓不存在）
            0,  // 数据库无法完整记录（找不到成交数据）
            order.order_id,
            `条件单${order.type}触发，但未找到成交记录。触发价=${order.trigger_price}, 创建时间=${order.created_at}。请检查交易所API或扩大查询时间窗口。`,
            timestamp,
            0
          ]
        });
        
        await this.dbClient.execute('COMMIT');
        logger.error(`❌ 已记录不一致状态，请人工排查！`);
        
      } catch (error: any) {
        await this.dbClient.execute('ROLLBACK');
        logger.error('❌ 记录不一致状态失败:', error);
      }
      
      return;
    }
    
    const finalCloseTrade = closeTrade;

    // 阶段3: 确认有持仓信息才继续（如果既没有持仓也没有开仓记录，无法处理）
    if (!position) {
      logger.error(`❌ 无法获取 ${order.symbol} ${order.side} 的持仓信息，无法记录平仓事件`);
      // 即使无法记录详情，也要更新条件单状态
      await this.updateOrderStatus(order.order_id, 'triggered');
      await this.cancelOppositeOrderInDB(order);
      return;
    }

    // 阶段4: 确认是真实平仓，计算盈亏
    logger.info(`🔔 确认条件单触发: ${order.symbol} ${order.type}, 平仓价格: ${finalCloseTrade.price}`);
    
    // 格式化成交数据，兼容所有交易所
    const trade = formatTradeRecord(finalCloseTrade);
    
    // 计算盈亏
    const entryPrice = parseFloat(position.entry_price as string);
    const exitPrice = parseFloat(trade.price);
    const quantity = Math.abs(parseFloat(trade.size));
    const leverage = parseInt(position.leverage as string) || 1;
    const contract = this.exchangeClient.normalizeContract(order.symbol);

    const grossPnl = await this.exchangeClient.calculatePnl(
      entryPrice,
      exitPrice,
      quantity,
      order.side,
      contract
    );
    
    // 计算手续费
    const contractType = this.exchangeClient.getContractType();
    let positionValue: number;
    
    if (contractType === 'inverse') {
      const quantoMultiplier = await getQuantoMultiplier(contract);
      positionValue = quantity * quantoMultiplier * exitPrice;
    } else {
      positionValue = quantity * exitPrice;
    }
    
    const openFee = positionValue * 0.0005;
    const closeFee = positionValue * 0.0005;
    const totalFee = openFee + closeFee;
    const netPnl = grossPnl - totalFee;
    
    // 计算盈亏百分比
    const priceChangePercent = order.side === "long"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
    const pnlPercent = priceChangePercent * leverage;
    
    logger.info(`💰 盈亏: 毛利=${grossPnl.toFixed(2)} USDT, 手续费=${totalFee.toFixed(2)} USDT, 净利=${netPnl.toFixed(2)} USDT (${pnlPercent.toFixed(2)}%)`);

    // 阶段5: 数据库事务操作
    const timestamp = new Date().toISOString();
    
    await this.dbClient.execute('BEGIN TRANSACTION');
    
    try {
      // ⭐️ 5.1 先删除持仓记录
      // 即使后续步骤失败，也不会误认为持仓存在
      await this.dbClient.execute({
        sql: 'DELETE FROM positions WHERE symbol = ? AND side = ?',
        args: [order.symbol, order.side]
      });
      logger.debug('✅ [事务] 步骤1: 持仓记录已删除');
      
      // ⭐️ 5.2 更新触发的条件单状态
      await this.updateOrderStatus(order.order_id, 'triggered');
      logger.debug('✅ [事务] 步骤2: 条件单状态已更新为triggered');
      
      // 5.3 取消反向条件单（数据库内操作）
      await this.cancelOppositeOrderInDB(order);
      logger.debug('✅ [事务] 步骤3: 反向条件单已取消');
      
      // 5.4 记录平仓交易
      await this.dbClient.execute({
        sql: `INSERT INTO trades 
              (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          trade.id || order.order_id,
          order.symbol,
          order.side,
          'close',
          exitPrice,
          quantity,
          leverage,
          netPnl,
          totalFee,
          timestamp,
          'filled'
        ]
      });
      logger.debug('✅ [事务] 步骤4: 交易记录已插入');
      
      // 5.5 记录平仓事件
      const closeReason = order.type === 'stop_loss' 
        ? 'stop_loss_triggered' 
        : 'take_profit_triggered';
      
      // 🔧 修复: order_id 统一存储实际平仓成交的订单ID，与 trades 表保持一致
      // trade.id: Gate.io的成交ID (短ID)，用于存储到 trades.order_id
      // order.order_id: 条件单ID，用于存储到 trigger_order_id
      const closeOrderId = trade.id || order.order_id; // 优先使用成交ID，与trades表保持一致
      
      await this.dbClient.execute({
        sql: `INSERT INTO position_close_events 
              (symbol, side, close_reason, trigger_type, trigger_price, close_price, 
               entry_price, quantity, leverage, pnl, pnl_percent, fee, 
               trigger_order_id, close_trade_id, order_id, created_at, processed)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          order.symbol, order.side, closeReason, 'exchange_order',
          parseFloat(order.trigger_price), exitPrice, entryPrice,
          quantity, leverage, netPnl, pnlPercent, totalFee,
          order.order_id, trade.id, closeOrderId, timestamp, 0
        ]
      });
      logger.debug('✅ [事务] 步骤5: 平仓事件已记录');
      
      // 提交事务
      await this.dbClient.execute('COMMIT');
      logger.info(`✅ [事务] ${order.symbol} ${order.type} 触发处理完成`);
      
    } catch (error: any) {
      // 回滚事务
      await this.dbClient.execute('ROLLBACK');
      logger.error('❌ [事务] 条件单触发处理失败，已回滚:', error);
      
      // ⚠️ 记录不一致状态
      try {
        await this.dbClient.execute({
          sql: `INSERT INTO inconsistent_states 
                (operation, symbol, side, exchange_success, db_success, 
                 exchange_order_id, error_message, created_at, resolved)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            'price_order_triggered',
            order.symbol,
            order.side,
            1,  // 交易所已平仓
            0,  // 数据库记录失败
            order.order_id,
            error.message,
            timestamp,
            0
          ]
        });
        logger.warn('⚠️ 已记录不一致状态到数据库');
      } catch (recordError: any) {
        logger.error('❌ 记录不一致状态失败:', recordError);
      }
    }
  }

  /**
   * 取消反向条件单 (同时更新交易所和数据库)
   */
  private async cancelOppositeOrderInDB(triggeredOrder: DBPriceOrder) {
    const oppositeType = triggeredOrder.type === 'stop_loss' ? 'take_profit' : 'stop_loss';
    
    const result = await this.dbClient.execute({
      sql: `SELECT order_id FROM price_orders 
            WHERE symbol = ? AND side = ? AND type = ? AND status = 'active'
            LIMIT 1`,
      args: [triggeredOrder.symbol, triggeredOrder.side, oppositeType]
    });
    
    if (result.rows.length > 0) {
      const oppositeOrderId = result.rows[0].order_id as string;
      
      // 先尝试在交易所端取消（兼容币安和Gate.io）
      try {
        const contract = this.exchangeClient.normalizeContract(triggeredOrder.symbol);
        
        // 检查交易所类型并调用对应的取消方法
        const exchangeName = process.env.EXCHANGE_NAME?.toLowerCase() || 'gate';
        
        if (exchangeName === 'gate') {
          // Gate.io: 使用单个订单取消API
          const gateClient = this.exchangeClient as any;
          if (gateClient.futuresApi && typeof gateClient.futuresApi.cancelPriceTriggeredOrder === 'function') {
            await gateClient.futuresApi.cancelPriceTriggeredOrder(
              gateClient.settle,
              oppositeOrderId
            );
            logger.debug(`✅ 已在Gate.io交易所取消反向条件单: ${oppositeOrderId}`);
          }
        } else if (exchangeName === 'binance') {
          // Binance: 需要symbol和orderId一起取消
          const binanceClient = this.exchangeClient as any;
          if (binanceClient.privateRequest && typeof binanceClient.privateRequest === 'function') {
            const symbol = contract.replace('_', '');
            await binanceClient.privateRequest('/fapi/v1/order', {
              symbol,
              orderId: oppositeOrderId
            }, 'DELETE', 2);
            logger.debug(`✅ 已在Binance交易所取消反向条件单: ${oppositeOrderId} (symbol=${symbol})`);
          }
        }
      } catch (cancelError: any) {
        // 如果取消失败（订单可能已被触发或不存在），记录警告但继续更新数据库
        logger.warn(`⚠️ 交易所端取消反向条件单失败（可能已触发）: ${cancelError.message}`);
      }
      
      // 更新数据库状态
      await this.updateOrderStatus(oppositeOrderId, 'cancelled');
      logger.debug(`✅ 已取消反向条件单: ${oppositeOrderId}`);
    }
  }

  /**
   * 查找平仓交易记录
   */
  private async findCloseTrade(order: DBPriceOrder, retries: number = 3): Promise<any | null> {
    try {
      const contract = this.exchangeClient.normalizeContract(order.symbol);
      
      // 🔧 币安条件单触发后，成交记录可能有延迟，添加重试机制
      let trades: any[] = [];
      const orderCreateTime = new Date(order.created_at).getTime();
      
      for (let attempt = 1; attempt <= retries; attempt++) {
        // 第一次尝试立即查询，后续尝试等待3秒
        if (attempt > 1) {
          logger.debug(`等待1秒后重试查询成交记录 (${attempt}/${retries})...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // 🔧 关键修复：传入条件单创建时间，让交易所API只返回此时间后的交易
        // 给予5秒的时间容差，应对时间精度和API延迟问题
        const timeToleranceMs = 5000;
        const searchStartTime = orderCreateTime - timeToleranceMs;
        
        trades = await this.exchangeClient.getMyTrades(contract, 500, searchStartTime);
        
        const now = Date.now();
        const maxTimeWindowMs = 24 * 60 * 60 * 1000; // 24小时

        if (attempt === 1) {
          logger.debug(`查找 ${order.symbol} 平仓交易: 条件单创建时间=${new Date(orderCreateTime).toISOString()}, 搜索起始=${new Date(searchStartTime).toISOString()}, 获取${trades.length}笔交易记录`);
        }

        // 查找所有符合条件的平仓交易
        const closeTrades = trades.filter(t => {
          // 交易时间必须在容差范围内
          const tradeTime = t.timestamp || t.create_time || 0;
          if (tradeTime < searchStartTime) {
            return false;
          }

          // 只检查条件单创建后24小时内的交易
          if (tradeTime - orderCreateTime > maxTimeWindowMs) {
            return false;
          }

          // 检查交易方向（平仓方向与持仓相反）
          const tradeSize = typeof t.size === 'number' ? t.size : parseFloat(t.size || '0');
          const isCloseTrade = (order.side === 'long' && tradeSize < 0) || 
                              (order.side === 'short' && tradeSize > 0);
          
          if (!isCloseTrade) return false;

          // 🔧 价格验证优化：放宽价格匹配条件，因为条件单触发时价格可能略有偏差
          const tradePrice = parseFloat(t.price);
          const triggerPrice = parseFloat(order.trigger_price);
          const priceTolerancePercent = 0.1; // 0.1% 价格容差
          const priceTolerance = triggerPrice * (priceTolerancePercent / 100);

          if (order.type === 'stop_loss') {
            // 止损：多单向下突破，空单向上突破
            // 放宽条件：价格在触发价附近即可
            if (order.side === 'long') {
              return tradePrice <= triggerPrice + priceTolerance;
            } else {
              return tradePrice >= triggerPrice - priceTolerance;
            }
          } else {
            // 止盈：多单向上突破，空单向下突破
            // 放宽条件：价格在触发价附近即可
            if (order.side === 'long') {
              return tradePrice >= triggerPrice - priceTolerance;
            } else {
              return tradePrice <= triggerPrice + priceTolerance;
            }
          }
        });

        if (closeTrades.length > 0) {
          // 找到了成交记录
          const closeTrade = closeTrades.reduce((earliest, current) => {
            const currentTime = current.timestamp || current.create_time || 0;
            const earliestTime = earliest.timestamp || earliest.create_time || 0;
            return currentTime < earliestTime ? current : earliest;
          });

          const tradeTime = closeTrade.timestamp || closeTrade.create_time || 0;
          const minutesAgo = Math.floor((now - tradeTime) / 60000);
          logger.debug(`✅ 找到平仓交易: 时间=${new Date(tradeTime).toISOString()}, 价格=${closeTrade.price}, 距今${minutesAgo}分钟`);

          return closeTrade;
        }
        
        // 🔍 调试：如果未找到，输出所有候选交易以便排查
        if (attempt === retries && trades.length > 0) {
          logger.warn(`❌ 未找到符合条件的平仓交易，输出调试信息:`);
          logger.warn(`   条件单信息: ${order.symbol} ${order.side} ${order.type}, 触发价=${order.trigger_price}, 创建时间=${new Date(orderCreateTime).toISOString()}`);
          logger.warn(`   搜索时间范围: ${new Date(searchStartTime).toISOString()} ~ 现在`);
          
          // 输出最近10笔交易的详细信息
          const recentTrades = trades.slice(0, 10);
          logger.warn(`   最近${recentTrades.length}笔交易:`);
          recentTrades.forEach((t, idx) => {
            const tradeTime = t.timestamp || t.create_time || 0;
            const tradeSize = typeof t.size === 'number' ? t.size : parseFloat(t.size || '0');
            const isCloseTrade = (order.side === 'long' && tradeSize < 0) || 
                                (order.side === 'short' && tradeSize > 0);
            logger.warn(`     [${idx + 1}] 时间=${new Date(tradeTime).toISOString()}, 价格=${t.price}, 数量=${tradeSize}, 方向=${isCloseTrade ? '平仓' : '开仓'}`);
          });
        }
        
        if (attempt < retries) {
          logger.debug(`第${attempt}次未找到成交记录，准备重试...`);
        }
      }

      logger.debug(`未找到 ${order.symbol} ${order.type} 的平仓交易记录 (已重试${retries}次)`);
      return null;
    } catch (error: any) {
      logger.error(`查找平仓交易失败:`, error);
      return null;
    }
  }

  /**
   * 查找开仓交易记录
   */
  private async findOpenTrade(symbol: string, side: 'long' | 'short'): Promise<any | null> {
    try {
      const result = await this.dbClient.execute({
        sql: `SELECT * FROM trades 
              WHERE symbol = ? 
              AND side = ? 
              AND type = 'open' 
              ORDER BY timestamp DESC 
              LIMIT 1`,
        args: [symbol, side]
      });

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error: any) {
      logger.error(`查找开仓交易失败:`, error);
      return null;
    }
  }

  /**
   * 更新条件单状态
   */
  private async updateOrderStatus(orderId: string, status: 'triggered' | 'cancelled') {
    const now = new Date().toISOString();
    
    await this.dbClient.execute({
      sql: `UPDATE price_orders
            SET status = ?,
                updated_at = ?,
                triggered_at = ?
            WHERE order_id = ?`,
      args: [status, now, status === 'triggered' ? now : null, orderId]
    });

    logger.debug(`更新条件单状态: ${orderId} -> ${status}`);
  }

  /**
   * 取消反向条件单
   */
  private async cancelOppositeOrder(triggeredOrder: DBPriceOrder) {
    try {
      // 1. 查找反向条件单
      const oppositeType = triggeredOrder.type === 'stop_loss' ? 'take_profit' : 'stop_loss';
      
      const result = await this.dbClient.execute({
        sql: `SELECT * FROM price_orders 
              WHERE symbol = ? 
              AND side = ? 
              AND type = ? 
              AND status = 'active'
              LIMIT 1`,
        args: [triggeredOrder.symbol, triggeredOrder.side, oppositeType]
      });

      if (result.rows.length === 0) {
        logger.debug(`未找到 ${triggeredOrder.symbol} 的反向条件单`);
        return;
      }

      const opposite = result.rows[0];
      const oppositeOrderId = opposite.order_id as string;
      const contract = this.exchangeClient.normalizeContract(triggeredOrder.symbol);

      // 2. 取消交易所的条件单
      try {
        // 先尝试从交易所查询条件单，确认是否存在
        const exchangePriceOrders = await this.exchangeClient.getPriceOrders(contract);
        
        // 统一格式：确保有id字段（兼容币安和Gate.io）
        const normalizedOrders = exchangePriceOrders.map(o => ({
          ...o,
          id: o.id?.toString() || o.orderId?.toString() || o.order_id?.toString()
        }));
        
        const exchangeOrder = normalizedOrders.find(o => o.id === oppositeOrderId);
        
        if (exchangeOrder) {
          // 订单存在，执行取消
          if (this.exchangeClient.getExchangeName() === 'binance') {
            // 币安需要使用特定的取消条件单API
            await this.cancelBinanceConditionalOrder(oppositeOrderId, contract);
          } else {
            // Gate.io 直接使用 cancelOrder
            await this.exchangeClient.cancelOrder(oppositeOrderId);
          }
          logger.info(`✅ 已取消交易所条件单: ${contract} ${oppositeOrderId}`);
        } else {
          logger.debug(`交易所条件单 ${oppositeOrderId} 已不存在（可能已触发或取消），无需取消`);
        }
      } catch (error: any) {
        logger.warn(`⚠️ 取消交易所条件单失败: ${error.message}`);
      }

      // 3. 更新数据库状态（无论交易所是否取消成功，都要更新本地状态）
      await this.updateOrderStatus(oppositeOrderId, 'cancelled');
      
      logger.info(`✅ 已更新本地反向条件单状态为cancelled: ${oppositeOrderId}`);
    } catch (error: any) {
      logger.error(`取消反向条件单失败:`, error);
    }
  }

  /**
   * 取消币安的条件单
   */
  private async cancelBinanceConditionalOrder(orderId: string, symbol: string): Promise<void> {
    const exchangeClient = this.exchangeClient as any;
    
    try {
      // 币安的条件单取消需要 symbol 参数
      await exchangeClient.privateRequest('/fapi/v1/order', {
        symbol,
        orderId
      }, 'DELETE');
      
      logger.debug(`已取消币安条件单 ${orderId}`);
    } catch (error: any) {
      // 如果订单已经不存在，不应该抛出错误
      if (error.message?.includes('Unknown order') || 
          error.message?.includes('Order does not exist')) {
        logger.debug(`订单 ${orderId} 已不存在，无需取消`);
        return;
      }
      throw error;
    }
  }

  /**
   * 获取持仓信息
   */
  private async getPositionInfo(symbol: string, side: 'long' | 'short'): Promise<any | null> {
    try {
      const result = await this.dbClient.execute({
        sql: `SELECT * FROM positions WHERE symbol = ? AND side = ? LIMIT 1`,
        args: [symbol, side]
      });

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error: any) {
      logger.error(`获取持仓信息失败:`, error);
      return null;
    }
  }

  /**
   * 记录平仓交易
   */
  private async recordCloseTrade(
    order: DBPriceOrder,
    closeTrade: any,
    position: any
  ) {
    try {
      // 格式化成交数据，兼容所有交易所
      const trade = formatTradeRecord(closeTrade);
      // 计算盈亏
      const entryPrice = parseFloat(position.entry_price as string);
      const exitPrice = parseFloat(trade.price);
      const quantity = Math.abs(parseFloat(trade.size));
      const leverage = parseInt(position.leverage as string);
      const contract = this.exchangeClient.normalizeContract(order.symbol);

      const pnl = await this.exchangeClient.calculatePnl(
        entryPrice,
        exitPrice,
        quantity,
        order.side,
        contract
      );

      // 计算盈亏百分比（考虑杠杆）
      const priceChange = order.side === 'long' 
        ? (exitPrice - entryPrice) / entryPrice 
        : (entryPrice - exitPrice) / entryPrice;
      const pnlPercent = priceChange * 100 * leverage;

      // 插入交易记录（timestamp是毫秒时间戳，转换为ISO 8601格式）
      // trade.timestamp 是UTC时间戳，直接转换为ISO格式即可
      const closeTimeISO = new Date(trade.timestamp).toISOString();
      
      logger.debug(`准备记录平仓交易: symbol=${order.symbol}, side=${order.side}, ` +
        `entry=${entryPrice}, exit=${exitPrice}, qty=${quantity}, pnl=${pnl.toFixed(2)}, ` +
        `time=${closeTimeISO}`);
      
      await this.dbClient.execute({
        sql: `INSERT INTO trades 
              (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          trade.id,
          order.symbol,
          order.side,
          'close',
          trade.price,
          quantity,
          leverage,
          pnl,
          trade.fee,
          closeTimeISO,
          'filled'
        ]
      });
      
      logger.info(`✅ 已记录平仓交易到数据库: ${order.symbol} ${order.side}, ` +
        `order_id=${trade.id}, PnL=${pnl.toFixed(2)} USDT (${pnlPercent.toFixed(2)}%)`);

      // 记录平仓事件（供AI决策使用）
      const closeReason = order.type === 'stop_loss' 
        ? 'stop_loss_triggered' 
        : 'take_profit_triggered';

      // 计算总手续费（开仓 + 平仓，这里只有平仓的，估算开仓手续费）
      const closeFee = parseFloat(trade.fee || '0');
      const estimatedOpenFee = Math.abs(entryPrice * quantity * 0.0002); // 估算开仓手续费
      const totalFee = closeFee + estimatedOpenFee;

      // 🔧 修复: order_id 统一存储实际平仓成交的订单ID，与 trades 表保持一致
      const closeOrderId = trade.id || order.order_id; // 优先使用成交ID，与trades表保持一致
      
      await this.dbClient.execute({
        sql: `INSERT INTO position_close_events 
              (symbol, side, close_reason, trigger_type, trigger_price, close_price, entry_price, 
               quantity, leverage, pnl, pnl_percent, fee, trigger_order_id, close_trade_id, order_id, created_at, processed)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          order.symbol,
          order.side,
          closeReason,
          'exchange_order',  // 触发类型：交易所条件单
          parseFloat(order.trigger_price),
          exitPrice,
          entryPrice,
          quantity,
          position.leverage || 1,
          pnl,
          pnlPercent,
          totalFee,
          order.order_id,
          trade.id,
          closeOrderId,
          new Date().toISOString(),
          0 // 未处理
        ]
      });

      logger.info(`📝 已记录平仓事件到数据库: ${order.symbol} ${closeReason}`);

      logger.info(`📝 已记录平仓事件到数据库: ${order.symbol} ${closeReason}`);
      
      // 验证记录是否成功插入
      const verifyResult = await this.dbClient.execute({
        sql: `SELECT COUNT(*) as count FROM trades WHERE order_id = ? AND type = 'close'`,
        args: [trade.id]
      });
      const recordCount = Number(verifyResult.rows[0]?.count || 0);
      if (recordCount > 0) {
        logger.info(`✅ 验证成功: 平仓交易已存入数据库 (order_id: ${trade.id})`);
      } else {
        logger.error(`❌ 验证失败: 平仓交易未找到 (order_id: ${trade.id})`);
      }
    } catch (error: any) {
      logger.error(`记录平仓交易失败:`, error);
      logger.error(`SQL插入参数:`, {
        orderId: order.order_id,
        symbol: order.symbol,
        side: order.side,
        type: 'close',
        tradeId: closeTrade?.id || closeTrade?.orderId,
        position: {
          entry_price: position?.entry_price,
          leverage: position?.leverage
        }
      });
    }
  }

  /**
   * 删除持仓记录
   */
  private async removePosition(symbol: string, side: 'long' | 'short') {
    try {
      await this.dbClient.execute({
        sql: `DELETE FROM positions WHERE symbol = ? AND side = ?`,
        args: [symbol, side]
      });

      logger.debug(`已删除持仓记录: ${symbol} ${side}`);
    } catch (error: any) {
      logger.error(`删除持仓记录失败:`, error);
    }
  }
}

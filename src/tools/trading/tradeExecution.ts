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
 * 交易执行工具
 */
import { createTool } from "@voltagent/core";
import { parsePositionSize } from "../../utils";
import { z } from "zod";
import { getExchangeClient } from "../../exchanges";
import { createClient } from "@libsql/client";
import { createLogger } from "../../utils/logger";
import { getChinaTimeISO } from "../../utils/timeUtils";
import { RISK_PARAMS } from "../../config/riskParams";
import { getQuantoMultiplier } from "../../utils/contractUtils";
import { 
  adjustQuantityPrecision, 
  getQuantityDecimalPlaces 
} from "../../utils/priceFormatter";
import { formatStopLossPrice } from "../../utils/priceFormatter";

const logger = createLogger({
  name: "trade-execution",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * 开仓工具
 */
export const openPositionTool = createTool({
  name: "openPosition",
  description: `开仓 - 做多或做空指定币种（使用市价单，立即以当前市场价格成交）。

✨ 新功能：自动设置科学止损！
- 如果启用科学止损系统（ENABLE_SCIENTIFIC_STOP_LOSS=true），开仓后会自动设置止损单
- 止损单在交易所服务器端执行，不受本地程序循环间隔限制
- 即使程序崩溃，止损单仍会自动触发，保护资金安全

IMPORTANT: 
- 开仓前必须先用 getAccountBalance 和 getPositions 查询可用资金和现有持仓
- 建议先用 checkOpenPosition 检查止损合理性
- 建议先用 calculateStopLoss 获取推荐止损位
- 交易手续费约0.05%，避免频繁交易`,
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    side: z.enum(["long", "short"]).describe("方向：long=做多，short=做空"),
    leverage: z.number().min(1).max(RISK_PARAMS.MAX_LEVERAGE).describe(`杠杆倍数（1-${RISK_PARAMS.MAX_LEVERAGE}倍，根据环境变量MAX_LEVERAGE配置）`),
    amountUsdt: z.number().describe("开仓金额（USDT）"),
  }),
  execute: async ({ symbol, side, leverage, amountUsdt }) => {
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(symbol);
    
    try {
      //  参数验证
      if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
        return {
          success: false,
          message: `无效的开仓金额: ${amountUsdt}`,
        };
      }
      
      if (!Number.isFinite(leverage) || leverage < 1 || leverage > RISK_PARAMS.MAX_LEVERAGE) {
        return {
          success: false,
          message: `无效的杠杆倍数: ${leverage}（必须在1-${RISK_PARAMS.MAX_LEVERAGE}之间，最大值由环境变量MAX_LEVERAGE控制）`,
        };
      }
      
      // ====== 开仓前强制风控检查 ======
      
      // 1. 检查持仓数量（最多5个）
      const allPositions = await exchangeClient.getPositions();
      const activePositions = allPositions.filter((p: any) => Math.abs(parsePositionSize(p.size)) !== 0);
      
      if (activePositions.length >= RISK_PARAMS.MAX_POSITIONS) {
        return {
          success: false,
          message: `已达到最大持仓数量限制（${RISK_PARAMS.MAX_POSITIONS}个），当前持仓 ${activePositions.length} 个，无法开新仓`,
        };
      }
      
      // 2. 检查该币种是否已有持仓（禁止双向持仓）
      const existingPosition = activePositions.find((p: any) => {
        const posSymbol = exchangeClient.extractSymbol(p.contract);
        return posSymbol === symbol;
      });
      
      if (existingPosition) {
        const existingSize = parsePositionSize(existingPosition.size);
        const existingSide = existingSize > 0 ? "long" : "short";
        
        if (existingSide !== side) {
          return {
            success: false,
            message: `${symbol} 已有${existingSide === "long" ? "多" : "空"}单持仓，禁止同时持有双向持仓。请先平掉${existingSide === "long" ? "多" : "空"}单后再开${side === "long" ? "多" : "空"}单。`,
          };
        }
        
        // 如果方向相同，允许加仓（但需要注意总持仓限制）
        logger.info(`${symbol} 已有${side === "long" ? "多" : "空"}单持仓，允许加仓`);
      }
      
      // 3. 获取账户信息
      const account = await exchangeClient.getFuturesAccount();
      const unrealisedPnl = Number.parseFloat(account.unrealisedPnl || "0");
      const totalBalance = Number.parseFloat(account.total || "0") - unrealisedPnl;
      const availableBalance = Number.parseFloat(account.available || "0");
      const positionMargin = Number.parseFloat(account.positionMargin || "0");
      
      // 🔧 详细日志：账户状态
      logger.info(`💰 账户状态: 总资产=${totalBalance.toFixed(2)} USDT, 可用=${availableBalance.toFixed(2)} USDT, 持仓保证金=${positionMargin.toFixed(2)} USDT, 未实现盈亏=${unrealisedPnl.toFixed(2)} USDT`);
      
      if (!Number.isFinite(availableBalance) || availableBalance <= 0) {
        return {
          success: false,
          message: `账户可用资金异常: ${availableBalance} USDT`,
        };
      }
      
      // 🔧 检查保证金是否充足（预留 1% 作为手续费缓冲）
      const requiredMargin = amountUsdt * 1.01; // 加 1% 手续费缓冲
      if (requiredMargin > availableBalance) {
        return {
          success: false,
          message: `保证金不足: 需要 ${requiredMargin.toFixed(2)} USDT（含手续费），可用 ${availableBalance.toFixed(2)} USDT。建议降低开仓金额或平仓释放保证金。`,
        };
      }
      
      // 4. 检查账户回撤（从数据库获取初始净值和峰值净值）
      // 注释：已移除回撤10%禁止开仓的限制
      // const initialBalanceResult = await dbClient.execute(
      //   "SELECT total_value FROM account_history ORDER BY timestamp ASC LIMIT 1"
      // );
      // const initialBalance = initialBalanceResult.rows[0]
      //   ? Number.parseFloat(initialBalanceResult.rows[0].total_value as string)
      //   : totalBalance;
      // 
      // const peakBalanceResult = await dbClient.execute(
      //   "SELECT MAX(total_value) as peak FROM account_history"
      // );
      // const peakBalance = peakBalanceResult.rows[0]?.peak 
      //   ? Number.parseFloat(peakBalanceResult.rows[0].peak as string)
      //   : totalBalance;
      // 
      // const drawdownFromPeak = peakBalance > 0 
      //   ? ((peakBalance - totalBalance) / peakBalance) * 100 
      //   : 0;
      // 
      // if (drawdownFromPeak >= RISK_PARAMS.ACCOUNT_DRAWDOWN_NO_NEW_POSITION_PERCENT) {
      //   return {
      //     success: false,
      //     message: `账户回撤已达 ${drawdownFromPeak.toFixed(2)}% ≥ ${RISK_PARAMS.ACCOUNT_DRAWDOWN_NO_NEW_POSITION_PERCENT}%，触发风控保护，禁止新开仓`,
      //   };
      // }
      
      // 5. 检查总敞口（不超过账户净值的15倍）
      let currentTotalExposure = 0;
      for (const pos of activePositions) {
        const posSize = Math.abs(parsePositionSize(pos.size));
        const entryPrice = Number.parseFloat(pos.entryPrice || "0");
        const posLeverage = Number.parseInt(pos.leverage || "1");
        // 获取合约乘数
        const posQuantoMultiplier = await getQuantoMultiplier(pos.contract);
        const posValue = posSize * entryPrice * posQuantoMultiplier;
        currentTotalExposure += posValue;
      }
      
      const newExposure = amountUsdt * leverage;
      const totalExposure = currentTotalExposure + newExposure;
      const maxAllowedExposure = totalBalance * RISK_PARAMS.MAX_LEVERAGE; // 使用配置的最大杠杆
      
      if (totalExposure > maxAllowedExposure) {
        return {
          success: false,
          message: `新开仓将导致总敞口 ${totalExposure.toFixed(2)} USDT 超过限制 ${maxAllowedExposure.toFixed(2)} USDT（账户净值的${RISK_PARAMS.MAX_LEVERAGE}倍），拒绝开仓`,
        };
      }
      
      // 6. 检查单笔仓位（建议不超过账户净值的30%）
      const maxSinglePosition = totalBalance * 0.30; // 30%
      if (amountUsdt > maxSinglePosition) {
        logger.warn(`开仓金额 ${amountUsdt.toFixed(2)} USDT 超过建议仓位 ${maxSinglePosition.toFixed(2)} USDT（账户净值的30%）`);
      }
      
      // ====== 流动性保护检查 ======
      
      // 1. 检查交易时段（UTC时间）
      const now = new Date();
      const hourUTC = now.getUTCHours();
      const dayOfWeek = now.getUTCDay(); // 0=周日，6=周六
      
      // 低流动性时段警告（UTC 2:00-6:00，亚洲时段凌晨）
      if (hourUTC >= 2 && hourUTC <= 6) {
        logger.warn(`⚠️  当前处于低流动性时段 (UTC ${hourUTC}:00)，建议谨慎交易`);
        // 在低流动性时段降低仓位
        amountUsdt = Math.max(10, amountUsdt * 0.7);
      }
      
      // 周末流动性检查
      if ((dayOfWeek === 5 && hourUTC >= 22) || dayOfWeek === 6 || (dayOfWeek === 0 && hourUTC < 20)) {
        logger.warn(`⚠️  当前处于周末时段，流动性可能较低`);
        amountUsdt = Math.max(10, amountUsdt * 0.8);
      }
      
      // 2. 检查订单簿深度（确保有足够流动性）
      try {
        const orderBook = await exchangeClient.getOrderBook(contract, 5); // 获取前5档订单
        
        if (orderBook && orderBook.bids && orderBook.bids.length > 0) {
          // 🔧 计算买单深度（前5档），带 NaN 防护
          const bidDepth = orderBook.bids.slice(0, 5).reduce((sum: number, bid: any) => {
            const price = Number.parseFloat(bid.p || '0');
            const size = Number.parseFloat(bid.s || '0');
            
            // 验证数据有效性
            if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
              logger.warn(`⚠️  订单簿数据异常: price=${bid.p}, size=${bid.s}`);
              return sum;
            }
            
            return sum + (price * size);
          }, 0);
          
          // 🔧 验证深度计算结果
          if (!Number.isFinite(bidDepth) || bidDepth <= 0) {
            logger.warn(`⚠️  订单簿深度计算异常: ${bidDepth}，跳过流动性检查`);
          } else {
            // 要求订单簿深度至少是开仓金额的5倍
            const requiredDepth = amountUsdt * leverage * 5;
            
            if (bidDepth < requiredDepth) {
              return {
                success: false,
                message: `流动性不足：订单簿深度 ${bidDepth.toFixed(2)} USDT < 所需 ${requiredDepth.toFixed(2)} USDT`,
              };
            }
            
            logger.info(`✅ 流动性检查通过：订单簿深度 ${bidDepth.toFixed(2)} USDT >= 所需 ${requiredDepth.toFixed(2)} USDT`);
          }
        } else {
          logger.warn(`⚠️  订单簿数据为空或无效`);
        }
      } catch (error) {
        logger.warn(`获取订单簿失败: ${error}`);
        // 如果无法获取订单簿，发出警告但继续
      }
      
      // ====== 波动率自适应调整 ======
      
      // 获取当前策略和市场数据
      const { getStrategyParams, getTradingStrategy } = await import("../../agents/tradingAgent.js");
      const strategy = getTradingStrategy();
      const strategyParams = getStrategyParams(strategy);
      
      let adjustedLeverage = leverage;
      let adjustedAmountUsdt = amountUsdt;
      
      // 从market data中获取ATR（需要从上下文传入）
      // 这里先计算ATR百分比
      let atrPercent = 0;
      let volatilityLevel = "normal";
      
      try {
        // 获取市场数据（包含ATR）
        const marketDataModule = await import("../trading/marketData.js");
        const ticker = await exchangeClient.getFuturesTicker(contract);
        const currentPrice = Number.parseFloat(ticker.last || "0");
        
        // 获取1小时K线计算ATR
        const candles1h = await exchangeClient.getFuturesCandles(contract, "1h", 24);
        if (candles1h && candles1h.length > 14) {
          // 计算ATR14
          const trs = [];
          for (let i = 1; i < candles1h.length; i++) {
            const high = Number.parseFloat(candles1h[i].high);
            const low = Number.parseFloat(candles1h[i].low);
            const prevClose = Number.parseFloat(candles1h[i - 1].close);
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            trs.push(tr);
          }
          const atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
          atrPercent = (atr14 / currentPrice) * 100;
          
          // 确定波动率级别
          if (atrPercent > 5) {
            volatilityLevel = "high";
          } else if (atrPercent < 2) {
            volatilityLevel = "low";
          }
        }
      } catch (error) {
        logger.warn(`计算波动率失败: ${error}`);
      }
      
      // 根据波动率调整参数
      if (volatilityLevel === "high") {
        const adjustment = strategyParams.volatilityAdjustment.highVolatility;
        adjustedLeverage = Math.max(1, Math.round(leverage * adjustment.leverageFactor));
        adjustedAmountUsdt = Math.max(10, amountUsdt * adjustment.positionFactor);
        logger.info(`🌊 高波动市场 (ATR ${atrPercent.toFixed(2)}%)：杠杆 ${leverage}x → ${adjustedLeverage}x，仓位 ${amountUsdt.toFixed(0)} → ${adjustedAmountUsdt.toFixed(0)} USDT`);
      } else if (volatilityLevel === "low") {
        const adjustment = strategyParams.volatilityAdjustment.lowVolatility;
        adjustedLeverage = Math.min(RISK_PARAMS.MAX_LEVERAGE, Math.round(leverage * adjustment.leverageFactor));
        adjustedAmountUsdt = Math.min(totalBalance * 0.32, amountUsdt * adjustment.positionFactor);
        logger.info(`🌊 低波动市场 (ATR ${atrPercent.toFixed(2)}%)：杠杆 ${leverage}x → ${adjustedLeverage}x，仓位 ${amountUsdt.toFixed(0)} → ${adjustedAmountUsdt.toFixed(0)} USDT`);
      } else {
        logger.info(`🌊 正常波动市场 (ATR ${atrPercent.toFixed(2)}%)：保持原始参数`);
      }
      
      // ====== 风控检查通过，继续开仓 ======
      
      // 设置杠杆（使用调整后的杠杆）
      await exchangeClient.setLeverage(contract, adjustedLeverage);
      
      // 获取当前价格和合约信息
      const ticker = await exchangeClient.getFuturesTicker(contract);
      const currentPrice = Number.parseFloat(ticker.last || "0");
      const contractInfo = await exchangeClient.getContractInfo(contract);
      
      // 🔧 使用交易所特定的计算方法
      // Gate.io (反向合约): 张数 = (保证金 * 杠杆) / (quantoMultiplier * 价格)
      // Binance (正向合约): 数量(币) = (保证金 * 杠杆) / 价格
      let quantity = await exchangeClient.calculateQuantity(
        adjustedAmountUsdt,
        currentPrice,
        adjustedLeverage,
        contract
      );
      
      const minSize = contractInfo.orderSizeMin || 1;
      const maxSize = contractInfo.orderSizeMax || 1000000;
      
      // 确保数量在允许范围内
      quantity = Math.max(quantity, minSize);
      quantity = Math.min(quantity, maxSize);
      
      let size = side === "long" ? quantity : -quantity;
      
      // 最后验证：如果 size 为 0 或者太小，放弃开仓
      if (Math.abs(size) < minSize) {
        return {
          success: false,
          message: `计算的数量 ${Math.abs(size)} 小于最小限制 ${minSize}，需要更多保证金（当前${adjustedAmountUsdt.toFixed(2)} USDT，杠杆${adjustedLeverage}x）`,
        };
      }
      
      // 计算实际使用的保证金（使用交易所方法重新计算）
      const contractType = exchangeClient.getContractType();
      let actualMargin: number;
      
      if (contractType === 'inverse') {
        // Gate.io: 保证金 = (张数 * quantoMultiplier * 价格) / 杠杆
        const quantoMultiplier = await getQuantoMultiplier(contract);
        actualMargin = (Math.abs(size) * quantoMultiplier * currentPrice) / adjustedLeverage;
      } else {
        // Binance: 保证金 = (数量 * 价格) / 杠杆
        actualMargin = (Math.abs(size) * currentPrice) / adjustedLeverage;
      }
      
      const unitName = contractType === 'inverse' ? '张' : symbol;
      logger.info(`开仓 ${symbol} ${side === "long" ? "做多" : "做空"} ${Math.abs(size)}${unitName} (杠杆${adjustedLeverage}x)`);
      
      //  市价单开仓（不设置止盈止损）
      const order = await exchangeClient.placeOrder({
        contract,
        size,
        price: 0,  // 市价单必须传 price: 0
      });
      
      //  等待并验证订单状态（带重试）
      // 增加等待时间，确保 Gate.io API 更新持仓信息
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      //  检查订单状态并获取实际成交价格（最多重试3次）
      let finalOrderStatus = order.status;
      let actualFillSize = 0;
      let actualFillPrice = currentPrice; // 默认使用当前价格
      
      if (order.id) {
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            const orderDetail = await exchangeClient.getOrder(order.id.toString());
            finalOrderStatus = orderDetail.status;
            
            // 使用 parseFloat 而不是 parseInt 以支持小数
            const totalSize = Math.abs(Number.parseFloat(orderDetail.size || "0"));
            const leftSize = Math.abs(Number.parseFloat(orderDetail.left || "0"));
            actualFillSize = totalSize - leftSize;
            
            //  获取实际成交价格（fill_price 或 average price）
            if (orderDetail.fill_price && Number.parseFloat(orderDetail.fill_price) > 0) {
              actualFillPrice = Number.parseFloat(orderDetail.fill_price);
            } else if (orderDetail.price && Number.parseFloat(orderDetail.price) > 0) {
              actualFillPrice = Number.parseFloat(orderDetail.price);
            }
            
            // 根据交易所类型显示不同单位
            const contractType = exchangeClient.getContractType();
            const unit = contractType === 'inverse' ? '张' : symbol;
            logger.info(`成交: ${actualFillSize.toFixed(6)}${unit} @ ${actualFillPrice.toFixed(2)} USDT`);
            
            //  验证成交价格的合理性（滑点保护）
            const priceDeviation = Math.abs(actualFillPrice - currentPrice) / currentPrice;
            if (priceDeviation > 0.02) {
              // 滑点超过2%，拒绝此次交易（回滚）
              logger.error(`❌ 成交价偏离超过2%: ${currentPrice.toFixed(2)} → ${actualFillPrice.toFixed(2)} (偏离 ${(priceDeviation * 100).toFixed(2)}%)，拒绝交易`);
              
              // 尝试平仓回滚（如果已经成交）
              try {
                await exchangeClient.placeOrder({
                  contract,
                  size: -size,
                  price: 0,
                  reduceOnly: true,
                });
                logger.info(`已回滚交易`);
              } catch (rollbackError: any) {
                logger.error(`回滚失败: ${rollbackError.message}，请手动处理`);
              }
              
              return {
                success: false,
                message: `开仓失败：成交价偏离超过2% (${currentPrice.toFixed(2)} → ${actualFillPrice.toFixed(2)})，已拒绝交易`,
              };
            }
            
            // 如果订单被取消或未成交，返回失败
            if (finalOrderStatus === 'cancelled' || actualFillSize === 0) {
              return {
                success: false,
                message: `开仓失败：订单${finalOrderStatus === 'cancelled' ? '被取消' : '未成交'}（订单ID: ${order.id}）`,
              };
            }
            
            // 成功获取订单信息，跳出循环
            break;
            
          } catch (error: any) {
            retryCount++;
            if (retryCount >= maxRetries) {
              logger.error(`获取订单详情失败（重试${retryCount}次）: ${error.message}`);
              // 如果无法获取订单详情，使用预估值继续
              logger.warn(`使用预估值继续: 数量=${Math.abs(size)}, 价格=${currentPrice}`);
              actualFillSize = Math.abs(size);
              actualFillPrice = currentPrice;
            } else {
              logger.warn(`获取订单详情失败，${retryCount}/${maxRetries} 次重试...`);
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        }
      }
      
      //  使用实际成交数量和价格记录到数据库
      const finalQuantity = actualFillSize > 0 ? actualFillSize : Math.abs(size);
      
      // 🔧 计算手续费（taker费率 0.05%）
      // 根据合约类型计算名义价值
      let positionValue: number;
      if (contractType === 'inverse') {
        // Gate.io: 名义价值 = 张数 * quantoMultiplier * 价格
        const quantoMultiplier = await getQuantoMultiplier(contract);
        positionValue = finalQuantity * quantoMultiplier * actualFillPrice;
      } else {
        // Binance: 名义价值 = 数量 * 价格
        positionValue = finalQuantity * actualFillPrice;
      }
      const fee = positionValue * 0.0005; // 0.05%
      
      // 记录开仓交易
      // side: 持仓方向（long=做多, short=做空）
      // 实际执行: long开仓=买入(+size), short开仓=卖出(-size)
      // 映射状态：Gate.io finished -> filled, open -> pending
      const dbStatus = finalOrderStatus === 'finished' ? 'filled' : 'pending';
      
      await dbClient.execute({
        sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          order.id?.toString() || "",
          symbol,
          side,            // 持仓方向（long/short）
          "open",
          actualFillPrice, // 使用实际成交价格
          finalQuantity,   // 使用实际成交数量
          leverage,
          fee,            // 手续费
          getChinaTimeISO(),
          dbStatus,
        ],
      });
      
      // ✨ 科学止损：开仓后自动设置止损单
      let slOrderId: string | undefined;
      let tpOrderId: string | undefined;
      let calculatedStopLoss: number | null = null;
      let calculatedTakeProfit: number | null = null;
      
      if (RISK_PARAMS.ENABLE_SCIENTIFIC_STOP_LOSS) {
        try {
          logger.info(`📊 计算科学止损位...`);
          
          // 动态导入止损计算服务
          const { calculateScientificStopLoss } = await import("../../services/stopLossCalculator.js");
          
          // 构建止损配置
          const stopLossConfig = {
            atrPeriod: RISK_PARAMS.ATR_PERIOD,
            atrMultiplier: RISK_PARAMS.ATR_MULTIPLIER,
            lookbackPeriod: RISK_PARAMS.SUPPORT_RESISTANCE_LOOKBACK,
            bufferPercent: RISK_PARAMS.SUPPORT_RESISTANCE_BUFFER,
            useATR: RISK_PARAMS.USE_ATR_STOP_LOSS,
            useSupportResistance: RISK_PARAMS.USE_SUPPORT_RESISTANCE_STOP_LOSS,
            minStopLossPercent: RISK_PARAMS.MIN_STOP_LOSS_PERCENT,
            maxStopLossPercent: RISK_PARAMS.MAX_STOP_LOSS_PERCENT,
          };
          
          // 计算止损位
          const stopLossResult = await calculateScientificStopLoss(
            symbol,
            side,
            actualFillPrice,
            stopLossConfig,
            "1h"
          );
          
          calculatedStopLoss = stopLossResult.stopLossPrice;
          
          // 计算止盈位（风险回报比 1:2）
          const stopLossDistance = Math.abs(actualFillPrice - calculatedStopLoss);
          calculatedTakeProfit = side === "long"
            ? actualFillPrice + stopLossDistance * 2
            : actualFillPrice - stopLossDistance * 2;
          
          // 提取币种符号用于价格格式化
          const symbolName = symbol.replace(/_USDT$/, '').replace(/USDT$/, '');
          
          logger.info(`✅ 科学止损计算完成:`);
          logger.info(`   入场价: ${formatStopLossPrice(symbolName, actualFillPrice)}`);
          logger.info(`   止损价: ${formatStopLossPrice(symbolName, calculatedStopLoss)} (${stopLossResult.stopLossDistancePercent.toFixed(2)}% 价格距离)`);
          logger.info(`   实际亏损: ${stopLossResult.stopLossDistancePercent.toFixed(2)}% × ${adjustedLeverage}x杠杆 = ${(stopLossResult.stopLossDistancePercent * adjustedLeverage).toFixed(2)}%`);
          logger.info(`   止盈价: ${formatStopLossPrice(symbolName, calculatedTakeProfit)} (${((Math.abs(calculatedTakeProfit - actualFillPrice) / actualFillPrice) * 100).toFixed(2)}%)`);
          logger.info(`   计算方法: ${stopLossResult.method}`);
          logger.info(`   质量评分: ${stopLossResult.qualityScore}/100`);
          
          // 设置止损止盈订单
          const setStopLossResult = await exchangeClient.setPositionStopLoss(
            contract,
            calculatedStopLoss,
            calculatedTakeProfit
          );
          
          if (setStopLossResult.success) {
            slOrderId = setStopLossResult.stopLossOrderId;
            tpOrderId = setStopLossResult.takeProfitOrderId;
            
            // 使用交易所返回的实际价格（可能被调整过）
            const actualStopLoss = setStopLossResult.actualStopLoss || calculatedStopLoss;
            const actualTakeProfit = setStopLossResult.actualTakeProfit || calculatedTakeProfit;
            
            // 如果价格被调整，记录日志
            if (actualStopLoss !== calculatedStopLoss) {
              logger.info(`⚠️  止损价格已由交易所调整: ${formatStopLossPrice(symbolName, calculatedStopLoss)} → ${formatStopLossPrice(symbolName, actualStopLoss)}`);
            }
            if (actualTakeProfit !== calculatedTakeProfit) {
              logger.info(`⚠️  止盈价格已由交易所调整: ${formatStopLossPrice(symbolName, calculatedTakeProfit)} → ${formatStopLossPrice(symbolName, actualTakeProfit)}`);
            }
            
            logger.info(`✅ 止损止盈订单已设置 (止损单ID: ${slOrderId}, 止盈单ID: ${tpOrderId})`);
            
            // 保存条件单到数据库（使用实际价格）
            try {
              const now = new Date().toISOString();
              if (slOrderId) {
                await dbClient.execute({
                  sql: `INSERT INTO price_orders 
                        (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  args: [slOrderId, symbol, side, 'stop_loss', actualStopLoss, 0, finalQuantity, 'active', now]
                });
              }
              if (tpOrderId) {
                await dbClient.execute({
                  sql: `INSERT INTO price_orders 
                        (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  args: [tpOrderId, symbol, side, 'take_profit', actualTakeProfit, 0, finalQuantity, 'active', now]
                });
              }
            } catch (dbError: any) {
              logger.warn(`⚠️  保存条件单到数据库失败: ${dbError.message}`);
            }
          } else {
            logger.warn(`⚠️  设置止损止盈订单失败: ${setStopLossResult.message}`);
          }
          
        } catch (error: any) {
          logger.error(`❌ 科学止损设置失败: ${error.message}`);
          logger.warn(`将不设置止损单，请手动管理风险`);
        }
      } else {
        logger.info(`科学止损系统未启用，不设置止损单`);
      }
      
      //  获取持仓信息以获取 Gate.io 返回的强平价
      // Gate.io API 有延迟，需要等待并重试
      let liquidationPrice = 0;
      let gatePositionSize = 0;
      let maxRetries = 5;
      let retryCount = 0;
      
      while (retryCount < maxRetries) {
        try {
          await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))); // 递增等待时间
          
          const positions = await exchangeClient.getPositions();
          
          const gatePosition = positions.find((p: any) => p.contract === contract);
          if (gatePosition) {
            gatePositionSize = parsePositionSize(gatePosition.size);
            
            if (gatePositionSize !== 0) {
              if (gatePosition.liqPrice) {
                liquidationPrice = Number.parseFloat(gatePosition.liqPrice);
              }
              break; // 持仓已存在，跳出循环
            }
          }
          
          retryCount++;
          
          if (retryCount >= maxRetries) {
            logger.error(`❌ 警告：Gate.io 查询显示持仓为0，但订单状态为 ${finalOrderStatus}`);
            logger.error(`订单ID: ${order.id}, 成交数量: ${actualFillSize}, 计算数量: ${finalQuantity}`);
            logger.error(`可能原因：Gate.io API 延迟或持仓需要更长时间更新`);
          }
        } catch (error) {
          logger.warn(`获取持仓失败（重试${retryCount + 1}/${maxRetries}）: ${error}`);
          retryCount++;
        }
      }
      
      // 如果未能从 Gate.io 获取强平价，使用估算公式（仅作为后备）
      if (liquidationPrice === 0) {
        liquidationPrice = side === "long" 
          ? actualFillPrice * (1 - 0.9 / leverage)
          : actualFillPrice * (1 + 0.9 / leverage);
        logger.warn(`使用估算强平价: ${liquidationPrice}`);
      }
        
      // 先检查是否已存在持仓
      const existingResult = await dbClient.execute({
        sql: "SELECT symbol FROM positions WHERE symbol = ?",
        args: [symbol],
      });
      
      if (existingResult.rows.length > 0) {
        // 更新现有持仓
        await dbClient.execute({
          sql: `UPDATE positions SET 
                quantity = ?, entry_price = ?, current_price = ?, liquidation_price = ?, 
                unrealized_pnl = ?, leverage = ?, side = ?, profit_target = ?, stop_loss = ?, 
                tp_order_id = ?, sl_order_id = ?, entry_order_id = ?
                WHERE symbol = ?`,
          args: [
            finalQuantity,
            actualFillPrice,
            actualFillPrice,
            liquidationPrice,
            0,
            leverage,
            side,
            calculatedTakeProfit,
            calculatedStopLoss,
            tpOrderId || null,
            slOrderId || null,
            order.id?.toString() || "",
            symbol,
          ],
        });
      } else {
        // 插入新持仓
        await dbClient.execute({
          sql: `INSERT INTO positions 
                (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
                 leverage, side, profit_target, stop_loss, tp_order_id, sl_order_id, entry_order_id, opened_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            symbol,
            finalQuantity,
            actualFillPrice,
            actualFillPrice,
            liquidationPrice,
            0,
            leverage,
            side,
            calculatedTakeProfit,
            calculatedStopLoss,
            tpOrderId || null,
            slOrderId || null,
            order.id?.toString() || "",
            getChinaTimeISO(),
          ],
        });
      }
      
      // 🔧 计算合约数量和总价值
      let contractAmount: number;
      let totalValue: number;
      
      if (contractType === 'inverse') {
        // Gate.io: 实际币数量 = 张数 * quantoMultiplier
        const quantoMultiplier = await getQuantoMultiplier(contract);
        contractAmount = Math.abs(size) * quantoMultiplier;
        totalValue = contractAmount * actualFillPrice;
      } else {
        // Binance: 数量就是币的数量
        contractAmount = Math.abs(size);
        totalValue = contractAmount * actualFillPrice;
      }
      
      return {
        success: true,
        orderId: order.id?.toString(),
        symbol,
        side,
        size: Math.abs(size), // 数量（Gate.io=张数, Binance=币数量）
        contractAmount, // 实际币的数量
        price: actualFillPrice,
        leverage: adjustedLeverage,
        actualMargin,
        message: `✅ 成功开仓 ${symbol} ${side === "long" ? "做多" : "做空"} ${Math.abs(size)} 张 (${contractAmount.toFixed(4)} ${symbol})，成交价 ${actualFillPrice.toFixed(2)}，保证金 ${actualMargin.toFixed(2)} USDT，杠杆 ${leverage}x。⚠️ 未设置止盈止损，请在每个周期主动决策是否平仓。`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        message: `开仓失败: ${error.message}`,
      };
    }
  },
});

/**
 * 平仓工具
 */
export const closePositionTool = createTool({
  name: "closePosition",
  description: "平仓 - 关闭指定币种的持仓",
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    percentage: z.number().min(1).max(100).default(100).describe("平仓百分比（1-100）"),
    reason: z.enum([
      'manual_close',      // AI手动平仓（默认）
      'trend_reversal',    // 趋势反转平仓
      'ai_decision',       // AI主动平仓
      'peak_drawdown',     // 峰值回撤平仓
      'time_limit',        // 持仓时间到期
    ]).optional().describe("平仓原因代码（可选）：trend_reversal=趋势反转, manual_close=AI手动平仓（默认）, peak_drawdown=峰值回撤, time_limit=持仓时间到期"),
  }),
  execute: async ({ symbol, percentage, reason = 'manual_close' }) => {
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(symbol);
    
    try {
      //  参数验证
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
        return {
          success: false,
          message: `无效的平仓百分比: ${percentage}（必须在1-100之间）`,
        };
      }
      
      //  直接从 Gate.io 获取最新的持仓信息（不依赖数据库）
      const allPositions = await exchangeClient.getPositions();
      const gatePosition = allPositions.find((p: any) => p.contract === contract);
      
      if (!gatePosition || parsePositionSize(gatePosition.size) === 0) {
        return {
          success: false,
          message: `没有找到 ${symbol} 的持仓`,
        };
      }
      
      // 🔒 防止同周期内平仓保护：检查持仓开仓时间，防止刚开仓就立即平仓
      // 从数据库获取持仓信息以检查开仓时间
      const dbClient = createClient({
        url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
      });
      
      const dbPositionResult = await dbClient.execute({
        sql: `SELECT opened_at FROM positions WHERE symbol = ? LIMIT 1`,
        args: [symbol],
      });
      
      if (dbPositionResult.rows.length > 0) {
        const openedAt = dbPositionResult.rows[0].opened_at as string;
        const openedTime = new Date(openedAt).getTime();
        const now = Date.now();
        const holdingMinutes = (now - openedTime) / (1000 * 60);
        
        // 获取交易周期间隔（分钟）
        const intervalMinutes = Number.parseInt(process.env.TRADING_INTERVAL_MINUTES || "5");
        // 最小持仓时间为半个交易周期
        const minHoldingMinutes = intervalMinutes / 2;
        
        // 如果持仓时间少于最小持仓时间，拒绝平仓
        if (holdingMinutes < minHoldingMinutes) {
          return {
            success: false,
            message: `拒绝平仓 ${symbol}：持仓时间仅 ${holdingMinutes.toFixed(1)} 分钟，少于最小持仓时间 ${minHoldingMinutes.toFixed(1)} 分钟。请等待至少半个交易周期后再评估平仓。这是为了防止在同一周期内刚开仓就立即平仓，造成不必要的手续费损失。`,
          };
        }
        
        logger.info(`${symbol} 持仓时间: ${holdingMinutes.toFixed(1)} 分钟，通过最小持仓时间检查`);
      }
      
      // 从 Gate.io 获取实时数据
      const gateSize = parsePositionSize(gatePosition.size);
      const side = gateSize > 0 ? "long" : "short";
      const quantity = Math.abs(gateSize);
      let entryPrice = Number.parseFloat(gatePosition.entryPrice || "0");
      let currentPrice = Number.parseFloat(gatePosition.markPrice || "0");
      const leverage = Number.parseInt(gatePosition.leverage || "1");
      const totalUnrealizedPnl = Number.parseFloat(gatePosition.unrealisedPnl || "0");
      
      //  如果价格为0，获取实时行情作为后备
      if (currentPrice === 0 || entryPrice === 0) {
        const ticker = await exchangeClient.getFuturesTicker(contract);
        if (currentPrice === 0) {
          currentPrice = Number.parseFloat(ticker.markPrice || ticker.last || "0");
          logger.warn(`持仓标记价格为0，使用行情价格: ${currentPrice}`);
        }
        if (entryPrice === 0) {
          entryPrice = currentPrice; // 如果开仓价为0，使用当前价格
          logger.warn(`持仓开仓价为0，使用当前价格: ${entryPrice}`);
        }
      }
      
      // 计算平仓数量
      const contractType = exchangeClient.getContractType();
      const contractInfo = await exchangeClient.getContractInfo(contract);
      const minQty = contractInfo.orderSizeMin;
      
      // 🔧 使用统一的精度处理函数
      const decimalPlaces = getQuantityDecimalPlaces(minQty);
      
      let closeSize: number;
      
      if (contractType === 'inverse') {
        // Gate.io: 张数必须是整数
        closeSize = Math.floor((quantity * percentage) / 100);
      } else {
        // Binance: 支持小数，使用精度修正
        const rawCloseSize = (quantity * percentage) / 100;
        closeSize = adjustQuantityPrecision(rawCloseSize, minQty);
      }
      
      // 🔧 检查平仓数量是否满足最小交易数量要求
      if (closeSize < minQty) {
        // 如果是100%平仓，则使用全部数量
        if (percentage === 100) {
          closeSize = quantity;
          logger.warn(`100%平仓但计算数量 ${closeSize.toFixed(decimalPlaces)} 小于最小限制 ${minQty}，使用持仓全部数量 ${quantity.toFixed(decimalPlaces)}`);
        } else {
          return {
            success: false,
            message: `平仓数量 ${closeSize.toFixed(decimalPlaces)} 小于最小交易数量 ${minQty}，无法执行。建议全部平仓或增加持仓规模。`,
            closeSize,
            minQuantity: minQty,
            currentQuantity: quantity,
            percentage,
            decimalPlaces,
          };
        }
      }
      
      logger.info(`准备平仓: symbol=${symbol}, percentage=${percentage}%, 持仓=${quantity.toFixed(decimalPlaces)}, 平仓=${closeSize.toFixed(decimalPlaces)}, 精度=${decimalPlaces}位`);
      
      const size = side === "long" ? -closeSize : closeSize;
      
      // 🔧 使用交易所特定方法计算盈亏
      const grossPnl = await exchangeClient.calculatePnl(
        entryPrice,
        currentPrice,
        closeSize,
        side,
        contract
      );
      
      logger.info(`预估盈亏: ${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(2)} USDT`);
      
      // 🔧 计算手续费（开仓 + 平仓）
      let openFee: number;
      let closeFee: number;
      
      if (contractType === 'inverse') {
        // Gate.io: 手续费 = 名义价值 * 0.05%
        const quantoMultiplier = await getQuantoMultiplier(contract);
        openFee = entryPrice * closeSize * quantoMultiplier * 0.0005;
        closeFee = currentPrice * closeSize * quantoMultiplier * 0.0005;
      } else {
        // Binance: 手续费 = 名义价值 * 0.05%
        openFee = entryPrice * closeSize * 0.0005;
        closeFee = currentPrice * closeSize * 0.0005;
      }
      
      const totalFees = openFee + closeFee;
      
      // 净盈亏 = 毛盈亏 - 总手续费（此值为预估，平仓后会基于实际成交价重新计算）
      let pnl = grossPnl - totalFees;
      
      const unitName = contractType === 'inverse' ? '张' : symbol;
      logger.info(`平仓 ${symbol} ${side === "long" ? "做多" : "做空"} ${closeSize}${unitName} (入场: ${entryPrice.toFixed(2)}, 当前: ${currentPrice.toFixed(2)})`);
      
      //  市价单平仓（Gate.io 市价单：price 为 "0"，不设置 tif）
      const order = await exchangeClient.placeOrder({
        contract,
        size,
        price: 0,  // 市价单必须传 price: 0
        reduceOnly: true, // 只减仓，不开新仓
      });
      
      //  等待并验证订单状态（带重试）
      await new Promise(resolve => setTimeout(resolve, 500));
      
      //  获取实际成交价格和数量（最多重试3次）
      let actualExitPrice = currentPrice;
      let actualCloseSize = closeSize;
      let finalOrderStatus = order.status;
      
      if (order.id) {
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            const orderDetail = await exchangeClient.getOrder(order.id.toString());
            finalOrderStatus = orderDetail.status;
            
            // 使用 parseFloat 而不是 parseInt 以支持小数
            const totalSize = Math.abs(Number.parseFloat(orderDetail.size || "0"));
            const leftSize = Math.abs(Number.parseFloat(orderDetail.left || "0"));
            const filled = totalSize - leftSize;
            
            if (filled > 0) {
              actualCloseSize = filled;
            }
            
            // 获取实际成交价格
            if (orderDetail.fill_price && Number.parseFloat(orderDetail.fill_price) > 0) {
              actualExitPrice = Number.parseFloat(orderDetail.fill_price);
            } else if (orderDetail.price && Number.parseFloat(orderDetail.price) > 0) {
              actualExitPrice = Number.parseFloat(orderDetail.price);
            }
            
            logger.info(`成交: ${actualCloseSize}${unitName} @ ${actualExitPrice.toFixed(2)} USDT`);
            
            //  验证成交价格的合理性（滑点保护）
            const priceDeviation = Math.abs(actualExitPrice - currentPrice) / currentPrice;
            if (priceDeviation > 0.03) {
              // 平仓时允许3%滑点（比开仓宽松，因为可能是紧急止损）
              logger.warn(`⚠️ 平仓成交价偏离超过3%: ${currentPrice.toFixed(2)} → ${actualExitPrice.toFixed(2)} (偏离 ${(priceDeviation * 100).toFixed(2)}%)`);
            }
            
            // 🔧 重新计算实际盈亏（基于真实成交价格）
            const grossPnl = await exchangeClient.calculatePnl(
              entryPrice,
              actualExitPrice,
              actualCloseSize,
              side,
              contract
            );
            
            // 🔧 扣除手续费（开仓 + 平仓）
            let openFee: number;
            let closeFee: number;
            
            if (contractType === 'inverse') {
              // Gate.io: 手续费 = 名义价值 * 0.05%
              const quantoMultiplier = await getQuantoMultiplier(contract);
              openFee = entryPrice * actualCloseSize * quantoMultiplier * 0.0005;
              closeFee = actualExitPrice * actualCloseSize * quantoMultiplier * 0.0005;
            } else {
              // Binance: 手续费 = 名义价值 * 0.05%
              openFee = entryPrice * actualCloseSize * 0.0005;
              closeFee = actualExitPrice * actualCloseSize * 0.0005;
            }
            // 总手续费
            const totalFees = openFee + closeFee;
            
            // 净盈亏 = 毛盈亏 - 总手续费
            pnl = grossPnl - totalFees;
            
            logger.info(`盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`);
            
            // 成功获取订单信息，跳出循环
            break;
            
          } catch (error: any) {
            retryCount++;
            if (retryCount >= maxRetries) {
              logger.error(`获取平仓订单详情失败（重试${retryCount}次）: ${error.message}`);
              // 如果无法获取订单详情，使用预估值
              logger.warn(`使用预估值继续: 数量=${closeSize}, 价格=${currentPrice}`);
              actualCloseSize = closeSize;
              actualExitPrice = currentPrice;
              
              // 🔧 重新计算盈亏
              const grossPnl = await exchangeClient.calculatePnl(
                entryPrice,
                actualExitPrice,
                actualCloseSize,
                side,
                contract
              );
              
              // 扣除手续费
              if (contractType === 'inverse') {
                const quantoMultiplier = await getQuantoMultiplier(contract);
                const openFee = entryPrice * actualCloseSize * quantoMultiplier * 0.0005;
                const closeFee = actualExitPrice * actualCloseSize * quantoMultiplier * 0.0005;
                pnl = grossPnl - openFee - closeFee;
              } else {
                const openFee = entryPrice * actualCloseSize * 0.0005;
                const closeFee = actualExitPrice * actualCloseSize * 0.0005;
                pnl = grossPnl - openFee - closeFee;
              }
            } else {
              logger.warn(`获取平仓订单详情失败，${retryCount}/${maxRetries} 次重试...`);
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        }
      }
      
      // 获取账户信息用于记录当前总资产
      const account = await exchangeClient.getFuturesAccount();
      const totalBalance = Number.parseFloat(account.total || "0");
      
      // 🔧 计算总手续费（开仓 + 平仓）用于数据库记录
      let dbOpenFee: number;
      let dbCloseFee: number;
      
      if (contractType === 'inverse') {
        // Gate.io
        const dbQuantoMultiplier = await getQuantoMultiplier(contract);
        dbOpenFee = entryPrice * actualCloseSize * dbQuantoMultiplier * 0.0005;
        dbCloseFee = actualExitPrice * actualCloseSize * dbQuantoMultiplier * 0.0005;
      } else {
        // Binance
        dbOpenFee = entryPrice * actualCloseSize * 0.0005;
        dbCloseFee = actualExitPrice * actualCloseSize * 0.0005;
      }
      
      const totalFee = dbOpenFee + dbCloseFee;
      
      // 🔥 关键验证：检查盈亏计算是否正确
      const expectedPnl = await exchangeClient.calculatePnl(
        entryPrice,
        actualExitPrice,
        actualCloseSize,
        side,
        contract
      ) - totalFee;
      
      // 获取名义价值用于检测异常
      let notionalValue: number;
      if (contractType === 'inverse') {
        const dbQuantoMultiplier = await getQuantoMultiplier(contract);
        notionalValue = actualExitPrice * actualCloseSize * dbQuantoMultiplier;
      } else {
        notionalValue = actualExitPrice * actualCloseSize;
      }
      
      // 检测盈亏是否被错误地设置为名义价值
      if (Math.abs(pnl - notionalValue) < Math.abs(pnl - expectedPnl)) {
        logger.error(`🚨 检测到盈亏计算异常！`);
        logger.error(`  当前pnl: ${pnl.toFixed(2)} USDT 接近名义价值 ${notionalValue.toFixed(2)} USDT`);
        logger.error(`  预期pnl: ${expectedPnl.toFixed(2)} USDT`);
        
        // 强制修正为正确值
        pnl = expectedPnl;
        logger.warn(`  已自动修正pnl为: ${pnl.toFixed(2)} USDT`);
      }
      
      // 详细日志记录（用于debug）
      logger.info(`【平仓盈亏详情】${symbol} ${side}`);
      logger.info(`  开仓价: ${entryPrice.toFixed(4)}, 平仓价: ${actualExitPrice.toFixed(4)}, 数量: ${actualCloseSize}${unitName}`);
      logger.info(`  开仓手续费: ${dbOpenFee.toFixed(4)} USDT, 平仓手续费: ${dbCloseFee.toFixed(4)} USDT`);
      logger.info(`  总手续费: ${totalFee.toFixed(4)} USDT`);
      logger.info(`  净盈亏: ${pnl.toFixed(2)} USDT`);
      
      // 记录平仓交易
      // side: 原持仓方向（long/short）
      // 实际执行方向: long平仓=卖出, short平仓=买入
      // pnl: 净盈亏（已扣除手续费）
      // fee: 总手续费（开仓+平仓）
      // 映射状态：Gate.io finished -> filled, open -> pending
      const dbStatus = finalOrderStatus === 'finished' ? 'filled' : 'pending';
      
      await dbClient.execute({
        sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          order.id?.toString() || "",
          symbol,
          side,             // 原持仓方向（便于统计某个币种的多空盈亏）
          "close",
          actualExitPrice,   // 使用实际成交价格
          actualCloseSize,   // 使用实际成交数量
          leverage,
          pnl,              // 净盈亏（已扣除手续费）
          totalFee,         // 总手续费（开仓+平仓）
          getChinaTimeISO(),
          dbStatus,
        ],
      });
      
      // 📝 记录平仓事件到 position_close_events 表
      // 这样可以追踪每次平仓的原因和详情
      const closeEventTime = getChinaTimeISO();
      
      // 计算盈亏百分比（含杠杆）
      const pnlPercent = entryPrice > 0 
        ? ((actualExitPrice - entryPrice) / entryPrice * 100 * (side === 'long' ? 1 : -1) * leverage)
        : 0;
      
      await dbClient.execute({
        sql: `INSERT INTO position_close_events 
              (symbol, side, entry_price, exit_price, quantity, leverage, 
               pnl, pnl_percent, fee, close_reason, trigger_type, order_id, 
               created_at, processed)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          symbol,
          side,
          entryPrice,
          actualExitPrice,
          actualCloseSize,
          leverage,
          pnl,
          pnlPercent,
          totalFee,
          reason,          // 使用传入的平仓原因代码
          'ai_decision',   // 触发类型：AI决策
          order.id?.toString() || "",
          closeEventTime,
          1,  // 已处理
        ],
      });
      
      logger.info(`📝 已记录平仓事件: ${symbol} ${side} 原因=${reason}, 盈亏=${pnl.toFixed(2)} USDT (${pnlPercent.toFixed(2)}%)`);

      
      // 🔥 关键修复：平仓时必须取消交易所的所有条件单
      // 使用交易所的 cancelPositionStopLoss 方法一次性取消所有条件单
      try {
        const cancelResult = await exchangeClient.cancelPositionStopLoss(contract);
        if (cancelResult.success) {
          logger.info(`✅ 已取消 ${symbol} 在交易所的所有止损止盈订单`);
          
          // 更新数据库中该币种所有活跃条件单的状态为 cancelled
          const now = new Date().toISOString();
          await dbClient.execute({
            sql: `UPDATE price_orders 
                  SET status = 'cancelled', updated_at = ?
                  WHERE symbol = ? AND status = 'active'`,
            args: [now, symbol]
          });
          logger.info(`✅ 已更新数据库中 ${symbol} 的条件单状态`);
        } else {
          logger.warn(`⚠️ 取消条件单失败: ${cancelResult.message}`);
        }
      } catch (cancelError: any) {
        logger.error(`❌ 取消条件单异常: ${cancelError.message}`);
      }
      
      // 从数据库获取止损止盈订单ID（用于日志记录）
      const posResult = await dbClient.execute({
        sql: "SELECT sl_order_id, tp_order_id FROM positions WHERE symbol = ?",
        args: [symbol],
      });
      
      // 额外检查：如果数据库中有订单ID记录，再尝试单独取消（双重保险）
      if (posResult.rows.length > 0) {
        const dbPosition = posResult.rows[0] as any;
        
        if (dbPosition.sl_order_id || dbPosition.tp_order_id) {
          logger.debug(`数据库记录的订单ID: SL=${dbPosition.sl_order_id}, TP=${dbPosition.tp_order_id}`);
          
          // 批量处理单个订单取消（作为双重保险）
          const cancelPromises: Promise<void>[] = [];
          
          if (dbPosition.sl_order_id) {
            cancelPromises.push(
              (async () => {
                try {
                  await exchangeClient.cancelOrder(dbPosition.sl_order_id);
                  logger.debug(`✅ 止损订单 ${dbPosition.sl_order_id} 已取消`);
                } catch (e: any) {
                  logger.debug(`止损订单 ${dbPosition.sl_order_id} 可能已被取消: ${e.message}`);
                }
              })()
            );
          }
          
          if (dbPosition.tp_order_id) {
            cancelPromises.push(
              (async () => {
                try {
                  await exchangeClient.cancelOrder(dbPosition.tp_order_id);
                  logger.debug(`✅ 止盈订单 ${dbPosition.tp_order_id} 已取消`);
                } catch (e: any) {
                  logger.debug(`止盈订单 ${dbPosition.tp_order_id} 可能已被取消: ${e.message}`);
                }
              })()
            );
          }
          
          // 等待所有取消操作完成（不阻塞主流程）
          await Promise.allSettled(cancelPromises);
        }
      }
      
      // 如果全部平仓，从持仓表删除；否则不操作（交由同步任务更新）
      if (percentage === 100) {
        await dbClient.execute({
          sql: "DELETE FROM positions WHERE symbol = ?",
          args: [symbol],
        });
      }
      
      return {
        success: true,
        orderId: order.id?.toString(),
        symbol,
        side,
        closedSize: actualCloseSize,  // 使用实际成交数量
        entryPrice,
        exitPrice: actualExitPrice,   // 使用实际成交价格
        leverage,
        pnl,                          // 净盈亏（已扣除手续费）
        fee: totalFee,                // 总手续费
        totalBalance,
        message: `成功平仓 ${symbol} ${actualCloseSize} 张，入场价 ${entryPrice.toFixed(4)}，平仓价 ${actualExitPrice.toFixed(4)}，净盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (已扣手续费 ${totalFee.toFixed(2)} USDT)，当前总资产 ${totalBalance.toFixed(2)} USDT`,
      };
    } catch (error: any) {
      logger.error(`平仓失败: ${error.message}`, error);
      return {
        success: false,
        error: error.message,
        message: `平仓失败: ${error.message}`,
      };
    }
  },
});

/**
 * 取消订单工具
 */
export const cancelOrderTool = createTool({
  name: "cancelOrder",
  description: "取消指定的挂单",
  parameters: z.object({
    orderId: z.string().describe("订单ID"),
  }),
  execute: async ({ orderId }) => {
    const exchangeClient = getExchangeClient();
    
    try {
      await exchangeClient.cancelOrder(orderId);
      
      return {
        success: true,
        orderId,
        message: `订单 ${orderId} 已取消`,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        message: `取消订单失败: ${error.message}`,
      };
    }
  },
});


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
 * 专业级分批止盈管理工具（基于风险倍数 R-Multiple）
 * 
 * 核心理念：
 * 1. 基于风险倍数而非固定百分比
 * 2. 每次分批后移动止损保护利润
 * 3. 最后部分采用移动止损博取大趋势
 * 4. 极限止盈作为最后兜底
 */

import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getExchangeClient } from "../../exchanges";
import { createClient } from "@libsql/client";
import { createLogger } from "../../utils/logger";
import { getChinaTimeISO } from "../../utils/timeUtils";
import { 
  formatStopLossPrice, 
  calculatePartialCloseQuantity 
} from "../../utils/priceFormatter";
import { calculateATR } from "../../services/stopLossCalculator";

const logger = createLogger({
  name: "take-profit-management",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
  syncUrl: process.env.DATABASE_SYNC_URL,
  syncInterval: 1000,
});

/**
 * 波动率级别定义
 */
export type VolatilityLevel = "LOW" | "NORMAL" | "HIGH" | "EXTREME";

/**
 * 波动率分析结果
 */
export interface VolatilityAnalysis {
  level: VolatilityLevel;
  atrPercent: number;         // ATR占价格的百分比
  atr14: number;              // 14周期ATR值
  adjustmentFactor: number;   // R-multiple调整系数
  description: string;        // 描述
}

/**
 * 分析市场波动率并返回调整系数
 * 
 * 波动率级别划分：
 * - LOW: ATR < 2% - 低波动，收紧止盈（0.8x）
 * - NORMAL: 2% <= ATR < 5% - 正常波动，标准止盈（1.0x）
 * - HIGH: 5% <= ATR < 8% - 高波动，放宽止盈（1.2x）
 * - EXTREME: ATR >= 8% - 极端波动，大幅放宽（1.5x）
 * 
 * @param symbol 交易对
 * @param interval K线周期（默认15m）
 * @returns 波动率分析结果
 */
export async function analyzeMarketVolatility(
  symbol: string,
  interval: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" = "15m"
): Promise<VolatilityAnalysis> {
  const exchangeClient = getExchangeClient();
  const contract = exchangeClient.normalizeContract(symbol);
  
  try {
    // 获取K线数据（至少需要20根用于ATR计算）
    const candles = await exchangeClient.getFuturesCandles(contract, interval, 30);
    
    if (!candles || candles.length < 15) {
      logger.warn(`${symbol} K线数据不足，使用默认波动率分析`);
      return {
        level: "NORMAL",
        atrPercent: 3.0,
        atr14: 0,
        adjustmentFactor: 1.0,
        description: "数据不足，使用默认标准波动率",
      };
    }
    
    // 提取OHLC数据（兼容不同交易所格式）
    const formattedCandles = candles.map((c: any) => ({
      time: Number.parseInt(c.t || c.time || "0", 10),
      open: Number.parseFloat(c.o || c.open || "0"),
      high: Number.parseFloat(c.h || c.high || "0"),
      low: Number.parseFloat(c.l || c.low || "0"),
      close: Number.parseFloat(c.c || c.close || "0"),
      volume: Number.parseFloat(c.v || c.volume || "0"),
    }));
    
    // 计算14周期ATR
    const atr14 = calculateATR(formattedCandles, 14);
    const currentPrice = formattedCandles[formattedCandles.length - 1].close;
    const atrPercent = (atr14 / currentPrice) * 100;
    
    // 根据ATR百分比判断波动率级别和调整系数
    let level: VolatilityLevel;
    let adjustmentFactor: number;
    let description: string;
    
    if (atrPercent < 2) {
      level = "LOW";
      adjustmentFactor = 0.8;
      description = "低波动环境，收紧止盈目标，快速落袋为安";
    } else if (atrPercent < 5) {
      level = "NORMAL";
      adjustmentFactor = 1.0;
      description = "正常波动环境，使用标准止盈配置";
    } else if (atrPercent < 8) {
      level = "HIGH";
      adjustmentFactor = 1.2;
      description = "高波动环境，放宽止盈目标，让利润奔跑";
    } else {
      level = "EXTREME";
      adjustmentFactor = 1.5;
      description = "极端波动环境，大幅放宽止盈，捕捉大趋势";
    }
    
    logger.info(`${symbol} 波动率分析: ATR14=${atr14.toFixed(4)} (${atrPercent.toFixed(2)}%), 级别=${level}, 调整系数=${adjustmentFactor}x`);
    
    return {
      level,
      atrPercent: Number.parseFloat(atrPercent.toFixed(2)),
      atr14,
      adjustmentFactor,
      description,
    };
  } catch (error: any) {
    logger.error(`分析 ${symbol} 波动率失败: ${error.message}`);
    // 返回默认值
    return {
      level: "NORMAL",
      atrPercent: 3.0,
      atr14: 0,
      adjustmentFactor: 1.0,
      description: "分析失败，使用默认标准波动率",
    };
  }
}

/**
 * 根据波动率调整R-multiple目标
 * 
 * @param baseRMultiple 基础R倍数
 * @param volatility 波动率分析结果
 * @returns 调整后的R倍数
 */
export function adjustRMultipleForVolatility(
  baseRMultiple: number,
  volatility: VolatilityAnalysis
): number {
  const adjusted = baseRMultiple * volatility.adjustmentFactor;
  
  logger.debug(`R倍数调整: 基础=${baseRMultiple}, 系数=${volatility.adjustmentFactor}, 调整后=${adjusted.toFixed(2)}`);
  
  return adjusted;
}

/**
 * 计算风险倍数（R-Multiple）
 * 
 * @param entryPrice 入场价
 * @param currentPrice 当前价
 * @param stopLossPrice 止损价
 * @param side 方向
 * @returns 风险倍数（正数表示盈利，负数表示亏损）
 */
export function calculateRMultiple(
  entryPrice: number,
  currentPrice: number,
  stopLossPrice: number,
  side: "long" | "short"
): number {
  const riskDistance = Math.abs(entryPrice - stopLossPrice);
  
  if (riskDistance === 0) {
    logger.warn("风险距离为0，无法计算R倍数");
    return 0;
  }
  
  let profitDistance: number;
  if (side === "long") {
    profitDistance = currentPrice - entryPrice;
  } else {
    profitDistance = entryPrice - currentPrice;
  }
  
  const rMultiple = profitDistance / riskDistance;
  
  logger.debug(`计算R倍数: entry=${entryPrice}, current=${currentPrice}, stop=${stopLossPrice}, side=${side}, R=${rMultiple.toFixed(2)}`);
  
  return rMultiple;
}

/**
 * 计算目标价格（基于R倍数）
 * 
 * @param entryPrice 入场价
 * @param stopLossPrice 止损价
 * @param rMultiple 目标风险倍数
 * @param side 方向
 * @returns 目标价格
 */
export function calculateTargetPrice(
  entryPrice: number,
  stopLossPrice: number,
  rMultiple: number,
  side: "long" | "short"
): number {
  const riskDistance = Math.abs(entryPrice - stopLossPrice);
  const targetDistance = riskDistance * rMultiple;
  
  let targetPrice: number;
  if (side === "long") {
    targetPrice = entryPrice + targetDistance;
  } else {
    targetPrice = entryPrice - targetDistance;
  }
  
  return targetPrice;
}

/**
 * 获取持仓的分批止盈历史
 */
async function getPartialTakeProfitHistory(symbol: string): Promise<any[]> {
  const result = await dbClient.execute({
    sql: `
      SELECT * FROM partial_take_profit_history
      WHERE symbol = ? AND status = 'completed'
      ORDER BY timestamp DESC
    `,
    args: [symbol],
  });
  
  return result.rows as any[];
}

/**
 * 记录分批止盈执行
 */
async function recordPartialTakeProfit(data: {
  symbol: string;
  stage: number;
  rMultiple: number;
  triggerPrice: number;
  closePercent: number;
  closedQuantity: number;
  remainingQuantity: number;
  pnl: number;
  newStopLossPrice?: number;
  status: "completed" | "failed";
  notes?: string;
}): Promise<void> {
  await dbClient.execute({
    sql: `
      INSERT INTO partial_take_profit_history (
        symbol, stage, r_multiple, trigger_price, close_percent,
        closed_quantity, remaining_quantity, pnl, new_stop_loss_price,
        status, notes, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      data.symbol,
      data.stage,
      data.rMultiple,
      data.triggerPrice,
      data.closePercent,
      data.closedQuantity,
      data.remainingQuantity,
      data.pnl,
      data.newStopLossPrice || null,
      data.status,
      data.notes || null,
      getChinaTimeISO(),
    ],
  });
}

/**
 * 执行分批止盈工具（基于风险倍数）
 */
export const partialTakeProfitTool = createTool({
  name: "executePartialTakeProfit",
  description: `执行分批止盈（基于风险倍数 R-Multiple）

专业交易员的分批止盈策略：
• 1R（盈利=1倍风险）：平仓 1/3，止损移至成本价（保本交易）
• 2R（盈利=2倍风险）：平仓 1/3，止损移至 1R（锁定1倍风险利润）
• 3R+（盈利≥3倍风险）：保留 1/3，使用移动止损让利润奔跑

核心理念：
1. 基于风险倍数，而非固定百分比
2. 每次平仓后移动止损，逐步保护利润
3. 最后部分采用移动止损，博取大趋势
4. 系统会自动计算当前R倍数并判断是否触发

使用前提：
• 持仓必须有止损价（stop_loss字段）
• 持仓必须处于盈利状态
• 建议先使用 getPositions 查看当前持仓状态

注意：
• 每个阶段只能执行一次
• 执行后会自动更新止损位置
• 如果启用科学止损，会同步更新交易所订单`,
  parameters: z.object({
    symbol: z.string().describe("币种代码（如：BTC, ETH）"),
    stage: z.enum(["1", "2", "3"]).describe("分批阶段：1=1R平仓1/3, 2=2R平仓1/3, 3=3R+移动止损"),
  }),
  execute: async ({ symbol, stage }) => {
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(symbol);
    
    try {
      // 1. 获取当前持仓
      const allPositions = await exchangeClient.getPositions();
      const position = allPositions.find((p: any) => {
        const posSymbol = exchangeClient.extractSymbol(p.contract);
        return posSymbol === symbol && Math.abs(Number.parseFloat(p.size || "0")) > 0;
      });
      
      if (!position) {
        return {
          success: false,
          message: `未找到 ${symbol} 的持仓`,
        };
      }
      
      const currentSize = Math.abs(Number.parseFloat(position.size || "0"));
      const side: "long" | "short" = Number.parseFloat(position.size || "0") > 0 ? "long" : "short";
      const entryPrice = Number.parseFloat(position.entryPrice || "0");
      const currentPrice = Number.parseFloat(position.markPrice || "0");
      const leverage = Number.parseInt(position.leverage || "1", 10);
      
      // 2. 从数据库获取止损价
      const positionResult = await dbClient.execute({
        sql: "SELECT stop_loss, partial_close_percentage FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
        args: [symbol],
      });
      
      if (positionResult.rows.length === 0 || !positionResult.rows[0].stop_loss) {
        return {
          success: false,
          message: `${symbol} 持仓没有设置止损价，无法使用基于R倍数的分批止盈。请先设置止损。`,
        };
      }
      
      const stopLossPrice = Number.parseFloat(positionResult.rows[0].stop_loss as string);
      const alreadyClosedPercent = Number.parseFloat(positionResult.rows[0].partial_close_percentage as string || "0");
      
      // 3. 分析市场波动率（用于动态调整R倍数）
      const volatility = await analyzeMarketVolatility(symbol, "15m");
      
      logger.info(`${symbol} 波动率分析: ${volatility.description} (ATR=${volatility.atrPercent}%, 调整系数=${volatility.adjustmentFactor}x)`);
      
      // 4. 计算当前R倍数
      const currentR = calculateRMultiple(entryPrice, currentPrice, stopLossPrice, side);
      
      logger.info(`${symbol} 当前状态: 入场=${entryPrice}, 当前=${currentPrice}, 止损=${stopLossPrice}, 原始R=${currentR.toFixed(2)}`);
      
      // 5. 检查分批止盈历史
      const history = await getPartialTakeProfitHistory(symbol);
      const stageHistory = history.filter((h) => h.stage === Number.parseInt(stage, 10));
      
      if (stageHistory.length > 0) {
        return {
          success: false,
          message: `阶段${stage}已经执行过分批止盈，不能重复执行`,
          history: stageHistory,
        };
      }
      
      // 6. 根据阶段执行不同逻辑（应用波动率调整）
      const stageNum = Number.parseInt(stage, 10);
      let baseRequiredR: number;    // 基础R倍数要求
      let requiredR: number;        // 动态调整后的R倍数要求
      let closePercent: number;
      let newStopLossPrice: number | undefined;
      
      if (stageNum === 1) {
        // 阶段1: 1R，平仓 1/3，止损移至成本价
        baseRequiredR = 1;
        requiredR = adjustRMultipleForVolatility(baseRequiredR, volatility);
        closePercent = 33.33;
        newStopLossPrice = entryPrice;
        
        logger.info(`${symbol} 阶段1 R倍数要求: 基础=${baseRequiredR}R, 调整后=${requiredR.toFixed(2)}R (${volatility.level}波动)`);
        
        if (currentR < requiredR) {
          return {
            success: false,
            message: `当前R倍数 ${currentR.toFixed(2)} 未达到阶段1要求（≥${requiredR.toFixed(2)}R，${volatility.description}）`,
            currentR,
            requiredR: Number.parseFloat(requiredR.toFixed(2)),
            baseRequiredR,
            volatility: {
              level: volatility.level,
              atrPercent: volatility.atrPercent,
              adjustmentFactor: volatility.adjustmentFactor,
            },
          };
        }
      } else if (stageNum === 2) {
        // 阶段2: 2R，平仓 1/3，止损移至 1R
        baseRequiredR = 2;
        requiredR = adjustRMultipleForVolatility(baseRequiredR, volatility);
        closePercent = 33.33;
        
        // 检查阶段1是否已执行
        const stage1History = history.filter((h) => h.stage === 1);
        if (stage1History.length === 0) {
          return {
            success: false,
            message: "必须先执行阶段1（1R平仓1/3）才能执行阶段2",
          };
        }
        
        // 止损移至 1R 位置（使用基础R，不受波动率影响）
        newStopLossPrice = calculateTargetPrice(entryPrice, stopLossPrice, 1, side);
        
        logger.info(`${symbol} 阶段2 R倍数要求: 基础=${baseRequiredR}R, 调整后=${requiredR.toFixed(2)}R (${volatility.level}波动)`);
        
        if (currentR < requiredR) {
          return {
            success: false,
            message: `当前R倍数 ${currentR.toFixed(2)} 未达到阶段2要求（≥${requiredR.toFixed(2)}R，${volatility.description}）`,
            currentR,
            requiredR: Number.parseFloat(requiredR.toFixed(2)),
            baseRequiredR,
            volatility: {
              level: volatility.level,
              atrPercent: volatility.atrPercent,
              adjustmentFactor: volatility.adjustmentFactor,
            },
          };
        }
      } else if (stageNum === 3) {
        // 阶段3: 3R+，不平仓，启用移动止损
        baseRequiredR = 3;
        requiredR = adjustRMultipleForVolatility(baseRequiredR, volatility);
        closePercent = 0;
        
        // 检查阶段1和2是否已执行
        const stage1History = history.filter((h) => h.stage === 1);
        const stage2History = history.filter((h) => h.stage === 2);
        
        if (stage1History.length === 0 || stage2History.length === 0) {
          return {
            success: false,
            message: "必须先执行阶段1和阶段2才能执行阶段3",
          };
        }
        
        logger.info(`${symbol} 阶段3 R倍数要求: 基础=${baseRequiredR}R, 调整后=${requiredR.toFixed(2)}R (${volatility.level}波动)`);
        
        if (currentR < requiredR) {
          return {
            success: false,
            message: `当前R倍数 ${currentR.toFixed(2)} 未达到阶段3要求（≥${requiredR.toFixed(2)}R，${volatility.description}）`,
            currentR,
            requiredR: Number.parseFloat(requiredR.toFixed(2)),
            baseRequiredR,
            volatility: {
              level: volatility.level,
              atrPercent: volatility.atrPercent,
              adjustmentFactor: volatility.adjustmentFactor,
            },
          };
        }
        
        // 阶段3不执行平仓，只记录启用移动止损
        await recordPartialTakeProfit({
          symbol,
          stage: stageNum,
          rMultiple: currentR,
          triggerPrice: currentPrice,
          closePercent: 0,
          closedQuantity: 0,
          remainingQuantity: currentSize,
          pnl: 0,
          status: "completed",
          notes: `阶段3：启用移动止损（${volatility.level}波动，要求${requiredR.toFixed(2)}R）`,
        });
        
        return {
          success: true,
          message: `✅ 阶段3完成：已达到${currentR.toFixed(2)}R（要求${requiredR.toFixed(2)}R，${volatility.description}），启用移动止损让利润奔跑`,
          stage: stageNum,
          currentR,
          requiredR: Number.parseFloat(requiredR.toFixed(2)),
          baseRequiredR,
          volatility: {
            level: volatility.level,
            atrPercent: volatility.atrPercent,
            adjustmentFactor: volatility.adjustmentFactor,
          },
          action: "启用移动止损（请使用 updateTrailingStop 工具定期更新）",
        };
      } else {
        return {
          success: false,
          message: "无效的阶段参数，必须是 1, 2 或 3",
        };
      }
      
      // 6. 执行平仓（阶段1和2）
      // 🔧 使用统一的数量精度处理函数
      const contractInfo = await exchangeClient.getContractInfo(contract);
      const minQty = contractInfo.orderSizeMin;
      
      const quantityResult = calculatePartialCloseQuantity(currentSize, closePercent, minQty);
      
      if (quantityResult.error) {
        return {
          success: false,
          message: quantityResult.error,
        };
      }
      
      const { closeQuantity, remainingQuantity, decimalPlaces, meetsMinQuantity, remainingMeetsMin } = quantityResult;
      
      logger.info(`准备平仓: symbol=${symbol}, closePercent=${closePercent}%, 持仓=${currentSize.toFixed(decimalPlaces)}, 平仓=${closeQuantity.toFixed(decimalPlaces)}, 剩余=${remainingQuantity.toFixed(decimalPlaces)}, 精度=${decimalPlaces}位`);
      
      // 检查平仓数量是否满足最小交易数量要求
      if (!meetsMinQuantity) {
        return {
          success: false,
          message: `分批平仓数量 ${closeQuantity.toFixed(decimalPlaces)} 小于最小交易数量 ${minQty}，无法执行。建议增加持仓规模或调整平仓比例。`,
          closeQuantity,
          minQuantity: minQty,
          currentSize,
          closePercent,
          decimalPlaces,
        };
      }
      
      // 检查剩余数量是否满足最小持仓要求（如果不为0的话）
      if (!remainingMeetsMin) {
        logger.warn(`分批平仓后剩余数量 ${remainingQuantity.toFixed(decimalPlaces)} 小于最小交易数量 ${minQty}`);
        return {
          success: false,
          message: `分批平仓后剩余数量 ${remainingQuantity.toFixed(decimalPlaces)} 小于最小交易数量 ${minQty}，建议调整平仓比例或全部平仓`,
          closeQuantity,
          remainingQuantity,
          minQuantity: minQty,
          suggestion: "建议全部平仓或增加持仓规模",
        };
      }
      
      // 执行平仓（使用市价单平仓）
      try {
        const closeSide = side === "long" ? "sell" : "buy";
        // 平仓时的数量需要根据方向确定正负
        // 对于 long 仓位，平仓数量应该是负数（卖出）
        // 对于 short 仓位，平仓数量应该是正数（买入）
        const closeSize = side === "long" ? -closeQuantity : closeQuantity;
        
        await exchangeClient.placeOrder({
          contract,
          size: closeSize,
          price: 0, // 市价单，price设为0
          reduceOnly: true,
        });
      } catch (error: any) {
        await recordPartialTakeProfit({
          symbol,
          stage: stageNum,
          rMultiple: currentR,
          triggerPrice: currentPrice,
          closePercent,
          closedQuantity: 0,
          remainingQuantity: currentSize,
          pnl: 0,
          status: "failed",
          notes: `平仓失败: ${error.message}`,
        });
        
        return {
          success: false,
          message: `平仓失败: ${error.message}`,
        };
      }
      
      // 7. 计算盈亏
      const profitPercent = ((currentPrice - entryPrice) / entryPrice) * (side === "long" ? 1 : -1) * 100;
      const pnl = (profitPercent / 100) * leverage * (closeQuantity * entryPrice);
      
      // 8. 更新止损价（如果需要）
      if (newStopLossPrice) {
        logger.info(`更新止损价: ${stopLossPrice} -> ${newStopLossPrice}`);
        
        // 更新数据库
        await dbClient.execute({
          sql: "UPDATE positions SET stop_loss = ? WHERE symbol = ?",
          args: [newStopLossPrice, symbol],
        });
        
        // 更新交易所的止损订单
        try {
          // 先取消旧的止损止盈订单
          await exchangeClient.cancelPositionStopLoss(contract);
          
          // 设置新的止损价格
          const result = await exchangeClient.setPositionStopLoss(
            contract,
            newStopLossPrice,
            undefined // 不设置止盈
          );
          
          if (result.success) {
            logger.info(`止损价已更新: ${stopLossPrice} -> ${newStopLossPrice}, 实际=${result.actualStopLoss}`);
            
            // 更新数据库中的订单ID（如果有）
            if (result.stopLossOrderId) {
              await dbClient.execute({
                sql: "UPDATE positions SET sl_order_id = ? WHERE symbol = ?",
                args: [result.stopLossOrderId, symbol],
              });
            }
          } else {
            logger.error(`更新止损订单失败: ${result.message}`);
          }
        } catch (error: any) {
          logger.error(`更新止损订单失败: ${error.message}`);
        }
      }
      
      // 9. 更新数据库中的已平仓百分比
      const newClosedPercent = alreadyClosedPercent + closePercent;
      await dbClient.execute({
        sql: "UPDATE positions SET partial_close_percentage = ? WHERE symbol = ?",
        args: [newClosedPercent, symbol],
      });
      
      // 10. 记录分批止盈历史
      await recordPartialTakeProfit({
        symbol,
        stage: stageNum,
        rMultiple: currentR,
        triggerPrice: currentPrice,
        closePercent,
        closedQuantity: closeQuantity,
        remainingQuantity,
        pnl,
        newStopLossPrice,
        status: "completed",
        notes: `阶段${stageNum}完成：R=${currentR.toFixed(2)}, 平仓${closePercent}%, PnL=${pnl.toFixed(2)} USDT`,
      });
      
      // 11. 同时记录到通用平仓事件表（供 getCloseEvents 查询）
      try {
        // 估算手续费（开仓 + 平仓）
        const estimatedFee = Math.abs(pnl * 0.001); // 约 0.1% 的手续费估算
        
        // 计算盈亏百分比（含杠杆）
        const pnlPercent = entryPrice > 0 
          ? ((currentPrice - entryPrice) / entryPrice * 100 * (side === 'long' ? 1 : -1) * leverage)
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
            currentPrice,      // 使用当前价格作为退出价格
            closeQuantity,
            leverage,
            pnl,
            pnlPercent,
            estimatedFee,
            'partial_close',   // ⭐ 平仓原因：分批平仓
            'ai_decision',     // 触发类型：AI决策
            `partial_${symbol}_stage${stageNum}_${Date.now()}`, // 生成唯一订单ID
            getChinaTimeISO(),
            1,  // 已处理
          ],
        });
        
        logger.info(`📝 已记录分批平仓事件到 position_close_events 表: ${symbol} 阶段${stageNum}`);
      } catch (error: any) {
        logger.error(`记录分批平仓事件到 position_close_events 失败: ${error.message}`);
        // 不影响主流程，继续执行
      }
      
      // 12. 返回成功
      return {
        success: true,
        message: `✅ 阶段${stageNum}分批止盈完成`,
        stage: stageNum,
        currentR,
        closePercent,
        closedQuantity: closeQuantity,
        remainingQuantity,
        pnl: pnl.toFixed(2),
        newStopLossPrice: newStopLossPrice ? newStopLossPrice.toFixed(2) : undefined,
        totalClosedPercent: newClosedPercent,
      };
    } catch (error: any) {
      logger.error(`分批止盈执行失败: ${error.message}`);
      return {
        success: false,
        message: `分批止盈执行失败: ${error.message}`,
      };
    }
  },
});

/**
 * 检查分批止盈机会工具
 */
export const checkPartialTakeProfitOpportunityTool = createTool({
  name: "checkPartialTakeProfitOpportunity",
  description: `检查当前持仓是否达到分批止盈条件

会分析所有持仓，返回：
• 当前R倍数（风险倍数）
• 可以执行的阶段
• 已执行的阶段历史
• 下一步建议

适用场景：
• 每个交易周期检查一次
• 判断是否应该执行分批止盈
• 了解持仓的盈利状态

返回示例：
{
  "BTC": {
    "currentR": 1.5,
    "canExecuteStages": [1],
    "executedStages": [],
    "recommendation": "建议执行阶段1（1R平仓1/3）"
  }
}`,
  parameters: z.object({}),
  execute: async () => {
    const exchangeClient = getExchangeClient();
    
    try {
      // 获取所有持仓
      const allPositions = await exchangeClient.getPositions();
      const activePositions = allPositions.filter((p: any) => Math.abs(Number.parseFloat(p.size || "0")) > 0);
      
      if (activePositions.length === 0) {
        return {
          success: true,
          message: "当前没有持仓",
          opportunities: {},
        };
      }
      
      const opportunities: Record<string, any> = {};
      
      for (const position of activePositions) {
        const symbol = exchangeClient.extractSymbol(position.contract);
        const side: "long" | "short" = Number.parseFloat(position.size || "0") > 0 ? "long" : "short";
        const entryPrice = Number.parseFloat(position.entryPrice || "0");
        const currentPrice = Number.parseFloat(position.markPrice || "0");
        
        // 从数据库获取止损价
        const positionResult = await dbClient.execute({
          sql: "SELECT stop_loss FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
          args: [symbol],
        });
        
        if (positionResult.rows.length === 0 || !positionResult.rows[0].stop_loss) {
          opportunities[symbol] = {
            currentR: null,
            canExecuteStages: [],
            executedStages: [],
            recommendation: "持仓没有设置止损价，无法使用基于R倍数的分批止盈",
          };
          continue;
        }
        
        const stopLossPrice = Number.parseFloat(positionResult.rows[0].stop_loss as string);
        
        // 分析市场波动率
        const volatility = await analyzeMarketVolatility(symbol, "15m");
        
        // 计算R倍数
        const currentR = calculateRMultiple(entryPrice, currentPrice, stopLossPrice, side);
        
        // 计算动态调整后的R倍数要求
        const adjustedR1 = adjustRMultipleForVolatility(1, volatility);
        const adjustedR2 = adjustRMultipleForVolatility(2, volatility);
        const adjustedR3 = adjustRMultipleForVolatility(3, volatility);
        
        // 获取历史
        const history = await getPartialTakeProfitHistory(symbol);
        const executedStages = history.map((h) => h.stage);
        
        // 判断可执行阶段（使用动态调整后的R倍数）
        const canExecuteStages: number[] = [];
        let recommendation = "";
        
        // 获取当前持仓数量和合约信息，用于检查最小交易数量
        const currentSize = Math.abs(Number.parseFloat(position.size || "0"));
        const contract = exchangeClient.normalizeContract(symbol);
        const contractInfo = await exchangeClient.getContractInfo(contract);
        
        // 🔧 使用统一的数量精度处理函数
        const closePercent = 33.33;
        const quantityResult = calculatePartialCloseQuantity(
          currentSize, 
          closePercent, 
          contractInfo.orderSizeMin
        );
        
        const { 
          closeQuantity, 
          remainingQuantity, 
          decimalPlaces,
          meetsMinQuantity, 
          remainingMeetsMin 
        } = quantityResult;
        
        if (currentR >= adjustedR3 && !executedStages.includes(3)) {
          canExecuteStages.push(3);
          recommendation = `建议执行阶段3（${adjustedR3.toFixed(2)}R，${volatility.description}）`;
        }
        
        if (currentR >= adjustedR2 && !executedStages.includes(2) && executedStages.includes(1)) {
          if (meetsMinQuantity && remainingMeetsMin) {
            canExecuteStages.push(2);
            recommendation = `建议执行阶段2（${adjustedR2.toFixed(2)}R，${volatility.description}）`;
          } else if (!meetsMinQuantity) {
            recommendation = `达到阶段2条件但平仓数量 ${closeQuantity.toFixed(decimalPlaces)} 小于最小限制 ${contractInfo.orderSizeMin}，无法执行分批止盈`;
          } else {
            recommendation = `达到阶段2条件但剩余数量 ${remainingQuantity.toFixed(decimalPlaces)} 小于最小限制 ${contractInfo.orderSizeMin}，建议全部平仓`;
          }
        }
        
        if (currentR >= adjustedR1 && !executedStages.includes(1)) {
          if (meetsMinQuantity && remainingMeetsMin) {
            canExecuteStages.push(1);
            recommendation = `建议执行阶段1（${adjustedR1.toFixed(2)}R，${volatility.description}）`;
          } else if (!meetsMinQuantity) {
            recommendation = `达到阶段1条件但平仓数量 ${closeQuantity.toFixed(decimalPlaces)} 小于最小限制 ${contractInfo.orderSizeMin}，无法执行分批止盈`;
          } else {
            recommendation = `达到阶段1条件但剩余数量 ${remainingQuantity.toFixed(decimalPlaces)} 小于最小限制 ${contractInfo.orderSizeMin}，建议全部平仓`;
          }
        }
        
        if (canExecuteStages.length === 0 && recommendation === "") {
          if (currentR < adjustedR1) {
            recommendation = `当前R=${currentR.toFixed(2)}，未达到阶段1要求（${adjustedR1.toFixed(2)}R，${volatility.level}波动），继续持有`;
          } else if (executedStages.includes(3)) {
            recommendation = "所有阶段已完成，使用移动止损管理剩余仓位";
          } else {
            recommendation = "已执行当前R倍数对应的所有阶段";
          }
        }
        
        opportunities[symbol] = {
          currentR: Number.parseFloat(currentR.toFixed(2)),
          entryPrice,
          currentPrice,
          stopLossPrice,
          side,
          currentSize,
          closeQuantity: Number.parseFloat(closeQuantity.toFixed(decimalPlaces)),
          remainingQuantity: Number.parseFloat(remainingQuantity.toFixed(decimalPlaces)),
          minQuantity: contractInfo.orderSizeMin,
          meetsMinQuantity,
          remainingMeetsMin,
          decimalPlaces,
          volatility: {
            level: volatility.level,
            atrPercent: volatility.atrPercent,
            adjustmentFactor: volatility.adjustmentFactor,
            description: volatility.description,
          },
          adjustedThresholds: {
            stage1: Number.parseFloat(adjustedR1.toFixed(2)),
            stage2: Number.parseFloat(adjustedR2.toFixed(2)),
            stage3: Number.parseFloat(adjustedR3.toFixed(2)),
          },
          canExecuteStages,
          executedStages,
          recommendation,
        };
      }
      
      return {
        success: true,
        message: `检查了 ${activePositions.length} 个持仓的分批止盈机会`,
        opportunities,
      };
    } catch (error: any) {
      logger.error(`检查分批止盈机会失败: ${error.message}`);
      return {
        success: false,
        message: `检查失败: ${error.message}`,
      };
    }
  },
});

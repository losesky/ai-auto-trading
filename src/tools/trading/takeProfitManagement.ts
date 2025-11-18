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
  calculatePartialCloseQuantity,
  getDecimalPlacesBySymbol
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
 * 🔧 支持多种symbol格式查询（兼容不同交易所和历史数据）
 */
async function getPartialTakeProfitHistory(symbol: string): Promise<any[]> {
  const exchangeClient = getExchangeClient();
  const contract = exchangeClient.normalizeContract(symbol);
  
  // 尝试简化符号查询（标准格式）
  let result = await dbClient.execute({
    sql: `
      SELECT * FROM partial_take_profit_history
      WHERE symbol = ? AND status = 'completed'
      ORDER BY timestamp DESC
    `,
    args: [symbol],
  });
  
  // 如果没找到，尝试Binance格式（无下划线）
  if (result.rows.length === 0 && contract !== symbol) {
    result = await dbClient.execute({
      sql: `
        SELECT * FROM partial_take_profit_history
        WHERE symbol = ? AND status = 'completed'
        ORDER BY timestamp DESC
      `,
      args: [contract],
    });
  }
  
  // 如果还没找到，尝试Gate.io格式（带下划线）
  if (result.rows.length === 0) {
    const gateFormat = symbol + '_USDT';
    result = await dbClient.execute({
      sql: `
        SELECT * FROM partial_take_profit_history
        WHERE symbol = ? AND status = 'completed'
        ORDER BY timestamp DESC
      `,
      args: [gateFormat],
    });
  }
  
  return result.rows as any[];
}

/**
 * 记录分批止盈执行
 */
async function recordPartialTakeProfit(data: {
  symbol: string;
  side: "long" | "short";
  stage: number;
  rMultiple: number;
  triggerPrice: number;
  closePercent: number;
  closedQuantity: number;
  remainingQuantity: number;
  pnl: number;
  newStopLossPrice?: number;
  orderId?: string;
  status: "completed" | "failed";
  notes?: string;
}): Promise<void> {
  await dbClient.execute({
    sql: `
      INSERT INTO partial_take_profit_history (
        symbol, side, stage, r_multiple, trigger_price, close_percent,
        closed_quantity, remaining_quantity, pnl, new_stop_loss_price,
        order_id, status, notes, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      data.symbol,
      data.side,
      data.stage,
      data.rMultiple,
      data.triggerPrice,
      data.closePercent,
      data.closedQuantity,
      data.remainingQuantity,
      data.pnl,
      data.newStopLossPrice || null,
      data.orderId || null,
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
      // 🔧 关键修复：数据库统一使用简化符号（BTC、ETH等），而非完整合约名
      // 这样可以在 Gate.io 和 Binance 之间保持一致性
      let dbSymbol = symbol;  // 使用简化符号（BTC、ETH等）
      
      logger.info(`🔍 开始执行分批止盈: symbol=${symbol}, contract=${contract}, dbSymbol=${dbSymbol}, stage=${stage}`);
      
      // ⚡ 30秒内去重保护：防止健康检查和AI Agent并发冲突
      const requestedStage = Number.parseInt(stage, 10);
      const cutoffTime = new Date(Date.now() - 30000).toISOString();
      const recentCheck = await dbClient.execute({
        sql: `SELECT COUNT(*) as count FROM partial_take_profit_history 
              WHERE symbol LIKE ? AND stage = ? AND timestamp > ?`,
        args: [`%${symbol}%`, requestedStage, cutoffTime]
      });
      
      const recentExecutions = Number(recentCheck.rows[0]?.count || 0);
      if (recentExecutions > 0) {
        logger.info(`⏭️ ${symbol} Stage${stage} 最近30秒内已执行，跳过（去重保护）`);
        return {
          success: false,
          message: `${symbol} Stage${stage} 最近30秒内已执行，跳过以避免重复`,
          reason: 'recently_executed'
        };
      }
      
      // 1. 获取当前持仓（优先从交易所，失败则从数据库）
      let position: any = null;
      let currentSize = 0;
      let side: "long" | "short" = "long";
      let entryPrice = 0;
      let currentPrice = 0;
      let leverage = 1;
      
      try {
        const allPositions = await exchangeClient.getPositions();
        position = allPositions.find((p: any) => {
          const posSymbol = exchangeClient.extractSymbol(p.contract);
          return posSymbol === symbol && Math.abs(Number.parseFloat(p.size || "0")) > 0;
        });
        
        if (position) {
          currentSize = Math.abs(Number.parseFloat(position.size || "0"));
          side = Number.parseFloat(position.size || "0") > 0 ? "long" : "short";
          entryPrice = Number.parseFloat(position.entryPrice || "0");
          currentPrice = Number.parseFloat(position.markPrice || "0");
          leverage = Number.parseInt(position.leverage || "1", 10);
        }
      } catch (error) {
        logger.warn(`无法从交易所获取${symbol}持仓，尝试从数据库读取`);
      }
      
      // 🔧 无论持仓从哪里获取，都需要确定数据库中的symbol格式
      // 尝试多种格式查询数据库（兼容不同交易所和测试数据）
      // 1. 简化符号（标准格式）：ETH
      // 2. Binance格式（无下划线）：ETHUSDT
      // 3. Gate.io格式（带下划线）：ETH_USDT
      
      let dbPosition = await dbClient.execute({
        sql: "SELECT * FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
        args: [symbol],
      });
      
      // 如果没找到，尝试Binance格式（ETHUSDT）
      if (dbPosition.rows.length === 0) {
        dbPosition = await dbClient.execute({
          sql: "SELECT * FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
          args: [contract],
        });
        
        if (dbPosition.rows.length > 0) {
          logger.info(`使用Binance格式 ${contract} 找到持仓记录`);
          dbSymbol = contract;
        }
      }
      
      // 如果还没找到，尝试Gate.io格式（ETH_USDT）
      if (dbPosition.rows.length === 0) {
        const gateFormat = symbol + '_USDT';
        dbPosition = await dbClient.execute({
          sql: "SELECT * FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
          args: [gateFormat],
        });
        
        if (dbPosition.rows.length > 0) {
          logger.info(`使用Gate.io格式 ${gateFormat} 找到持仓记录`);
          dbSymbol = gateFormat;
        }
      }
      
      if (dbPosition.rows.length === 0) {
        return {
          success: false,
          message: `未找到 ${symbol} 的持仓（已尝试格式: ${symbol}, ${contract}, ${symbol}_USDT）`,
        };
      }
      
      // 如果交易所无持仓，从数据库读取
      if (!position) {
        const row = dbPosition.rows[0];
        currentSize = Math.abs(Number.parseFloat(row.quantity as string || "0"));
        side = row.side as "long" | "short";
        entryPrice = Number.parseFloat(row.entry_price as string || "0");
        currentPrice = Number.parseFloat(row.current_price as string || "0");
        leverage = Number.parseInt(row.leverage as string || "1", 10);
        position = row; // 使用数据库记录
      }
      
      // 2. 从数据库获取止损价
      const positionResult = await dbClient.execute({
        sql: "SELECT stop_loss, partial_close_percentage FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
        args: [dbSymbol],
      });
      
      if (positionResult.rows.length === 0) {
        return {
          success: false,
          message: `${symbol} 持仓不存在或已关闭`,
        };
      }
      
      const rawStopLoss = positionResult.rows[0].stop_loss;
      const stopLossPrice = Number.parseFloat(rawStopLoss as string || "0");
      
      // ⚠️ 严格验证止损价是否有效
      if (!rawStopLoss || Number.isNaN(stopLossPrice) || stopLossPrice <= 0) {
        logger.warn(`${symbol} 止损价无效: rawValue=${rawStopLoss}, parsedValue=${stopLossPrice}`);
        return {
          success: false,
          message: `${symbol} 持仓没有设置止损价，无法使用基于R倍数的分批止盈。请先设置止损。`,
        };
      }
      
      const alreadyClosedPercent = Number.parseFloat(positionResult.rows[0].partial_close_percentage as string || "0");
      
      // 🔧 如果已执行过分批止盈，需要从历史记录恢复原始止损价来计算R倍数
      // 因为止损价已经移动到成本价或1R位置，直接使用当前止损价会导致R倍数计算错误
      let originalStopLoss = stopLossPrice;
      const takeProfitHistory = await getPartialTakeProfitHistory(dbSymbol);
      if (takeProfitHistory.length > 0) {
        // 从最早的记录推算原始止损价
        // Stage1: 止损移至成本价，newStopLoss = entryPrice
        // Stage2: 止损移至1R，newStopLoss = entryPrice + R * (entryPrice - originalStopLoss)
        const firstStage = takeProfitHistory.sort((a, b) => a.stage - b.stage)[0];
        if (firstStage.stage === 1 && firstStage.new_stop_loss_price) {
          // Stage1后止损=成本价，可以使用当前止损作为入场价参考
          // 通过triggerPrice反推：triggerPrice = entry + 1R = entry + (entry - originalStopLoss)
          // 所以: originalStopLoss = 2 * entry - triggerPrice
          originalStopLoss = 2 * entryPrice - firstStage.trigger_price;
          logger.info(`从Stage1历史恢复原始止损价: ${originalStopLoss.toFixed(2)} (入场=${entryPrice}, Stage1触发=${firstStage.trigger_price})`);
        }
      }
      
      // 3. 分析市场波动率（用于动态调整R倍数）
      const volatility = await analyzeMarketVolatility(symbol, "15m");
      
      logger.info(`${symbol} 波动率分析: ${volatility.description} (ATR=${volatility.atrPercent}%, 调整系数=${volatility.adjustmentFactor}x)`);
      
      // 4. 计算当前R倍数（使用原始止损价）
      const currentR = calculateRMultiple(entryPrice, currentPrice, originalStopLoss, side);
      
      logger.info(`${symbol} 当前状态: 入场=${entryPrice}, 当前=${currentPrice}, 原始止损=${originalStopLoss.toFixed(2)}, 当前止损=${stopLossPrice.toFixed(2)}, R=${currentR.toFixed(2)}`);
      
      // 5. 检查分批止盈历史
      const history = await getPartialTakeProfitHistory(dbSymbol);
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
        
        // 🔧 止损移至 1R 位置（使用原始止损价计算，不受波动率影响）
        newStopLossPrice = calculateTargetPrice(entryPrice, originalStopLoss, 1, side);
        
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
        
        // 阶段3不执行平仓,只记录启用移动止损
        await recordPartialTakeProfit({
          symbol: dbSymbol,
          side,
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
      
      // 🔧 Gate.io合约以"张"为单位，需要转换
      // quanto_multiplier是每张合约的币数（如0.0001 ETH/张）
      const quantoMultiplier = Number.parseFloat(contractInfo.quantoMultiplier || contractInfo.quanto_multiplier || "1");
      
      // 转换为合约数量（张数）
      const currentSizeInContracts = quantoMultiplier < 1 ? currentSize / quantoMultiplier : currentSize;
      
      const quantityResult = calculatePartialCloseQuantity(currentSizeInContracts, closePercent, minQty);
      
      if (quantityResult.error) {
        return {
          success: false,
          message: quantityResult.error,
        };
      }
      
      const { closeQuantity, remainingQuantity, decimalPlaces, meetsMinQuantity, remainingMeetsMin } = quantityResult;
      
      logger.info(`准备平仓: symbol=${symbol}, closePercent=${closePercent}%, 持仓=${currentSizeInContracts.toFixed(decimalPlaces)}张, 平仓=${closeQuantity.toFixed(decimalPlaces)}张, 剩余=${remainingQuantity.toFixed(decimalPlaces)}张, 精度=${decimalPlaces}位`);
      
      // 🔧 将张数转换回实际数量（ETH）
      const closeQuantityInCoin = quantoMultiplier < 1 ? closeQuantity * quantoMultiplier : closeQuantity;
      const remainingQuantityInCoin = quantoMultiplier < 1 ? remainingQuantity * quantoMultiplier : remainingQuantity;
      
      // 检查平仓数量是否满足最小交易数量要求
      if (!meetsMinQuantity) {
        return {
          success: false,
          message: `分批平仓数量 ${closeQuantity.toFixed(decimalPlaces)}张 小于最小交易数量 ${minQty}张，无法执行。建议增加持仓规模或调整平仓比例。`,
          closeQuantity: closeQuantityInCoin,
          minQuantity: minQty,
          currentSize,
          closePercent,
          decimalPlaces,
        };
      }
      
      // 检查剩余数量是否满足最小持仓要求（如果不为0的话）
      if (!remainingMeetsMin) {
        logger.warn(`分批平仓后剩余数量 ${remainingQuantity.toFixed(decimalPlaces)}张 小于最小交易数量 ${minQty}张`);
        return {
          success: false,
          message: `分批平仓后剩余数量 ${remainingQuantity.toFixed(decimalPlaces)}张 小于最小交易数量 ${minQty}张，建议调整平仓比例或全部平仓`,
          closeQuantity: closeQuantityInCoin,
          remainingQuantity: remainingQuantityInCoin,
          minQuantity: minQty,
          suggestion: "建议全部平仓或增加持仓规模",
        };
      }
      
      // 执行平仓（使用市价单平仓）
      let closeOrderResponse;
      
      // 🔧 检测测试模式，避免真实交易
      const isTestMode = process.env.TEST_MODE === 'true';
      
      if (isTestMode) {
        logger.warn(`⚠️ 测试模式：跳过真实平仓操作，仅模拟数据更新`);
        
        // 模拟订单响应
        closeOrderResponse = {
          id: `TEST_CLOSE_${Date.now()}`,
          contract,
          size: side === "long" ? -closeQuantityInCoin : closeQuantityInCoin,
          price: currentPrice.toString(),
          fill_price: currentPrice.toString(),
          status: 'filled',
        };
      } else {
        // 真实交易模式
        try {
          const closeSide = side === "long" ? "sell" : "buy";
          // 平仓时的数量需要根据方向确定正负
          // 对于 long 仓位，平仓数量应该是负数（卖出）
          // 对于 short 仓位，平仓数量应该是正数（买入）
          const closeSize = side === "long" ? -closeQuantityInCoin : closeQuantityInCoin;
          
          closeOrderResponse = await exchangeClient.placeOrder({
            contract,
            size: closeSize,
            price: 0, // 市价单，price设为0
            reduceOnly: true,
          });
          
          const decimalPlaces = getDecimalPlacesBySymbol(symbol, currentPrice);
          logger.info(`✅ 分批平仓订单已提交: ${symbol} ${closeQuantityInCoin.toFixed(decimalPlaces)} @ 市价, 订单ID=${closeOrderResponse.id}`);
        } catch (error: any) {
          await recordPartialTakeProfit({
            symbol: dbSymbol,
            side,
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
      }
      
      // 7. 计算盈亏和手续费
      // ⚠️ 重要：使用 exchangeClient.calculatePnl 计算正确的盈亏，不要手动乘以杠杆！
      // 杠杆只影响保证金和盈亏百分比，不影响绝对盈亏金额
      const pnl = await exchangeClient.calculatePnl(
        entryPrice,
        currentPrice,
        closeQuantityInCoin,
        side,
        contract
      );
      
      // 估算手续费（市价单taker费率约0.05%）
      // 对于Gate.io的币本位合约，需要考虑quanto multiplier
      let estimatedFee: number;
      if (contract.includes('_USD')) {
        // Gate.io币本位合约
        const { getQuantoMultiplier } = await import('../../utils/contractUtils.js');
        const quantoMultiplier = await getQuantoMultiplier(contract);
        // 手续费 = 名义价值 * 费率
        estimatedFee = currentPrice * closeQuantityInCoin * quantoMultiplier * 0.0005;
      } else {
        // Binance USDT合约
        estimatedFee = Math.abs(closeQuantityInCoin * currentPrice * 0.0005);
      }
      
      // 净盈亏 = 毛盈亏 - 手续费
      const netPnl = pnl - estimatedFee;
      
      // 8. 记录平仓交易到 trades 表（⭐ 关键修复）
      try {
        await dbClient.execute({
          sql: `INSERT INTO trades 
                (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            closeOrderResponse.id,
            dbSymbol,  // ⭐ 使用完整符号名称（ETH_USDT）而不是短名称（ETH）
            side,
            'close',
            currentPrice,
            closeQuantityInCoin,
            leverage,
            netPnl,
            estimatedFee,
            getChinaTimeISO(),
            'filled'
          ]
        });
        
        logger.info(`✅ 分批平仓交易已记录到 trades 表: ${symbol} ${closeQuantityInCoin.toFixed(decimalPlaces)} @ ${currentPrice}, PnL=${netPnl.toFixed(2)} USDT`);
      } catch (error: any) {
        logger.error(`记录分批平仓交易到 trades 表失败: ${error.message}`);
        // 不影响主流程，继续执行
      }
      
      // 9. 更新条件单（⭐ 关键：分批平仓后必须更新条件单数量）
      // 即使止损价格不变，也需要重新设置条件单，因为持仓数量改变了
      logger.info(`${symbol} 分批平仓后更新条件单，剩余持仓: ${remainingQuantityInCoin.toFixed(decimalPlaces)}`);
      
      // 从数据库获取当前的止损、止盈价格和开仓订单ID
      const posResult = await dbClient.execute({
        sql: "SELECT stop_loss, profit_target, entry_order_id FROM positions WHERE symbol = ?",
        args: [dbSymbol],
      });
      
      const currentStopLoss = posResult.rows.length > 0 
        ? Number.parseFloat(posResult.rows[0].stop_loss as string || "0")
        : 0;
      const profitTarget = posResult.rows.length > 0 
        ? Number.parseFloat(posResult.rows[0].profit_target as string || "0")
        : 0;
      const entryOrderId = posResult.rows.length > 0 && posResult.rows[0].entry_order_id
        ? posResult.rows[0].entry_order_id as string
        : null;
      
      // 确定最终的止损价格（如果有新止损价则使用新的，否则使用当前的）
      const finalStopLoss = newStopLossPrice || currentStopLoss;
      
      // 如果有新止损价，更新数据库
      if (newStopLossPrice) {
        logger.info(`更新止损价: ${currentStopLoss} -> ${newStopLossPrice}`);
        await dbClient.execute({
          sql: "UPDATE positions SET stop_loss = ? WHERE symbol = ?",
          args: [newStopLossPrice, dbSymbol],
        });
      }
      
      // 更新交易所的条件单（会自动使用最新的持仓数量）
      if (!isTestMode) {
        try {
          // ⭐ 先在数据库中标记旧条件单为已取消
          await dbClient.execute({
            sql: "UPDATE price_orders SET status = 'cancelled', updated_at = ? WHERE symbol = ? AND status = 'active'",
            args: [getChinaTimeISO(), dbSymbol],
          });
          logger.info(`✅ 数据库中的旧条件单已标记为取消: ${symbol}`);
          
          // 取消交易所的旧条件单
          await exchangeClient.cancelPositionStopLoss(contract);
          logger.info(`✅ 交易所的旧条件单已取消: ${symbol}`);
          
          // 重新设置条件单，使用最新的持仓数量
          const result = await exchangeClient.setPositionStopLoss(
            contract,
            finalStopLoss > 0 ? finalStopLoss : undefined,
            profitTarget > 0 ? profitTarget : undefined
          );
        
          if (result.success) {
            logger.info(`✅ 条件单已更新: 止损=${result.actualStopLoss || 'N/A'}, 止盈=${result.actualTakeProfit || 'N/A'}`);
            
            // ⭐ 更新数据库中的持仓数量
            await dbClient.execute({
              sql: "UPDATE positions SET quantity = ? WHERE symbol = ?",
              args: [remainingQuantityInCoin, dbSymbol],
            });
            
            // 更新数据库中的订单ID
            if (result.stopLossOrderId) {
              await dbClient.execute({
                sql: "UPDATE positions SET sl_order_id = ? WHERE symbol = ?",
                args: [result.stopLossOrderId, dbSymbol],
              });
              
              // ⭐ 在 price_orders 表中记录新的止损条件单（使用开仓订单ID）
              await dbClient.execute({
                sql: `INSERT INTO price_orders 
                      (order_id, symbol, side, type, trigger_price, quantity, status, position_order_id, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                  result.stopLossOrderId,
                  symbol,
                  side,
                  'stop_loss',
                  result.actualStopLoss || 0,
                  remainingQuantityInCoin,
                  'active',
                  entryOrderId,  // 使用开仓订单ID而不是平仓订单ID
                  getChinaTimeISO(),
                ],
              });
            }
            
            if (result.takeProfitOrderId) {
              await dbClient.execute({
                sql: "UPDATE positions SET tp_order_id = ? WHERE symbol = ?",
                args: [result.takeProfitOrderId, dbSymbol],
              });
              
              // ⭐ 在 price_orders 表中记录新的止盈条件单（使用开仓订单ID）
              if (result.actualTakeProfit && result.actualTakeProfit > 0) {
                await dbClient.execute({
                  sql: `INSERT INTO price_orders 
                        (order_id, symbol, side, type, trigger_price, quantity, status, position_order_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  args: [
                    result.takeProfitOrderId,
                    symbol,
                    side,
                    'take_profit',
                    result.actualTakeProfit,
                    remainingQuantityInCoin,
                    'active',
                    entryOrderId,  // 使用开仓订单ID而不是平仓订单ID
                    getChinaTimeISO(),
                  ],
                });
              }
            }
          } else {
            logger.error(`❌ 更新条件单失败: ${result.message}`);
          }
        } catch (error: any) {
          logger.error(`❌ 更新条件单异常: ${error.message}`);
        }
      } else {
        logger.warn(`⚠️ 测试模式：跳过更新交易所条件单`);
        
        // ⭐ 测试模式：仍需更新数据库中的条件单和持仓数量
        // 1. 标记旧条件单为已取消
        await dbClient.execute({
          sql: "UPDATE price_orders SET status = 'cancelled', updated_at = ? WHERE symbol = ? AND status = 'active'",
          args: [getChinaTimeISO(), dbSymbol],
        });
        
        // 2. 插入新的止损条件单（使用新的止损价和剩余数量，使用开仓订单ID）
        if (finalStopLoss > 0) {
          const newSlOrderId = `SL_TEST_${Date.now()}`;
          await dbClient.execute({
            sql: `INSERT INTO price_orders 
                  (order_id, symbol, side, type, trigger_price, quantity, status, position_order_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              newSlOrderId,
              dbSymbol,
              side,
              'stop_loss',
              finalStopLoss,
              remainingQuantityInCoin,
              'active',
              entryOrderId,  // 使用开仓订单ID而不是平仓订单ID
              getChinaTimeISO(),
            ],
          });
          
          // 更新positions表的sl_order_id
          await dbClient.execute({
            sql: "UPDATE positions SET sl_order_id = ? WHERE symbol = ?",
            args: [newSlOrderId, dbSymbol],
          });
        }
        
        // 3. 插入新的止盈条件单（使用剩余数量，使用开仓订单ID）
        if (profitTarget > 0) {
          const newTpOrderId = `TP_TEST_${Date.now()}`;
          await dbClient.execute({
            sql: `INSERT INTO price_orders 
                  (order_id, symbol, side, type, trigger_price, quantity, status, position_order_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              newTpOrderId,
              dbSymbol,
              side,
              'take_profit',
              profitTarget,
              remainingQuantityInCoin,
              'active',
              entryOrderId,  // 使用开仓订单ID而不是平仓订单ID
              getChinaTimeISO(),
            ],
          });
          
          // 更新positions表的tp_order_id
          await dbClient.execute({
            sql: "UPDATE positions SET tp_order_id = ? WHERE symbol = ?",
            args: [newTpOrderId, dbSymbol],
          });
        }
      }
      
      // 10. 更新数据库中的持仓数量、已平仓百分比、未实现盈亏
      const newClosedPercent = alreadyClosedPercent + closePercent;
      
      // ⭐ 关键：重新计算剩余持仓的未实现盈亏
      // unrealized_pnl = (current_price - entry_price) * remaining_quantity * direction
      // 对于 Gate.io 币本位合约，还需要乘以 quanto_multiplier
      let updatedUnrealizedPnl: number;
      try {
        updatedUnrealizedPnl = await exchangeClient.calculatePnl(
          entryPrice,
          currentPrice,
          remainingQuantityInCoin,
          side,
          contract
        );
        logger.info(`✅ 重新计算未实现盈亏: ${updatedUnrealizedPnl.toFixed(2)} USDT (剩余持仓: ${remainingQuantityInCoin.toFixed(decimalPlaces)})`);
      } catch (error: any) {
        logger.warn(`计算未实现盈亏失败，使用简化公式: ${error.message}`);
        // 后备方案：简化计算（不考虑 quanto_multiplier）
        const priceDiff = currentPrice - entryPrice;
        const direction = side === 'long' ? 1 : -1;
        updatedUnrealizedPnl = priceDiff * remainingQuantityInCoin * direction;
      }
      
      await dbClient.execute({
        sql: "UPDATE positions SET quantity = ?, partial_close_percentage = ?, unrealized_pnl = ?, current_price = ? WHERE symbol = ?",
        args: [remainingQuantityInCoin, newClosedPercent, updatedUnrealizedPnl, currentPrice, dbSymbol],
      });
      
      // 10. 记录分批止盈历史
      await recordPartialTakeProfit({
        symbol: dbSymbol,
        side,
        stage: stageNum,
        rMultiple: currentR,
        triggerPrice: currentPrice,
        closePercent,
        closedQuantity: closeQuantityInCoin,
        remainingQuantity: remainingQuantityInCoin,
        pnl: netPnl,
        newStopLossPrice,
        orderId: closeOrderResponse.id,
        status: "completed",
        notes: `阶段${stageNum}完成：R=${currentR.toFixed(2)}, 平仓${closePercent}%, PnL=${netPnl.toFixed(2)} USDT`,
      });
      
      // 11. 同时记录到通用平仓事件表（供 getCloseEvents 查询）
      try {
        // 计算盈亏百分比（含杠杆）
        const pnlPercent = entryPrice > 0 
          ? ((currentPrice - entryPrice) / entryPrice * 100 * (side === 'long' ? 1 : -1) * leverage)
          : 0;
        
        await dbClient.execute({
          sql: `INSERT INTO position_close_events 
                (symbol, side, entry_price, close_price, quantity, leverage, 
                 pnl, pnl_percent, fee, close_reason, trigger_type, order_id, 
                 created_at, processed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            dbSymbol,  // ⭐ 使用完整符号名称（ETH_USDT）而不是短名称（ETH）
            side,
            entryPrice,
            currentPrice,      // 使用当前价格作为退出价格
            closeQuantityInCoin,
            leverage,
            netPnl,
            pnlPercent,
            estimatedFee,
            'partial_close',   // ⭐ 平仓原因：分批平仓
            'ai_decision',     // 触发类型：AI决策
            closeOrderResponse.id, // ⭐ 使用真实的交易订单ID
            getChinaTimeISO(),
            1,  // 已处理
          ],
        });
        
        logger.info(`📝 已记录分批平仓事件到 position_close_events 表: ${symbol} 阶段${stageNum}, 订单ID=${closeOrderResponse.id}`);
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
        closedQuantity: closeQuantityInCoin,
        remainingQuantity: remainingQuantityInCoin,
        pnl: netPnl.toFixed(2),
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
• 止损价格（stopLossPrice）和是否已设置止损（hasStopLoss）
• 可以执行的阶段
• 已执行的阶段历史
• 下一步建议

适用场景：
• 每个交易周期检查一次
• 判断是否应该执行分批止盈
• 了解持仓的盈利状态和止损设置情况

返回示例（已设置止损）：
{
  "BTC": {
    "currentR": 1.5,
    "stopLossPrice": 95000,
    "hasStopLoss": true,
    "canExecuteStages": [1],
    "executedStages": [],
    "recommendation": "建议执行阶段1（1R平仓1/3）"
  }
}

返回示例（未设置止损）：
{
  "BTC": {
    "currentR": null,
    "stopLossPrice": null,
    "hasStopLoss": false,
    "canExecuteStages": [],
    "executedStages": [],
    "recommendation": "❌ 持仓没有设置止损价，无法使用基于R倍数的分批止盈"
  }
}`,
  parameters: z.object({}),
  execute: async () => {
    const exchangeClient = getExchangeClient();
    
    try {
      // 🔧 先从数据库获取持仓，如果交易所无持仓则使用数据库数据（支持测试模式）
      let activePositions: any[] = [];
      
      try {
        const exchangePositions = await exchangeClient.getPositions();
        activePositions = exchangePositions.filter((p: any) => Math.abs(Number.parseFloat(p.size || "0")) > 0);
      } catch (error) {
        logger.warn("无法从交易所获取持仓，尝试从数据库读取");
      }
      
      // 如果交易所无持仓，从数据库读取
      if (activePositions.length === 0) {
        const dbPositions = await dbClient.execute({
          sql: "SELECT * FROM positions WHERE quantity != 0",
          args: [],
        });
        
        if (dbPositions.rows.length === 0) {
          return {
            success: true,
            message: "当前没有持仓",
            opportunities: {},
          };
        }
        
        // 将数据库持仓转换为交易所格式
        activePositions = dbPositions.rows.map((row: any) => ({
          contract: row.symbol,
          size: row.side === "long" ? row.quantity : -row.quantity,
          entryPrice: row.entry_price,
          markPrice: row.current_price,
          leverage: row.leverage,
        }));
      }
      
      const opportunities: Record<string, any> = {};
      
      for (const position of activePositions) {
        const symbol = exchangeClient.extractSymbol(position.contract);
        const side: "long" | "short" = Number.parseFloat(position.size || "0") > 0 ? "long" : "short";
        const entryPrice = Number.parseFloat(position.entryPrice || "0");
        const currentPrice = Number.parseFloat(position.markPrice || "0");
        
        // 🔧 从数据库获取止损价
        // ⚠️ 数据库应该使用简化符号（BTC、ETH等），这样可以在两个交易所间保持一致
        // 但为了兼容历史数据，我们先尝试简化符号，如果找不到再尝试完整合约名
        
        logger.info(`🔍 检查持仓止损: contract=${position.contract}, extractedSymbol=${symbol}`);
        
        // 优先使用简化符号查询（标准格式）
        let positionResult = await dbClient.execute({
          sql: "SELECT stop_loss FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
          args: [symbol],
        });
        
        // 如果没找到，尝试使用完整合约名查询（兼容旧数据）
        if (positionResult.rows.length === 0) {
          positionResult = await dbClient.execute({
            sql: "SELECT stop_loss FROM positions WHERE symbol = ? AND quantity != 0 LIMIT 1",
            args: [position.contract],
          });
          logger.info(`🔍 数据库查询结果（完整格式）: contract=${position.contract}, rows=${positionResult.rows.length}, stop_loss=${positionResult.rows[0]?.stop_loss || 'NULL'}`);
        } else {
          logger.info(`🔍 数据库查询结果（简化格式）: symbol=${symbol}, rows=${positionResult.rows.length}, stop_loss=${positionResult.rows[0]?.stop_loss || 'NULL'}`);
        }
        
        let stopLossPrice = 0;
        let hasStopLoss = false;
        
        if (positionResult.rows.length > 0 && positionResult.rows[0].stop_loss) {
          const rawStopLoss = positionResult.rows[0].stop_loss;
          stopLossPrice = Number.parseFloat(rawStopLoss as string);
          
          // ⚠️ 关键修复：检查止损价是否为有效数值（不是0、NaN或空）
          if (!Number.isNaN(stopLossPrice) && stopLossPrice > 0) {
            hasStopLoss = true;
            logger.info(`✅ ${symbol} 找到有效止损价: ${stopLossPrice}`);
          } else {
            logger.warn(`❌ ${symbol} 止损价无效: rawValue=${rawStopLoss}, parsedValue=${stopLossPrice}`);
          }
        } else {
          logger.warn(`❌ ${symbol} 未找到止损价: rows=${positionResult.rows.length}`);
        }
        
        // 如果没有止损价，返回基本信息但标注无法使用分批止盈
        if (!hasStopLoss) {
          opportunities[symbol] = {
            currentR: null,
            entryPrice,
            currentPrice,
            stopLossPrice: null,
            side,
            currentSize: Math.abs(Number.parseFloat(position.size || "0")),
            canExecuteStages: [],
            executedStages: [],
            recommendation: "❌ 持仓没有设置止损价，无法使用基于R倍数的分批止盈",
            hasStopLoss: false,
          };
          continue;
        }
        
        // 🔧 使用symbol作为数据库查询的实际键（已兼容两种格式）
        const actualDbSymbol = symbol;
        
        // 🔧 如果已执行过分批止盈，恢复原始止损价来计算R倍数
        let originalStopLoss = stopLossPrice;
        const takeProfitHistory = await getPartialTakeProfitHistory(actualDbSymbol);
        if (takeProfitHistory.length > 0) {
          const firstStage = takeProfitHistory.sort((a, b) => a.stage - b.stage)[0];
          if (firstStage.stage === 1 && firstStage.trigger_price) {
            originalStopLoss = 2 * entryPrice - firstStage.trigger_price;
          }
        }
        
        // 分析市场波动率
        const volatility = await analyzeMarketVolatility(symbol, "15m");
        
        // 计算R倍数（使用原始止损价）
        const currentR = calculateRMultiple(entryPrice, currentPrice, originalStopLoss, side);
        
        // 计算动态调整后的R倍数要求
        const adjustedR1 = adjustRMultipleForVolatility(1, volatility);
        const adjustedR2 = adjustRMultipleForVolatility(2, volatility);
        const adjustedR3 = adjustRMultipleForVolatility(3, volatility);
        
        // 获取历史（使用实际的数据库符号）
        const history = await getPartialTakeProfitHistory(actualDbSymbol);
        const executedStages = history.map((h) => h.stage);
        
        // 判断可执行阶段（使用动态调整后的R倍数）
        const canExecuteStages: number[] = [];
        let recommendation = "";
        
        // 获取当前持仓数量和合约信息，用于检查最小交易数量
        const currentSize = Math.abs(Number.parseFloat(position.size || "0"));
        const contract = exchangeClient.normalizeContract(symbol);
        const contractInfo = await exchangeClient.getContractInfo(contract);
        
        // 🔧 Gate.io合约以"张"为单位，需要转换
        const quantoMultiplier = Number.parseFloat(contractInfo.quantoMultiplier || contractInfo.quanto_multiplier || "1");
        const currentSizeInContracts = quantoMultiplier < 1 ? currentSize / quantoMultiplier : currentSize;
        
        // 🔧 使用统一的数量精度处理函数
        const closePercent = 33.33;
        const quantityResult = calculatePartialCloseQuantity(
          currentSizeInContracts, 
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
          // 根据已执行的阶段，给出下一阶段的建议
          if (executedStages.includes(3)) {
            recommendation = "所有阶段已完成，使用移动止损管理剩余仓位";
          } else if (executedStages.includes(2)) {
            recommendation = `当前R=${currentR.toFixed(2)}，阶段1-2已完成，未达到阶段3要求（${adjustedR3.toFixed(2)}R，${volatility.level}波动），继续持有`;
          } else if (executedStages.includes(1)) {
            recommendation = `当前R=${currentR.toFixed(2)}，阶段1已完成，未达到阶段2要求（${adjustedR2.toFixed(2)}R，${volatility.level}波动），继续持有`;
          } else if (currentR < adjustedR1) {
            recommendation = `当前R=${currentR.toFixed(2)}，未达到阶段1要求（${adjustedR1.toFixed(2)}R，${volatility.level}波动），继续持有`;
          } else {
            recommendation = "已执行当前R倍数对应的所有阶段";
          }
        }
        
        opportunities[symbol] = {
          currentR: Number.parseFloat(currentR.toFixed(2)),
          entryPrice,
          currentPrice,
          stopLossPrice,
          hasStopLoss: true,
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
      
      // 🔧 添加详细日志输出
      logger.info(`📋 分批止盈检查完成，返回结果:`);
      logger.info(JSON.stringify({ success: true, message: `检查了 ${activePositions.length} 个持仓的分批止盈机会`, opportunities }, null, 2));
      
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

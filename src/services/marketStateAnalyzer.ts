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
 * 市场状态识别服务
 * 
 * 功能：
 * 1. 策略自适应时间框架选择（根据交易策略自动匹配最优时间框架）
 * 2. 趋势强度判断（基于主框架的EMA20/EMA50关系）
 * 3. 超买超卖判断（基于确认框架的RSI7/RSI14）
 * 4. 波动率状态（基于过滤框架的ATR，判断市场活跃度）
 * 5. 多时间框架一致性检查（三层验证）
 * 6. 价格与关键均线的位置关系（偏离度计算）
 * 
 * 策略时间框架映射：
 * - ultra-short:  3分钟（主）+ 5分钟（确认）+ 15分钟（过滤）
 * - aggressive:   5分钟（主）+ 15分钟（确认）+ 30分钟（过滤）
 * - balanced:     5分钟（主）+ 15分钟（确认）+ 1小时（过滤）
 * - conservative: 15分钟（主）+ 30分钟（确认）+ 1小时（过滤）
 * - swing-trend:  15分钟（主）+ 1小时（确认）+ 4小时（过滤）
 */

import { createLogger } from "../utils/logger";
import { getTradingStrategy, type TradingStrategy } from "../agents/tradingAgent";
import { 
  performMultiTimeframeAnalysis,
  calculateTrendConsistency,
  type MultiTimeframeAnalysis,
  type TimeframeIndicators 
} from "./multiTimeframeAnalysis";
import type {
  MarketState,
  MarketStateAnalysis,
  TrendStrength,
  MomentumState,
  VolatilityState
} from "../types/marketState";

const logger = createLogger({
  name: "market-state",
  level: "info",
});

// 环境变量配置（带默认值）
const OVERSOLD_EXTREME_THRESHOLD = Number.parseFloat(process.env.OVERSOLD_EXTREME_THRESHOLD || "20");
const OVERSOLD_MILD_THRESHOLD = Number.parseFloat(process.env.OVERSOLD_MILD_THRESHOLD || "30");
const OVERBOUGHT_EXTREME_THRESHOLD = Number.parseFloat(process.env.OVERBOUGHT_EXTREME_THRESHOLD || "80");
const OVERBOUGHT_MILD_THRESHOLD = Number.parseFloat(process.env.OVERBOUGHT_MILD_THRESHOLD || "70");

/**
 * 策略自适应时间框架配置
 * 根据不同交易策略选择最优的时间框架组合
 */
interface StrategyTimeframes {
  primary: string;    // 主框架：用于趋势判断
  confirm: string;    // 确认框架：用于动量判断
  filter: string;     // 过滤框架：用于大势判断
}

/**
 * 获取策略对应的时间框架配置
 */
function getTimeframesForStrategy(strategy: TradingStrategy): StrategyTimeframes {
  const timeframeMap: Record<TradingStrategy, StrategyTimeframes> = {
    'ultra-short': {
      primary: 'SHORT_1',      // 3分钟 - 极快响应
      confirm: 'SHORT',        // 5分钟 - 减少噪音
      filter: 'SHORT_CONFIRM'  // 15分钟 - 避免逆势
    },
    'aggressive': {
      primary: 'SHORT',        // 5分钟 - 快速响应
      confirm: 'SHORT_CONFIRM', // 15分钟 - 平衡噪音
      filter: 'MEDIUM_SHORT'   // 30分钟 - 趋势质量
    },
    'balanced': {
      primary: 'SHORT',        // 5分钟 - 敏感适中
      confirm: 'SHORT_CONFIRM', // 15分钟 - 标准配置
      filter: 'MEDIUM'         // 1小时 - 稳定可靠
    },
    'conservative': {
      primary: 'SHORT_CONFIRM', // 15分钟 - 过滤噪音
      confirm: 'MEDIUM_SHORT',  // 30分钟 - 高质量信号
      filter: 'MEDIUM'         // 1小时 - 趋势确认
    },
    'swing-trend': {
      primary: 'SHORT_CONFIRM', // 15分钟 - 过滤短期波动
      confirm: 'MEDIUM',        // 1小时 - 趋势成熟度
      filter: 'MEDIUM_LONG'    // 4小时 - 大趋势方向
    }
  };
  
  return timeframeMap[strategy];
}

/**
 * 分析市场状态
 * 
 * @param symbol 交易品种
 * @returns 市场状态分析结果
 */
export async function analyzeMarketState(symbol: string): Promise<MarketStateAnalysis> {
  logger.info(`开始分析 ${symbol} 的市场状态...`);
  
  // 获取当前策略
  const strategy = getTradingStrategy();
  const timeframes = getTimeframesForStrategy(strategy);
  
  logger.debug(`${symbol} 使用策略: ${strategy}, 时间框架: ${timeframes.primary}/${timeframes.confirm}/${timeframes.filter}`);
  
  // 获取多时间框架数据（策略自适应）
  const mtfData = await performMultiTimeframeAnalysis(
    symbol, 
    [timeframes.primary, timeframes.confirm, timeframes.filter]
  );
  
  // 提取时间框架数据（动态适配）
  const tfPrimaryKey = timeframes.primary.toLowerCase().replace(/_/g, '') as keyof typeof mtfData.timeframes;
  const tfConfirmKey = timeframes.confirm.toLowerCase().replace(/_/g, '') as keyof typeof mtfData.timeframes;
  const tfFilterKey = timeframes.filter.toLowerCase().replace(/_/g, '') as keyof typeof mtfData.timeframes;
  
  const tfPrimary = mtfData.timeframes[tfPrimaryKey];
  const tfConfirm = mtfData.timeframes[tfConfirmKey];
  const tfFilter = mtfData.timeframes[tfFilterKey];
  
  if (!tfPrimary || !tfConfirm || !tfFilter) {
    throw new Error(`无法获取 ${symbol} 的时间框架数据`);
  }
  
  // 1. 判断趋势强度（基于主框架）
  const trendStrength = determineTrendStrength(tfPrimary);
  
  // 2. 判断动量状态（基于确认框架）
  const momentumState = determineMomentumState(tfConfirm);
  
  // 3. 判断波动率状态（基于过滤框架）
  const volatilityState = determineVolatilityState(tfFilter);
  
  // 4. 综合判断市场状态
  const { state, confidence } = determineMarketState(
    trendStrength,
    momentumState,
    tfConfirm,
    tfFilter
  );
  
  // 5. 计算多时间框架一致性（三层验证）
  const alignmentScore = calculateTripleTimeframeConsistency(
    tfPrimary,
    tfConfirm,
    tfFilter
  );
  
  const isAligned = alignmentScore > 0.6;
  
  // 6. 计算价格相对布林带的位置
  const priceVsUpperBB = calculatePriceVsBB(tfConfirm.currentPrice, tfConfirm.bollingerUpper, tfConfirm.bollingerMiddle);
  const priceVsLowerBB = calculatePriceVsBB(tfConfirm.currentPrice, tfConfirm.bollingerLower, tfConfirm.bollingerMiddle);
  
  const analysis: MarketStateAnalysis = {
    symbol,
    state,
    trendStrength,
    momentumState,
    volatilityState,
    confidence,
    keyMetrics: {
      rsi7_15m: tfConfirm.rsi7,
      rsi14_15m: tfConfirm.rsi14,
      macd_15m: tfConfirm.macd,
      ema20_1h: tfFilter.ema20,
      ema50_1h: tfFilter.ema50,
      macd_1h: tfFilter.macd,
      price: tfConfirm.currentPrice,
      atr_ratio: tfFilter.atrRatio,
      distanceToEMA20: tfConfirm.deviationFromEMA20,
      priceVsUpperBB,
      priceVsLowerBB,
    },
    timeframeAlignment: {
      is15mAnd1hAligned: isAligned,
      alignmentScore,
    },
    timestamp: new Date().toISOString(),
  };
  
  logger.info(`${symbol} 市场状态: ${state} (置信度: ${(confidence * 100).toFixed(1)}%, 策略: ${strategy})`);
  
  return analysis;
}

/**
 * 计算三层时间框架一致性（主框架 + 确认框架 + 过滤框架）
 */
function calculateTripleTimeframeConsistency(
  tfPrimary: TimeframeIndicators,
  tfConfirm: TimeframeIndicators,
  tfFilter: TimeframeIndicators
): number {
  // 计算主框架和确认框架的一致性
  const primaryConfirmScore = calculateTrendConsistency(
    tfPrimary.ema20,
    tfPrimary.ema50,
    tfConfirm.ema20,
    tfConfirm.ema50,
    tfPrimary.macd,
    tfConfirm.macd
  );
  
  // 计算确认框架和过滤框架的一致性
  const confirmFilterScore = calculateTrendConsistency(
    tfConfirm.ema20,
    tfConfirm.ema50,
    tfFilter.ema20,
    tfFilter.ema50,
    tfConfirm.macd,
    tfFilter.macd
  );
  
  // 加权平均：主框架-确认框架占60%，确认框架-过滤框架占40%
  return primaryConfirmScore * 0.6 + confirmFilterScore * 0.4;
}

/**
 * 判断趋势强度
 */
function determineTrendStrength(tf: TimeframeIndicators): TrendStrength {
  const { ema20, ema50, macd, currentPrice } = tf;
  
  // 上涨趋势：EMA20 > EMA50 且 MACD > 0 且价格在EMA20上方
  if (ema20 > ema50 && macd > 0) {
    return "trending_up";
  }
  
  // 下跌趋势：EMA20 < EMA50 且 MACD < 0 且价格在EMA20下方
  if (ema20 < ema50 && macd < 0) {
    return "trending_down";
  }
  
  // 其他情况为震荡
  return "ranging";
}

/**
 * 判断动量状态（超买超卖）
 */
function determineMomentumState(tf: TimeframeIndicators): MomentumState {
  const rsi7 = tf.rsi7;
  
  if (rsi7 < OVERSOLD_EXTREME_THRESHOLD) {
    return "oversold_extreme";
  }
  if (rsi7 < OVERSOLD_MILD_THRESHOLD) {
    return "oversold_mild";
  }
  if (rsi7 > OVERBOUGHT_EXTREME_THRESHOLD) {
    return "overbought_extreme";
  }
  if (rsi7 > OVERBOUGHT_MILD_THRESHOLD) {
    return "overbought_mild";
  }
  
  return "neutral";
}

/**
 * 判断波动率状态
 */
function determineVolatilityState(tf: TimeframeIndicators): VolatilityState {
  const atrRatio = tf.atrRatio;
  
  if (atrRatio > 1.5) {
    return "high_vol";
  }
  if (atrRatio < 0.7) {
    return "low_vol";
  }
  
  return "normal_vol";
}

/**
 * 综合判断市场状态
 */
function determineMarketState(
  trendStrength: TrendStrength,
  momentumState: MomentumState,
  tf15m: TimeframeIndicators,
  tf1h: TimeframeIndicators
): { state: MarketState; confidence: number } {
  let state: MarketState = "no_clear_signal";
  let confidence = 0.3;
  
  // 上涨趋势 + 极端超卖 = 最佳做多机会（回调买入）⭐⭐⭐⭐⭐
  if (trendStrength === "trending_up" && momentumState === "oversold_extreme") {
    state = "uptrend_oversold";
    confidence = 0.9;
  }
  // 下跌趋势 + 极端超买 = 最佳做空机会（反弹卖出）⭐⭐⭐⭐⭐
  else if (trendStrength === "trending_down" && momentumState === "overbought_extreme") {
    state = "downtrend_overbought";
    confidence = 0.9;
  }
  // 🔧 新增：下跌趋势 + 极端超卖 = 潜在反弹机会（逆势做多）⭐⭐⭐
  else if (trendStrength === "trending_down" && momentumState === "oversold_extreme") {
    state = "downtrend_oversold";
    confidence = 0.6; // 逆势交易风险较高，置信度中等
  }
  // 🔧 新增：上涨趋势 + 极端超买 = 潜在回调风险（逆势做空）⭐⭐⭐
  else if (trendStrength === "trending_up" && momentumState === "overbought_extreme") {
    state = "uptrend_overbought";
    confidence = 0.6; // 逆势交易风险较高，置信度中等
  }
  // 上涨趋势 + 轻度超卖或中性 = 趋势延续做多 ⭐⭐⭐⭐
  else if (
    trendStrength === "trending_up" && 
    (momentumState === "oversold_mild" || momentumState === "neutral")
  ) {
    state = "uptrend_continuation";
    confidence = 0.7;
  }
  // 下跌趋势 + 轻度超买或中性 = 趋势延续做空 ⭐⭐⭐⭐
  else if (
    trendStrength === "trending_down" && 
    (momentumState === "overbought_mild" || momentumState === "neutral")
  ) {
    state = "downtrend_continuation";
    confidence = 0.7;
  }
  // 下跌趋势 + 轻度超卖 = 下跌趋势中的超卖状态 ⭐⭐⭐
  else if (trendStrength === "trending_down" && momentumState === "oversold_mild") {
    state = "downtrend_oversold";
    confidence = 0.5; // 风险中等
  }
  // 上涨趋势 + 轻度超买 = 上涨趋势中的超买状态 ⭐⭐⭐
  else if (trendStrength === "trending_up" && momentumState === "overbought_mild") {
    state = "uptrend_overbought";
    confidence = 0.5; // 风险中等
  }
  // 震荡市 + 极端超卖 = 均值回归做多 ⭐⭐⭐
  else if (trendStrength === "ranging" && momentumState === "oversold_extreme") {
    state = "ranging_oversold";
    confidence = 0.8;
  }
  // 震荡市 + 极端超买 = 均值回归做空 ⭐⭐⭐
  else if (trendStrength === "ranging" && momentumState === "overbought_extreme") {
    state = "ranging_overbought";
    confidence = 0.8;
  }
  // 震荡市 + 中性 = 观望 ⭐
  else if (trendStrength === "ranging" && momentumState === "neutral") {
    state = "ranging_neutral";
    confidence = 0.5;
  }
  
  // 增加置信度调整：MACD拐点确认
  if (tf15m.macdTurn === 1 && (state === "uptrend_oversold" || state === "ranging_oversold")) {
    confidence = Math.min(confidence + 0.1, 1.0);
  }
  if (tf15m.macdTurn === -1 && (state === "downtrend_overbought" || state === "ranging_overbought")) {
    confidence = Math.min(confidence + 0.1, 1.0);
  }
  
  return { state, confidence };
}

/**
 * 计算价格相对布林带的位置
 * 返回 -1 到 1 的值
 * -1: 在下轨下方
 *  0: 在中轨
 *  1: 在上轨上方
 */
function calculatePriceVsBB(price: number, bbLevel: number, bbMiddle: number): number {
  if (bbMiddle === 0 || bbLevel === bbMiddle) return 0;
  
  const distance = price - bbMiddle;
  const range = Math.abs(bbLevel - bbMiddle);
  
  if (range === 0) return 0;
  
  const position = distance / range;
  
  // 限制在 -2 到 2 之间（允许超出布林带）
  return Math.max(-2, Math.min(2, position));
}

/**
 * 批量分析多个品种的市场状态
 */
export async function analyzeMultipleMarketStates(
  symbols: string[]
): Promise<Map<string, MarketStateAnalysis>> {
  logger.info(`批量分析 ${symbols.length} 个品种的市场状态...`);
  
  const results = new Map<string, MarketStateAnalysis>();
  
  // 并发分析所有品种
  const promises = symbols.map(async (symbol) => {
    try {
      const analysis = await analyzeMarketState(symbol);
      results.set(symbol, analysis);
    } catch (error) {
      logger.error(`分析 ${symbol} 市场状态失败:`, error);
    }
  });
  
  await Promise.all(promises);
  
  logger.info(`完成市场状态分析，成功: ${results.size}/${symbols.length}`);
  
  return results;
}

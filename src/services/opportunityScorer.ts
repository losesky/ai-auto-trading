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
 * 机会评分系统 - 策略自适应版本
 * 
 * 对每个币种的开仓机会进行量化评分（0-100分）
 * 评分维度（权重根据策略动态调整）：
 * 1. 信号强度 (20-35分)
 * 2. 趋势一致性 (20-35分)
 * 3. 波动率适配 (15-20分)
 * 4. 风险收益比 (10-20分)
 * 5. 市场活跃度 (10-15分)
 */

import { createLogger } from "../utils/logger";
import { getTradingStrategy } from "../agents/tradingAgent";
import type { TradingStrategy } from "../agents/tradingAgent";
import type { 
  OpportunityScore, 
  StrategyResult,
  MarketStateAnalysis 
} from "../types/marketState";

const logger = createLogger({
  name: "opportunity-scorer",
  level: "info",
});

/**
 * 策略评分权重配置
 */
interface StrategyScoreWeights {
  signalStrength: number;
  trendConsistency: number;
  volatilityFit: number;
  riskRewardRatio: number;
  liquidity: number;
  minScore: number;
}

/**
 * 策略差异化权重配置表
 * 导出供测试和调试使用
 */
export const STRATEGY_SCORE_WEIGHTS: Record<TradingStrategy, StrategyScoreWeights> = {
  "ultra-short": {
    signalStrength: 35,      // 更看重信号强度
    trendConsistency: 20,    // 短期趋势可能不稳
    volatilityFit: 20,
    riskRewardRatio: 10,     // 追求速度而非比例
    liquidity: 15,           // 需要快速成交
    minScore: 65,            // 降低阈值,增加机会
  },
  "aggressive": {
    signalStrength: 30,
    trendConsistency: 25,
    volatilityFit: 20,
    riskRewardRatio: 12,
    liquidity: 13,
    minScore: 70,
  },
  "balanced": {
    signalStrength: 30,
    trendConsistency: 25,
    volatilityFit: 20,
    riskRewardRatio: 15,
    liquidity: 10,
    minScore: 75,
  },
  "conservative": {
    signalStrength: 25,      // 信号可以慢一些
    trendConsistency: 30,    // 更看重趋势确认
    volatilityFit: 15,
    riskRewardRatio: 20,     // 严格要求R:R
    liquidity: 10,
    minScore: 80,            // 提高阈值,宁缺毋滥
  },
  "swing-trend": {
    signalStrength: 20,      // 不追求精准入场
    trendConsistency: 35,    // 三层时间框架验证
    volatilityFit: 15,
    riskRewardRatio: 20,     // 追求大R:R
    liquidity: 10,
    minScore: 78,
  },
};

/**
 * 波动率偏好配置
 */
interface VolatilityPreference {
  idealMin: number;
  idealMax: number;
  acceptableMin: number;
  acceptableMax: number;
  penaltyFactor: number;
}

const STRATEGY_VOLATILITY_PREFS: Record<TradingStrategy, VolatilityPreference> = {
  "ultra-short": {
    idealMin: 1.0,
    idealMax: 1.5,
    acceptableMin: 0.8,
    acceptableMax: 2.0,
    penaltyFactor: 0.4,
  },
  "aggressive": {
    idealMin: 0.9,
    idealMax: 1.4,
    acceptableMin: 0.7,
    acceptableMax: 1.8,
    penaltyFactor: 0.5,
  },
  "balanced": {
    idealMin: 0.8,
    idealMax: 1.2,
    acceptableMin: 0.6,
    acceptableMax: 1.5,
    penaltyFactor: 0.5,
  },
  "conservative": {
    idealMin: 0.6,
    idealMax: 1.0,
    acceptableMin: 0.5,
    acceptableMax: 1.3,
    penaltyFactor: 0.7,
  },
  "swing-trend": {
    idealMin: 0.7,
    idealMax: 1.1,
    acceptableMin: 0.5,
    acceptableMax: 1.4,
    penaltyFactor: 0.6,
  },
};

/**
 * wait信号智能评分
 * 根据市场状态和策略特性动态调整评分
 */
function calculateWaitScore(
  strategyResult: StrategyResult,
  marketState: MarketStateAnalysis,
  strategy: TradingStrategy
): OpportunityScore {
  let baseScore = 0;
  let reason = strategyResult.reason;
  const state = marketState.state;
  
  // 根据市场状态给基础分
  if (state === "downtrend_overbought" || state === "uptrend_oversold") {
    // 最佳时机但策略未触发
    if (strategy === "ultra-short" || strategy === "aggressive") {
      baseScore = 60;
    } else {
      baseScore = 55;
    }
    reason = `最佳入场时机但指标未完全满足。${strategyResult.reason}`;
  } else if (state === "downtrend_continuation" || state === "uptrend_continuation") {
    // 趋势延续
    if (strategy === "swing-trend") {
      baseScore = 50;
      reason = `趋势延续中,等待更高级别时间框架确认。${strategyResult.reason}`;
    } else if (strategy === "conservative") {
      baseScore = 48;
      reason = `趋势明确但等待更安全的入场点。${strategyResult.reason}`;
    } else {
      baseScore = 45;
      reason = `趋势明确但暂无精确入场点。${strategyResult.reason}`;
    }
  } else if (state.startsWith("ranging")) {
    // 震荡市
    if (strategy === "ultra-short") {
      baseScore = 35;
      reason = `震荡市场,等待边界突破或反转信号。${strategyResult.reason}`;
    } else {
      baseScore = 30;
      reason = `震荡市场,等待更明确信号。${strategyResult.reason}`;
    }
  } else {
    baseScore = 20;
    reason = `市场信号不明确,暂时观望。${strategyResult.reason}`;
  }
  
  // 趋势一致性加成
  const alignmentScore = marketState.timeframeAlignment.alignmentScore;
  if (alignmentScore >= 0.8) {
    baseScore += 10;
    reason = `多时间框架高度一致(${(alignmentScore * 100).toFixed(0)}%),${reason}`;
  } else if (alignmentScore >= 0.6) {
    baseScore += 5;
  }
  
  // 波动率加成
  const atrRatio = marketState.keyMetrics.atr_ratio;
  const volatilityPref = STRATEGY_VOLATILITY_PREFS[strategy];
  if (atrRatio >= volatilityPref.idealMin && atrRatio <= volatilityPref.idealMax) {
    baseScore += 5;
  }
  
  return {
    symbol: strategyResult.symbol,
    totalScore: Math.min(baseScore, 70), // wait信号最高70分
    breakdown: {
      signalStrength: baseScore,
      trendConsistency: Math.round(alignmentScore * 25),
      volatilityFit: 0,
      riskRewardRatio: 0,
      liquidity: 0,
    },
    confidence: baseScore >= 55 ? "medium" : "low",
    recommendation: {
      strategyType: "none",
      direction: "wait",
      confidence: baseScore >= 55 ? "medium" : "low",
      reason,
    },
  };
}

/**
 * 计算机会评分（策略感知版）
 * 
 * @param strategyResult 策略结果
 * @param marketState 市场状态分析
 * @param strategy 当前交易策略（可选，默认从环境变量读取）
 * @returns 机会评分
 */
export function scoreOpportunity(
  strategyResult: StrategyResult,
  marketState: MarketStateAnalysis,
  strategy?: TradingStrategy
): OpportunityScore {
  // 获取当前策略
  const currentStrategy = strategy ?? getTradingStrategy();
  
  // 如果策略建议观望，使用智能评分
  if (strategyResult.action === "wait") {
    return calculateWaitScore(strategyResult, marketState, currentStrategy);
  }
  
  // 获取策略权重配置
  const weights = STRATEGY_SCORE_WEIGHTS[currentStrategy];
  
  // 1. 信号强度评分
  const signalScore = strategyResult.signalStrength * weights.signalStrength;
  
  // 2. 趋势一致性评分
  const trendScore = marketState.timeframeAlignment.alignmentScore * weights.trendConsistency;
  
  // 3. 波动率适配评分（策略化）
  const volatilityScore = calculateVolatilityFitScore(marketState, currentStrategy) * weights.volatilityFit;
  
  // 4. 风险收益比评分
  const rrScore = calculateRiskRewardScore(strategyResult, marketState, currentStrategy) * weights.riskRewardRatio;
  
  // 5. 流动性评分（策略化 + 动态成交量）
  const volume24h = strategyResult.keyMetrics.volume24h;
  const liquidityScore = calculateLiquidityScore(strategyResult.symbol, currentStrategy, volume24h) * weights.liquidity;
  
  // 计算总分
  const totalScore = signalScore + trendScore + volatilityScore + rrScore + liquidityScore;
  
  // 记录评分明细日志
  logger.debug(`${strategyResult.symbol} 评分明细 [策略: ${currentStrategy}]:`, {
    总分: Math.round(totalScore),
    信号强度: `${Math.round(signalScore)}/${weights.signalStrength}`,
    趋势一致性: `${Math.round(trendScore)}/${weights.trendConsistency}`,
    波动率适配: `${Math.round(volatilityScore)}/${weights.volatilityFit}`,
    风险收益比: `${Math.round(rrScore)}/${weights.riskRewardRatio}`,
    流动性: `${Math.round(liquidityScore)}/${weights.liquidity}`,
    成交量24h: volume24h ? `${(volume24h / 1_000_000).toFixed(0)}M USDT` : "未获取",
  });
  
  // 根据总分判断置信度（使用策略阈值）
  let confidence: "high" | "medium" | "low";
  const highThreshold = weights.minScore;
  const mediumThreshold = highThreshold - 15;
  
  if (totalScore >= highThreshold) {
    confidence = "high";
  } else if (totalScore >= mediumThreshold) {
    confidence = "medium";
  } else {
    confidence = "low";
  }
  
  return {
    symbol: strategyResult.symbol,
    totalScore: Math.round(totalScore),
    breakdown: {
      signalStrength: Math.round(signalScore),
      trendConsistency: Math.round(trendScore),
      volatilityFit: Math.round(volatilityScore),
      riskRewardRatio: Math.round(rrScore),
      liquidity: Math.round(liquidityScore),
    },
    confidence,
    recommendation: {
      strategyType: strategyResult.strategyType as any,
      direction: strategyResult.action === "long" ? "long" : strategyResult.action === "short" ? "short" : "wait",
      confidence,
      reason: strategyResult.reason,
    },
  };
}

/**
 * 计算波动率适配评分（策略化） (0-1)
 */
function calculateVolatilityFitScore(
  marketState: MarketStateAnalysis,
  strategy: TradingStrategy
): number {
  const atrRatio = marketState.keyMetrics.atr_ratio;
  const pref = STRATEGY_VOLATILITY_PREFS[strategy];
  
  // 理想区间 -> 满分
  if (atrRatio >= pref.idealMin && atrRatio <= pref.idealMax) {
    return 1.0;
  }
  
  // 可接受区间 -> 线性衰减
  if (atrRatio >= pref.acceptableMin && atrRatio <= pref.acceptableMax) {
    if (atrRatio < pref.idealMin) {
      const distance = pref.idealMin - atrRatio;
      const range = pref.idealMin - pref.acceptableMin;
      return 1.0 - (distance / range) * pref.penaltyFactor;
    } else {
      const distance = atrRatio - pref.idealMax;
      const range = pref.acceptableMax - pref.idealMax;
      return 1.0 - (distance / range) * pref.penaltyFactor;
    }
  }
  
  // 超出可接受范围 -> 最低分
  return 0.3;
}

/**
 * 计算风险收益比评分 (0-1)
 * 基于策略推荐的杠杆和市场状态
 */
function calculateRiskRewardScore(
  strategyResult: StrategyResult,
  marketState: MarketStateAnalysis,
  strategy: TradingStrategy
): number {
  // 基础风险收益比基于市场状态
  let baseRR = 0.5;
  
  // 极端状态（最佳做多/做空机会）
  if (marketState.state === "uptrend_oversold" || marketState.state === "downtrend_overbought") {
    baseRR = 0.9;
  }
  // 趋势延续
  else if (marketState.state === "uptrend_continuation" || marketState.state === "downtrend_continuation") {
    baseRR = 0.7;
  }
  // 震荡市均值回归
  else if (marketState.state === "ranging_oversold" || marketState.state === "ranging_overbought") {
    baseRR = 0.8;
  }
  
  // 根据推荐杠杆调整
  const leverage = strategyResult.recommendedLeverage;
  if (leverage <= 2) {
    baseRR *= 0.95;
  } else if (leverage >= 5) {
    baseRR *= 0.75;
  }
  
  // 策略差异化调整
  if (strategy === "conservative" && baseRR < 0.7) {
    baseRR *= 0.8;
  }
  
  if (strategy === "ultra-short") {
    baseRR = Math.min(1.0, baseRR + 0.1);
  }
  
  return baseRR;
}

/**
 * 计算流动性评分 (0-1)
 * 基于交易品种的流动性（策略化 + 动态成交量）
 * 
 * @param symbol 币种符号
 * @param strategy 交易策略
 * @param volume24h 可选的24h成交量(USDT)
 */
function calculateLiquidityScore(symbol: string, strategy: TradingStrategy, volume24h?: number): number {
  // 1. 基础静态评分（基于币种分级）
  let baseScore = 0.6;
  
  const tier1 = ["BTC", "ETH"];  // 超级主流
  const tier2 = ["BNB", "SOL", "XRP", "ADA"];  // 主流
  const tier3 = ["DOGE", "AVAX", "DOT", "MATIC", "LTC", "ARB", "OP"];  // 二线
  
  if (tier1.includes(symbol)) {
    baseScore = 1.0;
  } else if (tier2.includes(symbol)) {
    baseScore = 0.85;
  } else if (tier3.includes(symbol)) {
    baseScore = 0.7;
  }
  
  // 2. 动态成交量加成（如果有数据）
  if (volume24h !== undefined && volume24h > 0) {
    if (volume24h >= 1_000_000_000) {  // ≥10亿USDT
      baseScore = Math.min(1.0, baseScore + 0.1);
    } else if (volume24h >= 500_000_000) {  // ≥5亿USDT
      baseScore = Math.min(1.0, baseScore + 0.05);
    } else if (volume24h < 100_000_000) {  // <1亿USDT
      baseScore = Math.max(0.3, baseScore - 0.1);
    }
  }
  
  // 3. 策略差异化调整
  if (strategy === "ultra-short" && baseScore < 0.7) {
    // 超短线对流动性要求严格
    baseScore *= 0.8;
  }
  
  if (strategy === "swing-trend" && baseScore >= 0.6) {
    // 波段策略对流动性要求宽松
    baseScore = Math.min(1.0, baseScore + 0.05);
  }
  
  return baseScore;
}

/**
 * 批量评分并排序（策略感知版）
 * 
 * @param strategyResults 策略结果列表
 * @param marketStates 市场状态映射
 * @param strategy 当前交易策略（可选，默认从环境变量读取）
 * @param customMinScore 可选的自定义阈值
 * @returns 排序后的机会评分列表
 */
export function scoreAndRankOpportunities(
  strategyResults: StrategyResult[],
  marketStates: Map<string, MarketStateAnalysis>,
  strategy?: TradingStrategy,
  customMinScore?: number
): OpportunityScore[] {
  // 获取当前策略
  const currentStrategy = strategy ?? getTradingStrategy();
  
  // 获取策略权重配置
  const weights = STRATEGY_SCORE_WEIGHTS[currentStrategy];
  
  // 确定最低评分阈值（自定义阈值 > 环境变量 > 策略默认值）
  const minScore = customMinScore ?? 
    (process.env.MIN_OPPORTUNITY_SCORE ? Number.parseInt(process.env.MIN_OPPORTUNITY_SCORE, 10) : weights.minScore);
  
  logger.info(`使用策略 ${currentStrategy} 评分 ${strategyResults.length} 个机会（阈值: ${minScore}）...`);
  
  const scores: OpportunityScore[] = [];
  
  for (const result of strategyResults) {
    const marketState = marketStates.get(result.symbol);
    if (!marketState) {
      logger.warn(`未找到 ${result.symbol} 的市场状态，跳过评分`);
      continue;
    }
    
    const score = scoreOpportunity(result, marketState, currentStrategy);
    
    // 只保留评分达标的机会
    if (score.totalScore >= minScore) {
      scores.push(score);
    }
  }
  
  // 按总分降序排序
  scores.sort((a, b) => b.totalScore - a.totalScore);
  
  // 输出评分摘要
  if (scores.length > 0) {
    logger.info(`评分完成，${scores.length} 个机会达到最低评分 ${minScore}`);
    logger.info("评分前3位:", scores.slice(0, 3).map((s, i) => 
      `${i + 1}. ${s.symbol}: ${s.totalScore}分 (${s.confidence}) - ${s.recommendation.direction}`
    ).join(", "));
  } else {
    logger.info(`评分完成，无机会达到最低评分 ${minScore}`);
  }
  
  return scores;
}

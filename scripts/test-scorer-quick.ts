/**
 * 快速验证评分系统策略自适应功能
 */

import { scoreOpportunity, STRATEGY_SCORE_WEIGHTS } from "../src/services/opportunityScorer";
import type { TradingStrategy } from "../src/agents/tradingAgent";

console.log("\n" + "=".repeat(80));
console.log("📊 机会评分系统 - 策略自适应快速验证");
console.log("=".repeat(80));

// 模拟一个wait信号（趋势延续场景）
const waitSignal: any = {
  symbol: "BTC",
  action: "wait",
  signalStrength: 0,
  recommendedLeverage: 0,
  strategyType: "none",
  reason: "趋势延续，等待更好入场点",
  confidence: "low",
  opportunityScore: 0,
  marketState: "uptrend_continuation",
  keyMetrics: {},
  timestamp: Date.now(),
};

const marketState: any = {
  symbol: "BTC",
  state: "uptrend_continuation",
  confidence: 0.7,
  timeframeAlignment: {
    direction: "up",
    alignmentScore: 0.75,
    conflicts: [],
  },
  keyMetrics: {
    rsi7: 55,
    rsi14: 58,
    macd: 0.008,
    atr_ratio: 1.1, // 偏高波动
  },
  trendStrength: "trending_up",
  momentumState: "neutral",
  volatilityState: "normal",
  supportResistance: {
    nearestSupport: 90000,
    nearestResistance: 95000,
    currentPrice: 92000,
  },
  recommendation: "等待回调",
  timestamp: Date.now(),
};

console.log("\n测试场景: 上涨趋势延续 + wait信号");
console.log("市场状态: uptrend_continuation");
console.log("多时间框架一致性: 75%");
console.log("ATR比率: 1.1 (偏高波动)");
console.log("\n" + "-".repeat(80));

const strategies: TradingStrategy[] = ["ultra-short", "aggressive", "balanced", "conservative", "swing-trend"];

console.log("\n策略          | 总分 | 阈值 | 是否达标 | 置信度 | 评分理由");
console.log("-".repeat(80));

for (const strategy of strategies) {
  const score = scoreOpportunity(waitSignal, marketState, strategy);
  const threshold = STRATEGY_SCORE_WEIGHTS[strategy].minScore;
  const passed = score.totalScore >= threshold ? "✅ 达标" : "❌ 未达标";
  
  console.log(
    `${strategy.padEnd(13)} | ${score.totalScore.toString().padStart(4)} | ${threshold.toString().padStart(4)} | ${passed.padEnd(8)} | ${score.confidence.padEnd(6)} | ${score.recommendation.reason.substring(0, 40)}...`
  );
}

console.log("\n" + "-".repeat(80));
console.log("\n模拟一个long信号（超卖回调场景）");

const longSignal: any = {
  symbol: "BTC",
  action: "long",
  signalStrength: 0.8,
  recommendedLeverage: 3,
  strategyType: "momentum",
  reason: "上涨趋势+超卖回调",
  confidence: "high",
  opportunityScore: 0,
  marketState: "uptrend_oversold",
  keyMetrics: {},
  timestamp: Date.now(),
};

const oversoldMarket: any = {
  ...marketState,
  state: "uptrend_oversold",
  keyMetrics: {
    ...marketState.keyMetrics,
    rsi7: 28,
    rsi14: 35,
  },
  timeframeAlignment: {
    direction: "up",
    alignmentScore: 0.85,
    conflicts: [],
  },
};

console.log("市场状态: uptrend_oversold");
console.log("信号强度: 0.8");
console.log("多时间框架一致性: 85%");
console.log("ATR比率: 1.1");
console.log("\n" + "-".repeat(80));

console.log("\n策略          | 总分 | 阈值 | 是否达标 | 置信度 | 信号 | 趋势 | 波动 | R:R | 流动");
console.log("-".repeat(80));

for (const strategy of strategies) {
  const score = scoreOpportunity(longSignal, oversoldMarket, strategy);
  const threshold = STRATEGY_SCORE_WEIGHTS[strategy].minScore;
  const passed = score.totalScore >= threshold ? "✅ 达标" : "❌ 未达标";
  
  console.log(
    `${strategy.padEnd(13)} | ${score.totalScore.toString().padStart(4)} | ${threshold.toString().padStart(4)} | ${passed.padEnd(8)} | ${score.confidence.padEnd(6)} | ${score.breakdown.signalStrength.toString().padStart(4)} | ${score.breakdown.trendConsistency.toString().padStart(4)} | ${score.breakdown.volatilityFit.toString().padStart(4)} | ${score.breakdown.riskRewardRatio.toString().padStart(3)} | ${score.breakdown.liquidity.toString().padStart(4)}`
  );
}

console.log("\n" + "=".repeat(80));
console.log("✅ 验证完成");
console.log("\n预期结果:");
console.log("1. wait信号: ultra-short/aggressive应给予更高分(45-50分)");
console.log("2. long信号: ultra-short应更容易达标(阈值65),conservative要求更严(阈值80)");
console.log("3. long信号: ultra-short在信号强度得分更高(35%权重)");
console.log("4. long信号: swing-trend在趋势一致性得分更高(35%权重)");
console.log("=".repeat(80) + "\n");

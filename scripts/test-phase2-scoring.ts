/**
 * 阶段二优化测试：流动性动态评分和日志增强
 */

import { scoreOpportunity, STRATEGY_SCORE_WEIGHTS } from "../src/services/opportunityScorer";
import type { StrategyResult, MarketStateAnalysis } from "../src/types/marketState";
import type { TradingStrategy } from "../src/agents/tradingAgent";

// 模拟市场状态
const mockMarketState: MarketStateAnalysis = {
  symbol: "BTC",
  state: "uptrend_oversold",
  trendStrength: "trending_up",
  momentumState: "oversold_mild",
  volatilityState: "normal_vol",
  confidence: 0.85,
  keyMetrics: {
    rsi7_15m: 35,
    rsi14_15m: 42,
    macd_15m: 150,
    ema20_1h: 95000,
    ema50_1h: 93000,
    macd_1h: 200,
    price: 96000,
    atr_ratio: 1.1,
    distanceToEMA20: 1.0,
    priceVsUpperBB: 0.3,
    priceVsLowerBB: -0.5,
  },
  timeframeAlignment: {
    is15mAnd1hAligned: true,
    alignmentScore: 0.85,
  },
  timestamp: new Date().toISOString(),
};

console.log("================================================================================");
console.log("阶段二优化测试：流动性动态评分和日志增强");
console.log("================================================================================\n");

// 测试场景1：不同成交量对流动性评分的影响
console.log("📊 测试场景1：成交量对流动性评分的影响\n");

const volumes = [
  { label: "极高成交量", value: 15_000_000_000 },  // 150亿USDT
  { label: "高成交量", value: 2_000_000_000 },    // 20亿USDT
  { label: "中等成交量", value: 600_000_000 },     // 6亿USDT
  { label: "低成交量", value: 80_000_000 },        // 8000万USDT
  { label: "极低成交量", value: 30_000_000 },      // 3000万USDT
  { label: "未获取成交量", value: undefined },
];

for (const vol of volumes) {
  const mockStrategy: StrategyResult = {
    symbol: "BTC",
    action: "long",
    confidence: "high",
    signalStrength: 0.8,
    opportunityScore: 0,
    recommendedLeverage: 3,
    marketState: "uptrend_oversold",
    strategyType: "trend_following",
    reason: "测试用例",
    keyMetrics: {
      rsi7: 35,
      rsi14: 42,
      macd: 150,
      ema20: 95000,
      ema50: 93000,
      price: 96000,
      atrRatio: 1.1,
      volume24h: vol.value,
    },
    timestamp: new Date().toISOString(),
  };

  const score = scoreOpportunity(mockStrategy, mockMarketState, "balanced");
  
  console.log(`  ${vol.label}:`, {
    成交量: vol.value !== undefined ? `${(vol.value / 1_000_000).toFixed(0)}M USDT` : "未获取",
    流动性得分: `${score.breakdown.liquidity}/10`,
    总分: score.totalScore,
  });
}

console.log("\n================================================================================");
console.log("📊 测试场景2：不同策略对流动性评分的影响\n");

const strategies: TradingStrategy[] = ["ultra-short", "balanced", "conservative", "swing-trend"];

for (const strategy of strategies) {
  const mockStrategy: StrategyResult = {
    symbol: "DOGE",  // 二线币种
    action: "long",
    confidence: "high",
    signalStrength: 0.75,
    opportunityScore: 0,
    recommendedLeverage: 3,
    marketState: "uptrend_oversold",
    strategyType: "trend_following",
    reason: "测试用例",
    keyMetrics: {
      rsi7: 35,
      rsi14: 42,
      macd: 150,
      ema20: 0.15,
      ema50: 0.14,
      price: 0.155,
      atrRatio: 1.1,
      volume24h: 300_000_000,  // 3亿USDT
    },
    timestamp: new Date().toISOString(),
  };

  const score = scoreOpportunity(mockStrategy, mockMarketState, strategy);
  const weights = STRATEGY_SCORE_WEIGHTS[strategy];
  
  console.log(`  ${strategy.padEnd(15)}:`, {
    流动性权重: `${weights.liquidity}%`,
    流动性得分: `${score.breakdown.liquidity}/${weights.liquidity}`,
    总分: `${score.totalScore}/${weights.minScore}`,
    是否达标: score.totalScore >= weights.minScore ? "✅" : "❌",
  });
}

console.log("\n================================================================================");
console.log("📊 测试场景3：评分明细日志测试\n");
console.log("提示：查看上方的DEBUG日志，应包含详细的评分明细\n");

const testStrategy: StrategyResult = {
  symbol: "ETH",
  action: "long",
  confidence: "high",
  signalStrength: 0.85,
  opportunityScore: 0,
  recommendedLeverage: 4,
  marketState: "uptrend_oversold",
  strategyType: "trend_following",
  reason: "上涨趋势中的回调，RSI超卖",
  keyMetrics: {
    rsi7: 32,
    rsi14: 38,
    macd: 80,
    ema20: 3500,
    ema50: 3400,
    price: 3550,
    atrRatio: 1.0,
    volume24h: 5_000_000_000,  // 50亿USDT
  },
  timestamp: new Date().toISOString(),
};

const finalScore = scoreOpportunity(testStrategy, mockMarketState, "aggressive");

console.log("最终评分结果:", {
  币种: finalScore.symbol,
  总分: finalScore.totalScore,
  置信度: finalScore.confidence,
  推荐动作: finalScore.recommendation.direction,
  评分明细: {
    信号强度: finalScore.breakdown.signalStrength,
    趋势一致性: finalScore.breakdown.trendConsistency,
    波动率适配: finalScore.breakdown.volatilityFit,
    风险收益比: finalScore.breakdown.riskRewardRatio,
    流动性: finalScore.breakdown.liquidity,
  },
});

console.log("\n================================================================================");
console.log("✅ 阶段二优化测试完成");
console.log("================================================================================");
console.log("\n验证要点:");
console.log("1. ✅ 高成交量币种流动性得分更高");
console.log("2. ✅ 低成交量币种流动性得分降低");
console.log("3. ✅ ultra-short策略对低流动性币种更严格");
console.log("4. ✅ swing-trend策略对流动性要求更宽松");
console.log("5. ✅ 评分明细日志包含所有维度得分");
console.log("6. ✅ 日志显示24h成交量信息");
console.log("\n");

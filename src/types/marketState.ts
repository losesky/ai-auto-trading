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
 * 市场状态类型定义
 */

/**
 * 市场状态枚举
 */
export type MarketState = 
  | "uptrend_oversold"      // 上涨趋势中的超卖回调（最佳做多）⭐⭐⭐⭐⭐
  | "uptrend_overbought"    // 上涨趋势中的超买（潜在回调风险，逆势做空）⭐⭐⭐
  | "downtrend_overbought"  // 下跌趋势中的超买反弹（最佳做空）⭐⭐⭐⭐⭐
  | "downtrend_oversold"    // 下跌趋势中的超卖（潜在反弹机会，逆势做多）⭐⭐⭐
  | "uptrend_continuation"  // 上涨趋势延续（稳健做多）⭐⭐⭐⭐
  | "downtrend_continuation"// 下跌趋势延续（稳健做空）⭐⭐⭐⭐
  | "ranging_oversold"      // 震荡市超卖（均值回归做多）⭐⭐⭐
  | "ranging_overbought"    // 震荡市超买（均值回归做空）⭐⭐⭐
  | "ranging_neutral"       // 震荡市中性（观望）⭐
  | "no_clear_signal";      // 无明确信号（观望）⭐

/**
 * 趋势强度
 */
export type TrendStrength = "trending_up" | "trending_down" | "ranging";

/**
 * 动量状态（超买超卖）
 */
export type MomentumState = 
  | "oversold_extreme"   // 极端超卖
  | "oversold_mild"      // 轻度超卖
  | "neutral"            // 中性
  | "overbought_mild"    // 轻度超买
  | "overbought_extreme"; // 极端超买

/**
 * 波动率状态
 */
export type VolatilityState = "high_vol" | "normal_vol" | "low_vol";

/**
 * 市场状态分析结果
 */
export interface MarketStateAnalysis {
  symbol: string;
  state: MarketState;
  trendStrength: TrendStrength;
  momentumState: MomentumState;
  volatilityState: VolatilityState;
  confidence: number; // 0-1，置信度评分
  
  // 关键指标
  keyMetrics: {
    // 15分钟框架
    rsi7_15m: number;
    rsi14_15m: number;
    macd_15m: number;
    
    // 1小时框架
    ema20_1h: number;
    ema50_1h: number;
    macd_1h: number;
    
    // 价格和波动率
    price: number;
    atr_ratio: number;           // 当前ATR / 平均ATR
    distanceToEMA20: number;     // 价格距离EMA20的百分比
    priceVsUpperBB: number;      // 价格相对布林带上轨的位置 (-1到1)
    priceVsLowerBB: number;      // 价格相对布林带下轨的位置 (-1到1)
  };
  
  // 多时间框架一致性
  timeframeAlignment: {
    is15mAnd1hAligned: boolean;  // 15分钟和1小时是否一致
    alignmentScore: number;       // 一致性评分 0-1
  };
  
  timestamp: string;
}

/**
 * 策略推荐
 */
export interface StrategyRecommendation {
  strategyType: "trend_following" | "mean_reversion" | "breakout" | "none";
  direction: "long" | "short" | "wait";
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * 机会评分
 */
export interface OpportunityScore {
  symbol: string;
  totalScore: number; // 0-100
  
  // 评分维度
  breakdown: {
    signalStrength: number;      // 信号强度 (0-30分)
    trendConsistency: number;    // 趋势一致性 (0-25分)
    volatilityFit: number;       // 波动率适配 (0-20分)
    riskRewardRatio: number;     // 风险收益比 (0-15分)
    liquidity: number;           // 市场活跃度 (0-10分)
  };
  
  // 综合评价
  confidence: "high" | "medium" | "low";
  recommendation: StrategyRecommendation;
}

/**
 * 策略结果（统一格式）
 */
export interface StrategyResult {
  symbol: string;
  action: "long" | "short" | "wait";
  confidence: "high" | "medium" | "low";
  signalStrength: number; // 0-1
  opportunityScore: number; // 0-100
  recommendedLeverage: number; // 推荐杠杆倍数
  marketState: MarketState;
  strategyType: string; // "trend_following" | "mean_reversion" | "breakout"
  reason: string; // 人类可读的决策理由
  
  keyMetrics: { // 关键指标快照
    rsi7: number;
    rsi14: number;
    macd: number;
    ema20: number;
    ema50: number;
    price: number;
    atrRatio: number;
    volume24h?: number; // 24小时成交量(USDT) - 可选
  };
  
  timestamp: string;
}

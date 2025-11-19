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
 * 多时间框架分析模块（极简版 - 只提供原始数据）
 */

import { createLogger } from "../utils/logger";
import { getExchangeClient } from "../exchanges";

const logger = createLogger({
  name: "multi-timeframe",
  level: "info",
});

/**
 * 时间框架定义
 */
export interface TimeframeConfig {
  interval: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
  candleCount: number;
  description: string;
}

// 标准时间框架配置 - 短线交易配置
export const TIMEFRAMES: Record<string, TimeframeConfig> = {
  VERY_SHORT: {
    interval: "1m",
    candleCount: 60,
    description: "1分钟",
  },
  SHORT_1: {
    interval: "3m",
    candleCount: 100,
    description: "3分钟",
  },
  SHORT: {
    interval: "5m",
    candleCount: 100,
    description: "5分钟",
  },
  SHORT_CONFIRM: {
    interval: "15m",
    candleCount: 96,
    description: "15分钟",
  },
  MEDIUM_SHORT: {
    interval: "30m",
    candleCount: 90,
    description: "30分钟",
  },
  MEDIUM: {
    interval: "1h",
    candleCount: 120,
    description: "1小时",
  },
  MEDIUM_LONG: {
    interval: "4h",
    candleCount: 60,
    description: "4小时",
  },
};

/**
 * 确保数值是有效的有限数字，否则返回默认值
 */
function ensureFinite(value: number, defaultValue: number = 0): number {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  return value;
}

/**
 * 确保数值在指定范围内
 */
function ensureRange(value: number, min: number, max: number, defaultValue?: number): number {
  if (!Number.isFinite(value)) {
    return defaultValue !== undefined ? defaultValue : (min + max) / 2;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 计算EMA
 */
function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  
  return ensureFinite(ema);
}

/**
 * 计算RSI
 */
function calculateRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50;
  
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) {
      gains += changes[i];
    } else {
      losses -= changes[i];
    }
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period; i < changes.length; i++) {
    if (changes[i] >= 0) {
      avgGain = (avgGain * (period - 1) + changes[i]) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - changes[i]) / period;
    }
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  // 确保RSI在0-100范围内
  return ensureRange(rsi, 0, 100, 50);
}

/**
 * 计算MACD
 */
function calculateMACD(prices: number[]): { macd: number; signal: number; histogram: number } {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;
  
  const macdLine = [];
  for (let i = 26; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    macdLine.push(e12 - e26);
  }
  
  const signal = calculateEMA(macdLine, 9);
  const histogram = macd - signal;
  
  return { 
    macd: ensureFinite(macd), 
    signal: ensureFinite(signal), 
    histogram: ensureFinite(histogram) 
  };
}

/**
 * 单个时间框架的原始数据
 */
export interface TimeframeIndicators {
  interval: string;
  currentPrice: number;
  
  // 均线
  ema20: number;
  ema50: number;
  
  // MACD
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  macdTurn: number; // 1(拐头向上), -1(拐头向下), 0(无拐点)
  
  // RSI
  rsi7: number;
  rsi14: number;
  
  // 布林带
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerBandwidth: number;
  
  // ATR和波动率
  atr: number;
  atrRatio: number; // 当前ATR / 历史平均ATR
  
  // 成交量
  volume: number;
  avgVolume: number;
  volumeRatio: number; // 当前成交量 / 平均成交量
  
  // 价格变化和偏离度
  priceChange20: number; // 最近20根K线变化%
  deviationFromEMA20: number; // 价格距离EMA20的百分比
  deviationFromEMA50: number; // 价格距离EMA50的百分比
  
  // 支撑阻力
  recentHigh: number;
  recentLow: number;
  resistanceLevels: number[];
  supportLevels: number[];
  
  // K线历史数据（用于突破策略等需要识别支撑/阻力位的策略）
  candles: any[];
}

/**
 * 分析单个时间框架（只计算原始指标）
 */
export async function analyzeTimeframe(
  symbol: string,
  config: TimeframeConfig
): Promise<TimeframeIndicators> {
  const exchangeClient = getExchangeClient();
  const contract = exchangeClient.normalizeContract(symbol);
  
  // 获取K线数据
  const candles = await exchangeClient.getFuturesCandles(
    contract,
    config.interval,
    config.candleCount
  );
  
  if (!candles || candles.length === 0) {
    throw new Error(`无法获取 ${symbol} 的 ${config.interval} K线数据`);
  }
  
  // 提取价格和成交量数据
  // 🔧 兼容两种数据格式：
  // - GateExchangeClient 返回: { close, volume }
  // - BinanceExchangeClient 可能返回: { c, v }
  const closes = candles.map((c: any) => {
    const closeVal = c.close || c.c;
    return Number.parseFloat(closeVal || "0");
  }).filter((n: number) => Number.isFinite(n));
  
  // 🔧 成交量数据处理：兼容不同字段名和数据格式
  const volumes = candles.map((c: any) => {
    // 支持多种字段名：volume (标准), v (简写)
    const volStr = c.volume || c.v || "0";
    const vol = Number.parseFloat(volStr);
    return Number.isFinite(vol) && vol >= 0 ? vol : 0;
  }).filter((n: number) => n >= 0);
  
  const currentPrice = closes[closes.length - 1] || 0;
  
  // 计算技术指标
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  
  const { macd, signal: macdSignal, histogram } = calculateMACD(closes);
  const macdTurn = detectMACDHistogramTurn(closes);
  
  const rsi7 = calculateRSI(closes, 7);
  const rsi14 = calculateRSI(closes, 14);
  
  // 布林带
  const bb = calculateBollingerBands(closes, 20, 2);
  
  // ATR和波动率
  const atr = calculateATR(candles, 14);
  const historicalATR = candles.length >= 40 ? calculateATR(candles.slice(0, -20), 14) : atr;
  const atrRatio = historicalATR !== 0 ? atr / historicalATR : 1;
  
  // 成交量
  const avgVolume = volumes.length > 0 
    ? volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length 
    : 0;
  const currentVolume = volumes[volumes.length - 1] || 0;
  const volumeRatio = avgVolume !== 0 ? currentVolume / avgVolume : 1;
  
  // 价格变化和偏离度
  const priceChange20 = closes.length >= 21 && closes[closes.length - 21] !== 0
    ? ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
    : 0;
  
  const { deviationFromEMA20, deviationFromEMA50 } = calculatePriceDeviation(currentPrice, ema20, ema50);
  
  // 支撑阻力
  const { recentHigh, recentLow, resistanceLevels, supportLevels } = identifyRecentHighLow(candles, 20);
  
  return {
    interval: config.interval,
    currentPrice: ensureFinite(currentPrice),
    ema20: ensureFinite(ema20),
    ema50: ensureFinite(ema50),
    macd: ensureFinite(macd),
    macdSignal: ensureFinite(macdSignal),
    macdHistogram: ensureFinite(histogram),
    macdTurn,
    rsi7: ensureRange(rsi7, 0, 100, 50),
    rsi14: ensureRange(rsi14, 0, 100, 50),
    bollingerUpper: bb.upper,
    bollingerMiddle: bb.middle,
    bollingerLower: bb.lower,
    bollingerBandwidth: bb.bandwidth,
    atr: ensureFinite(atr),
    atrRatio: ensureFinite(atrRatio),
    volume: ensureFinite(currentVolume),
    avgVolume: ensureFinite(avgVolume),
    volumeRatio: ensureFinite(volumeRatio),
    priceChange20: ensureFinite(priceChange20),
    deviationFromEMA20: ensureFinite(deviationFromEMA20),
    deviationFromEMA50: ensureFinite(deviationFromEMA50),
    recentHigh: ensureFinite(recentHigh),
    recentLow: ensureFinite(recentLow),
    resistanceLevels,
    supportLevels,
    candles, // 保留原始K线数据，供突破策略等使用
  };
}

/**
 * 多时间框架原始数据
 */
export interface MultiTimeframeAnalysis {
  symbol: string;
  timestamp: string;
  
  // 各时间框架原始数据
  timeframes: {
    veryshort?: TimeframeIndicators;
    short1?: TimeframeIndicators;
    short?: TimeframeIndicators;
    shortconfirm?: TimeframeIndicators;
    mediumshort?: TimeframeIndicators;
    medium?: TimeframeIndicators;
    mediumlong?: TimeframeIndicators;
  };
  
  // 关键价位（支撑阻力）
  keyLevels: {
    resistance: number[];
    support: number[];
  };
}

/**
 * 执行多时间框架分析（极简版 - 只提供原始数据）
 */
export async function performMultiTimeframeAnalysis(
  symbol: string,
  timeframesToUse: string[] = ["VERY_SHORT", "SHORT_1", "SHORT", "SHORT_CONFIRM", "MEDIUM_SHORT", "MEDIUM"]
): Promise<MultiTimeframeAnalysis> {
  logger.info(`获取 ${symbol} 多时间框架数据...`);
  
  const timeframes: MultiTimeframeAnalysis["timeframes"] = {};
  
  // 并行获取所有时间框架数据
  const promises: Promise<any>[] = [];
  
  for (const tfName of timeframesToUse) {
    const config = TIMEFRAMES[tfName];
    if (!config) continue;
    
    promises.push(
      analyzeTimeframe(symbol, config)
        .then(data => {
          const key = tfName.toLowerCase().replace(/_/g, "");
          timeframes[key as keyof typeof timeframes] = data;
        })
        .catch(error => {
          logger.debug(`获取 ${symbol} ${config.interval} 数据失败:`, error);
        })
    );
  }
  
  await Promise.all(promises);
  
  // 计算支撑阻力位（基于价格数据）
  const keyLevels = calculateKeyLevels(timeframes);
  
  const analysis: MultiTimeframeAnalysis = {
    symbol,
    timestamp: new Date().toISOString(),
    timeframes,
    keyLevels,
  };
  
  logger.info(`${symbol} 多时间框架数据获取完成`);
  
  return analysis;
}

/**
 * 计算关键价位（支撑阻力）
 */
function calculateKeyLevels(
  timeframes: MultiTimeframeAnalysis["timeframes"]
): MultiTimeframeAnalysis["keyLevels"] {
  const prices: number[] = [];
  
  // 收集所有时间框架的关键价格
  for (const [_, data] of Object.entries(timeframes)) {
    if (!data) continue;
    prices.push(data.currentPrice);
    prices.push(data.ema20);
    prices.push(data.ema50);
  }
  
  if (prices.length === 0) {
    return { resistance: [], support: [] };
  }
  
  // 简单的支撑阻力位计算（基于价格聚类）
  const currentPrice = timeframes.short?.currentPrice || timeframes.short1?.currentPrice || timeframes.medium?.currentPrice || 0;
  
  const resistance = prices
    .filter(p => p > currentPrice)
    .sort((a, b) => a - b)
    .slice(0, 3);
  
  const support = prices
    .filter(p => p < currentPrice)
    .sort((a, b) => b - a)
    .slice(0, 3);
  
  return {
    resistance,
    support,
  };
}

/**
 * 计算ATR (Average True Range)
 */
function calculateATR(candles: any[], period: number = 14): number {
  if (!candles || candles.length < period + 1) return 0;
  
  const trueRanges: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high || candles[i].h || "0");
    const low = parseFloat(candles[i].low || candles[i].l || "0");
    const prevClose = parseFloat(candles[i - 1].close || candles[i - 1].c || "0");
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }
  
  // 计算ATR（简单移动平均）
  if (trueRanges.length < period) return 0;
  
  const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  return ensureFinite(atr);
}

/**
 * 计算布林带 (Bollinger Bands)
 */
export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: number; middle: number; lower: number; bandwidth: number } {
  if (prices.length < period) {
    return { upper: 0, middle: 0, lower: 0, bandwidth: 0 };
  }
  
  // 计算SMA作为中轨
  const recentPrices = prices.slice(-period);
  const middle = recentPrices.reduce((a, b) => a + b, 0) / period;
  
  // 计算标准差
  const variance = recentPrices.reduce((sum, price) => {
    return sum + Math.pow(price - middle, 2);
  }, 0) / period;
  const std = Math.sqrt(variance);
  
  const upper = middle + stdDev * std;
  const lower = middle - stdDev * std;
  const bandwidth = upper - lower;
  
  return {
    upper: ensureFinite(upper),
    middle: ensureFinite(middle),
    lower: ensureFinite(lower),
    bandwidth: ensureFinite(bandwidth),
  };
}

/**
 * 检测MACD柱状线拐点
 * 返回: 1 (拐头向上), -1 (拐头向下), 0 (无明显拐点)
 */
export function detectMACDHistogramTurn(prices: number[]): number {
  if (prices.length < 30) return 0;
  
  const macdHistory: number[] = [];
  
  // 计算最近的MACD柱状线
  for (let i = 26; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const { histogram } = calculateMACD(slice);
    macdHistory.push(histogram);
  }
  
  if (macdHistory.length < 3) return 0;
  
  const latest = macdHistory[macdHistory.length - 1];
  const prev = macdHistory[macdHistory.length - 2];
  const prevPrev = macdHistory[macdHistory.length - 3];
  
  // 拐头向上：前面递减，现在开始递增
  if (prevPrev > prev && prev < latest && latest > 0) {
    return 1;
  }
  
  // 拐头向下：前面递增，现在开始递减
  if (prevPrev < prev && prev > latest && latest < 0) {
    return -1;
  }
  
  return 0;
}

/**
 * 识别近期高低点（支撑/阻力位）
 */
export function identifyRecentHighLow(
  candles: any[],
  lookback: number = 20
): { recentHigh: number; recentLow: number; resistanceLevels: number[]; supportLevels: number[] } {
  if (!candles || candles.length < lookback) {
    return { recentHigh: 0, recentLow: 0, resistanceLevels: [], supportLevels: [] };
  }
  
  const recentCandles = candles.slice(-lookback);
  
  let recentHigh = 0;
  let recentLow = Number.POSITIVE_INFINITY;
  
  const highs: number[] = [];
  const lows: number[] = [];
  
  for (const candle of recentCandles) {
    const high = parseFloat(candle.high || candle.h || "0");
    const low = parseFloat(candle.low || candle.l || "0");
    
    if (high > recentHigh) recentHigh = high;
    if (low < recentLow) recentLow = low;
    
    highs.push(high);
    lows.push(low);
  }
  
  // 识别局部高点作为阻力位
  const resistanceLevels: number[] = [];
  for (let i = 1; i < highs.length - 1; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) {
      resistanceLevels.push(highs[i]);
    }
  }
  
  // 识别局部低点作为支撑位
  const supportLevels: number[] = [];
  for (let i = 1; i < lows.length - 1; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) {
      supportLevels.push(lows[i]);
    }
  }
  
  return {
    recentHigh: ensureFinite(recentHigh),
    recentLow: ensureFinite(recentLow === Number.POSITIVE_INFINITY ? 0 : recentLow),
    resistanceLevels: resistanceLevels.sort((a, b) => b - a).slice(0, 3),
    supportLevels: supportLevels.sort((a, b) => b - a).slice(0, 3),
  };
}

/**
 * 计算趋势一致性评分（多时间框架对齐度）
 * 返回0-1的评分
 */
export function calculateTrendConsistency(
  ema20_short: number,
  ema50_short: number,
  ema20_medium: number,
  ema50_medium: number,
  macd_short: number,
  macd_medium: number
): number {
  let score = 0;
  
  // 短时间框架趋势方向
  const shortTrend = ema20_short > ema50_short ? 1 : -1;
  const shortMomentum = macd_short > 0 ? 1 : -1;
  
  // 中期时间框架趋势方向
  const mediumTrend = ema20_medium > ema50_medium ? 1 : -1;
  const mediumMomentum = macd_medium > 0 ? 1 : -1;
  
  // EMA趋势一致性 (40%)
  if (shortTrend === mediumTrend) {
    score += 0.4;
  }
  
  // MACD动量一致性 (30%)
  if (shortMomentum === mediumMomentum) {
    score += 0.3;
  }
  
  // EMA和MACD内部一致性 (30%)
  if (shortTrend === shortMomentum) {
    score += 0.15;
  }
  if (mediumTrend === mediumMomentum) {
    score += 0.15;
  }
  
  return ensureRange(score, 0, 1, 0.5);
}

/**
 * 计算价格偏离度（距离关键均线的百分比）
 */
export function calculatePriceDeviation(
  currentPrice: number,
  ema20: number,
  ema50: number
): { deviationFromEMA20: number; deviationFromEMA50: number } {
  const deviationFromEMA20 = ema20 !== 0 
    ? ((currentPrice - ema20) / ema20) * 100 
    : 0;
  
  const deviationFromEMA50 = ema50 !== 0 
    ? ((currentPrice - ema50) / ema50) * 100 
    : 0;
  
  return {
    deviationFromEMA20: ensureFinite(deviationFromEMA20),
    deviationFromEMA50: ensureFinite(deviationFromEMA50),
  };
}

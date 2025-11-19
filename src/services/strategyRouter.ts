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
 * 策略路由器
 * 
 * 根据市场状态自动选择最优策略
 */

import { createLogger } from "../utils/logger";
import { analyzeMarketState } from "./marketStateAnalyzer";
import { performMultiTimeframeAnalysis } from "./multiTimeframeAnalysis";
import { trendFollowingStrategy } from "../strategies/trendFollowingStrategy";
import { meanReversionStrategy } from "../strategies/meanReversionStrategy";
import { breakoutStrategy } from "../strategies/breakoutStrategy";
import { getExchangeClient } from "../exchanges";
import type { StrategyResult } from "../types/marketState";

const logger = createLogger({
  name: "strategy-router",
  level: "info",
});

/**
 * 策略路由器 - 根据市场状态选择最优策略
 * 
 * @param symbol 交易品种
 * @returns 策略结果
 */
export async function routeStrategy(symbol: string): Promise<StrategyResult> {
  logger.info(`为 ${symbol} 路由策略...`);
  
  // 1. 分析市场状态
  const marketState = await analyzeMarketState(symbol);
  
  // 2. 获取多时间框架数据（供策略使用）
  const mtfData = await performMultiTimeframeAnalysis(symbol, ["SHORT_CONFIRM", "MEDIUM"]);
  
  const tf15m = mtfData.timeframes.shortconfirm;
  const tf1h = mtfData.timeframes.medium;
  
  if (!tf15m || !tf1h) {
    return {
      symbol,
      action: "wait",
      confidence: "low",
      signalStrength: 0,
      opportunityScore: 0,
      recommendedLeverage: 0,
      marketState: marketState.state,
      strategyType: "none",
      reason: "无法获取时间框架数据",
      keyMetrics: {
        rsi7: 0,
        rsi14: 0,
        macd: 0,
        ema20: 0,
        ema50: 0,
        price: 0,
        atrRatio: 0,
      },
      timestamp: new Date().toISOString(),
    };
  }
  
  // 3. 根据市场状态路由到相应策略
  let baseResult: any;
  
  switch (marketState.state) {
    case "uptrend_oversold":
      // 上涨趋势中的超卖 -> 趋势跟踪做多
      logger.info(`${symbol}: 上涨趋势中的超卖，使用趋势跟踪做多策略`);
      baseResult = await trendFollowingStrategy(symbol, "long", marketState, tf15m, tf1h);
      break;
      
    case "downtrend_overbought":
      // 下跌趋势中的超买 -> 趋势跟踪做空
      logger.info(`${symbol}: 下跌趋势中的超买，使用趋势跟踪做空策略`);
      baseResult = await trendFollowingStrategy(symbol, "short", marketState, tf15m, tf1h);
      break;
      
    case "downtrend_oversold":
      // 🔧 新增：下跌趋势中的超卖 -> 均值回归做多（逆势反弹）
      logger.info(`${symbol}: 下跌趋势中的超卖，使用均值回归做多策略（逆势反弹）`);
      baseResult = await meanReversionStrategy(symbol, "long", marketState, tf15m, tf1h);
      break;
      
    case "uptrend_overbought":
      // 🔧 新增：上涨趋势中的超买 -> 均值回归做空（逆势回调）
      logger.info(`${symbol}: 上涨趋势中的超买，使用均值回归做空策略（逆势回调）`);
      baseResult = await meanReversionStrategy(symbol, "short", marketState, tf15m, tf1h);
      break;
      
    case "uptrend_continuation":
      // 上涨趋势延续 -> 趋势跟踪做多（较低置信度）
      logger.info(`${symbol}: 上涨趋势延续，使用趋势跟踪做多策略`);
      baseResult = await trendFollowingStrategy(symbol, "long", marketState, tf15m, tf1h);
      break;
      
    case "downtrend_continuation":
      // 下跌趋势延续 -> 趋势跟踪做空（较低置信度）
      logger.info(`${symbol}: 下跌趋势延续，使用趋势跟踪做空策略`);
      baseResult = await trendFollowingStrategy(symbol, "short", marketState, tf15m, tf1h);
      break;
      
    case "ranging_oversold":
      // 震荡市超卖 -> 均值回归做多
      logger.info(`${symbol}: 震荡市超卖，使用均值回归做多策略`);
      baseResult = await meanReversionStrategy(symbol, "long", marketState, tf15m, tf1h);
      break;
      
    case "ranging_overbought":
      // 震荡市超买 -> 均值回归做空
      logger.info(`${symbol}: 震荡市超买，使用均值回归做空策略`);
      baseResult = await meanReversionStrategy(symbol, "short", marketState, tf15m, tf1h);
      break;
      
    case "ranging_neutral":
    case "no_clear_signal":
    default:
      // 无明确信号 -> 观望
      logger.info(`${symbol}: 无明确信号，建议观望`);
      baseResult = {
        symbol,
        action: "wait",
        confidence: "low",
        signalStrength: 0,
        recommendedLeverage: 0,
        marketState: marketState.state,
        strategyType: "none",
        reason: `市场状态: ${marketState.state}，暂无明确交易信号`,
        keyMetrics: {
          rsi7: tf15m.rsi7,
          rsi14: tf15m.rsi14,
          macd: tf15m.macd,
          ema20: tf1h.ema20,
          ema50: tf1h.ema50,
          price: tf15m.currentPrice,
          atrRatio: tf1h.atrRatio,
        },
      };
  }
  
  // 4. 获取24h成交量数据（用于流动性评分）
  let volume24h: number | undefined;
  try {
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(symbol);
    const ticker = await exchangeClient.getFuturesTicker(contract);
    volume24h = Number.parseFloat(ticker.volume24h || "0");
  } catch (error) {
    logger.warn(`获取 ${symbol} 的24h成交量失败，将使用静态评分`, error);
  }
  
  // 5. 添加缺失的字段并返回完整结果
  const result: StrategyResult = {
    ...baseResult,
    opportunityScore: 0, // 将在机会评分系统中计算
    keyMetrics: {
      ...baseResult.keyMetrics,
      volume24h, // 添加24h成交量
    },
    timestamp: new Date().toISOString(),
  };
  
  logger.info(`${symbol} 策略路由完成: ${result.strategyType} - ${result.action}`);
  
  return result;
}

/**
 * 批量路由策略
 * 
 * @param symbols 交易品种列表
 * @returns 策略结果映射
 */
export async function routeMultipleStrategies(
  symbols: string[]
): Promise<Map<string, StrategyResult>> {
  logger.info(`为 ${symbols.length} 个品种批量路由策略...`);
  
  const results = new Map<string, StrategyResult>();
  
  // 并发路由所有品种
  const promises = symbols.map(async (symbol) => {
    try {
      const result = await routeStrategy(symbol);
      results.set(symbol, result);
    } catch (error) {
      logger.error(`路由 ${symbol} 策略失败:`, error);
    }
  });
  
  await Promise.all(promises);
  
  logger.info(`完成策略路由，成功: ${results.size}/${symbols.length}`);
  
  return results;
}

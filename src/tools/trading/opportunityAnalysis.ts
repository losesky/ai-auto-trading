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
 * 开仓机会分析工具
 * 
 * 这是TradingAgent调用的主要工具，用于获取当前最佳开仓机会
 * 
 * 核心流程：
 * 1. 获取所有交易对的市场数据（并发请求）
 * 2. 对每个币种进行市场状态分析
 * 3. 调用策略路由器生成开仓建议
 * 4. 使用机会评分系统进行量化评分
 * 5. 过滤掉已有持仓的币种
 * 6. 返回评分最高的前N个机会
 */

import { createTool } from "@voltagent/core";
import { z } from "zod";
import { createLogger } from "../../utils/logger";
import { createClient } from "@libsql/client";
import { analyzeMultipleMarketStates } from "../../services/marketStateAnalyzer";
import { routeMultipleStrategies } from "../../services/strategyRouter";
import { scoreAndRankOpportunities } from "../../services/opportunityScorer";

const logger = createLogger({
  name: "analyze-opportunities",
  level: "info",
});

// 环境变量配置
const MIN_OPPORTUNITY_SCORE = Number.parseInt(process.env.MIN_OPPORTUNITY_SCORE || "75", 10);
const MAX_OPPORTUNITIES_TO_SHOW = Number.parseInt(process.env.MAX_OPPORTUNITIES_TO_SHOW || "3", 10);

const analyzeOpeningOpportunitiesSchema = z.object({
  symbols: z.array(z.string()).optional().describe("要分析的交易品种列表，如果不提供则使用环境变量中配置的交易品种"),
  minScore: z.number().optional().describe("最低机会评分阈值（0-100），默认使用环境变量配置"),
  maxResults: z.number().optional().describe("⚠️ 此参数已废弃，系统将强制使用环境变量 MAX_OPPORTUNITIES_TO_SHOW 的配置值"),
  includeOpenPositions: z.boolean().optional().describe("是否包含已有持仓的币种，默认false（自动过滤）"),
});

/**
 * 分析开仓机会工具
 */
export const analyzeOpeningOpportunitiesTool = createTool({
  name: "analyze_opening_opportunities",
  description: `分析当前市场的最佳开仓机会。

这个工具会：
1. 自动识别每个币种的市场状态（上涨趋势、下跌趋势、震荡等）
2. 根据市场状态选择最优策略（趋势跟踪、均值回归、突破）
3. 对所有机会进行量化评分（0-100分）
4. 自动过滤已有持仓的币种
5. 返回评分最高的前N个开仓机会（N由环境变量 MAX_OPPORTUNITIES_TO_SHOW 控制）

返回的每个机会包含：
- 机会评分（0-100）
- 推荐动作（long/short/wait）
- 市场状态
- 策略类型
- 推荐杠杆
- 信号强度
- 详细理由
- 关键指标

⚠️ 重要提示：
- 返回数量由系统配置决定，不要传入 maxResults 参数
- 最低评分阈值由环境变量 MIN_OPPORTUNITY_SCORE 控制
- 工具会自动过滤已有持仓的币种

建议使用场景：
- 当需要评估新的开仓机会时
- 当账户有可用余额但没有持仓时
- 定期检查市场机会（如每15分钟）

注意：此工具只提供开仓建议，实际开仓决策由AI根据全局情况判断。`,
  parameters: analyzeOpeningOpportunitiesSchema,
  execute: async ({ symbols: inputSymbols, minScore = MIN_OPPORTUNITY_SCORE, maxResults, includeOpenPositions = false }) => {

    try {
      logger.info("🔍 开始分析开仓机会...");
      
      // 强制使用配置的最大显示数量，忽略 AI 传入的参数
      const effectiveMaxResults = MAX_OPPORTUNITIES_TO_SHOW;
      if (maxResults !== undefined && maxResults !== effectiveMaxResults) {
        logger.warn(`⚠️ AI 传入 maxResults=${maxResults}，已强制使用配置值 ${effectiveMaxResults}`);
      }

      // 1. 确定要分析的交易品种列表
      let symbolsToAnalyze: string[];
      
      if (inputSymbols && inputSymbols.length > 0) {
        symbolsToAnalyze = inputSymbols;
      } else {
        // 从环境变量获取交易品种
        const envSymbols = process.env.TRADING_SYMBOLS || "BTC,ETH,SOL";
        symbolsToAnalyze = envSymbols.split(",").map(s => s.trim());
      }

      logger.info(`  分析品种数量: ${symbolsToAnalyze.length}`);
      logger.info(`  品种列表: ${symbolsToAnalyze.join(", ")}`);

      // 2. 获取当前持仓（用于过滤）
      let openPositionSymbols: string[] = [];
      
      if (!includeOpenPositions) {
        const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
        const dbClient = createClient({ url: dbUrl });
        
        // positions表没有status字段，通过quantity != 0判断是否有持仓
        const openPositions = await dbClient.execute(
          "SELECT symbol FROM positions WHERE quantity != 0"
        );
        
        openPositionSymbols = openPositions.rows.map((p: any) => p.symbol as string);
        
        if (openPositionSymbols.length > 0) {
          logger.info(`  当前持仓: ${openPositionSymbols.join(", ")}`);
          
          // 过滤掉已有持仓的品种
          symbolsToAnalyze = symbolsToAnalyze.filter(s => !openPositionSymbols.includes(s));
          logger.info(`  过滤后待分析: ${symbolsToAnalyze.length} 个品种`);
        }
      }

      // 如果没有可分析的品种，直接返回
      if (symbolsToAnalyze.length === 0) {
        return {
          success: true,
          totalAnalyzed: 0,
          opportunitiesFound: 0,
          topOpportunities: [],
          message: "所有配置的交易品种都已有持仓，无新的开仓机会",
          timestamp: new Date().toISOString(),
        };
      }

      // 3. 并发分析市场状态
      logger.info("📊 步骤1/3: 分析市场状态...");
      const marketStates = await analyzeMultipleMarketStates(symbolsToAnalyze);
      logger.info(`  ✓ 完成: ${marketStates.size}/${symbolsToAnalyze.length} 个品种`);

      // 4. 并发路由策略
      logger.info("🎯 步骤2/3: 路由策略...");
      const strategyResults = await routeMultipleStrategies(symbolsToAnalyze);
      logger.info(`  ✓ 完成: ${strategyResults.size}/${symbolsToAnalyze.length} 个品种`);

      // 5. 评分和排序
      logger.info("📈 步骤3/3: 评分和排序...");
      const resultArray = Array.from(strategyResults.values());
      const rankedOpportunities = scoreAndRankOpportunities(resultArray, marketStates, undefined, minScore);
      
      // 限制返回数量（使用强制的配置值）
      const topOpportunities = rankedOpportunities.slice(0, effectiveMaxResults);
      
      logger.info(`  ✓ 发现 ${rankedOpportunities.length} 个评分达标的机会`);
      logger.info(`  ✓ 返回前 ${topOpportunities.length} 个最佳机会`);

      // 6. 格式化输出
      const formattedOpportunities = topOpportunities.map((opp, index) => {
        const result = strategyResults.get(opp.symbol)!;
        const state = marketStates.get(opp.symbol)!;

        return {
          rank: index + 1,
          symbol: opp.symbol,
          score: opp.totalScore,
          action: result.action,
          confidence: opp.confidence,
          marketState: state.state,
          strategyType: result.strategyType,
          recommendedLeverage: result.recommendedLeverage,
          signalStrength: Math.round(result.signalStrength * 100),
          reason: result.reason,
          keyMetrics: {
            rsi7: result.keyMetrics.rsi7,
            rsi14: result.keyMetrics.rsi14,
            macd: result.keyMetrics.macd,
            ema20: result.keyMetrics.ema20,
            ema50: result.keyMetrics.ema50,
            price: result.keyMetrics.price,
            atrRatio: result.keyMetrics.atrRatio,
          },
          scoreBreakdown: {
            signalStrength: `${opp.breakdown.signalStrength}/30`,
            trendConsistency: `${opp.breakdown.trendConsistency}/25`,
            volatilityFit: `${opp.breakdown.volatilityFit}/20`,
            riskRewardRatio: `${opp.breakdown.riskRewardRatio}/15`,
            liquidity: `${opp.breakdown.liquidity}/10`,
          },
          marketStateDetails: {
            trendStrength: state.trendStrength,
            momentumState: state.momentumState,
            volatilityState: state.volatilityState,
            stateConfidence: Math.round(state.confidence * 100),
            timeframeAlignment: state.timeframeAlignment.is15mAnd1hAligned,
            alignmentScore: Math.round(state.timeframeAlignment.alignmentScore * 100),
          },
        };
      });

      // 7. 构建结果
      const result = {
        success: true,
        totalAnalyzed: symbolsToAnalyze.length,
        opportunitiesFound: rankedOpportunities.length,
        topOpportunities: formattedOpportunities,
        filterInfo: {
          minScore,
          maxResults: effectiveMaxResults,
          openPositionsFiltered: openPositionSymbols,
        },
        marketSummary: generateMarketSummary(marketStates),
        timestamp: new Date().toISOString(),
      };

      logger.info(`✅ 分析完成! 发现 ${rankedOpportunities.length} 个机会，返回前 ${topOpportunities.length} 个`);

      return result;

    } catch (error) {
      logger.error("❌ 分析开仓机会失败:", error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        totalAnalyzed: 0,
        opportunitiesFound: 0,
        topOpportunities: [],
        timestamp: new Date().toISOString(),
      };
    }
  },
});

/**
 * 生成市场概况摘要
 */
function generateMarketSummary(marketStates: Map<string, any>): any {
  const summary: any = {
    total: marketStates.size,
    byState: {} as Record<string, number>,
    byTrend: {} as Record<string, number>,
    byMomentum: {} as Record<string, number>,
  };

  for (const state of marketStates.values()) {
    // 统计市场状态
    summary.byState[state.state] = (summary.byState[state.state] || 0) + 1;
    
    // 统计趋势
    summary.byTrend[state.trendStrength] = (summary.byTrend[state.trendStrength] || 0) + 1;
    
    // 统计动量
    summary.byMomentum[state.momentumState] = (summary.byMomentum[state.momentumState] || 0) + 1;
  }

  return summary;
}

export default analyzeOpeningOpportunitiesTool;

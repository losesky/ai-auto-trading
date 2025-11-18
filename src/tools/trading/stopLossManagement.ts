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
 * 止损管理工具
 * 为 AI Agent 提供科学止损计算和管理接口
 */

import { createTool } from "@voltagent/core";
import { z } from "zod";
import { createClient } from "@libsql/client";
import { createLogger } from "../../utils/logger";
import { RISK_PARAMS } from "../../config/riskParams";
import { formatStopLossPrice } from "../../utils/priceFormatter";
import {
  calculateScientificStopLoss,
  shouldOpenPosition,
  updateTrailingStopLoss,
  DEFAULT_STOP_LOSS_CONFIG,
  type StopLossConfig,
} from "../../services/stopLossCalculator";

const logger = createLogger({
  name: "stop-loss-management",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * 计算科学止损位工具
 */
export const calculateStopLossTool = createTool({
  name: "calculateStopLoss",
  description: `计算科学止损位 - 基于ATR（平均真实波幅）和支撑/阻力位的综合止损策略。
  
核心理念：
- ATR止损：自适应市场波动，高波动时自动放宽，低波动时自动收紧
- 支撑/阻力止损：基于市场结构的关键位置，提高盈亏比
- 综合策略：结合两者优势，选择更保守的止损位

⚠️ 重要说明：
- 返回的 stopLossDistancePercent 是"价格变化百分比"（不含杠杆）
- 实际盈亏百分比 = stopLossDistancePercent × 杠杆倍数
- 例如：2% 止损距离 × 10倍杠杆 = -20% 实际亏损
- 比较时请注意单位统一！

返回结果包含：
- 推荐止损价格
- 止损距离百分比（价格距离，不含杠杆）
- 市场波动率评估
- 风险建议
- 质量评分（0-100）`,
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    side: z.enum(["long", "short"]).describe("方向：long=做多，short=做空"),
    entryPrice: z.number().describe("入场价格"),
    timeframe: z.enum(["1m", "5m", "15m", "1h", "4h"]).optional().describe("K线周期（默认1h）"),
  }),
  execute: async ({ symbol, side, entryPrice, timeframe = "1h" }) => {
    try {
      if (!RISK_PARAMS.ENABLE_SCIENTIFIC_STOP_LOSS) {
        return {
          success: false,
          message: "科学止损系统未启用，请在环境变量中设置 ENABLE_SCIENTIFIC_STOP_LOSS=true",
        };
      }

      // 构建止损配置
      const config: StopLossConfig = {
        atrPeriod: RISK_PARAMS.ATR_PERIOD,
        atrMultiplier: RISK_PARAMS.ATR_MULTIPLIER,
        lookbackPeriod: RISK_PARAMS.SUPPORT_RESISTANCE_LOOKBACK,
        bufferPercent: RISK_PARAMS.SUPPORT_RESISTANCE_BUFFER,
        useATR: RISK_PARAMS.USE_ATR_STOP_LOSS,
        useSupportResistance: RISK_PARAMS.USE_SUPPORT_RESISTANCE_STOP_LOSS,
        minStopLossPercent: RISK_PARAMS.MIN_STOP_LOSS_PERCENT,
        maxStopLossPercent: RISK_PARAMS.MAX_STOP_LOSS_PERCENT,
      };

      const result = await calculateScientificStopLoss(
        symbol,
        side,
        entryPrice,
        config,
        timeframe
      );

      // 提取币种符号用于价格格式化（如 BTC_USDT -> BTC）
      const symbolName = symbol.replace(/_USDT$/, '').replace(/USDT$/, '');
      
      return {
        success: true,
        data: {
          symbol,
          side,
          entryPrice,
          stopLossPrice: result.stopLossPrice,
          stopLossDistancePercent: result.stopLossDistancePercent.toFixed(2),
          method: result.method,
          atr: result.details.atr !== undefined ? formatStopLossPrice(symbolName, result.details.atr) : undefined,
          atrPercent: result.details.atrPercent?.toFixed(2),
          supportLevel: result.details.supportLevel !== undefined ? formatStopLossPrice(symbolName, result.details.supportLevel) : undefined,
          resistanceLevel: result.details.resistanceLevel !== undefined ? formatStopLossPrice(symbolName, result.details.resistanceLevel) : undefined,
          qualityScore: result.qualityScore,
          volatilityLevel: result.riskAssessment.volatilityLevel,
          isNoisy: result.riskAssessment.isNoisy,
          recommendation: result.riskAssessment.recommendation,
        },
        message: `✅ 止损计算完成
- 入场价: ${formatStopLossPrice(symbolName, entryPrice)}
- 止损价: ${formatStopLossPrice(symbolName, result.stopLossPrice)}
- 止损距离: ${result.stopLossDistancePercent.toFixed(2)}% (价格距离，不含杠杆)
- 计算方法: ${result.method}
- 波动率: ${result.riskAssessment.volatilityLevel}
- 质量评分: ${result.qualityScore}/100
- 建议: ${result.riskAssessment.recommendation}
⚠️ 注意：实际亏损 = ${result.stopLossDistancePercent.toFixed(2)}% × 杠杆倍数`,
      };
    } catch (error: any) {
      logger.error(`计算止损失败: ${error.message}`);
      return {
        success: false,
        message: `计算止损失败: ${error.message}`,
      };
    }
  },
});

/**
 * 检查开仓合理性工具（基于止损）
 */
export const checkOpenPositionTool = createTool({
  name: "checkOpenPosition",
  description: `开仓前检查工具 - 基于止损合理性判断是否应该开仓。这是一个"过滤器"，帮助避免以下情况：
  
1. 止损距离过大，风险回报比不佳
2. 市场波动极端剧烈
3. 止损质量评分过低

建议：在执行 openPosition 之前，先调用此工具检查。如果返回 shouldOpen=false，建议放弃此次交易机会。`,
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    side: z.enum(["long", "short"]).describe("方向：long=做多，short=做空"),
    entryPrice: z.number().describe("计划入场价格（当前市场价）"),
  }),
  execute: async ({ symbol, side, entryPrice }) => {
    try {
      if (!RISK_PARAMS.ENABLE_STOP_LOSS_FILTER) {
        return {
          success: true,
          shouldOpen: true,
          message: "止损过滤器未启用，允许开仓",
        };
      }

      const config: StopLossConfig = {
        atrPeriod: RISK_PARAMS.ATR_PERIOD,
        atrMultiplier: RISK_PARAMS.ATR_MULTIPLIER,
        lookbackPeriod: RISK_PARAMS.SUPPORT_RESISTANCE_LOOKBACK,
        bufferPercent: RISK_PARAMS.SUPPORT_RESISTANCE_BUFFER,
        useATR: RISK_PARAMS.USE_ATR_STOP_LOSS,
        useSupportResistance: RISK_PARAMS.USE_SUPPORT_RESISTANCE_STOP_LOSS,
        minStopLossPercent: RISK_PARAMS.MIN_STOP_LOSS_PERCENT,
        maxStopLossPercent: RISK_PARAMS.MAX_STOP_LOSS_PERCENT,
      };

      const checkResult = await shouldOpenPosition(symbol, side, entryPrice, config);

      if (checkResult.shouldOpen) {
        return {
          success: true,
          shouldOpen: true,
          data: checkResult.stopLossResult
            ? {
                stopLossPrice: checkResult.stopLossResult.stopLossPrice,
                stopLossDistancePercent: checkResult.stopLossResult.stopLossDistancePercent.toFixed(2),
                qualityScore: checkResult.stopLossResult.qualityScore,
                volatilityLevel: checkResult.stopLossResult.riskAssessment.volatilityLevel,
              }
            : undefined,
          message: `✅ ${checkResult.reason}`,
        };
      } else {
        return {
          success: true,
          shouldOpen: false,
          data: checkResult.stopLossResult
            ? {
                stopLossPrice: checkResult.stopLossResult.stopLossPrice,
                stopLossDistancePercent: checkResult.stopLossResult.stopLossDistancePercent.toFixed(2),
                qualityScore: checkResult.stopLossResult.qualityScore,
                volatilityLevel: checkResult.stopLossResult.riskAssessment.volatilityLevel,
              }
            : undefined,
          message: `⚠️ 不建议开仓: ${checkResult.reason}`,
        };
      }
    } catch (error: any) {
      logger.error(`检查开仓条件失败: ${error.message}`);
      return {
        success: false,
        shouldOpen: false,
        message: `检查失败: ${error.message}`,
      };
    }
  },
});

/**
 * 更新移动止损工具
 */
export const updateTrailingStopTool = createTool({
  name: "updateTrailingStop",
  description: `更新移动止损 - 动态调整止损位，基于当前市场波动优化保护。
  
🔒 核心保护原则（严格执行）：
- ✅ 多单：只能上移止损（新止损 > 旧止损），锁定利润
- ✅ 空单：只能下移止损（新止损 < 旧止损），锁定利润
- ❌ 绝不允许：多单下移止损 或 空单上移止损（会扩大风险）

📐 科学计算方法：
1. 基于当前价格（而非入场价格）重新计算止损位
2. 考虑当前市场的 ATR 波动率
3. 参考当前的支撑/阻力位
4. 严格验证止损移动方向

🎯 工作流程：
1. 使用当前价格和当前 ATR 重新计算科学止损位
2. 比较新止损与旧止损的关系
3. 多单：如果新止损更高（向上移动），允许更新
4. 空单：如果新止损更低（向下移动），允许更新
5. 否则拒绝更新，保持现有保护水平

⚠️ 重要提示：
- 此工具只返回建议，不会实际修改交易所的止损单
- 如需实际修改，请使用 updatePositionStopLoss 工具
- updatePositionStopLoss 工具内部也有方向验证，双重保护

适用场景：
- 定期检查（如每15-30分钟）是否可以优化止损
- 价格大幅移动后，重新评估合理止损位
- 市场波动率变化，需要调整止损空间
- 持仓盈利达到一定阈值（如 +3%, +5%），考虑上移止损锁定利润`,
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    side: z.enum(["long", "short"]).describe("方向"),
    entryPrice: z.number().describe("入场价格"),
    currentPrice: z.number().describe("当前市场价格"),
    currentStopLoss: z.number().describe("当前止损价格"),
  }),
  execute: async ({ symbol, side, entryPrice, currentPrice, currentStopLoss }) => {
    try {
      if (!RISK_PARAMS.ENABLE_TRAILING_STOP_LOSS) {
        return {
          success: false,
          message: "移动止损未启用，请在环境变量中设置 ENABLE_TRAILING_STOP_LOSS=true",
        };
      }

      // 🔒 冷却期检查：防止在分批止盈后立即移动止损
      // 检查该持仓是否在最近5分钟内执行过分批止盈
      const recentPartialTakeProfit = await dbClient.execute({
        sql: `SELECT timestamp FROM partial_take_profit_history 
              WHERE symbol = ? AND status = 'completed' 
              ORDER BY timestamp DESC LIMIT 1`,
        args: [symbol],
      });

      if (recentPartialTakeProfit.rows.length > 0) {
        const lastExecutionTime = new Date(recentPartialTakeProfit.rows[0].timestamp as string);
        const now = new Date();
        const minutesSinceLastExecution = (now.getTime() - lastExecutionTime.getTime()) / (1000 * 60);
        
        // 如果在最近5分钟内执行过分批止盈,拒绝移动止损
        if (minutesSinceLastExecution < 5) {
          logger.info(`${symbol} 在 ${minutesSinceLastExecution.toFixed(1)} 分钟前刚执行过分批止盈，冷却期内拒绝移动止损`);
          return {
            success: false,
            message: `${symbol} 在 ${minutesSinceLastExecution.toFixed(1)} 分钟前刚执行过分批止盈，本周期无需再次调整止损（冷却期：5分钟）`,
          };
        }
      }

      const config: StopLossConfig = {
        atrPeriod: RISK_PARAMS.ATR_PERIOD,
        atrMultiplier: RISK_PARAMS.ATR_MULTIPLIER,
        lookbackPeriod: RISK_PARAMS.SUPPORT_RESISTANCE_LOOKBACK,
        bufferPercent: RISK_PARAMS.SUPPORT_RESISTANCE_BUFFER,
        useATR: RISK_PARAMS.USE_ATR_STOP_LOSS,
        useSupportResistance: RISK_PARAMS.USE_SUPPORT_RESISTANCE_STOP_LOSS,
        minStopLossPercent: RISK_PARAMS.MIN_STOP_LOSS_PERCENT,
        maxStopLossPercent: RISK_PARAMS.MAX_STOP_LOSS_PERCENT,
      };

      const updateResult = await updateTrailingStopLoss(
        symbol,
        side,
        entryPrice,
        currentPrice,
        currentStopLoss,
        config
      );

      // 提取币种符号用于价格格式化
      const symbolName = symbol.replace(/_USDT$/, '').replace(/USDT$/, '');
      
      if (updateResult.shouldUpdate && updateResult.newStopLoss) {
        return {
          success: true,
          shouldUpdate: true,
          data: {
            oldStopLoss: currentStopLoss,
            newStopLoss: updateResult.newStopLoss,
            improvement: ((Math.abs(updateResult.newStopLoss - currentStopLoss) / currentStopLoss) * 100).toFixed(2),
          },
          message: `✅ ${updateResult.reason}
- 旧止损: ${formatStopLossPrice(symbolName, currentStopLoss)}
- 新止损: ${formatStopLossPrice(symbolName, updateResult.newStopLoss)}
💡 提示：使用 updatePositionStopLoss 工具实际更新交易所的止损单`,
        };
      } else {
        return {
          success: true,
          shouldUpdate: false,
          message: `ℹ️ ${updateResult.reason}`,
        };
      }
    } catch (error: any) {
      logger.error(`更新移动止损失败: ${error.message}`);
      return {
        success: false,
        message: `更新失败: ${error.message}`,
      };
    }
  },
});

/**
 * 更新持仓止损单工具（实际修改交易所订单）
 */
export const updatePositionStopLossTool = createTool({
  name: "updatePositionStopLoss",
  description: `更新持仓的止损止盈订单 - 直接修改交易所服务器端的止损单。

🔒 内置双重保护机制：
1. 工具层验证：updateTrailingStop 检查并建议
2. 执行层验证：updatePositionStopLoss 再次验证方向
- ✅ 多单：新止损 > 旧止损 才允许执行
- ✅ 空单：新止损 < 旧止损 才允许执行
- ❌ 任何扩大风险的操作都会被拒绝

✨ 核心功能：
- 取消旧的止损止盈订单
- 创建新的止损止盈订单
- 适用于 Gate.io 和 Binance 两个交易所
- 自动保存到数据库

使用场景：
1. 移动止损：优化止损保护（多单上移/空单下移）
2. 调整止盈：根据市场情况修改目标价位
3. 重新设置：市场波动变化后重新计算

🔄 建议工作流（两步法，更安全）：
步骤1: 先调用 updateTrailingStop 检查是否需要更新
  const check = await updateTrailingStop({
    symbol, side, entryPrice, currentPrice, currentStopLoss
  });

步骤2: 如果 shouldUpdate=true，再调用此工具实际更新
  if (check.shouldUpdate) {
    await updatePositionStopLoss({
      symbol,
      stopLoss: check.data.newStopLoss
    });
  }

⚡ 快速方法（单步法，直接更新）：
也可以直接调用此工具，内部会自动验证方向：
  await updatePositionStopLoss({
    symbol: "BTC_USDT",
    stopLoss: 51500,  // 新止损价
    takeProfit: 55000 // 新止盈价（可选）
  });

⚠️ 安全保证：
无论使用哪种方法，系统都会严格验证止损移动方向，
确保不会出现多单止损下移或空单止损上移的错误行为。`,
  parameters: z.object({
    symbol: z.enum(RISK_PARAMS.TRADING_SYMBOLS).describe("币种代码"),
    stopLoss: z.number().optional().describe("新的止损价格（可选，不传则取消止损）"),
    takeProfit: z.number().optional().describe("新的止盈价格（可选，不传则取消止盈）"),
  }),
  execute: async ({ symbol, stopLoss, takeProfit }) => {
    try {
      const { getExchangeClient } = await import("../../exchanges/index.js");
      const exchangeClient = getExchangeClient();
      const contract = exchangeClient.normalizeContract(symbol);

      // 获取当前持仓
      const positions = await exchangeClient.getPositions();
      const position = positions.find((p: any) => {
        const posSymbol = exchangeClient.extractSymbol(p.contract);
        return posSymbol === symbol;
      });

      if (!position || Math.abs(parseFloat(position.size)) === 0) {
        return {
          success: false,
          message: `未找到 ${symbol} 的持仓，无法设置止损`,
        };
      }

      // 🔥 关键保护：如果提供了新止损价，必须验证方向
      if (stopLoss !== undefined) {
        // 从数据库读取当前止损价
        const { createClient } = await import("@libsql/client");
        const dbClient = createClient({
          url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
        });
        
        const result = await dbClient.execute({
          sql: "SELECT stop_loss, side, entry_price FROM positions WHERE symbol = ?",
          args: [symbol],
        });
        
        if (result.rows.length > 0) {
          const currentStopLoss = result.rows[0].stop_loss ? Number(result.rows[0].stop_loss) : null;
          const side = result.rows[0].side as 'long' | 'short';
          const entryPrice = Number(result.rows[0].entry_price);
          
          // 如果已存在止损，验证移动方向
          if (currentStopLoss && currentStopLoss > 0) {
            const isValidMove = side === 'long' 
              ? stopLoss > currentStopLoss  // 多单：新止损必须更高
              : stopLoss < currentStopLoss; // 空单：新止损必须更低
            
            if (!isValidMove) {
              const symbolName = symbol.replace(/_USDT$/, '').replace(/USDT$/, '');
              logger.warn(`❌ 止损移动方向错误！${symbol} ${side}`, {
                currentStopLoss: formatStopLossPrice(symbolName, currentStopLoss),
                newStopLoss: formatStopLossPrice(symbolName, stopLoss),
                direction: side === 'long' ? '多单只能上移' : '空单只能下移'
              });
              
              return {
                success: false,
                message: `❌ 止损移动方向错误！${side === 'long' ? '多单' : '空单'}止损${side === 'long' ? '不能下移' : '不能上移'}（当前: ${formatStopLossPrice(symbolName, currentStopLoss)}, 新: ${formatStopLossPrice(symbolName, stopLoss)}）`,
              };
            }
            
            // 验证通过，记录日志
            const improvement = Math.abs(stopLoss - currentStopLoss);
            const improvementPercent = (improvement / currentStopLoss) * 100;
            const symbolName = symbol.replace(/_USDT$/, '').replace(/USDT$/, '');
            logger.info(`✅ 止损移动验证通过: ${symbol} ${side}`, {
              old: formatStopLossPrice(symbolName, currentStopLoss),
              new: formatStopLossPrice(symbolName, stopLoss),
              improvement: `${improvementPercent.toFixed(2)}%`,
              direction: side === 'long' ? '上移' : '下移'
            });
          }
        }
      }

      // 🔧 如果没有传 takeProfit，从数据库读取原来的止盈价格，保持不变
      if (takeProfit === undefined) {
        try {
          const { createClient } = await import("@libsql/client");
          const dbClient = createClient({
            url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
          });
          
          const result = await dbClient.execute({
            sql: "SELECT profit_target FROM positions WHERE symbol = ?",
            args: [symbol],
          });
          
          if (result.rows.length > 0 && result.rows[0].profit_target) {
            takeProfit = Number(result.rows[0].profit_target);
            logger.info(`📌 保留原止盈价格: ${symbol} = ${takeProfit}`);
          }
        } catch (error: any) {
          logger.warn(`读取原止盈价格失败: ${error.message}`);
        }
      }

      // 调用交易所接口设置止损止盈
      const result = await exchangeClient.setPositionStopLoss(
        contract,
        stopLoss,
        takeProfit
      );

      if (result.success) {
        // 更新数据库中的持仓信息和条件单记录
        try {
          const { createClient } = await import("@libsql/client");
          const dbClient = createClient({
            url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
          });

          const now = new Date().toISOString();
          
          // 0. 获取 position_order_id（开仓订单ID）
          let positionOrderId: string | null = null;
          try {
            // 0.1 首先尝试从旧的条件单中获取
            const oldOrderResult = await dbClient.execute({
              sql: `SELECT position_order_id FROM price_orders 
                    WHERE symbol = ? AND status = 'active' AND position_order_id IS NOT NULL
                    LIMIT 1`,
              args: [symbol],
            });
            
            if (oldOrderResult.rows.length > 0 && oldOrderResult.rows[0].position_order_id) {
              positionOrderId = oldOrderResult.rows[0].position_order_id as string;
              logger.info(`📎 从旧条件单获取到关联的开仓订单ID: ${positionOrderId}`);
            } else {
              // 0.2 从 positions 表获取 entry_order_id
              const positionResult = await dbClient.execute({
                sql: `SELECT entry_order_id FROM positions WHERE symbol = ? LIMIT 1`,
                args: [symbol],
              });
              
              if (positionResult.rows.length > 0 && positionResult.rows[0].entry_order_id) {
                positionOrderId = positionResult.rows[0].entry_order_id as string;
                logger.info(`📎 从 positions 表获取到关联的开仓订单ID: ${positionOrderId}`);
              } else {
                // 0.3 如果还是没有，从 trades 表查找该币种的开仓订单
                const tradeResult = await dbClient.execute({
                  sql: `SELECT order_id FROM trades 
                        WHERE symbol = ? AND type = 'open' AND status = 'filled'
                        ORDER BY id DESC LIMIT 1`,
                  args: [symbol],
                });
                
                if (tradeResult.rows.length > 0 && tradeResult.rows[0].order_id) {
                  positionOrderId = tradeResult.rows[0].order_id as string;
                  logger.info(`📎 从 trades 表获取到开仓订单ID: ${positionOrderId}`);
                } else {
                  logger.warn(`⚠️ 未找到 ${symbol} 的开仓订单ID，条件单将不关联持仓`);
                }
              }
            }
          } catch (error: any) {
            logger.warn(`获取开仓订单ID失败: ${error.message}`);
          }
          
          // 1. 标记旧的条件单为已取消（如果存在）
          await dbClient.execute({
            sql: `UPDATE price_orders 
                  SET status = 'cancelled', updated_at = ?
                  WHERE symbol = ? AND status = 'active'`,
            args: [now, symbol],
          });
          
          // 2. 插入新的条件单记录（如果有 positionOrderId，则保持关联）
          if (result.stopLossOrderId && stopLoss) {
            await dbClient.execute({
              sql: `INSERT INTO price_orders 
                    (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              args: [
                result.stopLossOrderId,
                symbol,
                parseFloat(position.size) > 0 ? 'long' : 'short',
                'stop_loss',
                stopLoss,
                0,
                Math.abs(parseFloat(position.size)),
                'active',
                now,
                positionOrderId  // 保持与原开仓订单的关联
              ]
            });
          }
          
          if (result.takeProfitOrderId && takeProfit) {
            await dbClient.execute({
              sql: `INSERT INTO price_orders 
                    (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              args: [
                result.takeProfitOrderId,
                symbol,
                parseFloat(position.size) > 0 ? 'long' : 'short',
                'take_profit',
                takeProfit,
                0,
                Math.abs(parseFloat(position.size)),
                'active',
                now,
                positionOrderId  // 保持与原开仓订单的关联
              ]
            });
          }

          // 3. 更新持仓表
          await dbClient.execute({
            sql: `UPDATE positions 
                  SET stop_loss = ?, profit_target = ?, sl_order_id = ?, tp_order_id = ?
                  WHERE symbol = ?`,
            args: [
              stopLoss || null,
              takeProfit || null,
              result.stopLossOrderId || null,
              result.takeProfitOrderId || null,
              symbol,
            ],
          });

          logger.info(`✅ 数据库已更新: ${symbol} 止损=${stopLoss || 'null'}, 止盈=${takeProfit || 'null'}, 订单ID=${result.stopLossOrderId}/${result.takeProfitOrderId}`);
        } catch (dbError: any) {
          logger.error(`更新数据库失败: ${dbError.message}`);
          // 数据库更新失败不影响订单已设置的事实
        }

        return {
          success: true,
          data: {
            symbol,
            stopLoss,
            takeProfit,
            stopLossOrderId: result.stopLossOrderId,
            takeProfitOrderId: result.takeProfitOrderId,
          },
          message: `✅ ${result.message}`,
        };
      } else {
        return {
          success: false,
          message: `❌ ${result.message}`,
        };
      }
    } catch (error: any) {
      logger.error(`更新持仓止损失败: ${error.message}`);
      return {
        success: false,
        message: `更新失败: ${error.message}`,
      };
    }
  },
});

/**
 * 导出所有止损管理工具
 */
export const stopLossManagementTools = [
  calculateStopLossTool,
  checkOpenPositionTool,
  updateTrailingStopTool,
  updatePositionStopLossTool,
];

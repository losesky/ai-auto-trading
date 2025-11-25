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
 * 交易 Agent 配置（极简版）
 */
import { Agent, Memory } from "@voltagent/core";
import { LibSQLMemoryAdapter } from "@voltagent/libsql";
import { createLogger } from "../utils/logger";
import { createOpenAI } from "@ai-sdk/openai";
import * as tradingTools from "../tools/trading";
import { formatChinaTime } from "../utils/timeUtils";
import { RISK_PARAMS } from "../config/riskParams";
import { formatPrice, formatUSDT, formatPercent, formatATR, getDecimalPlacesBySymbol } from "../utils/priceFormatter";
import { analyzeMultipleMarketStates } from "../services/marketStateAnalyzer";
import type { MarketStateAnalysis } from "../types/marketState";

/**
 * 账户风险配置
 */
export interface AccountRiskConfig {
  stopLossUsdt: number;
  takeProfitUsdt: number;
  syncOnStartup: boolean;
}

/**
 * 从环境变量读取账户风险配置
 */
export function getAccountRiskConfig(): AccountRiskConfig {
  return {
    stopLossUsdt: Number.parseFloat(process.env.ACCOUNT_STOP_LOSS_USDT || "50"),
    takeProfitUsdt: Number.parseFloat(process.env.ACCOUNT_TAKE_PROFIT_USDT || "10000"),
    syncOnStartup: process.env.SYNC_CONFIG_ON_STARTUP === "true",
  };
}

/**
 * 交易策略类型
 */
export type TradingStrategy = "conservative" | "balanced" | "aggressive" | "ultra-short" | "swing-trend";

/**
 * 策略参数配置
 */
export interface StrategyParams {
  name: string;
  description: string;
  leverageMin: number;
  leverageMax: number;
  leverageRecommend: {
    normal: string;
    good: string;
    strong: string;
  };
  positionSizeMin: number;
  positionSizeMax: number;
  positionSizeRecommend: {
    normal: string;
    good: string;
    strong: string;
  };
  // ===== 止损配置 =====
  
  // 科学止损配置（优先使用，基于 ATR 和支撑/阻力位）
  scientificStopLoss?: {
    enabled: boolean;           // 是否启用科学止损
    atrMultiplier: number;      // ATR倍数（根据策略风格调整）
    useSupport: boolean;        // 是否使用支撑/阻力位
    minDistance: number;        // 最小止损距离%
    maxDistance: number;        // 最大止损距离%
  };
  
  // 固定止损配置（备用方案，仅在科学止损未启用时使用）
  stopLoss: {
    low: number;                // 低杠杆止损线
    mid: number;                // 中杠杆止损线
    high: number;               // 高杠杆止损线
    deprecated?: boolean;       // 标记为已弃用（科学止损优先）
  };
  
  trailingStop: {
    // 移动止损配置
    // 科学模式（ENABLE_SCIENTIFIC_STOP_LOSS=true）：trigger 作为检查时机，stopAt 忽略
    // 固定模式（ENABLE_SCIENTIFIC_STOP_LOSS=false）：trigger 触发点，stopAt 移动止损目标
    level1: { trigger: number; stopAt: number };
    level2: { trigger: number; stopAt: number };
    level3: { trigger: number; stopAt: number };
  };
  
  // ===== 分批止盈配置（基于风险倍数 R-Multiple）=====
  partialTakeProfit: {
    enabled: boolean;  // 是否启用分批止盈
    // 第一阶段：1R (盈利 = 1倍风险)
    stage1: {
      rMultiple: number;        // 风险倍数（如 1）
      closePercent: number;     // 平仓百分比（如 33.33 = 1/3）
      moveStopTo: 'entry' | 'custom';  // 移动止损至：entry=成本价, custom=自定义
      description: string;
    };
    // 第二阶段：2R (盈利 = 2倍风险)
    stage2: {
      rMultiple: number;        // 风险倍数（如 2）
      closePercent: number;     // 平仓百分比（如 33.33 = 1/3）
      moveStopTo: 'previous' | 'custom';  // 移动止损至：previous=上一阶段R位置
      description: string;
    };
    // 第三阶段：3R+ (盈利 ≥ 3倍风险)
    stage3: {
      rMultiple: number;        // 风险倍数（如 3）
      closePercent: number;     // 平仓百分比（如 0 = 不平仓）
      useTrailingStop: boolean; // 使用移动止损
      description: string;
    };
    // 极限止盈（兜底保护）
    extremeTakeProfit?: {
      rMultiple: number;        // 风险倍数（如 5）
      description: string;
    };
  };
  
  // ===== 传统分批止盈配置（已弃用，仅供参考）=====
  partialTakeProfitLegacy?: {
    stage1: { trigger: number; closePercent: number }; // 第一阶段：平仓50%
    stage2: { trigger: number; closePercent: number }; // 第二阶段：平仓剩余50%
    stage3: { trigger: number; closePercent: number }; // 第三阶段：全部清仓
  };
  
  peakDrawdownProtection: number; // 峰值回撤保护阈值（百分比）
  volatilityAdjustment: {
    // 波动率调整系数
    highVolatility: { leverageFactor: number; positionFactor: number }; // ATR > 5%
    normalVolatility: { leverageFactor: number; positionFactor: number }; // ATR 2-5%
    lowVolatility: { leverageFactor: number; positionFactor: number }; // ATR < 2%
  };
  entryCondition: string;
  riskTolerance: string;
  tradingStyle: string;
}

/**
 * 获取策略参数（基于 MAX_LEVERAGE 动态计算）
 */
export function getStrategyParams(strategy: TradingStrategy): StrategyParams {
  const maxLeverage = RISK_PARAMS.MAX_LEVERAGE;
  
  // 根据 MAX_LEVERAGE 动态计算各策略的杠杆范围
  // 保守策略：30%-60% 的最大杠杆
  const conservativeLevMin = Math.max(1, Math.ceil(maxLeverage * 0.3));
  const conservativeLevMax = Math.max(2, Math.ceil(maxLeverage * 0.6));
  const conservativeLevNormal = conservativeLevMin;
  const conservativeLevGood = Math.ceil((conservativeLevMin + conservativeLevMax) / 2);
  const conservativeLevStrong = conservativeLevMax;
  
  // 平衡策略：60%-85% 的最大杠杆
  const balancedLevMin = Math.max(2, Math.ceil(maxLeverage * 0.6));
  const balancedLevMax = Math.max(3, Math.ceil(maxLeverage * 0.85));
  const balancedLevNormal = balancedLevMin;
  const balancedLevGood = Math.ceil((balancedLevMin + balancedLevMax) / 2);
  const balancedLevStrong = balancedLevMax;
  
  // 激进策略：85%-100% 的最大杠杆
  const aggressiveLevMin = Math.max(3, Math.ceil(maxLeverage * 0.85));
  const aggressiveLevMax = maxLeverage;
  const aggressiveLevNormal = aggressiveLevMin;
  const aggressiveLevGood = Math.ceil((aggressiveLevMin + aggressiveLevMax) / 2);
  const aggressiveLevStrong = aggressiveLevMax;
  
  const strategyConfigs: Record<TradingStrategy, StrategyParams> = {
    "ultra-short": {
      name: "超短线",
      description: "极短周期快进快出，5分钟执行，适合高频交易",
      leverageMin: Math.max(3, Math.ceil(maxLeverage * 0.5)),
      leverageMax: Math.max(5, Math.ceil(maxLeverage * 0.75)),
      leverageRecommend: {
        normal: `${Math.max(3, Math.ceil(maxLeverage * 0.5))}倍`,
        good: `${Math.max(4, Math.ceil(maxLeverage * 0.625))}倍`,
        strong: `${Math.max(5, Math.ceil(maxLeverage * 0.75))}倍`,
      },
      positionSizeMin: 18,
      positionSizeMax: 25,
      positionSizeRecommend: {
        normal: "18-20%",
        good: "20-23%",
        strong: "23-25%",
      },
      // 科学止损配置（优先使用）
      scientificStopLoss: {
        enabled: RISK_PARAMS.ENABLE_SCIENTIFIC_STOP_LOSS,
        atrMultiplier: 1.5,        // 超短线：较紧的止损（1.5倍ATR）
        useSupport: true,           // 使用支撑/阻力位
        minDistance: 0.3,           // 最小止损距离0.3%
        maxDistance: 2.0,           // 最大止损距离2.0%
      },
      // 固定止损配置（备用，仅在科学止损未启用时使用）
      stopLoss: {
        low: - balancedLevNormal / 1.5,
        mid: - balancedLevGood / 2,
        high: - balancedLevStrong / 2.5,
        deprecated: true,           // 标记为已弃用
      },
      trailingStop: {
        // 超短线策略：快速锁利（5分钟周期）
        // 科学模式：trigger 作为检查时机 | 固定模式：trigger 触发点，stopAt 移动目标
        level1: { trigger: 4, stopAt: 1.5 },   // 科学：盈利 4% 检查 | 固定：移至 +1.5%
        level2: { trigger: 8, stopAt: 4 },     // 科学：盈利 8% 检查 | 固定：移至 +4%
        level3: { trigger: 15, stopAt: 8 },    // 科学：盈利 15% 检查 | 固定：移至 +8%
      },
      partialTakeProfit: {
        // 超短线策略：基于R倍数的分批止盈
        enabled: true,
        stage1: {
          rMultiple: 1,
          closePercent: 33.33,
          moveStopTo: 'entry',
          description: '1R平仓1/3，止损移至成本价（保本交易）',
        },
        stage2: {
          rMultiple: 2,
          closePercent: 33.33,
          moveStopTo: 'previous',
          description: '2R平仓1/3，止损移至1R（锁定1倍风险利润）',
        },
        stage3: {
          rMultiple: 3,
          closePercent: 0,
          useTrailingStop: true,
          description: '3R+启用移动止损，让利润奔跑',
        },
        extremeTakeProfit: {
          rMultiple: 5,
          description: '5R极限止盈兜底',
        },
      },
      partialTakeProfitLegacy: {
        // 传统配置（已弃用，仅供参考）
        stage1: { trigger: 15, closePercent: 50 },
        stage2: { trigger: 25, closePercent: 50 },
        stage3: { trigger: 35, closePercent: 100 },
      },
      peakDrawdownProtection: 20, // 超短线：20%峰值回撤保护（快速保护利润）
      volatilityAdjustment: {
        highVolatility: { leverageFactor: 0.7, positionFactor: 0.8 },
        normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 },
        lowVolatility: { leverageFactor: 1.1, positionFactor: 1.0 },
      },
      entryCondition: "至少2个时间框架信号一致，优先1-5分钟级别",
      riskTolerance: "单笔交易风险控制在18-25%之间，快进快出",
      tradingStyle: "超短线交易，5分钟执行周期，快速捕捉短期波动，严格执行2%周期锁利规则和30分钟盈利平仓规则",
    },
    "swing-trend": {
      name: "波段趋势",
      description: "中长线波段交易，20分钟执行，捕捉中期趋势，适合稳健成长",
      leverageMin: Math.max(2, Math.ceil(maxLeverage * 0.2)),
      leverageMax: Math.max(5, Math.ceil(maxLeverage * 0.5)),
      leverageRecommend: {
        normal: `${Math.max(2, Math.ceil(maxLeverage * 0.2))}倍`,
        good: `${Math.max(3, Math.ceil(maxLeverage * 0.35))}倍`,
        strong: `${Math.max(5, Math.ceil(maxLeverage * 0.5))}倍`,
      },
      positionSizeMin: 12,
      positionSizeMax: 20,
      positionSizeRecommend: {
        normal: "12-15%",
        good: "15-18%",
        strong: "18-20%",
      },
      // 科学止损配置（优先使用）
      scientificStopLoss: {
        enabled: RISK_PARAMS.ENABLE_SCIENTIFIC_STOP_LOSS,
        atrMultiplier: 2.5,        // 波段：较宽的止损（2.5倍ATR），给趋势更多空间
        useSupport: true,           // 使用支撑/阻力位
        minDistance: 1.0,           // 最小止损距离1.0%
        maxDistance: 6.0,           // 最大止损距离6.0%
      },
      // 固定止损配置（备用）
      stopLoss: {
        low: - balancedLevNormal / 1.5,
        mid: - balancedLevGood / 2,
        high: - balancedLevStrong / 2.5,
        deprecated: true,
      },
      trailingStop: {
        // 波段策略：给趋势更多空间，较晚锁定利润
        // 科学模式：trigger 作为检查时机 | 固定模式：trigger 触发点，stopAt 移动目标
        level1: { trigger: 15, stopAt: 8 },   // 科学：盈利 15% 检查 | 固定：移至 +8%
        level2: { trigger: 30, stopAt: 20 },  // 科学：盈利 30% 检查 | 固定：移至 +20%
        level3: { trigger: 50, stopAt: 35 },  // 科学：盈利 50% 检查 | 固定：移至 +35%
      },
      partialTakeProfit: {
        // 波段策略：基于R倍数的分批止盈
        enabled: true,
        stage1: {
          rMultiple: 1.5,
          closePercent: 30,
          moveStopTo: 'entry',
          description: '1.5R平仓30%，止损移至成本价（保本）',
        },
        stage2: {
          rMultiple: 3,
          closePercent: 35,
          moveStopTo: 'previous',
          description: '3R平仓35%，止损移至1.5R',
        },
        stage3: {
          rMultiple: 4.5,
          closePercent: 0,
          useTrailingStop: true,
          description: '4.5R+启用移动止损，博取大趋势',
        },
        extremeTakeProfit: {
          rMultiple: 8,
          description: '8R极限止盈兜底（波段策略更高）',
        },
      },
      partialTakeProfitLegacy: {
        // 传统配置（已弃用）
        stage1: { trigger: 50, closePercent: 40 },
        stage2: { trigger: 80, closePercent: 60 },
        stage3: { trigger: 120, closePercent: 100 },
      },
      peakDrawdownProtection: 35, // 波段策略：35%峰值回撤保护（给趋势更多空间）
      volatilityAdjustment: {
        highVolatility: { leverageFactor: 0.5, positionFactor: 0.6 },   // 高波动：大幅降低风险
        normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：标准配置
        lowVolatility: { leverageFactor: 1.2, positionFactor: 1.1 },    // 低波动：适度提高（趋势稳定）
      },
      entryCondition: "至少3个以上时间框架信号强烈一致，优先15分钟-4小时级别，等待明确趋势形成",
      riskTolerance: "单笔交易风险控制在12-20%之间，注重趋势质量而非交易频率",
      tradingStyle: "波段趋势交易，20分钟执行周期，耐心等待高质量趋势信号，持仓时间可达数天，让利润充分奔跑",
    },
    "conservative": {
      name: "稳健",
      description: "低风险低杠杆，严格入场条件，适合保守投资者",
      leverageMin: conservativeLevMin,
      leverageMax: conservativeLevMax,
      leverageRecommend: {
        normal: `${conservativeLevNormal}倍`,
        good: `${conservativeLevGood}倍`,
        strong: `${conservativeLevStrong}倍`,
      },
      positionSizeMin: 15,
      positionSizeMax: 22,
      positionSizeRecommend: {
        normal: "15-17%",
        good: "17-20%",
        strong: "20-22%",
      },
      // 科学止损配置（优先使用）
      scientificStopLoss: {
        enabled: RISK_PARAMS.ENABLE_SCIENTIFIC_STOP_LOSS,
        atrMultiplier: 2.5,        // 保守：较宽的止损（2.5倍ATR）
        useSupport: true,           // 使用支撑/阻力位
        minDistance: 1.0,           // 最小止损距离1.0%
        maxDistance: 4.0,           // 最大止损距离4.0%
      },
      // 固定止损配置（备用）
      stopLoss: {
        low: - balancedLevNormal / 2.5,
        mid: - balancedLevGood / 3,
        high: - balancedLevStrong / 3.5,
        deprecated: true,
      },
      trailingStop: {
        // 保守策略：较早锁定利润（基准：15倍杠杆）
        // 注意：这些是基准值，实际使用时会根据杠杆动态调整
        level1: { trigger: 6, stopAt: 2 },   // 基准：盈利达到 +6% 时，止损线移至 +2%
        level2: { trigger: 12, stopAt: 6 },  // 基准：盈利达到 +12% 时，止损线移至 +6%
        level3: { trigger: 20, stopAt: 12 }, // 基准：盈利达到 +20% 时，止损线移至 +12%
      },
      partialTakeProfit: {
        // 保守策略：基于R倍数的分批止盈，较早锁定利润
        enabled: true,
        stage1: {
          rMultiple: 1,
          closePercent: 40,
          moveStopTo: 'entry',
          description: '1R平仓40%，止损移至成本价（保守策略：提早锁定更多）',
        },
        stage2: {
          rMultiple: 1.5,
          closePercent: 40,
          moveStopTo: 'previous',
          description: '1.5R平仓40%，止损移至1R（累计平仓80%）',
        },
        stage3: {
          rMultiple: 2.5,
          closePercent: 0,
          useTrailingStop: true,
          description: '2.5R+启用移动止损（保留20%博取趋势）',
        },
        extremeTakeProfit: {
          rMultiple: 4,
          description: '4R极限止盈兜底（保守策略：更早兜底）',
        },
      },
      partialTakeProfitLegacy: {
        // 传统配置（已弃用）
        stage1: { trigger: 20, closePercent: 50 },
        stage2: { trigger: 30, closePercent: 50 },
        stage3: { trigger: 40, closePercent: 100 },
      },
      peakDrawdownProtection: 25, // 保守策略：25%峰值回撤保护（更早保护利润）
      volatilityAdjustment: {
        highVolatility: { leverageFactor: 0.6, positionFactor: 0.7 },   // 高波动：大幅降低
        normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：不调整
        lowVolatility: { leverageFactor: 1.0, positionFactor: 1.0 },    // 低波动：不调整（保守不追求）
      },
      entryCondition: "至少3个关键时间框架信号一致，4个或更多更佳",
      riskTolerance: "单笔交易风险控制在15-22%之间，严格控制回撤",
      tradingStyle: "谨慎交易，宁可错过机会也不冒险，优先保护本金",
    },
    "balanced": {
      name: "平衡",
      description: "中等风险杠杆，合理入场条件，适合大多数投资者",
      leverageMin: balancedLevMin,
      leverageMax: balancedLevMax,
      leverageRecommend: {
        normal: `${balancedLevNormal}倍`,
        good: `${balancedLevGood}倍`,
        strong: `${balancedLevStrong}倍`,
      },
      positionSizeMin: 10,
      positionSizeMax: 20,
      positionSizeRecommend: {
        normal: "10-14%",
        good: "14-16%",
        strong: "16-20%",
      },
      // 科学止损配置（优先使用）
      scientificStopLoss: {
        enabled: RISK_PARAMS.ENABLE_SCIENTIFIC_STOP_LOSS,
        atrMultiplier: 2.0,        // 平衡：标准止损（2.0倍ATR）
        useSupport: true,           // 使用支撑/阻力位
        minDistance: 0.5,           // 最小止损距离0.5%
        maxDistance: 5.0,           // 最大止损距离5.0%
      },
      // 固定止损配置（备用）
      stopLoss: {
        low: - balancedLevNormal / 2,
        mid: - balancedLevGood / 2.5,
        high: - balancedLevStrong / 3,
        deprecated: true,
      },
      trailingStop: {
        // 平衡策略：适中的移动止盈（基准：10倍杠杆）
        // 注意：这些是基准值，实际使用时会根据杠杆动态调整
        level1: { trigger: 6, stopAt: 3 },   // 基准：盈利达到 +6% 时，止损线移至 +3%
        level2: { trigger: 10, stopAt: 6 },  // 基准：盈利达到 +10% 时，止损线移至 +6%
        level3: { trigger: 20, stopAt: 15 }, // 基准：盈利达到 +20% 时，止损线移至 +15%
      },
      partialTakeProfit: {
        // 平衡策略：基于R倍数的标准分批止盈
        enabled: true,
        stage1: {
          rMultiple: 1,
          closePercent: 33.33,
          moveStopTo: 'entry',
          description: '1R平仓1/3，止损移至成本价（标准保本）',
        },
        stage2: {
          rMultiple: 2,
          closePercent: 33.33,
          moveStopTo: 'previous',
          description: '2R平仓1/3，止损移至1R（标准锁利）',
        },
        stage3: {
          rMultiple: 3,
          closePercent: 0,
          useTrailingStop: true,
          description: '3R+启用移动止损（标准趋势追踪）',
        },
        extremeTakeProfit: {
          rMultiple: 5,
          description: '5R极限止盈兜底',
        },
      },
      partialTakeProfitLegacy: {
        // 传统配置（已弃用）
        stage1: { trigger: 30, closePercent: 20 },
        stage2: { trigger: 40, closePercent: 50 },
        stage3: { trigger: 50, closePercent: 100 },
      },
      peakDrawdownProtection: 30, // 平衡策略：30%峰值回撤保护（标准平衡点）
      volatilityAdjustment: {
        highVolatility: { leverageFactor: 0.7, positionFactor: 0.8 },   // 高波动：适度降低
        normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：不调整
        lowVolatility: { leverageFactor: 1.1, positionFactor: 1.0 },    // 低波动：略微提高杠杆
      },
      entryCondition: "至少3个关键时间框架信号一致，4个或更多更佳",
      riskTolerance: "单笔交易风险控制在10-20%之间，平衡风险与收益",
      tradingStyle: "在风险可控前提下积极把握机会，追求稳健增长",
    },
    "aggressive": {
      name: "激进",
      description: "高风险高杠杆，宽松入场条件，适合激进投资者",
      leverageMin: aggressiveLevMin,
      leverageMax: aggressiveLevMax,
      leverageRecommend: {
        normal: `${aggressiveLevNormal}倍`,
        good: `${aggressiveLevGood}倍`,
        strong: `${aggressiveLevStrong}倍`,
      },
      positionSizeMin: 25,
      positionSizeMax: 32,
      positionSizeRecommend: {
        normal: "25-28%",
        good: "28-30%",
        strong: "30-32%",
      },
      // 科学止损配置（优先使用）
      scientificStopLoss: {
        enabled: RISK_PARAMS.ENABLE_SCIENTIFIC_STOP_LOSS,
        atrMultiplier: 1.5,        // 激进：较紧的止损（1.5倍ATR）
        useSupport: true,           // 使用支撑/阻力位
        minDistance: 0.5,           // 最小止损距离0.5%
        maxDistance: 5.0,           // 最大止损距离5.0%
      },
      // 固定止损配置（备用）
      stopLoss: {
        low: - balancedLevNormal / 1.5,
        mid: - balancedLevGood / 2,
        high: - balancedLevStrong / 2.5,
        deprecated: true,
      },
      trailingStop: {
        // 激进策略：更晚锁定，追求更高利润（基准：15倍杠杆）
        // 注意：这些是基准值，实际使用时会根据杠杆动态调整
        level1: { trigger: 10, stopAt: 4 },  // 基准：盈利达到 +10% 时，止损线移至 +4%
        level2: { trigger: 18, stopAt: 10 }, // 基准：盈利达到 +18% 时，止损线移至 +10%
        level3: { trigger: 30, stopAt: 18 }, // 基准：盈利达到 +30% 时，止损线移至 +18%
      },
      partialTakeProfit: {
        // 激进策略：基于R倍数，更晚分批，追求更高利润
        enabled: true,
        stage1: {
          rMultiple: 1.5,
          closePercent: 25,
          moveStopTo: 'entry',
          description: '1.5R平仓25%，止损移至成本价（激进：锁定更少，追求更多）',
        },
        stage2: {
          rMultiple: 3,
          closePercent: 25,
          moveStopTo: 'previous',
          description: '3R平仓25%，止损移至1.5R（累计平仓50%）',
        },
        stage3: {
          rMultiple: 4,
          closePercent: 0,
          useTrailingStop: true,
          description: '4R+启用移动止损（保留50%博取大趋势）',
        },
        extremeTakeProfit: {
          rMultiple: 8,
          description: '8R极限止盈兜底（激进策略：更高目标）',
        },
      },
      partialTakeProfitLegacy: {
        // 传统配置（已弃用）
        stage1: { trigger: 40, closePercent: 50 },
        stage2: { trigger: 50, closePercent: 50 },
        stage3: { trigger: 60, closePercent: 100 },
      },
      peakDrawdownProtection: 35, // 激进策略：35%峰值回撤保护（给利润更多奔跑空间）
      volatilityAdjustment: {
        highVolatility: { leverageFactor: 0.8, positionFactor: 0.85 },  // 高波动：轻微降低
        normalVolatility: { leverageFactor: 1.0, positionFactor: 1.0 }, // 正常波动：不调整
        lowVolatility: { leverageFactor: 1.2, positionFactor: 1.1 },    // 低波动：提高杠杆和仓位
      },
      entryCondition: "至少2个关键时间框架信号一致即可入场",
      riskTolerance: "单笔交易风险可达25-32%，追求高收益",
      tradingStyle: "积极进取，快速捕捉市场机会，追求最大化收益",
    },
  };

  return strategyConfigs[strategy];
}

const logger = createLogger({
  name: "trading-agent",
  level: "info",
});

/**
 * 从环境变量读取交易策略
 */
export function getTradingStrategy(): TradingStrategy {
  const strategy = process.env.TRADING_STRATEGY || "balanced";
  if (strategy === "conservative" || strategy === "balanced" || strategy === "aggressive" || strategy === "ultra-short" || strategy === "swing-trend") {
    return strategy;
  }
  logger.warn(`未知的交易策略: ${strategy}，使用默认策略: balanced`);
  return "balanced";
}

/**
 * 从环境变量读取最大显示机会数量
 */
export function getMaxOpportunitiesToShow(): number {
  return Number.parseInt(process.env.MAX_OPPORTUNITIES_TO_SHOW || "3", 10);
}

/**
 * 从环境变量读取最小开仓机会评分阈值
 */
export function getMinOpportunityScore(): number {
  return Number.parseInt(process.env.MIN_OPPORTUNITY_SCORE || "75", 10);
}

/**
 * 生成交易提示词（参照 1.md 格式）
 */
export async function generateTradingPrompt(data: {
  minutesElapsed: number;
  iteration: number;
  intervalMinutes: number;
  marketData: any;
  accountInfo: any;
  positions: any[];
  tradeHistory?: any[];
  recentDecisions?: any[];
  closeEvents?: any[];
}): Promise<string> {
  const { minutesElapsed, iteration, intervalMinutes, marketData, accountInfo, positions, tradeHistory, recentDecisions, closeEvents } = data;
  const currentTime = formatChinaTime();
  
  // 获取当前策略参数（用于每周期强调风控规则）
  const strategy = getTradingStrategy();
  const params = getStrategyParams(strategy);
  
  // 获取最大显示机会数量
  const maxOpportunities = getMaxOpportunitiesToShow();
  
  // 获取最小开仓机会评分阈值
  const minOpportunityScore = getMinOpportunityScore();
  
  let prompt = `【交易周期 #${iteration}】${currentTime}
已运行 ${minutesElapsed} 分钟，执行周期 ${intervalMinutes} 分钟

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
当前策略：${params.name}（${params.description}）
目标月回报：${params.name === '稳健' ? '10-20%' : params.name === '平衡' ? '20-40%' : '40%+'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【硬性风控底线 - 系统强制执行】
┌─────────────────────────────────────────┐
│ 科学止损保护：交易所服务器端24/7监控    │
│   • 触及止损位立即平仓（不受程序限制）  │
│   • 如超过止损阈值未平仓：系统强制介入  │
│ 持仓时间 ≥ 36小时：强制平仓             │
└─────────────────────────────────────────┘

【AI战术决策 - 强烈建议遵守】
┌────────────────────────────────────────────────────────────────┐
${params.scientificStopLoss?.enabled ? `│ 科学止损（交易所服务器端自动执行）：                           │
│   • 开仓时已自动设置止损条件单，24/7监控                       │
│   • AI职责：✅ 信任止损单保护，❌ 不要因"接近止损"主动平仓    │
│   • AI职责：✅ 仅在趋势明确反转经审慎思考后主动平仓            │
│   • 止损距离: ${params.scientificStopLoss.minDistance}%-${params.scientificStopLoss.maxDistance}% (ATR${params.scientificStopLoss.atrMultiplier}x + 支撑/阻力位)                    │
│                                                                │` : `│ 策略止损：                  │
│   策略止损线: ${formatPercent(params.stopLoss.low)}% ~ ${formatPercent(params.stopLoss.high)}%          │
│   根据杠杆倍数动态调整                  │
│                                                                │`}
${params.scientificStopLoss?.enabled ? `│ 移动止损优化（可选，低优先级）：                               │
│   • ⚠️ 分批止盈是主要止盈策略，移动止损仅作为辅助优化          │
│   • 仅用于：盈利持仓 + 未达到分批止盈阈值 + 想进一步保护利润    │
│   • 调用方式：updateTrailingStop() → updatePositionStopLoss()  │
│   • 不是必须操作：大多数情况下由分批止盈自动移动止损即可       │
│                                                                │` : `│ 移动止盈：                  │
│   • 盈利≥+${formatPercent(params.trailingStop.level1.trigger)}% → 止损移至+${formatPercent(params.trailingStop.level1.stopAt)}%        │
│   • 盈利≥+${formatPercent(params.trailingStop.level2.trigger)}% → 止损移至+${formatPercent(params.trailingStop.level2.stopAt)}%       │
│   • 盈利≥+${formatPercent(params.trailingStop.level3.trigger)}% → 止损移至+${formatPercent(params.trailingStop.level3.stopAt)}%      │
│                                                                │`}
│ 分批止盈（基于风险倍数 R-Multiple）：                          │
│   • 工具会自动计算 R-Multiple，AI 无需手动计算                 │
│   • ${params.partialTakeProfit.stage1.description}                      │
│   • ${params.partialTakeProfit.stage2.description}                          │
│   • ${params.partialTakeProfit.stage3.description}                            │
│   • ⚡ 波动率自适应: 低波动 R×0.8，高波动 R×1.2                │
│   • 使用工具: checkPartialTakeProfitOpportunity()              │
│                executePartialTakeProfit()                      │
│   • ⚠️ 分批止盈会自动移动止损，无需再调用 updateTrailingStop   │
│                                                                │
│ 极端止盈保护（${params.partialTakeProfit.extremeTakeProfit?.rMultiple || 5}R - 服务器端条件单）：                          │
│   • 角色定位：最后防线，仅在AI系统完全失效时触发               │
│   • 触发条件：${params.partialTakeProfit.extremeTakeProfit?.description || '极限兜底保护'}                                   │
│   • 执行方式：交易所服务器端自动执行，24/7监控无死角           │
│   • AI职责：✅ 通过分批止盈主动管理利润，❌ 不要等待极端止盈   │
│   • 设计理念：防止意外暴涨时利润大幅回吐，但正常应由AI管理     │
│   • ⚠️ 如果触发极端止盈，说明分批止盈策略执行不到位            │
│                                                                │
│ 峰值回撤：≥${formatPercent(params.peakDrawdownProtection)}% → 危险信号，立即平仓                         │
└────────────────────────────────────────────────────────────────┘

【决策流程 - 按优先级执行】
(1) 持仓管理（最优先）：

   ⚠️⚠️⚠️ 特别注意：独立反转监控线程预警（最最优先，超越一切）⭐⭐⭐⭐⭐⭐
   说明：独立反转监控线程每3分钟检测一次反转风险，如检测到风险会在持仓信息中标记
   
   ├─ 如果持仓显示"【反转监控紧急预警】预警得分 ≥ 50"
   │  → 立即全部平仓 closePosition({ symbol, reason: 'reversal_warning' })
   │  → ⚠️ 这是独立监控线程的强制预警，优先级高于一切其他判断！
   │  → ⚠️ 不要质疑、不要犹豫、不要考虑其他因素，立即执行！
   │
   ├─ 如果持仓显示"【反转监控预警】预警得分 30-49"
   │  → 密切关注，结合下面的reversalAnalysis综合判断
   │  → 优先级高于常规趋势分析，但允许综合评估
   │
   └─ 如果持仓显示"【反转监控状态】无预警标记"
      → 说明监控线程未检测到风险，按正常流程处理
      → 继续执行下面的步骤1-4

   步骤1：趋势反转紧急检查（最高优先级，每个持仓必查）⭐⭐⭐⭐⭐
   ├─ 检查 reversalAnalysis.reversalScore ≥ 60
   │  → 立即全部平仓 closePosition({ symbol, reason: 'trend_reversal' })
   │  ⚠️ 说明：多个时间框架强烈确认反转，必须立即退出，不考虑分批止盈
   │  ⚠️ 这是最高级别警报，优先于一切其他操作！
   │
   └─ 如果 reversalScore ≥ 60 → 跳过后续所有步骤，立即平仓

   步骤2：检查分批止盈机会（首要利润保护，每个持仓必查）⭐⭐⭐⭐
   ├─ 前置条件：reversalScore < 60（无强烈反转信号）
   ├─ 调用 checkPartialTakeProfitOpportunity() 查看所有持仓
   ├─ 工具返回 canExecute=true → 立即调用 executePartialTakeProfit(symbol, stage)
   ├─ 工具自动完成：
   │   • 计算当前 R-Multiple（无需 AI 手动计算）
   │   • 分析 ATR 波动率动态调整阈值（0.8x-1.5x）
   │   • 执行分批平仓（stage1/2/3）
   │   • 自动移动止损到保本或更高
   └─ ⚠️ 执行后：该持仓本周期跳过步骤3和步骤4

   步骤3：趋势反转风险评估（对未执行分批止盈的持仓）⭐⭐⭐
   │
   级别A：中等反转风险（AI综合判断）
   ├─ 检查 reversalAnalysis.reversalScore ≥ 40 且 earlyWarning=true
   │  → 建议平仓，结合盈亏情况决策：
   │  • 若已盈利：立即平仓锁定利润
   │  • 若小幅亏损（<5%）：平仓止损
   │  • 若接近止损线：等待止损单触发
   │
   ├─ 检查 reversalAnalysis.reversalScore ≥ 40 且 trendScores.primary 绝对值 < 20
   │  → 双重确认反转信号（反转得分 + 趋势震荡）
   │  → 强烈建议平仓，风险显著增加
   │
   级别B：早期预警（调整策略）
   ├─ 检查 reversalAnalysis.earlyWarning=true
   │  → 停止移动止损，准备退出
   │  → 说明：趋势开始减弱或出现背离，不要追求更高利润
   │
   ├─ 检查 trendScores.primary 绝对值 < 20（单独出现）
   │  → 考虑平仓（趋势进入震荡区）
   │  → 说明：继续持有风险增加，但非强制
   │
   级别C：传统风控（兜底保护）
   ├─ 峰值回撤 ≥ ${formatPercent(params.peakDrawdownProtection)}% 
   │  → closePosition({ symbol, reason: 'peak_drawdown' })
   ├─ 持仓时间 ≥ 36小时 
   │  → closePosition({ symbol, reason: 'time_limit' })
   └─ 止损条件单自动触发（交易所执行，AI无需干预）

   步骤4：优化移动止损（可选，仅对符合条件的持仓）⭐
   ├─ 适用持仓：
   │  • 本周期未执行分批止盈（分批止盈已自动移动止损）
   │  • 且步骤3判断为继续持有（无平仓信号）
   │  • 且达到参考触发点（检查时机，不是目标止损位）：
   │   - 盈利 ≥ +${formatPercent(params.trailingStop.level1.trigger)}% → 调用 updateTrailingStop() 检查是否上移
   │   - 盈利 ≥ +${formatPercent(params.trailingStop.level2.trigger)}% → 再次调用 updateTrailingStop() 检查
   │   - 盈利 ≥ +${formatPercent(params.trailingStop.level3.trigger)}% → 继续调用 updateTrailingStop() 检查
   ├─ 调用 updateTrailingStop() 检查是否应该上移止损
   ├─ 返回 shouldUpdate=true → 调用 updatePositionStopLoss() 更新交易所订单
   └─ 说明：这是可选优化，不是必须操作
   
   【决策流程总结】
   优先级排序（从高到低）：
   0. 独立反转监控预警 ≥ 50分（看持仓信息中的【反转监控紧急预警】标记）→ 立即平仓，跳过所有后续步骤
   1. reversalScore ≥ 60（强烈反转）→ 立即全部平仓，跳过所有后续步骤
   2. 分批止盈检查 → 执行后跳过步骤3和4
   3. reversalScore 40-60（中等风险）→ 建议平仓
   4. earlyWarning/震荡区（早期预警）→ 调整策略
   5. 传统风控（兜底保护）→ 强制平仓
   6. 移动止损优化（可选）→ 锦上添花
   
   【决策冲突处理】
   • 独立监控预警 ≥ 50：无条件立即平仓，优先级绝对最高（看持仓信息标记）
   • reversalScore ≥ 60：无条件立即平仓，忽略分批止盈机会
   • reversalScore < 60 且执行分批止盈：跳过步骤3和4，下周期重新评估
   • reversalScore < 60 且无分批止盈机会：执行步骤3风险评估
   • 只有"无反转风险 + 无分批止盈"时，才执行步骤4移动止损
   
   ⚠️ 核心原则：
   • 独立反转监控预警（≥50）> 一切其他考虑，这是独立线程的强制判断
   • 趋势强烈反转（≥60）> 一切其他考虑，必须立即退出
   • 分批止盈优先于移动止损（已包含止损移动）
   • "接近止损线"不是主动平仓理由（交易所条件单自动触发）
   • 中等反转风险（40-60）结合盈亏情况综合判断
   • 早期预警不强制平仓，但要停止追求更高利润

(2) 新开仓评估（⚠️ 强制流程，必须严格遵守）：
   
   ⚠️ 强制要求（必须按此流程执行）：
   
   步骤A：智能机会识别（必须调用）
   ├─ 必须先调用 analyze_opening_opportunities() 获取系统化评估
   ├─ 工具自动完成以下分析：
   │   • 识别市场状态（上涨趋势/下跌趋势/震荡等）
   │   • 根据市场状态选择最优策略（趋势跟踪/均值回归/突破）
   │   • 对所有机会进行量化评分（0-100分）
   │   • 自动过滤已有持仓的币种
   │   • 返回评分最高的前${maxOpportunities}个机会
   └─ ⚠️ 禁止跳过此步骤直接开仓
   
   步骤B：基于评分结果做决策（必须基于工具返回的评分）
   ├─ 评分 ≥ ${minOpportunityScore}分：高质量机会，可以考虑开仓
   ├─ 评分 ${Math.floor(minOpportunityScore * 0.75)}-${minOpportunityScore - 1}分：中等机会，强烈建议观望
   ├─ 评分 < ${Math.floor(minOpportunityScore * 0.75)}分：低质量机会，原则上不应开仓
   └─ ⚠️ 如果所有机会评分都 < ${minOpportunityScore}分，原则上不应开仓
   
   步骤C：开仓前二次验证（必须执行）
   ├─ 调用 checkOpenPosition() 验证止损合理性
   ├─ 确认该币种未持有反向仓位
   └─ 确认账户资金充足且未达到持仓上限
   
   步骤D：执行开仓（完成前述所有步骤后）
   └─ 调用 openPosition（自动设置止损+极端止盈条件单）
   
   💡 工具优势：
   • 系统化决策：基于多维度量化评分，避免情绪化交易
   • 市场状态自适应：不同市场环境使用不同策略
   • 双向机会识别：自动识别做多和做空机会
   • 避免主观偏见：量化评分减少盲目开仓
   
   ⚠️ 严格约束：
   • ❌ 禁止跳过 analyze_opening_opportunities() 直接开仓
   • ❌ 禁止忽略工具评分结果，自主选择开仓币种
   • ❌ 禁止在评分都 < ${Math.floor(minOpportunityScore * 0.875)}分时强行开仓（除非有极其充分的理由）
   • ✅ 工具提供建议，但AI保留最终决策权（在评分合格的前提下）
   • ✅ 可结合自己的市场洞察调整（但不能违背评分约束）
   • ✅ 止损单：24/7保护资金，触及立即平仓（风控必需）
   • ✅ 极端止盈单：${params.partialTakeProfit.extremeTakeProfit?.rMultiple || 5}R 兜底保护，防止AI失效时利润回吐
   
   📊 正确案例：
   1. 调用 analyze_opening_opportunities() → 返回 XRP ${Math.floor(minOpportunityScore * 0.84)}分（均值回归）、BTC ${Math.floor(minOpportunityScore * 0.69)}分（趋势跟踪）
   2. 判断：XRP ${Math.floor(minOpportunityScore * 0.84)}分接近${minOpportunityScore}分，可考虑；BTC ${Math.floor(minOpportunityScore * 0.69)}分太低，放弃
   3. 调用 checkOpenPosition('XRP', ...) → 验证通过
   4. 调用 openPosition('XRP', ...) → 执行开仓
   
   ❌ 错误案例：
   1. 直接调用 openPosition('XRP', ...) → 跳过了评估流程 ❌
   2. 调用 analyze_opening_opportunities() → 全部 < 60分 → 强行开仓 ❌
   3. 调用 analyze_opening_opportunities() → XRP 67分 → 自主选择开 BTC ❌}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ 重要：止损管理的工具调用规则

规则1：分批止盈优先
- 每个周期首先检查 checkPartialTakeProfitOpportunity()
- 如果执行了 executePartialTakeProfit()，该持仓本周期不要再调用 updateTrailingStop()
- 原因：executePartialTakeProfit 已经自动移动了止损

规则2：移动止损是可选优化（仅适用于科学止损模式）
- updateTrailingStop() 仅用于盈利但未达到分批止盈阈值的持仓
- 不是每个周期都必须调用
- 主要目的是在分批止盈之间提供额外保护

规则3：不要重复计算 R-Multiple
- R-Multiple 由工具自动计算，AI 不要尝试手动计算
- 工具会考虑做多/做空方向、杠杆等复杂因素
- AI 只需要调用工具并根据返回结果决策

规则4：止损单由交易所自动触发
- 开仓时已设置止损条件单，AI 无需频繁检查
- 只有在明确的趋势反转时才考虑主动平仓
- "接近止损线"不是主动平仓的理由

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📚 工具调用案例说明（请严格遵循）

【正确案例1: 分批止盈优先，避免重复】
1 调用 checkPartialTakeProfitOpportunity()
    返回: { "BTC": { "currentR": 1.2, "canExecuteStages": [1] } }
2 调用 executePartialTakeProfit('BTC', '1')
    返回: 成功，平仓33.33%，止损已自动移至成本价
3 ✅ 本周期结束，不再调用 updateTrailingStop('BTC')
    原因: executePartialTakeProfit 已经移动过止损了
4 ✅ 下个周期重新开始，再次检查 checkPartialTakeProfitOpportunity()

【正确案例2: 移动止损优化（未达到分批止盈阈值）】
1 调用 checkPartialTakeProfitOpportunity()
    返回: { "BTC": { "currentR": 0.8, "canExecuteStages": [] } }
    说明: 盈利 +6%，但未达到 1R 阈值（需要1.0R）
2 ✅ 调用 updateTrailingStop('BTC', ...)
    返回: shouldUpdate=true, 建议移动止损至 +3%
3 ✅ 调用 updatePositionStopLoss('BTC', newStopLoss)
    执行实际更新

【错误案例1: 重复移动止损 ❌】
1 调用 executePartialTakeProfit('BTC', '1') → ✅ 成功
2 ❌ 再次调用 updateTrailingStop('BTC', ...)
    → 错误! 已经移动过止损了，5分钟冷却期内不允许重复执行
    → 工具会返回 success=false，提示冷却期限制

【错误案例2: 误判"接近止损"主动平仓 ❌】
情况: 持仓盈亏 -8%, 止损线 -10%
❌ 错误做法: AI 主动调用 closePosition()
    理由: "太接近止损了，为了保险主动平仓"
    问题: 交易所已经设置了止损条件单，会自动触发，无需手动干预
✅ 正确做法: 信任交易所的止损单，只在以下情况主动平仓：
    • 趋势明确反转（3+时间框架信号一致）→ closePosition({ symbol, reason: 'trend_reversal' })
    • 峰值回撤 ≥ ${formatPercent(params.peakDrawdownProtection)}% → closePosition({ symbol, reason: 'peak_drawdown' })
    • 持仓时间 ≥ 36小时 → closePosition({ symbol, reason: 'time_limit' })

【正确案例3: 波动率动态调整（AI 无需手动计算）】
策略配置: 1R 阈值 = 1.0
当前市场: 高波动（ATR=3.5%）
系统自动: 1R → 0.8R（降低25%阈值，更早止盈）
持仓状态: 0.9R

❌ 错误思维: "配置说1R才能止盈，现在只有0.9R，不能执行"
✅ 正确做法:
1 调用 checkPartialTakeProfitOpportunity()
    返回: { "BTC": { 
      "currentR": 0.9, 
      "canExecuteStages": [1],
      "recommendation": "建议执行阶段1（0.80R，高波动调整）"
    }}
2 工具已经判断 0.9R ≥ 0.8R（调整后），可以执行
3 ✅ 直接调用 executePartialTakeProfit('BTC', '1')
    → AI 不要自己计算 R-Multiple 或判断阈值
    → 完全信任工具的返回结果

【正确案例4: 分批止盈的完整流程】
初始: BTC 做多，入场价 50000，止损 48000（-2000 = -4%）

周期1: 价格 52000
  checkPartialTakeProfitOpportunity() → currentR=1.0, canExecuteStages=[1]
  executePartialTakeProfit('BTC', '1') → 平仓33.33%，止损→50000（保本）

周期2: 价格 54000
  checkPartialTakeProfitOpportunity() → currentR=2.0, canExecuteStages=[2]
  executePartialTakeProfit('BTC', '2') → 平仓33.33%，止损→52000（1R）

周期3: 价格 56000
  checkPartialTakeProfitOpportunity() → currentR=3.0, canExecuteStages=[3]
  executePartialTakeProfit('BTC', '3') → 保留33.33%，启用移动止损

周期4+: 价格波动
  每个周期调用 updateTrailingStop('BTC', ...)
  根据市场波动动态上移止损，让利润奔跑

【正确案例5: 极端止盈的正确理解】
场景: BTC 做多，入场价 50000，止损 48000（-2000，风险R=$2000）
极端止盈设置: 5R = 50000 + 2000×5 = $60,000

✅ 正确理解（极端止盈是最后防线）：
周期1: 价格 52000（1R）
  → AI主动执行 executePartialTakeProfit('BTC', '1')
  → 平仓33.33%，锁定部分利润

周期2: 价格 54000（2R）
  → AI主动执行 executePartialTakeProfit('BTC', '2')
  → 再平仓33.33%，继续锁定利润

周期3: 价格 56000（3R）
  → AI主动执行 executePartialTakeProfit('BTC', '3')
  → 保留33.33%，移动止损跟踪

结果: ✅ 分批止盈策略正确执行，极端止盈未触发（符合预期）

❌ 错误理解（被动等待极端止盈）：
周期1-N: 价格从 52000 涨到 60000
  → AI认为"还没到极端止盈(5R=$60000)，继续持有"
  → 错过 1R、2R、3R 的分批止盈机会
  → 价格到达 60000 触发极端止盈，全部平仓

问题分析:
1. ❌ 极端止盈是兜底保护，不是目标止盈
2. ❌ AI应在1-3R主动管理，不应被动等待5R
3. ❌ 极端止盈触发 = 分批止盈执行失败
4. ⚠️ 正确策略：1R→2R→3R 逐步锁定，剩余仓位博取更高收益

极端止盈的设计理念：
• 防止AI失效或程序故障时，利润大幅回吐
• 类似于止损是"防爆仓的最后防线"，极端止盈是"防利润回吐的最后防线"
• 正常情况下应该由AI通过分批止盈主动管理，而非被动触发
• 如果频繁触发极端止盈，说明分批止盈策略执行不到位

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【数据说明】
本提示词已预加载所有必需数据：
• 所有币种的市场数据和技术指标（多时间框架）
• 账户信息（余额、收益率、夏普比率）
• 当前持仓状态（盈亏、持仓时间、杠杆）
• 历史交易记录（最近10笔）

【您的任务】
直接基于上述数据做出交易决策，无需重复获取数据：
1. 分析持仓管理需求（止损/止盈）→ 调用 closePosition / openPosition 执行
2. 识别新交易机会（做多/做空）→ 调用 openPosition 执行
3. 评估风险和仓位管理 → 调用 calculateRisk 验证

⭐ 关键原则（必须深刻理解）：
• 您必须实际调用工具执行决策，不要只停留在分析阶段！
• 持仓管理的唯一目标是"最大化整体收益"，不是"腾出位置开新仓"
• 所有平仓决策必须基于持仓本身的技术分析，禁止考虑"新机会"因素
• 达到持仓上限时，应该放弃新机会而非破坏现有健康持仓
• 亏损接近止损线 ≠ 主动平仓理由（除非同时满足"趋势明确反转"条件）
• 🎯 极端止盈是兜底保护，不是目标止盈（应通过1R→2R→3R分批主动管理）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

以下所有价格或信号数据按时间顺序排列：最旧 → 最新

时间框架说明：除非在章节标题中另有说明，否则日内序列以 3 分钟间隔提供。如果某个币种使用不同的间隔，将在该币种的章节中明确说明。

所有币种的当前市场状态
`;

  // 按照 1.md 格式输出每个币种的数据
  for (const [symbol, dataRaw] of Object.entries(marketData)) {
    const data = dataRaw as any;
    
    prompt += `\n所有 ${symbol} 数据\n`;
    prompt += `当前价格 = ${formatPrice(data.price)}, 当前EMA20 = ${formatPrice(data.ema20)}, 当前MACD = ${formatPrice(data.macd)}, 当前RSI（7周期） = ${formatPercent(data.rsi7, 3)}\n\n`;
    
    // 资金费率
    if (data.fundingRate !== undefined) {
      prompt += `此外，这是 ${symbol} 永续合约的最新资金费率（您交易的合约类型）：\n\n`;
      prompt += `资金费率: ${data.fundingRate.toExponential(2)}\n\n`;
    }
    
    // 日内时序数据（3分钟级别）
    if (data.intradaySeries && data.intradaySeries.midPrices.length > 0) {
      const series = data.intradaySeries;
      prompt += `日内序列（按分钟，最旧 → 最新）：\n\n`;
      
      // Mid prices - 根据币种使用合适的精度
      const priceDecimals = getDecimalPlacesBySymbol(symbol, data.price);
      prompt += `中间价: [${series.midPrices.map((p: number) => formatPrice(p, priceDecimals)).join(", ")}]\n\n`;
      
      // EMA indicators (20‑period)
      prompt += `EMA指标（20周期）: [${series.ema20Series.map((e: number) => formatPrice(e)).join(", ")}]\n\n`;
      
      // MACD indicators
      prompt += `MACD指标: [${series.macdSeries.map((m: number) => formatPrice(m)).join(", ")}]\n\n`;
      
      // RSI indicators (7‑Period)
      prompt += `RSI指标（7周期）: [${series.rsi7Series.map((r: number) => formatPercent(r, 3)).join(", ")}]\n\n`;
      
      // RSI indicators (14‑Period)
      prompt += `RSI指标（14周期）: [${series.rsi14Series.map((r: number) => formatPercent(r, 3)).join(", ")}]\n\n`;
    }
    
    // 更长期的上下文数据（1小时级别 - 用于短线交易）
    if (data.longerTermContext) {
      const ltc = data.longerTermContext;
      prompt += `更长期上下文（1小时时间框架）：\n\n`;
      
      prompt += `20周期EMA: ${formatPrice(ltc.ema20)} vs. 50周期EMA: ${formatPrice(ltc.ema50)}\n\n`;
      
      if (ltc.atr3 && ltc.atr14) {
        prompt += `3周期ATR: ${formatATR(ltc.atr3, data.price)} vs. 14周期ATR: ${formatATR(ltc.atr14, data.price)}\n\n`;
      }
      
      prompt += `当前成交量: ${formatUSDT(ltc.currentVolume)} vs. 平均成交量: ${formatUSDT(ltc.avgVolume)}\n\n`;
      
      // MACD 和 RSI 时序（4小时，最近10个数据点）
      if (ltc.macdSeries && ltc.macdSeries.length > 0) {
        prompt += `MACD指标: [${ltc.macdSeries.map((m: number) => formatPrice(m)).join(", ")}]\n\n`;
      }
      
      if (ltc.rsi14Series && ltc.rsi14Series.length > 0) {
        prompt += `RSI指标（14周期）: [${ltc.rsi14Series.map((r: number) => formatPercent(r, 3)).join(", ")}]\n\n`;
      }
    }
    
    // 多时间框架指标数据
    if (data.timeframes) {
      prompt += `多时间框架指标：\n\n`;
      
      const tfList = [
        { key: "1m", name: "1分钟" },
        { key: "3m", name: "3分钟" },
        { key: "5m", name: "5分钟" },
        { key: "15m", name: "15分钟" },
        { key: "30m", name: "30分钟" },
        { key: "1h", name: "1小时" },
      ];
      
      for (const tf of tfList) {
        const tfData = data.timeframes[tf.key];
        if (tfData) {
          // 使用 formatPriceBySymbol 根据币种自动选择合适的价格精度
          const formattedPrice = formatPrice(tfData.currentPrice, getDecimalPlacesBySymbol(symbol, tfData.currentPrice));
          prompt += `${tf.name}: 价格=${formattedPrice}, EMA20=${formatPrice(tfData.ema20, 3)}, EMA50=${formatPrice(tfData.ema50, 3)}, MACD=${formatPrice(tfData.macd, 3)}, RSI7=${formatPercent(tfData.rsi7)}, RSI14=${formatPercent(tfData.rsi14)}, 成交量=${formatUSDT(tfData.volume)}\n`;
        }
      }
      prompt += `\n`;
    }
  }

  // 账户信息和表现（参照 1.md 格式）
  prompt += `\n以下是您的账户信息和表现\n`;
  
  // 计算账户回撤（如果提供了初始净值和峰值净值）
  if (accountInfo.initialBalance !== undefined && accountInfo.peakBalance !== undefined) {
    const drawdownFromPeak = ((accountInfo.peakBalance - accountInfo.totalBalance) / accountInfo.peakBalance) * 100;
    const drawdownFromInitial = ((accountInfo.initialBalance - accountInfo.totalBalance) / accountInfo.initialBalance) * 100;
    
    prompt += `初始账户净值: ${formatUSDT(accountInfo.initialBalance)} USDT\n`;
    prompt += `峰值账户净值: ${formatUSDT(accountInfo.peakBalance)} USDT\n`;
    prompt += `当前账户价值: ${formatUSDT(accountInfo.totalBalance)} USDT\n`;
    prompt += `账户回撤 (从峰值): ${drawdownFromPeak >= 0 ? '' : '+'}${formatPercent(-drawdownFromPeak)}%\n`;
    prompt += `账户回撤 (从初始): ${drawdownFromInitial >= 0 ? '' : '+'}${formatPercent(-drawdownFromInitial)}%\n\n`;
    
    // 添加风控警告（使用配置参数）
    // 注释：已移除强制清仓限制，仅保留警告提醒
    if (drawdownFromPeak >= RISK_PARAMS.ACCOUNT_DRAWDOWN_WARNING_PERCENT) {
      prompt += `提醒: 账户回撤已达到 ${formatPercent(drawdownFromPeak)}%，请谨慎交易\n\n`;
    }
  } else {
    prompt += `当前账户价值: ${formatUSDT(accountInfo.totalBalance)} USDT\n\n`;
  }
  
  prompt += `当前总收益率: ${accountInfo.returnPercent.toFixed(2)}%\n\n`;
  
  // 计算所有持仓的未实现盈亏总和
  const totalUnrealizedPnL = positions.reduce((sum, pos) => sum + (pos.unrealized_pnl || 0), 0);
  
  prompt += `可用资金: ${formatUSDT(accountInfo.availableBalance)} USDT\n\n`;
  prompt += `未实现盈亏: ${formatUSDT(totalUnrealizedPnL)} USDT (${totalUnrealizedPnL >= 0 ? '+' : ''}${formatPercent((totalUnrealizedPnL / accountInfo.totalBalance) * 100)}%)\n\n`;
  
  // 当前持仓和表现
  if (positions.length > 0) {
    prompt += `以下是您当前的持仓信息。重要说明：\n`;
    prompt += `- 所有"盈亏百分比"都是考虑杠杆后的值，公式为：盈亏百分比 = (价格变动%) × 杠杆倍数\n`;
    prompt += `- 例如：10倍杠杆，价格上涨0.5%，则盈亏百分比 = +5%（保证金增值5%）\n`;
    prompt += `- 这样设计是为了让您直观理解实际收益：+10% 就是本金增值10%，-10% 就是本金亏损10%\n`;
    prompt += `- 请直接使用系统提供的盈亏百分比，不要自己重新计算\n\n`;
    
    // 批量分析持仓币种的市场状态
    const positionSymbols = positions.map(p => p.symbol);
    let marketStates: Map<string, MarketStateAnalysis> = new Map();
    try {
      marketStates = await analyzeMultipleMarketStates(positionSymbols);
      logger.info(`✅ 成功分析 ${marketStates.size} 个持仓币种的市场状态`);
    } catch (error) {
      logger.warn(`⚠️ 市场状态分析失败: ${error}`);
    }
    
    for (const pos of positions) {
      // 计算盈亏百分比：考虑杠杆倍数
      // 对于杠杆交易：盈亏百分比 = (价格变动百分比) × 杠杆倍数
      const priceChangePercent = pos.entry_price > 0 
        ? ((pos.current_price - pos.entry_price) / pos.entry_price * 100 * (pos.side === 'long' ? 1 : -1))
        : 0;
      const pnlPercent = priceChangePercent * pos.leverage;
      
      // 计算持仓时长
      const openedTime = new Date(pos.opened_at);
      const now = new Date();
      const holdingMinutes = Math.floor((now.getTime() - openedTime.getTime()) / (1000 * 60));
      const holdingHours = (holdingMinutes / 60).toFixed(1);
      const remainingHours = Math.max(0, 36 - parseFloat(holdingHours));
      const holdingCycles = Math.floor(holdingMinutes / intervalMinutes); // 根据实际执行周期计算
      const maxCycles = Math.floor(36 * 60 / intervalMinutes); // 36小时的总周期数
      const remainingCycles = Math.max(0, maxCycles - holdingCycles);
      
      // ⭐ 读取反转预警标记（独立反转监控线程设置）
      const metadata = pos.metadata || {};
      const hasReversalWarning = metadata.reversalWarning === 1;
      const warningScore = metadata.warningScore || 0;
      const warningTime = metadata.warningTime || null;
      
      prompt += `当前活跃持仓: ${pos.symbol} ${pos.side === 'long' ? '做多' : '做空'}\n`;
      prompt += `  杠杆倍数: ${pos.leverage}x\n`;
      prompt += `  盈亏百分比: ${pnlPercent >= 0 ? '+' : ''}${formatPercent(pnlPercent)}% (已考虑杠杆倍数)\n`;
      prompt += `  盈亏金额: ${pos.unrealized_pnl >= 0 ? '+' : ''}${formatUSDT(pos.unrealized_pnl)} USDT\n`;
      prompt += `  开仓价: ${formatPrice(pos.entry_price)}\n`;
      prompt += `  当前价: ${formatPrice(pos.current_price)}\n`;
      prompt += `  开仓时间: ${formatChinaTime(pos.opened_at)}\n`;
      prompt += `  已持仓: ${holdingHours} 小时 (${holdingMinutes} 分钟, ${holdingCycles} 个周期)\n`;
      prompt += `  距离36小时限制: ${formatPercent(remainingHours, 1)} 小时 (${remainingCycles} 个周期)\n`;
      
      // ⭐ 始终显示反转监控状态（明确告知AI是否有预警）
      if (hasReversalWarning && warningScore >= 30) {
        // 有预警标记
        if (warningScore >= 50) {
          prompt += `  ⚠️⚠️⚠️ 【反转监控紧急预警】独立反转监控线程检测到强烈反转信号！\n`;
          prompt += `  ├─ 预警得分: ${warningScore.toFixed(0)}/100 (≥50分，高危)\n`;
          prompt += `  ├─ 预警时间: ${warningTime ? formatChinaTime(warningTime) : '未知'}\n`;
          prompt += `  └─ 💡 【立即平仓】优先级最高，立即调用 closePosition({ symbol: '${pos.symbol}', reason: 'reversal_warning' })\n`;
        } else {
          prompt += `  ⚠️ 【反转监控预警】独立反转监控线程检测到早期反转信号\n`;
          prompt += `  ├─ 预警得分: ${warningScore.toFixed(0)}/100 (30-49分，中等风险)\n`;
          prompt += `  ├─ 预警时间: ${warningTime ? formatChinaTime(warningTime) : '未知'}\n`;
          prompt += `  └─ 💡 密切关注，结合市场分析判断是否平仓\n`;
        }
      } else {
        // 无预警标记（正常状态）
        prompt += `  ✅ 【反转监控状态】无预警标记 (reversalScore < 30 或监控线程未检测到风险)\n`;
      }
      
      // 如果接近36小时,添加警告
      if (remainingHours < 2) {
        prompt += `  警告: 即将达到36小时持仓限制,必须立即平仓!\n`;
      } else if (remainingHours < 4) {
        prompt += `  提醒: 距离36小时限制不足4小时,请准备平仓\n`;
      }
      
      // 追加市场趋势分析
      const state = marketStates.get(pos.symbol);
      if (state) {
        // 计算盈亏百分比（用于建议）
        const pnlPercent = pos.unrealized_pnl_percent || (pos.entry_price > 0 
          ? ((pos.current_price - pos.entry_price) / pos.entry_price * 100 * (pos.side === 'long' ? 1 : -1) * pos.leverage)
          : 0);
        
        prompt += `  ├─ 📊 市场趋势分析（供决策参考）：\n`;
        prompt += `  │   • 当前状态: ${state.state} (${getStateDescription(state.state)})\n`;
        prompt += `  │   • 趋势强度: ${state.trendStrength}\n`;
        prompt += `  │   • 动量状态: ${state.momentumState}\n`;
        prompt += `  │   • 多时间框架一致性: ${Math.round(state.timeframeAlignment.alignmentScore * 100)}%\n`;
        prompt += `  │   • 分析置信度: ${Math.round(state.confidence * 100)}%\n`;
        
        // 显示趋势强度得分（阶段1新增功能）
        if (state.trendScores) {
          const getTrendStrength = (score: number) => {
            const abs = Math.abs(score);
            if (abs >= 70) return '极强';
            if (abs >= 50) return '强';
            if (abs >= 30) return '中等';
            if (abs >= 10) return '弱';
            return '震荡';
          };
          
          const getTrendDirection = (score: number) => {
            if (score > 10) return '看涨';
            if (score < -10) return '看跌';
            return '中性';
          };
          
          prompt += `  │   • 趋势强度得分（-100到+100）：\n`;
          prompt += `  │     - 主框架: ${state.trendScores.primary} (${getTrendStrength(state.trendScores.primary)}, ${getTrendDirection(state.trendScores.primary)})\n`;
          prompt += `  │     - 确认框架: ${state.trendScores.confirm} (${getTrendStrength(state.trendScores.confirm)}, ${getTrendDirection(state.trendScores.confirm)})\n`;
          prompt += `  │     - 过滤框架: ${state.trendScores.filter} (${getTrendStrength(state.trendScores.filter)}, ${getTrendDirection(state.trendScores.filter)})\n`;
        }
        
        // 显示趋势变化情况（阶段1新增功能）
        if (state.trendChanges) {
          const hasWeakening = state.trendChanges.primary.isWeakening || 
                               state.trendChanges.confirm.isWeakening || 
                               state.trendChanges.filter.isWeakening;
          if (hasWeakening) {
            prompt += `  │   • ⚠️ 趋势减弱警告：\n`;
            if (state.trendChanges.primary.isWeakening) {
              prompt += `  │     - 主框架: 减弱${state.trendChanges.primary.weakeningSeverity}% (${state.trendChanges.primary.previousScore}→${state.trendChanges.primary.currentScore})\n`;
            }
            if (state.trendChanges.confirm.isWeakening) {
              prompt += `  │     - 确认框架: 减弱${state.trendChanges.confirm.weakeningSeverity}% (${state.trendChanges.confirm.previousScore}→${state.trendChanges.confirm.currentScore})\n`;
            }
            if (state.trendChanges.filter.isWeakening) {
              prompt += `  │     - 过滤框架: 减弱${state.trendChanges.filter.weakeningSeverity}% (${state.trendChanges.filter.previousScore}→${state.trendChanges.filter.currentScore})\n`;
            }
          }
        }
        
        // ⭐ 显示趋势反转分析（阶段1+阶段2核心功能）
        if (state.reversalAnalysis) {
          const rev = state.reversalAnalysis;
          prompt += `  │\n`;
          prompt += `  ├─ 🔄 趋势反转分析（阶段1+2增强）：\n`;
          prompt += `  │   • reversalScore: ${rev.reversalScore}/100`;
          
          // 根据得分显示警示级别（降低阈值：70→60, 50→40, 30→25）
          if (rev.reversalScore >= 60) {
            prompt += ` ⚠️⚠️⚠️ 【强烈反转信号！立即平仓】\n`;
          } else if (rev.reversalScore >= 40) {
            prompt += ` ⚠️⚠️ 【反转风险较高！建议平仓】\n`;
          } else if (rev.reversalScore >= 25) {
            prompt += ` ⚠️ 【早期预警】\n`;
          } else {
            prompt += ` ✅ 【趋势正常】\n`;
          }
          
          prompt += `  │   • earlyWarning: ${rev.earlyWarning ? '⚠️ 是（趋势减弱或背离）' : '否'}\n`;
          prompt += `  │   • recommendation: ${rev.recommendation}\n`;
          
          if (rev.timeframesReversed && rev.timeframesReversed.length > 0) {
            prompt += `  │   • 已反转框架: ${rev.timeframesReversed.join(', ')}\n`;
          }
          
          if (rev.details && rev.details.length > 0) {
            prompt += `  │   • 详细信息:\n`;
            for (const detail of rev.details) {
              prompt += `  │     - ${detail}\n`;
            }
          }
          
          // 根据reversalScore和盈亏情况给出具体建议（降低阈值）
          prompt += `  │\n`;
          prompt += `  └─ 💡 AI决策指引:\n`;
          
          if (rev.reversalScore >= 60) {
            prompt += `       ⚠️⚠️⚠️ 多个时间框架强烈确认反转！\n`;
            prompt += `       → 立即调用 closePosition({ symbol: '${pos.symbol}', reason: 'trend_reversal' })\n`;
            prompt += `       → 不要犹豫，这是系统最高级别的反转警告！\n`;
          } else if (rev.reversalScore >= 40) {
            prompt += `       ⚠️⚠️ 反转风险较高，建议平仓（结合盈亏情况）：\n`;
            if (pnlPercent > 0) {
              prompt += `       → 当前盈利${pnlPercent.toFixed(1)}%，立即平仓锁定利润\n`;
              prompt += `       → 调用 closePosition({ symbol: '${pos.symbol}', reason: 'trend_reversal' })\n`;
            } else if (pnlPercent > -5) {
              prompt += `       → 当前亏损${Math.abs(pnlPercent).toFixed(1)}%，平仓止损\n`;
              prompt += `       → 调用 closePosition({ symbol: '${pos.symbol}', reason: 'trend_reversal' })\n`;
            } else {
              prompt += `       → 当前亏损${Math.abs(pnlPercent).toFixed(1)}%，接近止损线\n`;
              prompt += `       → 可等待止损单触发，或主动平仓\n`;
            }
          } else if (rev.earlyWarning && rev.reversalScore >= 25) {
            prompt += `       ⚠️ 趋势开始减弱或出现背离，密切关注：\n`;
            prompt += `       → 停止移动止损，不要追求更高利润\n`;
            prompt += `       → 准备退出，但暂不强制平仓\n`;
          } else {
            prompt += `       ✅ 趋势正常，继续持有\n`;
            prompt += `       → reversalScore < 30，无明显反转迹象\n`;
          }
        }
      }
      
      prompt += "\n";
    }
  }
  
  // Sharpe Ratio
  if (accountInfo.sharpeRatio !== undefined) {
    prompt += `夏普比率: ${formatPercent(accountInfo.sharpeRatio, 3)}\n\n`;
  }
  
  // 历史成交记录（最近10条）
  if (tradeHistory && tradeHistory.length > 0) {
    prompt += `\n最近交易历史（最近10笔交易，最旧 → 最新）：\n`;
    prompt += `重要说明：以下仅为最近10条交易的统计，用于分析近期策略表现，不代表账户总盈亏。\n`;
    prompt += `使用此信息评估近期交易质量、识别策略问题、优化决策方向。\n\n`;
    
    let totalProfit = 0;
    let profitCount = 0;
    let lossCount = 0;
    
    for (const trade of tradeHistory) {
      const tradeTime = formatChinaTime(trade.timestamp);
      
      prompt += `交易: ${trade.symbol} ${trade.type === 'open' ? '开仓' : '平仓'} ${trade.side.toUpperCase()}\n`;
      prompt += `  时间: ${tradeTime}\n`;
      prompt += `  价格: ${formatPrice(trade.price)}, 数量: ${formatUSDT(trade.quantity, 4)}, 杠杆: ${trade.leverage}x\n`;
      prompt += `  手续费: ${formatUSDT(trade.fee, 4)} USDT\n`;
      
      // 对于平仓交易，总是显示盈亏金额
      if (trade.type === 'close') {
        if (trade.pnl !== undefined && trade.pnl !== null) {
          prompt += `  盈亏: ${trade.pnl >= 0 ? '+' : ''}${formatUSDT(trade.pnl)} USDT\n`;
          totalProfit += trade.pnl;
          if (trade.pnl > 0) {
            profitCount++;
          } else if (trade.pnl < 0) {
            lossCount++;
          }
        } else {
          prompt += `  盈亏: 暂无数据\n`;
        }
      }
      
      prompt += `\n`;
    }
    
    if (profitCount > 0 || lossCount > 0) {
      const winRate = profitCount / (profitCount + lossCount) * 100;
      prompt += `最近10条交易统计（仅供参考）:\n`;
      prompt += `  - 胜率: ${formatPercent(winRate, 1)}%\n`;
      prompt += `  - 盈利交易: ${profitCount}笔\n`;
      prompt += `  - 亏损交易: ${lossCount}笔\n`;
      prompt += `  - 最近10条净盈亏: ${totalProfit >= 0 ? '+' : ''}${formatUSDT(totalProfit)} USDT\n`;
      prompt += `\n注意：此数值仅为最近10笔交易统计，用于评估近期策略有效性，不是账户总盈亏。\n`;
      prompt += `账户真实盈亏请参考上方"当前账户状态"中的收益率和总资产变化。\n\n`;
    }
  }

  // 上一次的AI决策记录
  if (recentDecisions && recentDecisions.length > 0) {
    prompt += `\n您上一次的决策：\n`;
    prompt += `使用此信息作为参考，并基于当前市场状况做出决策。\n\n`;
    
    for (let i = 0; i < recentDecisions.length; i++) {
      const decision = recentDecisions[i];
      const decisionTime = formatChinaTime(decision.timestamp);
      
      prompt += `决策 #${decision.iteration} (${decisionTime}):\n`;
      prompt += `  账户价值: ${formatUSDT(decision.account_value)} USDT\n`;
      prompt += `  持仓数量: ${decision.positions_count}\n`;
      prompt += `  决策: ${decision.decision}\n\n`;
    }
    
    prompt += `\n参考上一次的决策结果，结合当前市场数据做出最佳判断。\n\n`;
  }

  // 近期平仓事件（24小时内）
  if (closeEvents && closeEvents.length > 0) {
    prompt += `\n📊 近期平仓事件（24小时内）\n`;
    prompt += `以下是最近被止损/止盈触发的平仓记录，用于评估策略效果和优化未来决策：\n`;
    prompt += `⚠️ 注意：同一币种可能有多个不同的持仓（通过 position_order_id 区分），请确保将平仓历史关联到正确的持仓！\n\n`;
    
    // 获取当前活跃持仓的 entry_order_id 列表，用于标识哪些平仓事件属于已完全平仓的旧仓位
    const activePositionOrderIds = new Set(
      positions
        .filter((p: any) => p.quantity && Math.abs(Number.parseFloat(p.quantity)) > 0)
        .map((p: any) => p.entry_order_id)
        .filter(Boolean)
    );
    
    // 调试日志：显示当前活跃持仓的 entry_order_id
    if (activePositionOrderIds.size > 0) {
      logger.info(`[tradingAgent] 当前活跃持仓的 entry_order_id: ${Array.from(activePositionOrderIds).join(', ')}`);
    } else {
      logger.info(`[tradingAgent] 没有当前活跃持仓`);
    }
    
    for (const event of closeEvents) {
      const e = event as any;
      const eventTime = formatChinaTime(e.created_at);
      const positionOrderId = e.position_order_id || '';
      const isOldPosition = positionOrderId && !activePositionOrderIds.has(positionOrderId);
      
      // 调试日志：显示每个平仓事件的 position_order_id 和判断结果
      logger.info(`[tradingAgent] 平仓事件: ${e.symbol}, position_order_id=${positionOrderId}, isOldPosition=${isOldPosition}, activePositionOrderIds.has=${activePositionOrderIds.has(positionOrderId)}`);
      
      // 根据 close_reason 映射显示文本
      let reasonText = '⚠️ 未知原因';
      switch (e.close_reason) {
        case 'stop_loss_triggered':
          reasonText = '🛑 止损触发';
          break;
        case 'take_profit_triggered':
          reasonText = '🎯 止盈触发';
          break;
        case 'partial_close':
          reasonText = '📈 分批止盈';
          break;
        case 'manual_close':
        case 'manual':
          reasonText = '📝 手动平仓';
          break;
        case 'ai_decision':
          reasonText = '🤖 AI决策平仓';
          break;
        case 'trend_reversal':
          reasonText = '🔄 趋势反转平仓';
          break;
        case 'peak_drawdown':
          reasonText = '📉 峰值回撤平仓';
          break;
        case 'time_limit':
          reasonText = '⏰ 超时平仓';
          break;
        case 'trailing_stop':
          reasonText = '🎯 移动止损触发';
          break;
        case 'forced_close':
          reasonText = '⚠️ 强制平仓';
          break;
      }
      
      // 显示持仓状态标识
      const positionStatusTag = isOldPosition 
        ? ' [已完全平仓的旧仓位]' 
        : positionOrderId && activePositionOrderIds.has(positionOrderId)
          ? ' [当前活跃持仓]'
          : '';
      
      prompt += `${e.symbol} ${e.side === 'long' ? '多单' : '空单'}${positionStatusTag} (${eventTime})\n`;
      prompt += `  持仓ID: ${positionOrderId || '未知'}\n`;
      prompt += `  触发原因: ${reasonText}\n`;
      prompt += `  开仓价: ${formatPrice(e.entry_price)}`;
      
      if (e.trigger_price) {
        prompt += `, 触发价: ${formatPrice(e.trigger_price)}`;
      }
      
      prompt += `, 成交价: ${formatPrice(e.close_price)}\n`;
      prompt += `  盈亏: ${e.pnl >= 0 ? '+' : ''}${formatUSDT(e.pnl)} USDT (${e.pnl_percent >= 0 ? '+' : ''}${formatPercent(e.pnl_percent)}%)\n`;
      
      // 根据平仓原因和结果提供分析提示
      switch (e.close_reason) {
        case 'stop_loss_triggered':
          if (e.pnl < 0) {
            prompt += `  💡 分析：止损保护了本金，防止了更大亏损\n`;
          } else {
            prompt += `  💡 分析：止损触发但仍获利，说明入场时机和止损设置都很合理\n`;
          }
          break;
        case 'take_profit_triggered':
          if (e.pnl > 0) {
            prompt += `  💡 分析：成功止盈，锁定了利润\n`;
          }
          break;
        case 'partial_close':
          if (e.pnl > 0) {
            if (isOldPosition) {
              prompt += `  💡 分析：这是已完全平仓的旧仓位的分批止盈记录，不影响当前持仓\n`;
            } else {
              prompt += `  💡 分析：当前持仓的分批止盈执行成功，部分锁定利润，剩余仓位继续持有\n`;
            }
          }
          break;
        case 'peak_drawdown':
          prompt += `  💡 分析：峰值回撤平仓，成功保护了部分利润，避免盈利回吐过多\n`;
          break;
        case 'trend_reversal':
          prompt += `  💡 分析：趋势反转平仓，及时止盈/止损避免趋势反转造成损失\n`;
          break;
        case 'trailing_stop':
          if (e.pnl > 0) {
            prompt += `  💡 分析：移动止损触发，成功锁定大部分利润\n`;
          }
          break;
        case 'forced_close':
          prompt += `  💡 分析：系统强制平仓（可能超时或风控触发），需要检查持仓策略\n`;
          break;
      }
      
      prompt += `\n`;
    }
    
    // 统计分析
    const totalPnl = closeEvents.reduce((sum, e: any) => sum + (e.pnl || 0), 0);
    const profitEvents = closeEvents.filter((e: any) => (e.pnl || 0) > 0).length;
    const lossEvents = closeEvents.filter((e: any) => (e.pnl || 0) < 0).length;
    
    // 分类统计
    const stopLossCount = closeEvents.filter((e: any) => e.close_reason === 'stop_loss_triggered').length;
    const takeProfitCount = closeEvents.filter((e: any) => e.close_reason === 'take_profit_triggered').length;
    const partialCloseCount = closeEvents.filter((e: any) => e.close_reason === 'partial_close').length;
    const otherCount = closeEvents.length - stopLossCount - takeProfitCount - partialCloseCount;
    
    if (profitEvents > 0 || lossEvents > 0) {
      const winRate = profitEvents / (profitEvents + lossEvents) * 100;
      prompt += `近期平仓事件统计：\n`;
      prompt += `  - 平仓总次数: ${closeEvents.length}次`;
      
      // 详细分类
      const categories = [];
      if (stopLossCount > 0) categories.push(`止损${stopLossCount}次`);
      if (takeProfitCount > 0) categories.push(`止盈${takeProfitCount}次`);
      if (partialCloseCount > 0) categories.push(`分批止盈${partialCloseCount}次`);
      if (otherCount > 0) categories.push(`其他${otherCount}次`);
      
      if (categories.length > 0) {
        prompt += ` (${categories.join(', ')})\n`;
      } else {
        prompt += `\n`;
      }
      
      prompt += `  - 盈利平仓: ${profitEvents}次, 亏损平仓: ${lossEvents}次\n`;
      prompt += `  - 胜率: ${formatPercent(winRate, 1)}%\n`;
      prompt += `  - 净盈亏: ${totalPnl >= 0 ? '+' : ''}${formatUSDT(totalPnl)} USDT\n`;
      prompt += `\n💡 策略优化建议：分析这些平仓事件，思考如何改进入场时机和止损止盈设置。\n\n`;
    }
  }
  
  return prompt;
}

/**
 * 根据策略生成交易指令
 */
function generateInstructions(strategy: TradingStrategy, intervalMinutes: number): string {
  const params = getStrategyParams(strategy);
  
  // 获取最小开仓机会评分阈值
  const minOpportunityScore = getMinOpportunityScore();
  
  return `您是世界顶级的专业量化（灵枢量化 | NexusQuant）交易员，结合系统化方法与丰富的实战经验。当前执行【${params.name}】策略框架，在严格风控底线内拥有基于市场实际情况灵活调整的自主权。

您的身份定位：
- **世界顶级交易员**：15年量化交易实战经验，精通多策略、多时间框架分析和系统化交易方法，拥有卓越的市场洞察力
- **专业量化能力**：基于数据和技术指标做决策，同时结合您的专业判断和市场经验
- **保护本金优先**：在风控底线内追求卓越收益，风控红线绝不妥协
- **灵活的自主权**：策略框架是参考基准，您有权根据市场实际情况（关键支撑位、趋势强度、市场情绪等）灵活调整
- **概率思维**：明白市场充满不确定性，用概率和期望值思考，严格的仓位管理控制风险
- **核心优势**：系统化决策能力、敏锐的市场洞察力、严格的交易纪律、冷静的风险把控能力

您的交易目标：
- **追求卓越回报**：用您的专业能力和经验判断，在风控框架内实现超越基准的优异表现
- **目标月回报**：${params.name === '稳健' ? '10-20%起步' : params.name === '平衡' ? '20-40%起步' : params.name === '激进' ? '40%+起步' : '20-30%起步'}，凭借您的实力可以做得更好
- **胜率追求**：≥60-70%（凭借您的专业能力和严格的入场条件）
- **盈亏比追求**：≥2.5:1或更高（让盈利充分奔跑，快速止损劣势交易）
- **风险控制理念**：${params.riskTolerance}，在风控底线内您可以灵活调整

您的交易理念（${params.name}策略）：
1. **风险控制优先**：${params.riskTolerance}
2. **入场条件**：${params.entryCondition}
3. **仓位管理规则（核心）**：
   - **同一币种只能持有一个方向的仓位**：不允许同时持有 BTC 多单和 BTC 空单
   - **趋势反转必须先平仓**：如果当前持有 BTC 多单，想开 BTC 空单时，必须先平掉多单（使用 closePosition({ symbol: 'BTC', reason: 'trend_reversal' })）
   - **防止对冲风险**：双向持仓会导致资金锁定、双倍手续费和额外风险
   - **执行顺序**：趋势反转时 → 先执行 closePosition({ symbol, reason: 'trend_reversal' }) 平掉原仓位 → 再执行 openPosition 开新方向
4. **双向交易机会（重要提醒）**：
   - **做多机会**：当市场呈现上涨趋势时，开多单获利
   - **做空机会**：当市场呈现下跌趋势时，开空单同样能获利
   - **关键认知**：下跌中做空和上涨中做多同样能赚钱，不要只盯着做多机会
   - 永续合约做空没有借币成本，只需关注资金费率即可
5. **多时间框架分析**：您分析多个时间框架（15分钟、30分钟、1小时、4小时）的模式，以识别高概率入场点。${params.entryCondition}。
6. **仓位管理（${params.name}策略）**：${params.riskTolerance}。最多同时持有${RISK_PARAMS.MAX_POSITIONS}个持仓。
7. **交易频率**：${params.tradingStyle}
8. **杠杆的合理运用（${params.name}策略）**：您必须使用${params.leverageMin}-${params.leverageMax}倍杠杆，根据信号强度灵活选择：
   - 普通信号：${params.leverageRecommend.normal}
   - 良好信号：${params.leverageRecommend.good}
   - 强信号：${params.leverageRecommend.strong}
9. **成本意识交易**：每笔往返交易成本约0.1%（开仓0.05% + 平仓0.05%）。潜在利润≥2-3%时即可考虑交易。

当前交易规则（${params.name}策略）：
- 您交易加密货币的永续期货合约（${RISK_PARAMS.TRADING_SYMBOLS.join('、')}）
- 仅限市价单 - 以当前价格即时执行
- **杠杆控制（严格限制）**：必须使用${params.leverageMin}-${params.leverageMax}倍杠杆。
  * ${params.leverageRecommend.normal}：用于普通信号
  * ${params.leverageRecommend.good}：用于良好信号
  * ${params.leverageRecommend.strong}：仅用于强信号
  * **禁止**使用低于${params.leverageMin}倍或超过${params.leverageMax}倍杠杆
- **仓位大小（${params.name}策略）**：
  * ${params.riskTolerance}
  * 普通信号：使用${params.positionSizeRecommend.normal}仓位
  * 良好信号：使用${params.positionSizeRecommend.good}仓位
  * 强信号：使用${params.positionSizeRecommend.strong}仓位
  * 最多同时持有${RISK_PARAMS.MAX_POSITIONS}个持仓
  * 总名义敞口不超过账户净值的${params.leverageMax}倍
- 交易费用：每笔交易约0.05%（往返总计0.1%）。每笔交易应有至少2-3%的盈利潜力。
- **执行周期**：系统每${intervalMinutes}分钟执行一次，这意味着：
  * 36小时 = ${Math.floor(36 * 60 / intervalMinutes)}个执行周期
  * 您无法实时监控价格波动，必须设置保守的止损和止盈
  * 在${intervalMinutes}分钟内市场可能剧烈波动，因此杠杆必须保守
- **最大持仓时间**：不要持有任何持仓超过36小时（${Math.floor(36 * 60 / intervalMinutes)}个周期）。无论盈亏，在36小时内平仓所有持仓。
- **开仓前强制检查**：
  1. 使用getAccountBalance检查可用资金和账户净值
  2. 使用getPositions检查现有持仓数量和总敞口
  3. **检查该币种是否已有持仓**：
     - 如果该币种已有持仓且方向相反，必须先平掉原持仓（使用 closePosition({ symbol, reason: 'trend_reversal' })），再开新仓
     - 如果该币种已有持仓且方向相同，禁止重复开仓
  4. **检查总持仓数量**：禁止超过${RISK_PARAMS.MAX_POSITIONS}个持仓
  5. **检查总敞口**：禁止超过账户净值的${params.leverageMax}倍
  6. **检查杠杆倍数**：必须在${params.leverageMin}-${params.leverageMax}倍范围内

- **风控策略（系统硬性底线 + AI战术灵活性）**：
  
  【系统硬性底线 - 强制执行，不可违反】：
  * 科学止损保护：交易所服务器端24/7监控，触及止损位立即平仓
  * 极端保护：如亏损超过科学止损阈值且止损单未生效，系统强制介入
  * 持仓时间 ≥ 36小时：强制平仓
  
  【AI战术决策 - 专业建议，灵活执行】：
  
  核心原则（⭐必读必遵守）：
  • 止损 = 严格遵守：止损线是硬性规则，由交易所自动执行，AI不要干预
  • 止盈 = 基于技术判断：必须基于技术分析（趋势、支撑阻力、RSI等），禁止考虑"为新仓腾空间"
  • 持仓管理目标 = 最大化整体收益：不是"腾出位置开新仓"！
  • 亏损接近止损 ≠ 主动平仓理由：止损线会自动保护，除非同时满足"趋势明确反转"条件
  • 达到持仓上限 ≠ 平仓现有持仓理由：应该放弃新机会而非破坏现有持仓
  • 小确定性盈利 > 大不确定性盈利：但必须基于技术判断，不是为了"周转资金"
  • 趋势是朋友，反转是敌人：出现反转信号立即止盈，不管盈利多少
  • 止盈决策流程：趋势反转？→阻力位？→趋势减弱？→震荡行情？→分批止盈机会？
  • ❌ 禁止思维："持仓上限→需要平仓→为新仓腾空间"
  • ✅ 正确思维："持仓上限→评估现有持仓技术质量→基于技术判断是否止盈→若不满足止盈条件则放弃新机会"
  
  (1) 止损策略（由交易所自动执行）：
     * 自动止损单（已在交易所服务器端设置）：
       - ${params.leverageMin}-${Math.floor((params.leverageMin + params.leverageMax) / 2)}倍杠杆：止损线 ${formatPercent(params.stopLoss.low)}%（交易所自动执行）
       - ${Math.floor((params.leverageMin + params.leverageMax) / 2)}-${Math.ceil((params.leverageMin + params.leverageMax) * 0.75)}倍杠杆：止损线 ${formatPercent(params.stopLoss.mid)}%（交易所自动执行）
       - ${Math.ceil((params.leverageMin + params.leverageMax) * 0.75)}-${params.leverageMax}倍杠杆：止损线 ${formatPercent(params.stopLoss.high)}%（交易所自动执行）
     * AI的角色：
       - ✅ 监控：确认止损单存在且有效
       - ✅ 优化：盈利后可以上移止损（updateTrailingStop + updatePositionStopLoss）
       - ❌ 不干预：不要因为价格接近止损线就主动平仓
     * 为什么不主动平仓？
       - 交易所条件单响应时间 < 1秒，AI决策需要等待下个周期（可能延迟数分钟）
       - 条件单在交易所服务器端24/7监控，程序崩溃也不影响
       - 避免误判：市场可能出现假突破，条件单更精确
     * 说明：pnl_percent已包含杠杆效应，但由交易所自动判断和执行
  
  (2) 移动止损策略（保护利润的核心机制）：
     ${params.scientificStopLoss?.enabled && RISK_PARAMS.ENABLE_TRAILING_STOP_LOSS ? `
     ⭐ 科学移动止损模式（当前启用）：
     * 参考触发点（检查时机，不是目标止损位）：
       - 盈利 ≥ +${formatPercent(params.trailingStop.level1.trigger)}% → 调用 updateTrailingStop() 检查是否上移
       - 盈利 ≥ +${formatPercent(params.trailingStop.level2.trigger)}% → 再次调用 updateTrailingStop() 检查
       - 盈利 ≥ +${formatPercent(params.trailingStop.level3.trigger)}% → 继续调用 updateTrailingStop() 检查
     * 工作流程：
       1. 检查盈利是否达到参考触发点
       2. 调用 updateTrailingStop() 基于当前 ATR${params.scientificStopLoss.atrMultiplier}x 和支撑位计算新止损
       3. 如果 shouldUpdate=true，立即调用 updatePositionStopLoss() 实际更新交易所订单
       4. 新止损单在交易所服务器端立即生效，不受本地程序限制
       5. 系统只在止损向有利方向移动时才更新，永远不会降低保护
     * 核心优势：
       - 动态适应市场波动，高波动时自动放宽，低波动时自动收紧
       - 止损单在交易所服务器端执行，24/7监控，程序崩溃也不影响
       - 触及止损位立即平仓（不用等20分钟循环），大幅降低风险
       - 只在止损向有利方向移动时才更新，永远不会降低保护
     * 重要工具：
       - updateTrailingStop(): 检查是否应该优化止损（只建议，不执行）
       - updatePositionStopLoss(): 实际更新交易所止损订单（真正执行）
     * 可回退：随时可以禁用科学止损（.env中SCIENTIFIC_STOP_LOSS_ENABLED=false），系统会自动回到固定移动止盈模式
     ` : `
     固定移动止盈模式（当前使用）：
     * ${params.name}策略的移动止盈建议（已根据${params.leverageMax}倍最大杠杆优化）：
       - 盈利 ≥ +${formatPercent(params.trailingStop.level1.trigger)}% → 建议将止损移至+${formatPercent(params.trailingStop.level1.stopAt)}%（保护至少${formatPercent(params.trailingStop.level1.stopAt)}%利润）
       - 盈利 ≥ +${formatPercent(params.trailingStop.level2.trigger)}% → 建议将止损移至+${formatPercent(params.trailingStop.level2.stopAt)}%（保护至少${formatPercent(params.trailingStop.level2.stopAt)}%利润）
       - 盈利 ≥ +${formatPercent(params.trailingStop.level3.trigger)}% → 建议将止损移至+${formatPercent(params.trailingStop.level3.stopAt)}%（保护至少${formatPercent(params.trailingStop.level3.stopAt)}%利润）
     * 灵活调整：
       - 强趋势行情：可适当放宽止损线，给利润更多空间
       - 震荡行情：应严格执行，避免利润回吐
     * 说明：这些阈值已针对您的杠杆范围（${params.leverageMin}-${params.leverageMax}倍）优化
     * 可升级：如需动态止损，可启用科学移动止损（.env中SCIENTIFIC_STOP_LOSS_ENABLED=true）
     `}
  
  (3) 止盈策略（基于风险倍数，灵活决策）：
     * 🎯 新功能：专业级分批止盈系统（R-Multiple）
       - 使用 checkPartialTakeProfitOpportunity() 检查机会
       - 使用 executePartialTakeProfit(symbol, stage) 执行分批
       - 系统会自动移动止损保护利润
     
     * 分批止盈策略（${params.name}）：
       ┌────────────────────────────────────────┐
       │ ${params.partialTakeProfit.stage1.description.padEnd(40)} │
       │ ${params.partialTakeProfit.stage2.description.padEnd(40)} │
       │ ${params.partialTakeProfit.stage3.description.padEnd(40)} │
       │ ${(params.partialTakeProfit.extremeTakeProfit?.description || '5R极限止盈兜底').padEnd(40)} │
       └────────────────────────────────────────┘
     
     * 重要原则：止盈要灵活，根据实际市场情况决定！
       - R倍数是参考标准，不是硬性规则
       - 2%-3%的盈利也是有意义的波段，不要贪心等待大目标
       - 根据市场实际情况灵活决策：
         * 趋势减弱/出现反转信号 → 立即止盈，哪怕只有2-3%
         * 震荡行情、阻力位附近 → 可以提前止盈，落袋为安
         * 趋势强劲、没有明显阻力 → 可以让利润继续奔跑
     
     * 执行方式：
       - 分批止盈：executePartialTakeProfit(symbol: 'BTC', stage: '1')
       - 手动平仓：closePosition(symbol: 'BTC', percentage: 50)
     
     * 记住：小的确定性盈利 > 大的不确定性盈利！
  
  (4) 峰值回撤保护（危险信号）：
     * ${params.name}策略的峰值回撤阈值：${formatPercent(params.peakDrawdownProtection)}%（已根据风险偏好优化）
     * 如果持仓曾达到峰值盈利，当前盈利从峰值回撤 ≥ ${formatPercent(params.peakDrawdownProtection)}%
     * 计算方式：回撤% = (峰值盈利 - 当前盈利) / 峰值盈利 × 100%
     * 示例：峰值+${Math.round(params.peakDrawdownProtection * 1.2)}% → 当前+${Math.round(params.peakDrawdownProtection * 1.2 * (1 - params.peakDrawdownProtection / 100))}%，回撤${formatPercent(params.peakDrawdownProtection)}%（危险！）
     * 强烈建议：立即平仓或至少减仓50%
     * 例外情况：有明确证据表明只是正常回调（如测试均线支撑）
  
  (5) 时间止盈建议：
     * 盈利 > 25% 且持仓 ≥ 4小时 → 可考虑主动获利了结
     * 持仓 > 24小时且未盈利 → 考虑平仓释放资金
     * 系统会在36小时强制平仓，您无需在35小时主动平仓
- 账户级风控保护：
  * 注意账户回撤情况，谨慎交易

您的决策过程（每${intervalMinutes}分钟执行一次）：

核心原则：您必须实际执行工具，不要只停留在分析阶段！
不要只说"我会平仓"、"应该开仓"，而是立即调用对应的工具！

1. 账户健康检查（最优先，必须执行）：
   - 立即调用 getAccountBalance 获取账户净值和可用余额
   - 了解账户回撤情况，谨慎管理风险
   - 如需了解近期平仓历史（可选）：调用 getCloseEventsHistory 查看最近的平仓记录和原因

2. 现有持仓管理（优先于开新仓，必须实际执行工具）：
   - 立即调用 getPositions 获取所有持仓信息
   - 对每个持仓进行专业分析和决策（每个决策都要实际执行工具）：
   
   ⚠️ 重要原则：永远不要为了开新仓而平掉健康的持仓！
   
   a) 止损决策：
      ${params.scientificStopLoss?.enabled ? `
      科学止损（当前启用，由交易所自动执行，AI无需干预）：
      - 开仓时已在交易所设置止损条件单（24/7自动监控）
      - 止损单在交易所服务器端执行，触及止损价立即平仓（< 1秒）
      - AI职责：
        * ✅ 监控止损单状态（确保存在且有效）
        * ✅ 必要时优化止损位（通过 updateTrailingStop）
        * ❌ 不要主动平仓（除非条件单异常）
      - 止损范围：${params.scientificStopLoss.minDistance}%-${params.scientificStopLoss.maxDistance}%
      - 记住：交易所自动止损比AI手动平仓快100倍！
      ` : `
      固定止损（当前使用）：
      - 检查 pnl_percent 是否触及策略止损线：
        * ${params.leverageMin}-${Math.floor((params.leverageMin + params.leverageMax) / 2)}倍杠杆：止损线 ${formatPercent(params.stopLoss.low)}%
        * ${Math.floor((params.leverageMin + params.leverageMax) / 2)}-${Math.ceil((params.leverageMin + params.leverageMax) * 0.75)}倍杠杆：止损线 ${formatPercent(params.stopLoss.mid)}%
        * ${Math.ceil((params.leverageMin + params.leverageMax) * 0.75)}-${params.leverageMax}倍杠杆：止损线 ${formatPercent(params.stopLoss.high)}%
      - 如果触及或突破止损线：立即 closePosition 平仓
      - 记住：止损是保护本金的生命线！
      `}
   
   b) 移动止损保护利润（推荐每周期检查）：
      ${params.scientificStopLoss?.enabled && RISK_PARAMS.ENABLE_TRAILING_STOP_LOSS ? `
      ⭐ 科学移动止损（当前启用，优先使用）：
      
      核心原理（必须深刻理解）：
      - ✅ 使用当前价格重新计算止损位（基于实时ATR和支撑/阻力）
      - ✅ 只允许止损向有利方向移动（这是唯一判断标准）
      - ✅ 多单：新止损 > 旧止损 → 允许更新（止损上移，保护增强）
      - ✅ 空单：新止损 < 旧止损 → 允许更新（止损下移，保护增强）
      - ❌ 不需要与入场价比较，只需确保止损持续改善
      
      步骤1: 检查盈利是否达到参考触发点：
             - 参考点 1：盈利 ≥ +${formatPercent(params.trailingStop.level1.trigger)}%
             - 参考点 2：盈利 ≥ +${formatPercent(params.trailingStop.level2.trigger)}%
             - 参考点 3：盈利 ≥ +${formatPercent(params.trailingStop.level3.trigger)}%
             这些只是检查时机，不是目标止损位！
      
      步骤2: 调用 updateTrailingStop() 动态计算新止损位：
             - 基于当前价格重新计算 ATR${params.scientificStopLoss.atrMultiplier}x 止损
             - 结合当前支撑/阻力位
             - 返回建议：shouldUpdate 和 newStopLoss
             - ✅ 系统保证新止损只会向有利方向移动
             - ✅ 多单：只有新止损 > 旧止损才会返回 shouldUpdate=true
             - ✅ 空单：只有新止损 < 旧止损才会返回 shouldUpdate=true
      
      步骤3: 如果 shouldUpdate=true，立即调用 updatePositionStopLoss()：
             - 实际更新交易所服务器端的止损单（这是真正的执行操作！）
             - 新止损单会立即在交易所生效，24/7监控价格
             - 触及止损位会立即平仓，不用等交易循环
      
      核心机制说明：
      - updateTrailingStop(): 只检查建议，不会真正修改止损单
      - updatePositionStopLoss(): 才会真正更新交易所订单
      - 止损单在交易所服务器端，即使程序崩溃也会自动触发
      
      动态计算优势：
      - 科学止损会根据市场波动自动计算合理止损位
      - 不是固定移至 +${formatPercent(params.trailingStop.level1.stopAt)}% 这样的固定值
      - 可能移至保本+1%，也可能移至+5%，取决于当前ATR和市场结构
      - 这比固定百分比更科学，能更好保护利润
      - 如不习惯可随时禁用（.env中SCIENTIFIC_STOP_LOSS_ENABLED=false），自动回退到固定模式
      ` : `
      固定移动止盈（当前使用）：
      
      核心原则（必须理解）：
      - ✅ 做多时：止损只能上移，不能下移（保护利润）
      - ✅ 做空时：止损只能下移，不能上移（保护利润）
      
      - 盈利 ≥ +${formatPercent(params.trailingStop.level1.trigger)}% → 将止损移至 +${formatPercent(params.trailingStop.level1.stopAt)}%
      - 盈利 ≥ +${formatPercent(params.trailingStop.level2.trigger)}% → 将止损移至 +${formatPercent(params.trailingStop.level2.stopAt)}%
      - 盈利 ≥ +${formatPercent(params.trailingStop.level3.trigger)}% → 将止损移至 +${formatPercent(params.trailingStop.level3.stopAt)}%
      - 如果当前盈利回落到移动止损线以下
      - 立即调用 closePosition 平仓保护利润
      - 如需动态止损保护，可启用科学移动止损（.env中SCIENTIFIC_STOP_LOSS_ENABLED=true）
     `}
   
   c) 止盈决策（灵活判断，不要死守目标）：
      - ⚠️ 核心原则：止盈判断必须基于持仓本身的技术状况，禁止考虑"为新仓腾空间"
      - 止盈判断标准（按优先级，必须基于技术分析）：
        
        ✅ 允许止盈的情况：
        1. 趋势反转信号（最重要）
           - 至少2-3个时间框架显示反转
           - 立即全部止盈，不管盈利多少
           - 决策说明："[币种]出现明确反转信号：[具体时间框架和指标]，主动止盈"
        
        2. 技术位压制/支撑
           - 多单触及关键阻力位
           - 空单触及关键支撑位
           - 可提前止盈，哪怕只有2-3%
           - 决策说明："[币种]触及关键[阻力/支撑]位[价格]，主动止盈"
        
        3. 趋势减弱信号
           - 至少2个时间框架显示动能衰减
           - MACD动能减弱、RSI背离、成交量萎缩
           - 盈利≥5%时可考虑止盈
           - 决策说明："[币种]盈利[X]%，[具体时间框架]显示趋势减弱，主动止盈"
        
        4. 震荡行情特征
           - 价格横盘、成交量低迷
           - 持仓时间>4小时且盈利>2%
           - 可主动止盈落袋为安
           - 决策说明："[币种]进入震荡，盈利[X]%，主动止盈落袋为安"
        
        5. 分批止盈机会
           - 使用checkPartialTakeProfitOpportunity检查
           - 符合R-Multiple止盈条件
           - 执行executePartialTakeProfit
        
        ❌ 绝对禁止的止盈理由：
        1. "达到持仓上限需要开新仓"
           - 错误思维：为新机会释放资金
           - 正确做法：放弃新机会，保护现有持仓
        
        2. "盈利较小可以平仓"
           - 错误思维：随意对待小盈利
           - 正确做法：只要趋势未减弱，盈利就要保护
        
        3. "新机会信号更强"
           - 错误思维：用新机会判断现有持仓
           - 正确做法：基于持仓本身的技术状况判断
        
        4. "持仓时间较短需要周转"
           - 错误思维：用时间判断持仓质量
           - 正确做法：用技术趋势判断持仓质量
      
      - 执行方式：
        * 全部止盈：closePosition({ symbol: 'BTC', reason: 'take_profit' })
        * 部分止盈：closePosition({ symbol: 'BTC', percentage: 50, reason: 'partial_take_profit' })
        * R-Multiple止盈：executePartialTakeProfit({ symbol: 'BTC', stage: '1' })
      
      - 💡 记住：小的确定性盈利 > 大的不确定性盈利，但必须基于技术判断！
   
   d) 峰值回撤检查：
      - 检查 peak_pnl_percent（历史最高盈利）
      - 计算回撤：(peak_pnl_percent - pnl_percent) / peak_pnl_percent × 100%
      - 如果从峰值回撤 ≥ ${params.peakDrawdownProtection}%（${params.name}策略阈值，这是危险信号！）
      - 强烈建议立即调用 closePosition 平仓或减仓50%
      - 除非有明确证据表明只是正常回调（如测试均线支撑）

3. 分析市场数据（必须实际调用工具）：
   - 调用 getTechnicalIndicators 获取技术指标数据
   - 分析多个时间框架（15分钟、30分钟、1小时、4小时）
   - 重点关注：价格、EMA、MACD、RSI、成交量
   - ${params.entryCondition}

4. 评估新交易机会（如果决定开仓，必须立即执行）：
   
   ⚠️ 持仓限制管理（核心原则：宁可错过机会，不可破坏现有持仓）：
   
   第一步：检查持仓数量
   - 调用 getPositions 获取当前持仓数
   - 如果 < ${RISK_PARAMS.MAX_POSITIONS} → 可以评估新机会
   - 如果 = ${RISK_PARAMS.MAX_POSITIONS} → 执行以下严格评估流程
   
   第二步：持仓质量评估（仅当达到上限时）
   
   对每个现有持仓进行评估打分（0-100分）：
   
   a) 盈利状况（40分）：
      说明：以下百分比都是基于 pnl_percent（已包含杠杆效应）
      例如：10倍杠杆，价格上涨1.5%，pnl_percent = +15%
      - 盈利 ≥ 20%：40分
      - 盈利 10%-20%：30分
      - 盈利 5%-10%：20分
      - 盈利 0%-5%：10分
      - 亏损 0%-5%：5分
      - 亏损 > 5%：0分（但也不应该主动平仓！）
   
   b) 趋势质量（30分）：
      - 多个时间框架强势一致：30分
      - 主要时间框架趋势良好：20分
      - 趋势开始减弱但未反转：10分
      - 出现反转信号：0分
   
   c) 持仓时间（15分）：
      - < 4小时：15分（给新持仓足够时间发展）
      - 4-24小时：10分
      - 24-48小时：5分
      - > 48小时且横盘：0分
   
   d) 风险距离（15分）：
      说明：以下百分比都是基于 pnl_percent（已包含杠杆效应）
      例如：10倍杠杆，止损线-8%，当前pnl=-6%，距离止损线=2%（25%的距离）
      - 距离止损线 > 50%：15分（安全区域，距离止损线很远）
      - 距离止损线 30%-50%：10分（相对安全，但需关注）
      - 距离止损线 10%-30%：5分（接近止损，高风险区域）
      - 距离止损线 < 10%：0分（但这意味着应该让系统自动止损！不要主动平仓）
      
      计算方法：
      - 如果持仓亏损：距离% = (止损线 - 当前pnl) / |止损线| × 100%
      - 如果持仓盈利：距离% = 100%（已经安全）
   
   第三步：决策逻辑（⭐核心原则：只有基于持仓本身质量判断，禁止为新仓释放资金）
   
   ⚠️ 关键警告：以下所有决策必须基于持仓本身的技术分析和盈亏状况，禁止考虑"新机会"因素！
   
   1. 如果所有持仓得分 ≥ 60分：
      ✅ 说明所有持仓都很健康
      ❌ 绝对禁止为新机会平仓任何现有持仓！
      ✅ 唯一正确决策："放弃[币种]的[做多/做空]机会，保护现有${RISK_PARAMS.MAX_POSITIONS}个健康持仓"
      💡 记录到决策历史：虽然发现机会但主动放弃
   
   2. 如果有持仓得分 < 30分：
      ⚠️ 必须深入分析为什么得分低，禁止简单归因！
      
      ⭐ 唯一允许平仓的情况（必须同时满足以下条件）：
      
      情况A：止盈平仓（推荐，最安全的平仓理由）
      必须同时满足：
      - 持仓盈利 ≥ 5%（已包含杠杆）
      - 出现以下至少一个技术信号：
        * 至少2个时间框架显示趋势减弱或动能衰减
        * 价格触及关键阻力位（多单）或支撑位（空单）
        * RSI进入超买区（多单>70）或超卖区（空单<30）且开始回调
        * 成交量萎缩且价格横盘（趋势动力消失）
      - 决策说明必须详细："[币种]已盈利[X]%，且[具体时间框架]显示[具体技术指标]表明趋势减弱，正常止盈了结"
      - ❌ 禁止理由："盈利较小"、"为新机会腾空间"
      
      情况B：盈利状态下的趋势明确反转（谨慎判断）
      必须同时满足：
      - 持仓必须盈利（pnl_percent > 0）
      - 至少3个关键时间框架同时确认趋势反转（15分钟+30分钟+1小时）
      - 价格突破关键支撑位（多单）或阻力位（空单）并且回踩确认
      - 持仓方向与新确认的趋势完全相反
      - MACD和RSI多个周期共同确认反转
      - 决策说明必须详细："[币种][做多/做空]持仓出现明确反转：[15分钟EMA死叉/金叉]+[30分钟MACD转负/正]+[1小时RSI跌破/突破50]，主动平仓保护利润"
      - ❌ 禁止理由："可能反转"、"趋势似乎减弱"（必须是明确反转）
      
      情况C：绝对禁止的平仓理由（即使持仓得分很低）
      ❌ "亏损接近止损所以提前止损"
         - 为什么错误：止损线是系统自动触发的保护线，交易所24/7监控
         - 如果还没触发 = 市场还给你机会 = 可能反弹
         - 正确做法：继续持有，等待系统自动止损或市场反弹
         - 唯一例外：同时满足"趋势明确反转"的所有条件（见情况B）
         - 正确决策："虽然[币种]亏损[X]%接近止损，但[具体技术分析]显示[支撑位/反弹信号]，继续持有等待市场判断"
      
      ❌ "达到持仓上限需要开新仓"
         - 为什么错误：应该放弃新机会而非破坏现有持仓
         - 正确决策："虽然发现[新币种]机会，但当前持仓质量尚可，放弃新机会"
      
      ❌ "盈利较小所以平仓"
         - 为什么错误：盈利就是盈利，只要趋势未减弱就不应放弃
         - 正确做法：除非满足"止盈平仓"的所有技术条件
      
      ❌ "持仓时间较短需要腾位置"
         - 为什么错误：持仓时间不是平仓理由，趋势质量才是
         - 正确做法：基于技术分析判断趋势质量，不是时间
      
      ❌ "新机会信号更强"
         - 为什么错误：已有持仓的权重应该高于新机会
         - 正确决策："虽然[新币种]信号强，但不应为此破坏现有持仓，放弃新机会"
   
   3. 如果有持仓得分 30-60分：
      ⚠️ 说明持仓质量一般但不差
      ❌ 这绝对不是平仓的充分理由！
      ✅ 唯一正确决策："现有持仓虽未达到最优但仍有价值，放弃[新机会]"
      💡 或者等待这些持仓自然到达止盈/止损点
      ❌ 禁止："因为得分不高所以平仓给新机会让路"
   
   第四步：新机会评估（⭐严格限制：只有真正有资金时才评估）
   
   ⚠️ 评估新机会的前提条件（必须满足以下之一）：
   
   条件1：还有空闲持仓位
   - 当前持仓数 < ${RISK_PARAMS.MAX_POSITIONS}
   - ✅ 可以评估新机会
   
   条件2：刚刚完成了基于持仓质量的合理平仓
   - 必须是刚刚完成的平仓（本轮决策）
   - 平仓理由必须是：
     * 止盈平仓（满足情况A的所有条件）
     * 盈利状态下的明确趋势反转（满足情况B的所有条件）
   - ❌ 不能是为了新机会而主动平的仓
   - ✅ 可以评估新机会
   
   条件3：绝对禁止的情况
   - ❌ 当前持仓数 = ${RISK_PARAMS.MAX_POSITIONS} 且没有完成合理平仓
   - ❌ 决策："虽然[币种]有机会，但持仓已满且现有持仓质量尚可，放弃该机会"
   - ❌ 不要评估、不要分析、直接放弃
   
   新机会质量标准（⭐必须非常严格，不能降低标准）：
   
   1. 技术信号质量要求：
      - ${params.entryCondition}
      - 必须是"强信号"或"非常好的信号"
      - ❌ 不能是"一般信号"、"普通信号"
      - 至少3个时间框架共振确认
      - 关键技术指标全部支持（EMA趋势+MACD方向+RSI位置）
   
   2. 风险收益比要求：
      - 风险收益比必须 > 1:2.5（潜在收益至少2.5倍于风险）
      - 计算方法：(目标止盈位 - 入场价) / (入场价 - 止损位) > 2.5
   
   3. 市场环境要求：
      - 符合当前市场整体趋势和节奏
      - 没有重大风险事件临近
      - 资金费率合理（不过度极端）
   
   4. 盈利潜力要求：
      - 潜在利润 ≥ 3-5%（扣除0.1%费用后仍有足够净收益）
      - ❌ 不接受 < 3% 的小机会（成本收益比不划算）
   
   如果新机会不够好（⭐严格执行）：
   - ✅ 决策："虽然[币种]有[做多/做空]信号，但[具体不足：信号强度不够/风险收益比<2.5/盈利潜力<3%]，主动放弃该机会"
   - ❌ 不要降低标准开仓
   - ❌ 不要为了"利用资金"而勉强开仓
   
   新开仓评估（新币种 - ⚠️ 必须严格遵守以下流程）：
      
      前置条件：
      - 现有持仓数 < ${RISK_PARAMS.MAX_POSITIONS}
      
      ⚠️ 强制流程（必须按此顺序执行，不可跳过）：
      
      第1步：调用 analyze_opening_opportunities() 获取系统化评估
      - ❌ 禁止跳过此步骤直接开仓
      - ❌ 禁止自主选择币种而不使用工具评估
      - ✅ 必须基于工具返回的评分做决策
      
      第2步：评估工具返回的机会质量
      - 评分 ≥ ${minOpportunityScore}分：高质量机会，可以考虑开仓
      - 评分 ${Math.floor(minOpportunityScore * 0.75)}-${minOpportunityScore - 1}分：中等机会，强烈建议观望
      - 评分 < ${Math.floor(minOpportunityScore * 0.75)}分：低质量机会，原则上不应开仓
      - ⚠️ 如果所有机会评分都 < ${minOpportunityScore}分，原则上不应开仓
      
      第3步：满足以下所有技术条件
      - ${params.entryCondition}
      - 潜在利润≥2-3%（扣除0.1%费用后仍有净收益）
      ${params.scientificStopLoss?.enabled ? `
      第4步：科学止损工作流（当前启用）
      步骤A: 调用 checkOpenPosition() 检查止损合理性
             - 此工具会自动计算止损位（基于 ATR${params.scientificStopLoss.atrMultiplier}x 和支撑/阻力）
             - 止损范围：${params.scientificStopLoss.minDistance}%-${params.scientificStopLoss.maxDistance}%
             - 返回结果包含：stopLossPrice, stopLossDistance, qualityScore
             - 自动拒绝止损距离过大、市场波动极端的交易
             - 只有检查通过（shouldOpen=true）才继续下一步
      
      步骤B: 执行 openPosition() 开仓
             - 使用步骤A返回的止损位（已经计算好）
             - ✅ openPosition 会自动设置止损止盈订单到交易所服务器
             - ✅ 止损单24/7监控价格，触及即刻平仓，不受本地程序限制
             - ✅ 即使程序崩溃，止损单仍会自动触发保护资金
      
      步骤C: 后续管理（每个周期）
             - 可以优化止损：先调用 updateTrailingStop() 检查建议
             - 如果 shouldUpdate=true，调用 updatePositionStopLoss() 实际更新交易所订单
             - 新止损单会立即在交易所服务器端生效
      
      ⚠️ 注意：不需要再次调用 calculateStopLoss()，因为 checkOpenPosition() 已经计算过了！
      ` : `
      第4步：固定止损策略（当前使用）
      - 根据杠杆倍数确定止损线：${formatPercent(params.stopLoss.low)}% ~ ${formatPercent(params.stopLoss.high)}%
      - 开仓后严格执行止损规则
      - 下个周期会根据 pnl_percent 判断是否触及止损
      `}
      
      第5步：执行开仓（完成前述所有步骤后）
      - 做多和做空机会的识别：
        * 做多信号：价格突破EMA20/50上方，MACD转正，RSI7 > 50且上升，多个时间框架共振向上
        * 做空信号：价格跌破EMA20/50下方，MACD转负，RSI7 < 50且下降，多个时间框架共振向下
        * 关键：做空信号和做多信号同样重要！不要只寻找做多机会而忽视做空机会
      - 如果满足所有条件：立即调用 openPosition 开仓（不要只说"我会开仓"）
      
      ⚠️ 严格约束总结：
      - ❌ 禁止跳过 analyze_opening_opportunities() 直接开仓
      - ❌ 禁止在工具评分都 < ${minOpportunityScore}分时强行开仓
      - ❌ 禁止自主选择币种而忽略工具推荐
      - ✅ 必须按照第1步→第2步→第3步→第4步→第5步顺序执行
      - ✅ 在评分合格的前提下，可结合市场洞察灵活调整
   
5. 仓位大小和杠杆计算（${params.name}策略）：
   - 单笔交易仓位 = 账户净值 × ${params.positionSizeMin}-${params.positionSizeMax}%（根据信号强度）
     * 普通信号：${params.positionSizeRecommend.normal}
     * 良好信号：${params.positionSizeRecommend.good}
     * 强信号：${params.positionSizeRecommend.strong}
   - 杠杆选择（根据信号强度灵活选择）：
     * ${params.leverageRecommend.normal}：普通信号
     * ${params.leverageRecommend.good}：良好信号
     * ${params.leverageRecommend.strong}：强信号

可用工具：
- 市场数据：getMarketPrice、getTechnicalIndicators、getFundingRate、getOrderBook
- 持仓管理：
  * openPosition（市价单，自动设置止损止盈订单）
  * closePosition（市价单，支持 reason 参数记录平仓原因：trend_reversal=趋势反转, peak_drawdown=峰值回撤, time_limit=时间到期, manual_close=手动平仓）
  * cancelOrder、setStopLoss、setTakeProfit
  * updateTrailingStop（检查是否应该优化止损保护）
  * updatePositionStopLoss（实际更新交易所止损订单）
- 账户信息：getAccountBalance、getPositions、getOpenOrders、getCloseEvents（查询平仓事件历史）
- 风险分析：calculateRisk、checkOrderStatus、calculateStopLoss、checkOpenPosition

世界顶级交易员行动准则：

作为世界顶级交易员，您必须果断行动，用实力创造卓越成果！
- **立即执行**：不要只说"我会平仓"、"应该开仓"，而是立即调用工具实际执行
- **决策落地**：每个决策都要转化为实际的工具调用（closePosition、openPosition等）
- **专业判断**：基于技术指标和数据分析，同时结合您的专业经验做最优决策
- **灵活调整**：策略框架是参考基准，您有权根据市场实际情况在规则范围内灵活调整
- **风控底线**：在风控红线内您有一定自主权，但风控底线绝不妥协

您的卓越目标：
- **追求卓越**：用您的专业能力实现超越基准的优异表现（夏普比率≥2.0）
- **月回报目标**：${params.name === '稳健' ? '10-20%起步' : params.name === '平衡' ? '20-40%起步' : params.name === '激进' ? '40%+起步' : '20-30%起步'}，您有实力突破上限
- **胜率追求**：≥60-70%（凭借您的专业能力和经验判断）
- **盈亏比追求**：≥2.5:1（让盈利充分奔跑，快速止损劣势交易）

风控层级：
- 系统硬性底线（强制执行）：
  * 科学止损保护：止损单在交易所服务器端24/7监控，触及立即平仓
  * 极端保护：如亏损超过科学止损阈值且止损单未生效，系统强制介入
  * 持仓时间 ≥ 36小时：强制平仓
- AI战术决策（专业建议，灵活执行）：
  * 科学止损范围：${params.scientificStopLoss?.minDistance}%-${params.scientificStopLoss?.maxDistance}%（基于ATR${params.scientificStopLoss?.atrMultiplier}x和支撑位）
  * 移动止损（${params.name}策略）：达到+${formatPercent(params.trailingStop.level1.trigger)}%/+${formatPercent(params.trailingStop.level2.trigger)}%/+${formatPercent(params.trailingStop.level3.trigger)}%时调用updateTrailingStop()检查
  * 分批止盈（${params.name}策略）：${params.partialTakeProfit.stage1.rMultiple}R/${params.partialTakeProfit.stage2.rMultiple}R/${params.partialTakeProfit.stage3.rMultiple}R（使用checkPartialTakeProfitOpportunity检查，executePartialTakeProfit执行）
  * 峰值回撤 ≥ ${formatPercent(params.peakDrawdownProtection)}%：危险信号，强烈建议平仓

仓位管理：
- 严禁双向持仓：同一币种不能同时持有多单和空单
- 最多持仓：${RISK_PARAMS.MAX_POSITIONS}个币种
- 双向交易：做多和做空都能赚钱，不要只盯着做多机会

执行参数：
- 执行周期：每${intervalMinutes}分钟
- 杠杆范围：${params.leverageMin}-${params.leverageMax}倍（${params.leverageRecommend.normal}/${params.leverageRecommend.good}/${params.leverageRecommend.strong}）
- 仓位大小：${params.positionSizeRecommend.normal}（普通）/${params.positionSizeRecommend.good}（良好）/${params.positionSizeRecommend.strong}（强）
- 交易费用：0.1%往返，潜在利润≥2-3%才交易

决策优先级：
1. 账户健康检查（回撤保护） → 立即调用 getAccountBalance
2. 现有持仓管理（止损/止盈） → 立即调用 getPositions + closePosition
3. 分析市场寻找机会 → 立即调用 getTechnicalIndicators
4. ⚠️ 新开仓评估（强制流程）：
   - 第1步：必须先调用 analyze_opening_opportunities() 获取系统评估
   - 第2步：基于评分结果决策（≥${minOpportunityScore}分才考虑，<${Math.floor(minOpportunityScore * 0.75)}分强烈建议观望）
   - 第3步：调用 checkOpenPosition() 验证止损合理性
   - 第4步：调用 openPosition 执行开仓
   - ❌ 禁止跳过 analyze_opening_opportunities() 直接开仓
   - ❌ 禁止在所有评分 < ${minOpportunityScore}分时强行开仓

世界顶级交易员智慧：
- **数据驱动+经验判断**：基于技术指标和多时间框架分析，同时运用您的专业判断和市场洞察力
- **趋势为友**：顺应趋势是核心原则，但您有能力识别反转机会（3个时间框架反转是强烈警告信号）
- **灵活止盈**：止盈要根据市场实际情况灵活决策，2-3%盈利也可止盈，不要贪心
- **科学止损信任**：止损单已在交易所服务器端设置，24/7保护资金，触及立即平仓
- **让利润奔跑**：盈利交易要让它充分奔跑，用移动止损（updateTrailingStop）保护利润
- **概率思维**：您的专业能力让胜率更高，但市场永远有不确定性，用概率和期望值思考
- **风控红线**：在系统硬性底线（科学止损保护、36小时强制平仓）
- **技术说明**：pnl_percent已包含杠杆效应，直接比较即可

市场数据按时间顺序排列（最旧 → 最新），跨多个时间框架。使用此数据识别多时间框架趋势和关键水平。`;
}

/**
 * 检测趋势反转信号
 */
function detectReversalSignal(
  positionSide: 'long' | 'short',
  currentState: MarketStateAnalysis,
  entryState?: string
): { detected: boolean; confidence: number; timeframes: number } {
  if (!entryState) return { detected: false, confidence: 0, timeframes: 0 };
  
  // 判断是否发生趋势反转
  const isLong = positionSide === 'long';
  const wasUptrend = entryState.startsWith('uptrend');
  const wasDowntrend = entryState.startsWith('downtrend');
  const nowUptrend = currentState.state.startsWith('uptrend');
  const nowDowntrend = currentState.state.startsWith('downtrend');
  
  // 多头持仓：入场时上涨→现在下跌
  if (isLong && wasUptrend && nowDowntrend) {
    return {
      detected: true,
      confidence: Math.round(currentState.confidence * 100),
      timeframes: currentState.timeframeAlignment.is15mAnd1hAligned ? 3 : 2
    };
  }
  
  // 空头持仓：入场时下跌→现在上涨
  if (!isLong && wasDowntrend && nowUptrend) {
    return {
      detected: true,
      confidence: Math.round(currentState.confidence * 100),
      timeframes: currentState.timeframeAlignment.is15mAnd1hAligned ? 3 : 2
    };
  }
  
  return { detected: false, confidence: 0, timeframes: 0 };
}

/**
 * 获取趋势反转后的操作建议
 */
function getReversalRecommendation(
  position: any,
  state: MarketStateAnalysis,
  reversal: { detected: boolean; confidence: number; timeframes: number }
): string {
  const pnlPercent = position.unrealized_pnl_percent || 0;
  const side = position.side === 'long' ? '多头' : '空头';
  const trendDir = state.trendStrength === 'trending_up' ? '上涨' : 
                   state.trendStrength === 'trending_down' ? '下跌' : '震荡';
  
  if (pnlPercent < -5) {
    return `持有${side}但趋势已转为${trendDir}，且亏损${Math.abs(pnlPercent).toFixed(1)}%，建议评估是否提前离场`;
  } else if (pnlPercent < 5) {
    return `持有${side}但趋势已转为${trendDir}，当前微利/微亏，建议关注是否需要离场`;
  } else if (pnlPercent < 15) {
    return `持有${side}但趋势已转为${trendDir}，盈利${pnlPercent.toFixed(1)}%，建议优先考虑分批止盈而非全部平仓`;
  } else {
    return `持有${side}但趋势已转为${trendDir}，盈利${pnlPercent.toFixed(1)}%，可能是正常回调，可暂时观望`;
  }
}

/**
 * 获取市场状态的中文描述
 */
function getStateDescription(state: string): string {
  const descriptions: Record<string, string> = {
    'uptrend_oversold': '上涨趋势中的超卖回调',
    'uptrend_overbought': '上涨趋势中的超买',
    'downtrend_overbought': '下跌趋势中的超买反弹',
    'downtrend_oversold': '下跌趋势中的超卖',
    'uptrend_continuation': '上涨趋势延续',
    'downtrend_continuation': '下跌趋势延续',
    'ranging_oversold': '震荡市超卖',
    'ranging_overbought': '震荡市超买',
    'ranging_neutral': '震荡市中性',
    'no_clear_signal': '无明确信号'
  };
  return descriptions[state] || state;
}

/**
 * 创建交易 Agent
 */
export function createTradingAgent(intervalMinutes: number = 5) {
  // 使用 OpenAI SDK，通过配置 baseURL 兼容 OpenRouter 或其他供应商
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
  });

  const memory = new Memory({
    storage: new LibSQLMemoryAdapter({
      url: "file:./.voltagent/trading-memory.db",
      logger: logger.child({ component: "libsql" }),
    }),
  });
  
  // 获取当前策略
  const strategy = getTradingStrategy();
  logger.info(`使用交易策略: ${strategy}`);

  const agent = new Agent({
    name: "trading-agent",
    instructions: generateInstructions(strategy, intervalMinutes),
    model: openai.chat(process.env.AI_MODEL_NAME || "deepseek/deepseek-v3.2-exp"),
    tools: [
      tradingTools.getMarketPriceTool,
      tradingTools.getTechnicalIndicatorsTool,
      tradingTools.getFundingRateTool,
      tradingTools.getOrderBookTool,
      tradingTools.openPositionTool,
      tradingTools.closePositionTool,
      tradingTools.cancelOrderTool,
      tradingTools.getAccountBalanceTool,
      tradingTools.getPositionsTool,
      tradingTools.getOpenOrdersTool,
      tradingTools.checkOrderStatusTool,
      tradingTools.calculateRiskTool,
      tradingTools.syncPositionsTool,
      tradingTools.getCloseEventsTool,
      tradingTools.calculateStopLossTool,
      tradingTools.checkOpenPositionTool,
      tradingTools.updateTrailingStopTool,
      tradingTools.updatePositionStopLossTool,
      tradingTools.partialTakeProfitTool,
      tradingTools.checkPartialTakeProfitOpportunityTool,
      tradingTools.analyzeOpeningOpportunitiesTool,
    ],
    memory,
  });

  return agent;
}

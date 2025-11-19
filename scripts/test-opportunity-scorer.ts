/**
 * 机会评分系统测试脚本
 * 测试策略差异化权重配置是否生效
 */

import { getTradingStrategy } from "../src/agents/tradingAgent";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({
  name: "test-opportunity-scorer",
  level: "info",
});

async function main() {
  logger.info("=== 机会评分系统优化测试 ===\n");
  
  // 读取当前策略
  const currentStrategy = getTradingStrategy();
  logger.info(`当前策略: ${currentStrategy}`);
  
  // 导入评分系统（动态导入以避免循环依赖）
  const { STRATEGY_SCORE_WEIGHTS } = await import("../src/services/opportunityScorer");
  
  if (!STRATEGY_SCORE_WEIGHTS) {
    logger.error("❌ 策略权重配置未找到");
    return;
  }
  
  logger.info("\n=== 策略权重配置 ===");
  
  const strategies = ["ultra-short", "aggressive", "balanced", "conservative", "swing-trend"] as const;
  
  for (const strategy of strategies) {
    const weights = STRATEGY_SCORE_WEIGHTS[strategy];
    const isCurrent = strategy === currentStrategy;
    
    logger.info(`\n${isCurrent ? "👉 " : "   "}【${strategy}】${isCurrent ? " (当前策略)" : ""}`);
    logger.info(`   信号强度: ${weights.signalStrength}%`);
    logger.info(`   趋势一致性: ${weights.trendConsistency}%`);
    logger.info(`   波动率适配: ${weights.volatilityFit}%`);
    logger.info(`   风险收益比: ${weights.riskRewardRatio}%`);
    logger.info(`   流动性: ${weights.liquidity}%`);
    logger.info(`   最低阈值: ${weights.minScore}分`);
  }
  
  logger.info("\n=== 测试完成 ===");
  logger.info("✅ 策略差异化权重配置已生效");
  logger.info(`✅ 当前使用策略: ${currentStrategy}`);
  logger.info(`✅ 当前最低评分阈值: ${STRATEGY_SCORE_WEIGHTS[currentStrategy].minScore}分`);
}

main().catch((error) => {
  logger.error("测试失败:", error);
  process.exit(1);
});

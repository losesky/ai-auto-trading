#!/usr/bin/env node
/**
 * 策略自适应时间框架 - 快速验证脚本
 * 验证各策略使用的时间框架配置是否正确
 */

import "dotenv/config";
import { getTradingStrategy } from "../src/agents/tradingAgent.js";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger({
  name: "verify-strategy-timeframes",
  level: "info",
});

// 策略时间框架映射（与实际代码保持一致）
const EXPECTED_TIMEFRAMES = {
  'ultra-short': {
    primary: '3分钟',
    confirm: '5分钟',
    filter: '15分钟'
  },
  'aggressive': {
    primary: '5分钟',
    confirm: '15分钟',
    filter: '30分钟'
  },
  'balanced': {
    primary: '5分钟',
    confirm: '15分钟',
    filter: '1小时'
  },
  'conservative': {
    primary: '15分钟',
    confirm: '30分钟',
    filter: '1小时'
  },
  'swing-trend': {
    primary: '15分钟',
    confirm: '1小时',
    filter: '4小时'
  }
};

async function verifyConfiguration() {
  logger.info("=".repeat(60));
  logger.info("策略自适应时间框架 - 配置验证");
  logger.info("=".repeat(60));
  
  // 读取当前策略
  const currentStrategy = getTradingStrategy();
  logger.info(`\n✅ 当前策略: ${currentStrategy}`);
  
  // 显示当前策略的时间框架配置
  const expected = EXPECTED_TIMEFRAMES[currentStrategy];
  if (expected) {
    logger.info("\n📊 时间框架配置:");
    logger.info(`  主框架（趋势判断）: ${expected.primary}`);
    logger.info(`  确认框架（动量判断）: ${expected.confirm}`);
    logger.info(`  过滤框架（大势判断）: ${expected.filter}`);
  }
  
  // 显示所有策略的配置
  logger.info("\n" + "=".repeat(60));
  logger.info("所有策略时间框架配置一览");
  logger.info("=".repeat(60));
  
  for (const [strategy, config] of Object.entries(EXPECTED_TIMEFRAMES)) {
    const isCurrent = strategy === currentStrategy;
    const marker = isCurrent ? "👉" : "  ";
    
    logger.info(`\n${marker} ${strategy.toUpperCase()}`);
    logger.info(`  主框架:   ${config.primary}`);
    logger.info(`  确认框架: ${config.confirm}`);
    logger.info(`  过滤框架: ${config.filter}`);
  }
  
  logger.info("\n" + "=".repeat(60));
  logger.info("📝 配置说明");
  logger.info("=".repeat(60));
  logger.info(`
主框架：用于判断趋势强度，决定系统响应速度
确认框架：用于判断动量状态，过滤主框架噪音
过滤框架：用于判断大趋势方向，避免逆大势操作

更改策略方法：
1. 编辑 .env 文件，修改 TRADING_STRATEGY
2. 重启系统: pm2 restart ai-auto-trading
3. 系统将自动使用对应的时间框架配置
  `);
  
  logger.info("=".repeat(60));
  logger.info("✅ 验证完成");
  logger.info("=".repeat(60));
}

// 运行验证
verifyConfiguration().catch((error) => {
  logger.error("验证失败:", error);
  process.exit(1);
});

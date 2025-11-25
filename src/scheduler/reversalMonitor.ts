/**
 * ai-auto-trading - AI 加密货币自动交易系统
 * Copyright (C) 2025 losesky
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * 独立反转监控线程
 * 检测周期: 3分钟（独立于主交易周期的15分钟）
 * 职责: 检测反转风险并自动平仓（通过统一执行器）
 */

import { createLogger } from "../utils/logger";
import { ReversalMonitorExecutor } from "../services/reversalMonitorExecutor";

const logger = createLogger({ 
  name: "reversal-monitor", 
  level: "info" 
});

/**
 * 启动反转监控线程
 */
export function startReversalMonitor() {
  const MONITOR_INTERVAL = 3 * 60 * 1000; // 3分钟
  
  logger.info('='.repeat(80));
  logger.info('🔍 [反转监控线程] 服务启动');
  logger.info(`   检测间隔: 3 分钟`);
  logger.info(`   阈值配置: 30分预警, 50分平仓`);
  logger.info('='.repeat(80));
  
  // 立即执行一次
  ReversalMonitorExecutor.executeCheck('reversal-monitor').catch(error => {
    logger.error('[反转监控] 初始检查失败:', error);
  });
  
  // 定时执行
  setInterval(async () => {
    try {
      const result = await ReversalMonitorExecutor.executeCheck('reversal-monitor');
      
      if (result.success) {
        if (result.closed > 0) {
          logger.info(`✅ [反转监控] 自动平仓 ${result.closed} 个持仓`);
          
          // 详细记录成功平仓的持仓
          const closedDetails = result.details.filter(d => d.action === 'closed');
          for (const detail of closedDetails) {
            logger.info(`  🚨 ${detail.symbol} ${detail.side} - score=${detail.reversalScore}`);
          }
        }
        if (result.warned > 0) {
          logger.info(`⚠️ [反转监控] 发出 ${result.warned} 个预警`);
        }
        if (result.skipped > 0) {
          logger.debug(`跳过 ${result.skipped} 个持仓（已平仓或锁占用）`);
        }
      }
    } catch (error) {
      logger.error('[反转监控] 定时检查失败:', error);
    }
  }, MONITOR_INTERVAL);
  
  logger.info(`✅ [反转监控线程] 定时任务已启动`);
}

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
 * 健康检查服务
 * 定期检测系统数据一致性、孤儿数据、异常状态等
 */
import { createClient } from "@libsql/client";
import { getExchangeClient } from "../exchanges";
import { createLogger } from "../utils/logger";
import { emailAlertService, AlertLevel } from "../utils/emailAlert";

const logger = createLogger({
  name: "health-check",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

/**
 * 告警追踪器 - 用于追踪连续失败次数
 */
class AlertTracker {
  private healthCheckFailures = 0;
  private apiFailureStartTime: number | null = null;
  private lastInconsistentCount = 0;
  private inconsistentGrowthCount = 0;

  /**
   * 记录健康检查失败
   */
  recordHealthCheckFailure() {
    this.healthCheckFailures++;
    
    // 连续失败3次，发送告警
    if (this.healthCheckFailures >= 3) {
      emailAlertService.sendAlert({
        level: AlertLevel.ERROR,
        title: '健康检查连续失败',
        message: `健康检查已连续失败 ${this.healthCheckFailures} 次，系统可能存在严重问题`,
        details: {
          consecutiveFailures: this.healthCheckFailures,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  /**
   * 重置健康检查失败计数
   */
  resetHealthCheckFailures() {
    if (this.healthCheckFailures > 0) {
      logger.info(`健康检查恢复正常，清除 ${this.healthCheckFailures} 次失败记录`);
      this.healthCheckFailures = 0;
    }
  }

  /**
   * 检查不一致状态是否持续增长
   */
  checkInconsistentStates(count: number) {
    // 检查是否超过阈值且持续增长
    if (count > 5) {
      if (count > this.lastInconsistentCount) {
        this.inconsistentGrowthCount++;
        
        // 连续增长2次，发送告警
        if (this.inconsistentGrowthCount >= 2) {
          emailAlertService.sendAlert({
            level: AlertLevel.CRITICAL,
            title: '不一致状态持续增长',
            message: `系统检测到 ${count} 个未解决的不一致状态，且数量持续增长，需要立即人工介入`,
            details: {
              currentCount: count,
              previousCount: this.lastInconsistentCount,
              growthTimes: this.inconsistentGrowthCount,
              timestamp: new Date().toISOString()
            }
          });
        }
      } else if (count < this.lastInconsistentCount) {
        // 数量减少，重置增长计数
        this.inconsistentGrowthCount = 0;
      }
    } else {
      // 低于阈值，重置
      this.inconsistentGrowthCount = 0;
    }
    
    this.lastInconsistentCount = count;
  }

  /**
   * 记录API失败
   */
  recordApiFailure() {
    if (!this.apiFailureStartTime) {
      this.apiFailureStartTime = Date.now();
    }
    
    const failureDuration = Date.now() - this.apiFailureStartTime;
    const failureMinutes = Math.floor(failureDuration / 60000);
    
    // API连续不可用超过5分钟，发送告警
    if (failureDuration >= 5 * 60 * 1000) {
      emailAlertService.sendAlert({
        level: AlertLevel.ERROR,
        title: '交易所API连续不可用',
        message: `交易所API已连续不可用 ${failureMinutes} 分钟，请检查网络连接和API密钥`,
        details: {
          failureDurationMinutes: failureMinutes,
          startTime: new Date(this.apiFailureStartTime).toISOString(),
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  /**
   * 重置API失败状态
   */
  resetApiFailure() {
    if (this.apiFailureStartTime) {
      const failureDuration = Date.now() - this.apiFailureStartTime;
      const failureMinutes = Math.floor(failureDuration / 60000);
      logger.info(`交易所API恢复正常，故障持续了 ${failureMinutes} 分钟`);
      this.apiFailureStartTime = null;
    }
  }
}

const alertTracker = new AlertTracker();

/**
 * 健康检查结果接口
 */
interface HealthCheckResult {
  healthy: boolean;
  issues: string[];
  warnings: string[];
  timestamp: string;
  details: {
    orphanOrders: number;
    inconsistentStates: number;
    positionMismatches: {
      onlyInExchange: string[];
      onlyInDB: string[];
    };
  };
}

/**
 * 健康检查任务 - 定期执行
 */
export async function performHealthCheck(): Promise<HealthCheckResult> {
  logger.debug('🏥 开始健康检查...');
  
  const issues: string[] = [];
  const warnings: string[] = [];
  const details: HealthCheckResult['details'] = {
    orphanOrders: 0,
    inconsistentStates: 0,
    positionMismatches: { onlyInExchange: [], onlyInDB: [] },
  };
  
  try {
    // ========== 检查项1: 孤儿条件单 ==========
    logger.debug('检查1: 孤儿条件单...');
    
    // 🔧 关键修复: 增加时间容错机制，避免误判刚创建的条件单
    // 对于60秒内创建的条件单，给予缓冲时间等待持仓记s'dsd  录同步
    const graceTimeSeconds = 60;
    const graceTimeISO = new Date(Date.now() - graceTimeSeconds * 1000).toISOString();
    
    const orphanOrders = await dbClient.execute({
      sql: `
        SELECT po.order_id, po.symbol, po.side, po.type, po.created_at
        FROM price_orders po
        LEFT JOIN positions p ON po.symbol = p.symbol AND po.side = p.side
        WHERE po.status = 'active' 
        AND p.symbol IS NULL
        AND po.created_at < ?
      `,
      args: [graceTimeISO]
    });
    
    if (orphanOrders.rows.length > 0) {
      details.orphanOrders = orphanOrders.rows.length;
      warnings.push(`发现 ${orphanOrders.rows.length} 个孤儿条件单（有条件单但无持仓）`);
      logger.warn(`⚠️ 发现 ${orphanOrders.rows.length} 个孤儿条件单`);
      
      // 自动修复: 标记为cancelled
      for (const order of orphanOrders.rows) {
        logger.debug(`  清理孤儿单: ${order.symbol} ${order.side} ${order.type}, 创建时间: ${order.created_at}`);
        await dbClient.execute({
          sql: `UPDATE price_orders 
                SET status = 'cancelled', updated_at = ?
                WHERE order_id = ?`,
          args: [new Date().toISOString(), order.order_id]
        });
      }
      logger.info('✅ 已自动清理孤儿条件单');
    } else {
      logger.debug('✅ 无孤儿条件单');
    }
    
    // ========== 检查项2: 未解决的不一致状态 ==========
    logger.debug('检查2: 不一致状态...');
    
    const inconsistentStates = await dbClient.execute(`
      SELECT * FROM inconsistent_states 
      WHERE resolved = 0 
      ORDER BY created_at DESC
    `);
    
    if (inconsistentStates.rows.length > 0) {
      details.inconsistentStates = inconsistentStates.rows.length;
      issues.push(`发现 ${inconsistentStates.rows.length} 个未解决的不一致状态`);
      logger.error(`❌ 发现 ${inconsistentStates.rows.length} 个未解决的不一致状态`);
      
      for (const state of inconsistentStates.rows) {
        logger.error(`  - ${state.operation} ${state.symbol}: ${state.error_message}`);
      }
      
      // 检查不一致状态是否持续增长
      alertTracker.checkInconsistentStates(inconsistentStates.rows.length);
    } else {
      logger.debug('✅ 无不一致状态');
    }
    
    // ========== 检查项3: 交易所与数据库持仓对比 ==========
    logger.debug('检查3: 持仓一致性...');
    
    try {
      const exchangeClient = getExchangeClient();
      const exchangePositions = await exchangeClient.getPositions();
      const dbPositions = await dbClient.execute('SELECT symbol, side FROM positions');
      
      // 解析持仓大小的辅助函数
      const parsePositionSize = (size: any): number => {
        if (typeof size === 'number') return size;
        if (typeof size === 'string') {
          const parsed = Number.parseFloat(size);
          return Number.isNaN(parsed) ? 0 : parsed;
        }
        return 0;
      };
      
      // 构建交易所持仓集合
      const exchangeKeys = new Set(
        exchangePositions
          .filter((p: any) => Math.abs(parsePositionSize(p.size)) > 0)
          .map((p: any) => {
            const symbol = exchangeClient.extractSymbol(p.contract);
            const side = parsePositionSize(p.size) > 0 ? 'long' : 'short';
            return `${symbol}_${side}`;
          })
      );
      
      // 构建数据库持仓集合
      const dbKeys = new Set(
        dbPositions.rows.map((p: any) => `${p.symbol}_${p.side}`)
      );
      
      // 找出差异
      const onlyInExchange = [...exchangeKeys].filter(k => !dbKeys.has(k));
      const onlyInDB = [...dbKeys].filter(k => !exchangeKeys.has(k));
      
      if (onlyInExchange.length > 0) {
        details.positionMismatches.onlyInExchange = onlyInExchange;
        warnings.push(`交易所有但数据库没有的持仓: ${onlyInExchange.length}个`);
        logger.warn(`⚠️ 交易所有但数据库没有的持仓: ${onlyInExchange.join(', ')}`);
      }
      
      if (onlyInDB.length > 0) {
        details.positionMismatches.onlyInDB = onlyInDB;
        warnings.push(`数据库有但交易所没有的持仓: ${onlyInDB.length}个`);
        logger.warn(`⚠️ 数据库有但交易所没有的持仓: ${onlyInDB.join(', ')}`);
      }
      
      if (onlyInExchange.length === 0 && onlyInDB.length === 0) {
        logger.debug('✅ 持仓一致');
      }
    } catch (positionError: any) {
      logger.error('检查持仓一致性失败:', positionError.message);
      warnings.push(`持仓一致性检查失败: ${positionError.message}`);
    }
    
    // ========== 检查项4: 数据库连接健康 ==========
    logger.debug('检查4: 数据库连接...');
    
    try {
      await dbClient.execute('SELECT 1');
      logger.debug('✅ 数据库连接正常');
    } catch (dbError: any) {
      issues.push('数据库连接异常');
      logger.error('❌ 数据库连接异常:', dbError.message);
    }
    
    // ========== 检查项5: 交易所API健康 ==========
    logger.debug('检查5: 交易所API...');
    
    try {
      const exchangeClient = getExchangeClient();
      const account = await exchangeClient.getFuturesAccount();
      if (account && account.total) {
        logger.debug('✅ 交易所API正常');
        alertTracker.resetApiFailure();
      } else {
        warnings.push('交易所API响应异常');
        logger.warn('⚠️ 交易所API响应异常');
        alertTracker.recordApiFailure();
      }
    } catch (apiError: any) {
      issues.push('交易所API连接失败');
      logger.error('❌ 交易所API连接失败:', apiError.message);
      alertTracker.recordApiFailure();
    }
    
  } catch (error: any) {
    issues.push(`健康检查执行失败: ${error.message}`);
    logger.error('❌ 健康检查执行失败:', error);
    alertTracker.recordHealthCheckFailure();
  }
  
  // ========== 汇总结果 ==========
  const healthy = issues.length === 0 && warnings.length === 0;
  const result: HealthCheckResult = {
    healthy,
    issues,
    warnings,
    timestamp: new Date().toISOString(),
    details,
  };
  
  if (healthy) {
    logger.debug('✅ 健康检查通过，系统运行正常');
    alertTracker.resetHealthCheckFailures();
  } else if (issues.length > 0) {
    logger.error(`❌ 健康检查发现 ${issues.length} 个严重问题，${warnings.length} 个警告`);
    issues.forEach((issue, i) => logger.error(`   ${i + 1}. ${issue}`));
    alertTracker.recordHealthCheckFailure();
  } else {
    logger.warn(`⚠️ 健康检查发现 ${warnings.length} 个警告`);
    warnings.forEach((warning, i) => logger.warn(`   ${i + 1}. ${warning}`));
    alertTracker.resetHealthCheckFailures();
  }
  
  return result;
}

/**
 * 启动健康检查定时任务
 */
export function startHealthCheck() {
  // 立即执行一次
  performHealthCheck().catch(error => {
    logger.error('初始健康检查失败:', error);
  });
  
  // 每5分钟执行一次（可通过环境变量配置）
  const intervalMinutes = parseInt(process.env.HEALTH_CHECK_INTERVAL_MINUTES || '5');
  setInterval(() => {
    performHealthCheck().catch(error => {
      logger.error('定时健康检查失败:', error);
    });
  }, intervalMinutes * 60 * 1000);
  
  logger.info(`✅ 健康检查任务已启动 (每${intervalMinutes}分钟)`);
}

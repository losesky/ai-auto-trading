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
import { positionStateManager } from "../utils/positionStateManager";
import { PartialTakeProfitExecutor } from "../services/partialTakeProfitExecutor";

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
      logger.warn(`⚠️ 交易所API开始出现异常，时间: ${new Date().toISOString()}`);
    }
    
    const failureDuration = Date.now() - this.apiFailureStartTime;
    const failureMinutes = Math.floor(failureDuration / 60000);
    const failureSeconds = Math.floor(failureDuration / 1000);
    
    // 降低告警阈值：从 5 分钟降低到 1 分钟
    if (failureDuration >= 1 * 60 * 1000) {
      logger.error(`🚨 交易所API已连续不可用 ${failureMinutes} 分钟 ${failureSeconds % 60} 秒`);
      
      emailAlertService.sendAlert({
        level: AlertLevel.ERROR,
        title: '交易所API连续不可用',
        message: `交易所API已连续不可用 ${failureMinutes} 分钟，请检查网络连接和API密钥`,
        details: {
          failureDurationMinutes: failureMinutes,
          failureDurationSeconds: failureSeconds,
          startTime: new Date(this.apiFailureStartTime).toISOString(),
          timestamp: new Date().toISOString()
        }
      });
    } else {
      logger.warn(`⚠️ 交易所API异常持续中... (${failureSeconds} 秒)`);
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
 * 缓存的健康检查结果（避免频繁执行完整检查）
 */
let cachedHealthResult: HealthCheckResult | null = null;
let lastCheckTime = 0;
const CACHE_TTL = 60 * 1000; // 缓存有效期：60秒

/**
 * 健康检查任务 - 定期执行
 * @param forceCheck 是否强制执行检查（跳过缓存）
 */
export async function performHealthCheck(forceCheck = false): Promise<HealthCheckResult> {
  // 如果有缓存且未过期，直接返回缓存结果
  const now = Date.now();
  if (!forceCheck && cachedHealthResult && (now - lastCheckTime) < CACHE_TTL) {
    logger.debug(`[系统健康检查] 返回缓存结果 (缓存时间: ${Math.floor((now - lastCheckTime) / 1000)}秒)`);
    return cachedHealthResult;
  }
  
  const startTime = Date.now();
  logger.debug('🏥 [系统健康检查] 开始执行...');
  
  const issues: string[] = [];
  const warnings: string[] = [];
  const details: HealthCheckResult['details'] = {
    orphanOrders: 0,
    inconsistentStates: 0,
    positionMismatches: { onlyInExchange: [], onlyInDB: [] },
  };
  
  try {
    // ========== 检查项1: 交易所API健康 ==========
    logger.debug('检查1: 交易所API...');
    
    try {
      const exchangeClient = getExchangeClient();
      const account = await exchangeClient.getFuturesAccount();
      if (account && account.total) {
        logger.debug('✅ 交易所API正常');
        alertTracker.resetApiFailure();
      } else {
        warnings.push('交易所API响应异常');
        logger.warn('⚠️ 交易所API响应异常: 返回数据格式不正确');
        alertTracker.recordApiFailure();
      }
    } catch (apiError: any) {
      const errorMsg = apiError.message || '未知错误';
      issues.push(`交易所API连接失败: ${errorMsg}`);
      logger.error('❌ 交易所API连接失败:', errorMsg);
      logger.error('❌ 完整错误信息:', apiError);
      alertTracker.recordApiFailure();
    }
 
    // ========== 检查项2: 数据库连接健康 ==========
    logger.debug('检查2: 数据库连接...');
    
    try {
      await dbClient.execute('SELECT 1');
      logger.debug('✅ 数据库连接正常');
    } catch (dbError: any) {
      issues.push('数据库连接异常');
      logger.error('❌ 数据库连接异常:', dbError.message);
    }

    // ========== 检查项3: 孤儿条件单 ==========
    logger.debug('检查3: 孤儿条件单...');
    
    // 🔧 关键修复: 增加时间容错机制，避免误判刚创建的条件单
    // 对于60秒内创建的条件单，给予缓冲时间等待持仓记录同步
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
    
    // ========== 检查项4: 未解决的不一致状态 ==========
    logger.debug('检查4: 不一致状态...');
    
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
    
    // ========== 检查项5: 交易所与数据库持仓对比 ==========
    logger.debug('检查5: 持仓一致性...');
    
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
      let onlyInExchange = [...exchangeKeys].filter(k => !dbKeys.has(k));
      let onlyInDB = [...dbKeys].filter(k => !exchangeKeys.has(k));
      
      // 🔧 关键修复：过滤掉正在进行开仓/平仓操作的品种，避免误判
      const activeOperations = positionStateManager.getActiveOperations();
      if (activeOperations.length > 0) {
        logger.debug(`📝 检测到 ${activeOperations.length} 个正在进行的操作，将跳过这些品种的检查`);
        
        for (const op of activeOperations) {
          const key = `${op.symbol}_${op.side}`;
          
          if (op.operation === 'opening') {
            // 正在开仓：忽略"交易所有但数据库没有"的警告
            onlyInExchange = onlyInExchange.filter(k => k !== key);
            logger.debug(`  跳过正在开仓的品种: ${key}`);
          } else if (op.operation === 'closing') {
            // 正在平仓：忽略"数据库有但交易所没有"的警告
            onlyInDB = onlyInDB.filter(k => k !== key);
            logger.debug(`  跳过正在平仓的品种: ${key}`);
          }
        }
      }
      
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
    
    // ========== 检查项6: 分批止盈自动执行（兜底保护）==========
    logger.debug('检查6: 分批止盈自动执行...');
    
    try {
      // � 核心升级：从被动检测升级为主动自动执行
      // 使用统一的分批止盈执行器，带分布式锁和去重机制
      // 确保即使AI Agent错过，健康检查也能及时执行
      
      const result = await PartialTakeProfitExecutor.executeCheck('health-check');
      
      if (result.success) {
        if (result.executed > 0) {
          logger.info(`✅ 健康检查自动执行了 ${result.executed} 个分批止盈操作`);
          
          // 记录成功执行的详情
          const successDetails = result.details.filter(d => d.result === 'success');
          for (const detail of successDetails) {
            logger.info(`  ✅ ${detail.symbol} Stage${detail.stage} - 执行成功`);
          }
        } else if (result.skipped > 0) {
          logger.debug(`跳过 ${result.skipped} 个分批止盈机会（已执行或锁占用）`);
        } else {
          logger.debug('✅ 无符合条件的分批止盈机会');
        }
      } else {
        logger.warn('⚠️ 分批止盈自动执行失败，详见日志');
      }
    } catch (partialTpError: any) {
      logger.debug('分批止盈自动执行失败:', partialTpError.message);
      // 不影响整体健康检查结果，只记录日志
    }
    
    // ========== 检查项7: 反转监控自动执行（兜底保护）==========
    logger.debug('检查7: 反转监控自动执行...');
    
    try {
      // 📌 核心升级：类似分批止盈，健康检查也执行反转监控
      // 确保即使反转监控线程失效，健康检查也能及时平仓（最后一道防线）
      
      const { ReversalMonitorExecutor } = await import('../services/reversalMonitorExecutor');
      const reversalResult = await ReversalMonitorExecutor.executeCheck('health-check');
      
      if (reversalResult.success) {
        if (reversalResult.closed > 0) {
          logger.warn(`⚠️ 健康检查触发紧急平仓 ${reversalResult.closed} 个持仓（反转监控线程可能失效）`);
          
          // 记录详细信息
          const closedDetails = reversalResult.details.filter(d => d.action === 'closed');
          for (const detail of closedDetails) {
            logger.warn(`  🚨 ${detail.symbol} ${detail.side} - score=${detail.reversalScore} - ${detail.reason}`);
          }
          
          // 发送邮件告警（说明反转监控线程可能失效）
          if (closedDetails.length > 0) {
            const alertMessage = closedDetails.map(d => 
              `${d.symbol} ${d.side}: reversalScore=${d.reversalScore}`
            ).join(', ');
            
            emailAlertService.sendAlert({
              level: AlertLevel.WARNING,
              title: '健康检查触发反转平仓',
              message: `健康检查检测到 ${reversalResult.closed} 个持仓需要紧急平仓，反转监控线程可能未及时处理`,
              details: {
                closedPositions: closedDetails,
                alertMessage,
                timestamp: new Date().toISOString()
              }
            });
          }
        }
        
        if (reversalResult.warned > 0) {
          logger.debug(`发出 ${reversalResult.warned} 个反转预警`);
        }
        
        if (reversalResult.closed === 0 && reversalResult.warned === 0) {
          logger.debug('✅ 无反转风险');
        }
      }
    } catch (reversalError: any) {
      logger.debug('反转监控自动执行失败:', reversalError.message);
      // 不影响整体健康检查结果
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
  
  const elapsedTime = Date.now() - startTime;
  
  if (healthy) {
    logger.info(`✅ [系统健康检查] 通过，系统运行正常 (耗时: ${elapsedTime}ms)`);
    alertTracker.resetHealthCheckFailures();
  } else if (issues.length > 0) {
    logger.error(`\n${'='.repeat(80)}`);
    logger.error(`❌ [系统健康检查] 发现 ${issues.length} 个严重问题，${warnings.length} 个警告 (耗时: ${elapsedTime}ms)`);
    logger.error(`${'='.repeat(80)}`);
    issues.forEach((issue, i) => logger.error(`   ${i + 1}. ${issue}`));
    if (warnings.length > 0) {
      warnings.forEach((warning, i) => logger.warn(`   警告 ${i + 1}. ${warning}`));
    }
    logger.error(`${'='.repeat(80)}\n`);
    alertTracker.recordHealthCheckFailure();
  } else {
    logger.warn(`\n⚠️ [系统健康检查] 发现 ${warnings.length} 个警告 (耗时: ${elapsedTime}ms)`);
    warnings.forEach((warning, i) => logger.warn(`   ${i + 1}. ${warning}`));
    alertTracker.resetHealthCheckFailures();
  }
  
  // 更新缓存
  cachedHealthResult = result;
  lastCheckTime = Date.now();
  
  return result;
}

/**
 * 启动健康检查定时任务
 */
export function startHealthCheck() {
  const intervalMinutes = parseInt(process.env.HEALTH_CHECK_INTERVAL_MINUTES || '5');
  
  logger.info('='.repeat(80));
  logger.info(`🏥 [系统健康检查] 服务启动`);
  logger.info(`   检查间隔: ${intervalMinutes} 分钟`);
  logger.info(`   环境变量 HEALTH_CHECK_INTERVAL_MINUTES = ${process.env.HEALTH_CHECK_INTERVAL_MINUTES || '(未设置，使用默认5分钟)'}`);
  logger.info('='.repeat(80));
  
  // 立即执行一次（强制检查）
  performHealthCheck(true).catch(error => {
    logger.error('[系统健康检查] 初始检查失败:', error);
  });
  
  // 定时执行（强制检查）
  setInterval(() => {
    performHealthCheck(true).catch(error => {
      logger.error('[系统健康检查] 定时检查失败:', error);
    });
  }, intervalMinutes * 60 * 1000);
  
  logger.info(`✅ [系统健康检查] 定时任务已启动`);
}

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
 * 统一API请求限流和熔断管理器
 * 
 * 功能：
 * 1. 全局请求限流 - 防止超过交易所API限制
 * 2. 429响应全局退避 - 收到429立即暂停所有请求
 * 3. 418 IP封禁感知 - 自动检测并长时间退避
 * 4. 熔断器机制 - 连续失败时自动保护
 * 5. 请求统计和监控 - 实时追踪API使用情况
 * 
 * 支持：Binance、Gate.io
 */

import { createLogger } from "../utils/logger";

const logger = createLogger({
  name: "rate-limit-manager",
  level: "info",
});

export interface RateLimitConfig {
  exchangeName: string;
  maxRequestsPerMinute: number;
  minRequestDelay: number;
  circuitBreakerThreshold: number;
  circuitBreakerTimeout: number;
}

export interface RateLimitStats {
  totalRequests: number;
  requestsPerMinute: number;
  isCircuitBreakerOpen: boolean;
  bannedUntil: number;
  backoffUntil: number;
  topEndpoints: Array<{ endpoint: string; count: number; perMinute: number }>;
}

/**
 * 统一限流管理器
 */
export class RateLimitManager {
  // ============ 基础配置 ============
  private readonly exchangeName: string;
  private readonly maxRequestsPerMinute: number;
  private readonly minRequestDelay: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerTimeout: number;
  
  // ============ 请求追踪 ============
  private requestTimestamps: number[] = [];
  private lastRequestTime = 0;
  private readonly REQUEST_WINDOW = 60000; // 1分钟窗口
  
  // ============ 熔断器 ============
  private consecutiveFailures = 0;
  private circuitBreakerOpenUntil = 0;
  
  // ============ 429/418处理 ============
  private backoffUntil = 0; // 429触发的全局退避时间
  private ipBannedUntil = 0; // 418 IP封禁截止时间
  private readonly BACKOFF_429_DURATION = 60000; // 收到429后退避60秒
  
  // ============ 请求统计 ============
  private requestStats = new Map<string, number>();
  private lastStatsLogTime = 0;
  private readonly STATS_LOG_INTERVAL = 300000; // 5分钟
  // 按分钟记录请求数，用于计算峰值
  private requestsPerMinute: Array<{ minute: number; count: number }> = [];
  
  // ============ 全局实例管理 ============
  private static instances = new Map<string, RateLimitManager>();

  constructor(config: RateLimitConfig) {
    this.exchangeName = config.exchangeName;
    this.maxRequestsPerMinute = config.maxRequestsPerMinute;
    this.minRequestDelay = config.minRequestDelay;
    this.circuitBreakerThreshold = config.circuitBreakerThreshold;
    this.circuitBreakerTimeout = config.circuitBreakerTimeout;
    
    logger.info(`[${this.exchangeName}] 限流管理器初始化: ${this.maxRequestsPerMinute}请求/分钟, 最小间隔${this.minRequestDelay}ms`);
  }

  /**
   * 获取或创建交易所限流管理器实例（单例模式）
   */
  static getInstance(config: RateLimitConfig): RateLimitManager {
    const key = config.exchangeName;
    if (!this.instances.has(key)) {
      this.instances.set(key, new RateLimitManager(config));
    }
    return this.instances.get(key)!;
  }

  /**
   * 检查是否应该阻止请求
   * @returns true表示应该阻止，false表示可以继续
   */
  private shouldBlockRequest(): { block: boolean; reason?: string; waitMs?: number } {
    const now = Date.now();
    
    // 1. 检查IP封禁状态（最高优先级）
    if (this.ipBannedUntil > now) {
      const remainingSeconds = Math.ceil((this.ipBannedUntil - now) / 1000);
      return { 
        block: true, 
        reason: `IP被封禁，剩余${remainingSeconds}秒`,
        waitMs: this.ipBannedUntil - now
      };
    }
    
    // IP封禁结束，清除状态
    if (this.ipBannedUntil > 0 && this.ipBannedUntil <= now) {
      logger.info(`[${this.exchangeName}] ✅ IP封禁已解除，恢复API请求`);
      this.ipBannedUntil = 0;
      this.consecutiveFailures = 0;
      this.circuitBreakerOpenUntil = 0;
      this.backoffUntil = 0;
    }
    
    // 2. 检查429全局退避状态
    if (this.backoffUntil > now) {
      const remainingSeconds = Math.ceil((this.backoffUntil - now) / 1000);
      return { 
        block: true, 
        reason: `429全局退避，剩余${remainingSeconds}秒`,
        waitMs: this.backoffUntil - now
      };
    }
    
    // 3. 检查熔断器状态
    if (this.circuitBreakerOpenUntil > now) {
      const remainingSeconds = Math.ceil((this.circuitBreakerOpenUntil - now) / 1000);
      return { 
        block: true, 
        reason: `熔断器打开，剩余${remainingSeconds}秒`,
        waitMs: this.circuitBreakerOpenUntil - now
      };
    }
    
    // 熔断器超时后重置
    if (this.circuitBreakerOpenUntil > 0 && this.circuitBreakerOpenUntil <= now) {
      logger.info(`[${this.exchangeName}] 🔄 熔断器恢复，尝试重新连接`);
      this.consecutiveFailures = 0;
      this.circuitBreakerOpenUntil = 0;
    }
    
    return { block: false };
  }

  /**
   * 请求限流控制（核心方法）
   * 在发起任何API请求前必须调用
   */
  async waitForRateLimit(endpoint: string): Promise<void> {
    // 1. 检查是否应该阻止请求
    const blockCheck = this.shouldBlockRequest();
    if (blockCheck.block) {
      // 如果被阻止，抛出错误而不是等待（让缓存降级处理）
      throw new Error(`[${this.exchangeName}] ${blockCheck.reason}`);
    }
    
    const now = Date.now();
    
    // 2. 清理1分钟前的时间戳
    this.requestTimestamps = this.requestTimestamps.filter(
      timestamp => now - timestamp < this.REQUEST_WINDOW
    );
    
    // 3. 检查是否达到限制
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = this.REQUEST_WINDOW - (now - oldestTimestamp) + 100; // 额外100ms
      if (waitTime > 0) {
        logger.warn(`[${this.exchangeName}] ⚠️ 达到限制(${this.requestTimestamps.length}/${this.maxRequestsPerMinute})，等待${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    // 4. 确保最小请求间隔
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestDelay) {
      const delay = this.minRequestDelay - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    // 5. 记录本次请求
    this.requestTimestamps.push(Date.now());
    this.lastRequestTime = Date.now();
    
    // 6. 更新统计
    this.recordRequestStat(endpoint);
  }

  /**
   * 记录429警告（全局退避）
   */
  handle429Warning(): void {
    const now = Date.now();
    this.backoffUntil = now + this.BACKOFF_429_DURATION;
    
    logger.error(`[${this.exchangeName}] 🚨 收到429警告！触发全局退避${this.BACKOFF_429_DURATION / 1000}秒`);
    logger.error(`[${this.exchangeName}] 💡 所有API请求将暂停，防止418封禁`);
    
    // 打印当前API使用情况
    this.logRequestStats(true);
  }

  /**
   * 记录418 IP封禁
   * @param banDurationSeconds 封禁时长（秒），如果未知则使用默认值
   */
  handle418Ban(banDurationSeconds?: number): void {
    const now = Date.now();
    const duration = banDurationSeconds ? banDurationSeconds * 1000 : 300000; // 默认5分钟
    this.ipBannedUntil = now + duration;
    this.circuitBreakerOpenUntil = this.ipBannedUntil; // 同步熔断器
    this.consecutiveFailures = this.circuitBreakerThreshold; // 标记为最大失败次数
    
    logger.error(`[${this.exchangeName}] 🚨 IP被封禁！封禁时长: ${Math.ceil(duration / 1000)}秒`);
    logger.error(`[${this.exchangeName}] ⏰ 系统将使用缓存数据，封禁解除后自动恢复`);
    
    // 打印封禁前的API请求统计
    this.logRequestStats(true);
  }

  /**
   * 记录请求成功
   */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      logger.info(`[${this.exchangeName}] ✅ API请求恢复正常，清除${this.consecutiveFailures}次失败记录`);
      this.consecutiveFailures = 0;
    }
  }

  /**
   * 记录请求失败
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.circuitBreakerOpenUntil = Date.now() + this.circuitBreakerTimeout;
      logger.error(
        `[${this.exchangeName}] 🚨 连续失败${this.consecutiveFailures}次，触发熔断器，` +
        `${this.circuitBreakerTimeout / 1000}秒内使用缓存数据`
      );
    }
  }

  /**
   * 记录请求统计
   */
  private recordRequestStat(endpoint: string): void {
    const count = this.requestStats.get(endpoint) || 0;
    this.requestStats.set(endpoint, count + 1);
    
    // 记录每分钟的请求数（用于计算峰值）
    const now = Date.now();
    const currentMinute = Math.floor(now / 60000); // 按分钟取整
    
    // 清理6分钟前的数据
    this.requestsPerMinute = this.requestsPerMinute.filter(
      item => currentMinute - item.minute < 6
    );
    
    // 更新当前分钟的计数
    const existingMinute = this.requestsPerMinute.find(item => item.minute === currentMinute);
    if (existingMinute) {
      existingMinute.count++;
    } else {
      this.requestsPerMinute.push({ minute: currentMinute, count: 1 });
    }
    
    // 定期打印统计
    if (now - this.lastStatsLogTime > this.STATS_LOG_INTERVAL) {
      this.logRequestStats(false);
      this.lastStatsLogTime = now;
      this.requestStats.clear();
    }
  }

  /**
   * 打印请求统计
   */
  private logRequestStats(isEmergency: boolean): void {
    if (this.requestStats.size === 0) return;
    
    const stats = Array.from(this.requestStats.entries())
      .sort((a, b) => b[1] - a[1]);
    
    const total = Array.from(this.requestStats.values()).reduce((sum, count) => sum + count, 0);
    const minutes = isEmergency ? 5 : 5; // 统计窗口
    const qpm = Math.round(total / minutes);
    
    // 计算峰值（最近5分钟内单分钟最高请求数）
    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);
    const recentMinutes = this.requestsPerMinute.filter(
      item => currentMinute - item.minute < 5
    );
    const peakQpm = recentMinutes.length > 0 
      ? Math.max(...recentMinutes.map(item => item.count))
      : qpm;
    
    const logLevel = isEmergency ? 'error' : 'info';
    const logFn = (msg: string) => {
      if (logLevel === 'error') logger.error(msg);
      else logger.info(msg);
    };
    
    if (isEmergency) {
      logFn('═'.repeat(80));
      logFn(`[${this.exchangeName}] 🚨 紧急诊断：API请求统计（封禁前）`);
      logFn('═'.repeat(80));
    }
    
    logFn(`[${this.exchangeName}] 📊 最近${minutes}分钟API统计:`);
    logFn(`   总请求: ${total}, 平均${qpm}/分钟, 峰值${peakQpm}/分钟 (限制: ${this.maxRequestsPerMinute}/分钟)`);
    
    if (peakQpm > this.maxRequestsPerMinute * 0.8) {
      logFn(`   ⚠️  峰值请求频率接近限制！`);
    } else if (qpm > this.maxRequestsPerMinute * 0.8) {
      logFn(`   ⚠️  平均请求频率接近限制！`);
    }
    
    logFn(`   TOP10高频端点:`);
    stats.slice(0, 10).forEach(([endpoint, count], index) => {
      const perMinute = Math.round(count / minutes);
      logFn(`      ${index + 1}. ${endpoint}: ${count}次 (${perMinute}/分钟)`);
    });
    
    if (isEmergency) {
      logFn('═'.repeat(80));
      logFn(`[${this.exchangeName}] 💡 建议措施:`);
      if (qpm > this.maxRequestsPerMinute) {
        logFn('   1. 减少监控币种数量 (TRADING_SYMBOLS)');
        logFn('   2. 延长交易周期 (TRADING_INTERVAL_MINUTES)');
        logFn('   3. 延长健康检查间隔 (HEALTH_CHECK_INTERVAL_MINUTES)');
      }
      const highFreq = stats.filter(([_, count]) => count / minutes > 15);
      if (highFreq.length > 0) {
        logFn(`   4. 优化高频端点 (发现${highFreq.length}个>15次/分钟):`);
        highFreq.slice(0, 3).forEach(([endpoint]) => {
          logFn(`      - ${endpoint}`);
        });
      }
      logFn('═'.repeat(80));
    }
  }

  /**
   * 获取当前统计信息
   */
  getStats(): RateLimitStats {
    const stats = Array.from(this.requestStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    const total = Array.from(this.requestStats.values()).reduce((sum, count) => sum + count, 0);
    const qpm = Math.round(total / 5);
    
    return {
      totalRequests: total,
      requestsPerMinute: qpm,
      isCircuitBreakerOpen: this.circuitBreakerOpenUntil > Date.now(),
      bannedUntil: this.ipBannedUntil,
      backoffUntil: this.backoffUntil,
      topEndpoints: stats.map(([endpoint, count]) => ({
        endpoint,
        count,
        perMinute: Math.round(count / 5)
      }))
    };
  }

  /**
   * 手动重置所有状态（仅用于紧急情况）
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.circuitBreakerOpenUntil = 0;
    this.backoffUntil = 0;
    this.ipBannedUntil = 0;
    this.requestTimestamps = [];
    logger.warn(`[${this.exchangeName}] 🔄 限流管理器状态已手动重置`);
  }
}

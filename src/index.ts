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

import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApiRoutes } from "./api/routes";
import { startTradingLoop, initTradingSystem } from "./scheduler/tradingLoop";
import { startAccountRecorder } from "./scheduler/accountRecorder";
import { PriceOrderMonitor } from "./scheduler/priceOrderMonitor";
import { startHealthCheck } from "./scheduler/healthCheck";
import { inconsistentStateResolver } from "./scheduler/inconsistentStateResolver";
import { emailAlertService } from "./utils/emailAlert";
import { initDatabase } from "./database/init";
import { RISK_PARAMS } from "./config/riskParams";
import { createClient } from "@libsql/client";
import { getExchangeClient } from "./exchanges";
import { createLogger } from "./utils/logger";

// 设置时区为中国时间（Asia/Shanghai，UTC+8）
process.env.TZ = 'Asia/Shanghai';

// 创建日志实例
const logger = createLogger({
  name: "ai-trading",
  level: "info"
});

// 全局服务器实例
let server: any = null;
let priceOrderMonitor: PriceOrderMonitor | null = null;

/**
 * 主函数
 */
async function main() {
  logger.info("启动 AI 加密货币自动交易系统");
  
  // 1. 初始化数据库
  logger.info("初始化数据库...");
  await initDatabase();

  // 2. 初始化邮件告警服务
  logger.info("初始化邮件告警服务...");
  emailAlertService.initialize();

  // 3. 初始化交易系统配置（读取环境变量并同步到数据库）
  await initTradingSystem();
  
  // 4. 启动 API 服务器
  logger.info("🌐 启动 Web 服务器...");
  const apiRoutes = createApiRoutes();
  
  const port = Number.parseInt(process.env.PORT || "3141");
  const host = process.env.HOST || "0.0.0.0";
  
  server = serve({
    fetch: apiRoutes.fetch,
    port,
    hostname: host,
  });
  
  logger.info(`Web 服务器已启动: http://${host}:${port}`);
  logger.info(`监控界面: http://localhost:${port}/ (本地访问)`);
  if (host === "0.0.0.0") {
    logger.info(`局域网访问: http://<你的局域网IP>:${port}/`);
  }
  
  // 5. 启动交易循环
  logger.info("启动交易循环...");
  startTradingLoop();
  
  // 6. 启动账户资产记录器
  logger.info("启动账户资产记录器...");
  startAccountRecorder();
  
   
  // 7. 启动健康检查服务
  const healthCheckEnabled = process.env.HEALTH_CHECK_ENABLED !== 'false';
  if (healthCheckEnabled) {
    logger.info("启动健康检查服务...");
    startHealthCheck();
  } else {
    logger.info("健康检查服务已禁用（HEALTH_CHECK_ENABLED=false）");
  }
  
  // 8. 启动反转监控线程（新增）
  const reversalMonitorEnabled = process.env.REVERSAL_MONITOR_ENABLED !== 'false';
  if (reversalMonitorEnabled) {
    logger.info("启动反转监控线程...");
    const { startReversalMonitor } = await import('./scheduler/reversalMonitor');
    startReversalMonitor();
  } else {
    logger.info("反转监控线程已禁用（REVERSAL_MONITOR_ENABLED=false）");
  }

  // 9. 启动条件单监控服务
  const monitorEnabled = process.env.PRICE_ORDER_MONITOR_ENABLED !== 'false';
  if (monitorEnabled) {
    try {
      logger.info("启动条件单监控服务...");
      const dbClient = createClient({
        url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
        syncUrl: process.env.DATABASE_SYNC_URL,
        syncInterval: Number.parseInt(process.env.DATABASE_SYNC_INTERVAL || '5000'), // 默认5秒同步
      });
      const exchangeClient = getExchangeClient();
      
      // 验证交易所连接
      try {
        await exchangeClient.getFuturesAccount();
        logger.info("✅ 交易所连接验证成功");
      } catch (error: any) {
        logger.warn("⚠️ 交易所连接验证失败,条件单监控可能受影响:", error.message);
      }
      
      priceOrderMonitor = new PriceOrderMonitor(dbClient, exchangeClient);
      await priceOrderMonitor.start();
      
      // 验证启动状态
      const activeOrders = await dbClient.execute({
        sql: 'SELECT COUNT(*) as count FROM price_orders WHERE status = ?',
        args: ['active']
      });
      const activeCount = Number(activeOrders.rows[0]?.count || 0);
      logger.info(`✅ 条件单监控服务启动成功,当前监控 ${activeCount} 个活跃条件单`);
    } catch (error: any) {
      logger.error("❌ 条件单监控服务启动失败:", error.message);
      logger.warn("⚠️ 系统将继续运行,但条件单监控功能不可用");
      logger.warn("⚠️ 建议检查: 1) 数据库连接 2) 交易所API配置 3) 网络连接");
      // 不抛出异常,允许系统继续运行
    }
  } else {
    logger.info("条件单监控服务已禁用（PRICE_ORDER_MONITOR_ENABLED=false）");
  }
  
  // 10. 启动自动修复服务（可选）
  const autoResolveEnabled = process.env.AUTO_RESOLVE_ENABLED === 'true';
  if (autoResolveEnabled) {
    logger.info("启动自动修复服务...");
    await inconsistentStateResolver.start();
  } else {
    logger.info("自动修复服务已禁用（AUTO_RESOLVE_ENABLED=false，如需启用请设置为true）");
  }
  
  logger.info("=".repeat(80));
  logger.info("系统启动完成！");
  logger.info("=".repeat(80));
  logger.info(`监控界面: http://localhost:${port}/`);
  logger.info(`交易间隔: ${process.env.TRADING_INTERVAL_MINUTES || 5} 分钟`);
  logger.info(`账户记录间隔: ${process.env.ACCOUNT_RECORD_INTERVAL_MINUTES || 10} 分钟`);
  logger.info(`支持币种: ${RISK_PARAMS.TRADING_SYMBOLS.join(', ')}`);
  logger.info(`最大杠杆: ${RISK_PARAMS.MAX_LEVERAGE}x`);
  logger.info(`最大持仓数: ${RISK_PARAMS.MAX_POSITIONS}`);
  logger.info(`🔴 账户止损线: ${process.env.ACCOUNT_STOP_LOSS_USDT || 50} USDT (触发后全部清仓并退出)`);
  logger.info(`🟢 账户止盈线: ${process.env.ACCOUNT_TAKE_PROFIT_USDT || 10000} USDT (触发后全部清仓并退出)`);
  logger.info(`⚠️ 按 Ctrl+C 停止系统`);
}

// 错误处理
process.on("uncaughtException", (error) => {
  logger.error("未捕获的异常:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("未处理的 Promise 拒绝:", { reason });
});

// 优雅退出处理
async function gracefulShutdown(signal: string) {
  logger.info(`\n\n收到 ${signal} 信号，正在关闭系统...`);
  
  try {
    // 停止条件单监控服务
    if (priceOrderMonitor) {
      logger.info("正在停止条件单监控服务...");
      priceOrderMonitor.stop();
      logger.info("条件单监控服务已停止");
    }
    
    // 关闭服务器
    if (server) {
      logger.info("正在关闭 Web 服务器...");
      server.close();
      logger.info("Web 服务器已关闭");
    }
    
    logger.info("系统已安全关闭");
    process.exit(0);
  } catch (error) {
    logger.error("关闭系统时出错:", error as any);
    process.exit(1);
  }
}

// 监听退出信号
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// 启动应用
await main();

/**
 * 清理重复的平仓事件记录
 * 
 * 问题原因：
 * 1. 历史版本的priceOrderMonitor可能重复处理同一个条件单
 * 2. 缺少唯一性约束导致重复插入
 * 
 * 解决方案：
 * 1. 保留每个trigger_order_id的第一条记录（最早创建的）
 * 2. 删除后续的重复记录
 * 3. 验证trades表和position_close_events表的一致性
 */

import { createClient } from "@libsql/client";
import "dotenv/config";

const logger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args),
};

async function cleanDuplicateCloseEvents() {
  const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
  const client = createClient({ url: dbUrl });

  try {
    logger.info("🔧 开始清理重复的平仓事件记录...\n");

    // ========================================
    // 步骤1: 分析重复记录
    // ========================================
    logger.info("📊 步骤1: 分析重复记录...");
    
    const duplicateAnalysis = await client.execute(`
      SELECT trigger_order_id, COUNT(*) as count
      FROM position_close_events
      WHERE trigger_order_id IS NOT NULL AND trigger_order_id != ''
      GROUP BY trigger_order_id
      HAVING COUNT(*) > 1
      ORDER BY count DESC
    `);

    if (duplicateAnalysis.rows.length === 0) {
      logger.info("✅ 未发现重复记录\n");
    } else {
      logger.warn(`⚠️  发现 ${duplicateAnalysis.rows.length} 个重复的trigger_order_id:\n`);
      duplicateAnalysis.rows.forEach((row: any) => {
        logger.warn(`   - ${row.trigger_order_id}: ${row.count} 条记录`);
      });
      logger.info("");
    }

    // ========================================
    // 步骤2: 清理重复记录（保留最早的）
    // ========================================
    if (duplicateAnalysis.rows.length > 0) {
      logger.info("📊 步骤2: 清理重复记录（保留最早的）...");
      
      let totalDeleted = 0;
      
      for (const row of duplicateAnalysis.rows) {
        const triggerId = row.trigger_order_id as string;
        
        // 查找该trigger_order_id的所有记录
        const records = await client.execute({
          sql: `SELECT id, created_at, pnl FROM position_close_events 
                WHERE trigger_order_id = ? 
                ORDER BY created_at ASC`,
          args: [triggerId]
        });
        
        // 保留第一条，删除其他
        const idsToDelete = records.rows.slice(1).map((r: any) => r.id);
        
        if (idsToDelete.length > 0) {
          logger.info(`   处理 ${triggerId}:`);
          logger.info(`     - 保留: ID=${records.rows[0].id}, 时间=${records.rows[0].created_at}, PnL=${records.rows[0].pnl}`);
          logger.info(`     - 删除: ${idsToDelete.length} 条重复记录`);
          
          for (const id of idsToDelete) {
            await client.execute({
              sql: `DELETE FROM position_close_events WHERE id = ?`,
              args: [id]
            });
            totalDeleted++;
          }
        }
      }
      
      logger.info(`\n✅ 已删除 ${totalDeleted} 条重复记录\n`);
    }

    // ========================================
    // 步骤3: 清理孤儿trades记录
    // ========================================
    logger.info("📊 步骤3: 检查trades表中的孤儿平仓记录...");
    
    // 查找trades表中type='close'但没有对应position_close_events记录的
    const orphanTrades = await client.execute(`
      SELECT t.id, t.order_id, t.symbol, t.side, t.timestamp
      FROM trades t
      WHERE t.type = 'close'
      AND NOT EXISTS (
        SELECT 1 FROM position_close_events pce
        WHERE pce.order_id = t.order_id OR pce.close_trade_id = t.order_id
      )
      ORDER BY t.timestamp DESC
    `);

    if (orphanTrades.rows.length > 0) {
      logger.warn(`⚠️  发现 ${orphanTrades.rows.length} 条孤儿平仓交易记录:`);
      orphanTrades.rows.forEach((row: any) => {
        logger.warn(`   - ${row.symbol} ${row.side}, order_id=${row.order_id}, 时间=${row.timestamp}`);
      });
      logger.info("");
    } else {
      logger.info("✅ 未发现孤儿平仓交易记录\n");
    }

    // ========================================
    // 步骤4: 验证最终状态
    // ========================================
    logger.info("📊 步骤4: 验证最终状态...");
    
    const finalStats = await client.execute(`
      SELECT 
        (SELECT COUNT(*) FROM position_close_events) as total_close_events,
        (SELECT COUNT(DISTINCT trigger_order_id) FROM position_close_events WHERE trigger_order_id IS NOT NULL) as unique_triggers,
        (SELECT COUNT(*) FROM trades WHERE type = 'close') as total_close_trades
    `);
    
    const stats = finalStats.rows[0] as any;
    logger.info(`  平仓事件总数: ${stats.total_close_events}`);
    logger.info(`  唯一条件单ID数: ${stats.unique_triggers}`);
    logger.info(`  平仓交易总数: ${stats.total_close_trades}`);
    
    // 检查是否还有重复
    const remainingDuplicates = await client.execute(`
      SELECT COUNT(*) as count
      FROM (
        SELECT trigger_order_id
        FROM position_close_events
        WHERE trigger_order_id IS NOT NULL AND trigger_order_id != ''
        GROUP BY trigger_order_id
        HAVING COUNT(*) > 1
      )
    `);
    
    const dupCount = remainingDuplicates.rows[0]?.count as number || 0;
    if (dupCount > 0) {
      logger.error(`\n❌ 仍存在 ${dupCount} 个重复的trigger_order_id，请检查！`);
    } else {
      logger.info("\n✅ 验证通过：无重复记录");
    }

    logger.info("\n✅ 数据清理完成！");
    
  } catch (error: any) {
    logger.error("❌ 数据清理失败:", error);
    throw error;
  } finally {
    client.close();
  }
}

// 执行清理
cleanDuplicateCloseEvents().catch((error) => {
  console.error("执行失败:", error);
  process.exit(1);
});

/**
 * 测试分批止盈历史查询修复
 * 验证新旧持仓的历史记录是否正确分离
 */

import { createClient } from "@libsql/client";

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

async function testPartialTakeProfitHistoryFix() {
  console.log("=" .repeat(80));
  console.log("测试分批止盈历史查询修复");
  console.log("=" .repeat(80));
  
  // 1. 查看所有 XRP 相关的历史记录
  console.log("\n📊 XRP 所有分批止盈历史记录:");
  const allXrpHistory = await dbClient.execute({
    sql: `SELECT id, symbol, stage, position_order_id, order_id, timestamp 
          FROM partial_take_profit_history 
          WHERE symbol LIKE '%XRP%' 
          ORDER BY timestamp DESC`,
    args: []
  });
  
  console.table(allXrpHistory.rows);
  
  // 2. 查看当前 XRP 持仓
  console.log("\n📈 当前 XRP 持仓:");
  const currentXrpPosition = await dbClient.execute({
    sql: "SELECT symbol, side, entry_order_id, quantity FROM positions WHERE symbol LIKE '%XRP%' AND quantity != 0",
    args: []
  });
  
  console.table(currentXrpPosition.rows);
  
  if (currentXrpPosition.rows.length === 0) {
    console.log("⚠️  当前没有 XRP 持仓，无法测试");
    return;
  }
  
  const currentEntryOrderId = currentXrpPosition.rows[0].entry_order_id as string;
  console.log(`\n当前 XRP 持仓的开仓订单ID: ${currentEntryOrderId}`);
  
  // 3. 使用旧方法查询（只按 symbol）
  console.log("\n❌ 旧方法查询 (只按 symbol - 会查到所有 XRP 历史):");
  const oldMethodHistory = await dbClient.execute({
    sql: `SELECT stage, position_order_id, order_id 
          FROM partial_take_profit_history 
          WHERE symbol LIKE '%XRP%' AND status = 'completed'
          ORDER BY timestamp DESC`,
    args: []
  });
  
  console.table(oldMethodHistory.rows);
  const oldMethodStages = oldMethodHistory.rows.map((r: any) => r.stage);
  console.log(`旧方法识别的已完成阶段: [${oldMethodStages.join(', ')}]`);
  
  // 4. 使用新方法查询（按 symbol + position_order_id）
  console.log("\n✅ 新方法查询 (按 symbol + position_order_id - 只查当前持仓的历史):");
  const newMethodHistory = await dbClient.execute({
    sql: `SELECT stage, position_order_id, order_id 
          FROM partial_take_profit_history 
          WHERE position_order_id = ? AND status = 'completed'
          ORDER BY timestamp DESC`,
    args: [currentEntryOrderId]
  });
  
  console.table(newMethodHistory.rows);
  const newMethodStages = newMethodHistory.rows.map((r: any) => r.stage);
  console.log(`新方法识别的已完成阶段: [${newMethodStages.join(', ')}]`);
  
  // 5. 对比结果
  console.log("\n" + "=".repeat(80));
  console.log("📋 修复效果对比:");
  console.log("=".repeat(80));
  console.log(`旧方法 (有BUG): 识别了 ${oldMethodStages.length} 个阶段 - [${oldMethodStages.join(', ')}]`);
  console.log(`新方法 (已修复): 识别了 ${newMethodStages.length} 个阶段 - [${newMethodStages.join(', ')}]`);
  
  if (oldMethodStages.length > newMethodStages.length) {
    console.log("\n✅ 修复成功！新方法正确过滤了其他持仓的历史记录");
    console.log(`   - 过滤掉了 ${oldMethodStages.length - newMethodStages.length} 条旧持仓的历史记录`);
  } else {
    console.log("\n⚠️  未发现差异，可能当前持仓就是历史记录对应的持仓");
  }
  
  // 6. 显示具体差异
  if (oldMethodStages.length !== newMethodStages.length) {
    console.log("\n🔍 被过滤的历史记录详情:");
    const filteredRecords = oldMethodHistory.rows.filter((r: any) => 
      r.position_order_id !== currentEntryOrderId
    );
    console.table(filteredRecords);
  }
}

testPartialTakeProfitHistoryFix()
  .then(() => {
    console.log("\n✅ 测试完成");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ 测试失败:", error);
    process.exit(1);
  });

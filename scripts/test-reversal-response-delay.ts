/**
 * 趋势反转响应延迟分析脚本
 * 
 * 目标：
 * 1. 分析数据库中趋势反转平仓记录
 * 2. 统计不同检测周期的理论响应延迟
 * 3. 量化15分钟交易周期造成的延迟损失
 * 4. 评估优化方案的实际可行性
 * 
 * 简化版实现：
 * - 基于实际平仓时间和持仓时间，推算不同检测周期下的理论首次检测点
 * - 假设趋势反转信号在实际平仓前的一定时间内已经出现
 * - 通过统计分析估算提前退出可节省的损失
 * 
 * 运行方式：
 * npx tsx --env-file=.env ./scripts/test-reversal-response-delay.ts
 */

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { createLogger } from '../src/utils/logger';

const dbUrl = process.env.DATABASE_URL || 'file:./.voltagent/trading.db';
const db = createClient({ url: dbUrl });

const logger = createLogger({ name: 'reversal-delay-test', level: 'info' });

// 测试配置
const TEST_CONFIG = {
  // 回测时间范围
  startTime: new Date('2025-11-22T00:00:00Z'),
  endTime: new Date('2025-11-25T12:00:00Z'),
  
  // 测试币种（实际发生趋势反转亏损的币种）
  symbols: ['ADA', 'ETH', 'SOL', 'BTC', 'LTC', 'XRP'],
  
  // 不同检测周期（分钟）
  checkIntervals: [1, 3, 5, 10, 15, 20, 30],
  
  // 反转判断阈值
  reversalThresholds: {
    strong: 70,   // 强烈反转（当前主程序使用60）
    moderate: 50, // 中等反转（当前主程序使用40）
    weak: 30      // 弱反转（早期预警）
  }
};

interface ReversalEvent {
  timestamp: Date;
  symbol: string;
  price: number;
  reversalScore: number;
  severity: 'weak' | 'moderate' | 'strong';
  detectedByInterval: number; // 哪个检测周期首次发现
}

interface TradeAnalysis {
  symbol: string;
  side: 'long' | 'short';
  entryTime: Date;
  entryPrice: number;
  closeTime: Date;
  closePrice: number;
  pnl: number;
  pnlPercent: number;
  holdingMinutes: number;
  
  // 反转检测分析
  firstWeakSignal?: ReversalEvent;      // 首次弱反转信号
  firstModerateSignal?: ReversalEvent;  // 首次中等反转信号
  firstStrongSignal?: ReversalEvent;    // 首次强反转信号
  actualCloseTime: Date;                 // 实际平仓时间
  
  // 延迟分析
  weakSignalDelay?: number;      // 弱信号距离平仓的时间（分钟）
  moderateSignalDelay?: number;  // 中等信号距离平仓的时间（分钟）
  strongSignalDelay?: number;    // 强信号距离平仓的时间（分钟）
  
  // 损失分析
  priceAtWeakSignal?: number;    // 弱信号时的价格
  priceAtModerateSignal?: number; // 中等信号时的价格
  priceAtStrongSignal?: number;   // 强信号时的价格
  pnlAtWeakSignal?: number;       // 弱信号时的盈亏%
  pnlAtModerateSignal?: number;   // 中等信号时的盈亏%
  pnlAtStrongSignal?: number;     // 强信号时的盈亏%
}

/**
 * 获取趋势反转平仓的交易记录
 */
async function getReversalTrades(): Promise<TradeAnalysis[]> {
  const result = await db.execute({
    sql: `
      SELECT 
        pce.symbol,
        pce.side,
        pce.entry_price,
        pce.close_price,
        pce.pnl,
        pce.pnl_percent,
        pce.created_at as close_time,
        pce.order_id
      FROM position_close_events pce
      WHERE pce.close_reason = 'trend_reversal'
        AND pce.created_at >= ?
        AND pce.created_at <= ?
      ORDER BY pce.created_at ASC
    `,
    args: [
      TEST_CONFIG.startTime.toISOString(),
      TEST_CONFIG.endTime.toISOString()
    ]
  });

  if (result.rows.length === 0) {
    logger.warn('未找到趋势反转平仓记录');
    return [];
  }

  // 为每笔交易查找对应的开仓时间
  const trades: TradeAnalysis[] = [];
  
  for (const row of result.rows) {
    const symbol = String(row.symbol);
    const side = String(row.side) as 'long' | 'short';
    const entryPrice = Number(row.entry_price);
    const closePrice = Number(row.close_price);
    const pnl = Number(row.pnl);
    const pnlPercent = Number(row.pnl_percent);
    const closeTime = new Date(String(row.close_time));
    const orderId = String(row.order_id || '');

    // 查找对应的开仓交易
    const openTrade = await db.execute({
      sql: `
        SELECT timestamp 
        FROM trades 
        WHERE symbol = ? 
          AND side = ? 
          AND type = 'open'
          AND timestamp <= ?
        ORDER BY timestamp DESC 
        LIMIT 1
      `,
      args: [symbol, side, closeTime.toISOString()]
    });

    const entryTime = openTrade.rows.length > 0 
      ? new Date(String(openTrade.rows[0].timestamp))
      : new Date(closeTime.getTime() - 3600000); // 默认往前推1小时

    const holdingMinutes = (closeTime.getTime() - entryTime.getTime()) / 60000;

    trades.push({
      symbol,
      side,
      entryTime,
      entryPrice,
      closeTime,
      closePrice,
      pnl,
      pnlPercent,
      holdingMinutes,
      actualCloseTime: closeTime
    });
  }

  return trades;
}

/**
 * 模拟不同检测周期下的反转检测
 * 
 * 简化实现：基于统计学假设
 * - 假设趋势反转信号在平仓前20-40%的时间段内开始出现
 * - 不同严重程度的信号出现时间不同：
 *   - 弱信号（score≥30）：平仓前40%时间开始
 *   - 中等信号（score≥50）：平仓前30%时间开始
 *   - 强信号（score≥70）：平仓前20%时间开始
 */
async function simulateReversalDetection(
  trade: TradeAnalysis,
  checkInterval: number
): Promise<ReversalEvent[]> {
  const events: ReversalEvent[] = [];
  
  // 基于持仓时间估算反转信号出现时间
  const holdingMs = trade.closeTime.getTime() - trade.entryTime.getTime();
  
  // 估算不同严重程度信号的出现时间（从平仓时间往前推）
  const weakSignalStart = new Date(trade.closeTime.getTime() - holdingMs * 0.4);    // 40%
  const moderateSignalStart = new Date(trade.closeTime.getTime() - holdingMs * 0.3); // 30%
  const strongSignalStart = new Date(trade.closeTime.getTime() - holdingMs * 0.2);  // 20%
  
  // 计算检测周期首次能捕获到这些信号的时间点
  // 从开仓时间开始，按检测周期对齐
  const getFirstDetectionTime = (signalStartTime: Date): Date | null => {
    let checkTime = new Date(trade.entryTime);
    
    // 对齐到检测周期
    checkTime.setMinutes(Math.ceil(checkTime.getMinutes() / checkInterval) * checkInterval);
    checkTime.setSeconds(0);
    checkTime.setMilliseconds(0);
    
    // 找到首次检测点 >= 信号开始时间
    while (checkTime < signalStartTime && checkTime <= trade.closeTime) {
      checkTime = new Date(checkTime.getTime() + checkInterval * 60000);
    }
    
    // 如果检测时间在平仓之后，说明该检测周期无法捕获
    if (checkTime > trade.closeTime) {
      return null;
    }
    
    return checkTime;
  };
  
  // 弱信号
  const weakDetectTime = getFirstDetectionTime(weakSignalStart);
  if (weakDetectTime) {
    // 估算信号时的价格（线性插值）
    const priceProgress = (weakDetectTime.getTime() - trade.entryTime.getTime()) / holdingMs;
    const estimatedPrice = trade.side === 'long'
      ? trade.entryPrice + (trade.closePrice - trade.entryPrice) * priceProgress
      : trade.entryPrice - (trade.entryPrice - trade.closePrice) * priceProgress;
    
    events.push({
      timestamp: weakDetectTime,
      symbol: trade.symbol,
      price: estimatedPrice,
      reversalScore: 35, // 估算分数
      severity: 'weak',
      detectedByInterval: checkInterval
    });
  }
  
  // 中等信号
  const moderateDetectTime = getFirstDetectionTime(moderateSignalStart);
  if (moderateDetectTime) {
    const priceProgress = (moderateDetectTime.getTime() - trade.entryTime.getTime()) / holdingMs;
    const estimatedPrice = trade.side === 'long'
      ? trade.entryPrice + (trade.closePrice - trade.entryPrice) * priceProgress
      : trade.entryPrice - (trade.entryPrice - trade.closePrice) * priceProgress;
    
    events.push({
      timestamp: moderateDetectTime,
      symbol: trade.symbol,
      price: estimatedPrice,
      reversalScore: 55,
      severity: 'moderate',
      detectedByInterval: checkInterval
    });
  }
  
  // 强信号
  const strongDetectTime = getFirstDetectionTime(strongSignalStart);
  if (strongDetectTime) {
    const priceProgress = (strongDetectTime.getTime() - trade.entryTime.getTime()) / holdingMs;
    const estimatedPrice = trade.side === 'long'
      ? trade.entryPrice + (trade.closePrice - trade.entryPrice) * priceProgress
      : trade.entryPrice - (trade.entryPrice - trade.closePrice) * priceProgress;
    
    events.push({
      timestamp: strongDetectTime,
      symbol: trade.symbol,
      price: estimatedPrice,
      reversalScore: 75,
      severity: 'strong',
      detectedByInterval: checkInterval
    });
  }
  
  return events;
}

/**
 * 分析反转响应延迟
 */
function analyzeResponseDelay(trade: TradeAnalysis, events: ReversalEvent[]): void {
  // 按严重程度分组
  const weakEvents = events.filter(e => e.severity === 'weak');
  const moderateEvents = events.filter(e => e.severity === 'moderate');
  const strongEvents = events.filter(e => e.severity === 'strong');
  
  // 记录首次信号
  if (weakEvents.length > 0) {
    const first = weakEvents[0];
    trade.firstWeakSignal = first;
    trade.weakSignalDelay = (trade.actualCloseTime.getTime() - first.timestamp.getTime()) / 60000;
    trade.priceAtWeakSignal = first.price;
    trade.pnlAtWeakSignal = trade.side === 'long' 
      ? ((first.price - trade.entryPrice) / trade.entryPrice) * 100
      : ((trade.entryPrice - first.price) / trade.entryPrice) * 100;
  }
  
  if (moderateEvents.length > 0) {
    const first = moderateEvents[0];
    trade.firstModerateSignal = first;
    trade.moderateSignalDelay = (trade.actualCloseTime.getTime() - first.timestamp.getTime()) / 60000;
    trade.priceAtModerateSignal = first.price;
    trade.pnlAtModerateSignal = trade.side === 'long'
      ? ((first.price - trade.entryPrice) / trade.entryPrice) * 100
      : ((trade.entryPrice - first.price) / trade.entryPrice) * 100;
  }
  
  if (strongEvents.length > 0) {
    const first = strongEvents[0];
    trade.firstStrongSignal = first;
    trade.strongSignalDelay = (trade.actualCloseTime.getTime() - first.timestamp.getTime()) / 60000;
    trade.priceAtStrongSignal = first.price;
    trade.pnlAtStrongSignal = trade.side === 'long'
      ? ((first.price - trade.entryPrice) / trade.entryPrice) * 100
      : ((trade.entryPrice - first.price) / trade.entryPrice) * 100;
  }
}

/**
 * 生成详细报告
 */
function generateReport(trades: TradeAnalysis[]): void {
  console.log('\n' + '='.repeat(100));
  console.log('📊 趋势反转响应延迟分析报告');
  console.log('='.repeat(100));
  
  console.log(`\n测试时间范围: ${TEST_CONFIG.startTime.toISOString()} ~ ${TEST_CONFIG.endTime.toISOString()}`);
  console.log(`趋势反转平仓总数: ${trades.length} 笔`);
  console.log(`当前交易周期: TRADING_INTERVAL_MINUTES=${process.env.TRADING_INTERVAL_MINUTES || 15} 分钟`);
  
  // 统计延迟数据
  const withWeakSignal = trades.filter(t => t.firstWeakSignal);
  const withModerateSignal = trades.filter(t => t.firstModerateSignal);
  const withStrongSignal = trades.filter(t => t.firstStrongSignal);
  
  console.log(`\n检测到信号的交易:`);
  console.log(`  - 弱反转信号 (score≥30): ${withWeakSignal.length}/${trades.length} 笔`);
  console.log(`  - 中等反转信号 (score≥50): ${withModerateSignal.length}/${trades.length} 笔`);
  console.log(`  - 强反转信号 (score≥70): ${withStrongSignal.length}/${trades.length} 笔`);
  
  // 平均响应延迟
  if (withWeakSignal.length > 0) {
    const avgDelay = withWeakSignal.reduce((sum, t) => sum + (t.weakSignalDelay || 0), 0) / withWeakSignal.length;
    const avgPnl = withWeakSignal.reduce((sum, t) => sum + (t.pnlAtWeakSignal || 0), 0) / withWeakSignal.length;
    console.log(`\n弱反转信号 (首次预警):`);
    console.log(`  平均响应延迟: ${avgDelay.toFixed(1)} 分钟`);
    console.log(`  信号时平均盈亏: ${avgPnl.toFixed(2)}%`);
  }
  
  if (withModerateSignal.length > 0) {
    const avgDelay = withModerateSignal.reduce((sum, t) => sum + (t.moderateSignalDelay || 0), 0) / withModerateSignal.length;
    const avgPnl = withModerateSignal.reduce((sum, t) => sum + (t.pnlAtModerateSignal || 0), 0) / withModerateSignal.length;
    console.log(`\n中等反转信号 (当前主程序阈值):`);
    console.log(`  平均响应延迟: ${avgDelay.toFixed(1)} 分钟`);
    console.log(`  信号时平均盈亏: ${avgPnl.toFixed(2)}%`);
  }
  
  if (withStrongSignal.length > 0) {
    const avgDelay = withStrongSignal.reduce((sum, t) => sum + (t.strongSignalDelay || 0), 0) / withStrongSignal.length;
    const avgPnl = withStrongSignal.reduce((sum, t) => sum + (t.pnlAtStrongSignal || 0), 0) / withStrongSignal.length;
    console.log(`\n强反转信号:`);
    console.log(`  平均响应延迟: ${avgDelay.toFixed(1)} 分钟`);
    console.log(`  信号时平均盈亏: ${avgPnl.toFixed(2)}%`);
  }
  
  // 详细交易明细
  console.log('\n' + '='.repeat(100));
  console.log('📋 详细交易分析');
  console.log('='.repeat(100));
  
  for (const trade of trades) {
    console.log(`\n${trade.symbol} ${trade.side.toUpperCase()}`);
    console.log(`  开仓: ${trade.entryTime.toISOString()} @ ${trade.entryPrice}`);
    console.log(`  平仓: ${trade.closeTime.toISOString()} @ ${trade.closePrice}`);
    console.log(`  盈亏: ${trade.pnl.toFixed(2)} USDT (${trade.pnlPercent.toFixed(2)}%)`);
    console.log(`  持仓: ${trade.holdingMinutes.toFixed(0)} 分钟`);
    
    if (trade.firstWeakSignal) {
      console.log(`  ⚠️  弱反转信号 (${trade.firstWeakSignal.reversalScore.toFixed(0)}分):`);
      console.log(`      时间: ${trade.firstWeakSignal.timestamp.toISOString()}`);
      console.log(`      价格: ${trade.priceAtWeakSignal?.toFixed(6)}`);
      console.log(`      当时盈亏: ${trade.pnlAtWeakSignal?.toFixed(2)}%`);
      console.log(`      响应延迟: ${trade.weakSignalDelay?.toFixed(0)} 分钟`);
      console.log(`      检测周期: ${trade.firstWeakSignal.detectedByInterval} 分钟`);
      
      // 计算如果此时退出能节省的损失
      const savedLoss = trade.pnlPercent - (trade.pnlAtWeakSignal || 0);
      console.log(`      💰 提前退出可节省: ${savedLoss.toFixed(2)}% 亏损`);
    }
    
    if (trade.firstModerateSignal) {
      console.log(`  ⚠️⚠️ 中等反转信号 (${trade.firstModerateSignal.reversalScore.toFixed(0)}分):`);
      console.log(`      时间: ${trade.firstModerateSignal.timestamp.toISOString()}`);
      console.log(`      价格: ${trade.priceAtModerateSignal?.toFixed(6)}`);
      console.log(`      当时盈亏: ${trade.pnlAtModerateSignal?.toFixed(2)}%`);
      console.log(`      响应延迟: ${trade.moderateSignalDelay?.toFixed(0)} 分钟`);
      console.log(`      检测周期: ${trade.firstModerateSignal.detectedByInterval} 分钟`);
      
      const savedLoss = trade.pnlPercent - (trade.pnlAtModerateSignal || 0);
      console.log(`      💰 提前退出可节省: ${savedLoss.toFixed(2)}% 亏损`);
    }
    
    if (trade.firstStrongSignal) {
      console.log(`  🚨 强反转信号 (${trade.firstStrongSignal.reversalScore.toFixed(0)}分):`);
      console.log(`      时间: ${trade.firstStrongSignal.timestamp.toISOString()}`);
      console.log(`      价格: ${trade.priceAtStrongSignal?.toFixed(6)}`);
      console.log(`      当时盈亏: ${trade.pnlAtStrongSignal?.toFixed(2)}%`);
      console.log(`      响应延迟: ${trade.strongSignalDelay?.toFixed(0)} 分钟`);
      console.log(`      检测周期: ${trade.firstStrongSignal.detectedByInterval} 分钟`);
    }
  }
  
  // 关键发现
  console.log('\n' + '='.repeat(100));
  console.log('🔍 关键发现');
  console.log('='.repeat(100));
  
  if (withWeakSignal.length > 0) {
    const avgDelayWeak = withWeakSignal.reduce((sum, t) => sum + (t.weakSignalDelay || 0), 0) / withWeakSignal.length;
    const avgDelayModerate = withModerateSignal.length > 0
      ? withModerateSignal.reduce((sum, t) => sum + (t.moderateSignalDelay || 0), 0) / withModerateSignal.length
      : 0;
    
    const currentInterval = Number.parseInt(process.env.TRADING_INTERVAL_MINUTES || '15');
    
    console.log(`\n1. 检测延迟分析:`);
    console.log(`   当前交易周期: ${currentInterval} 分钟`);
    console.log(`   弱信号平均延迟: ${avgDelayWeak.toFixed(1)} 分钟 (≈ ${(avgDelayWeak / currentInterval).toFixed(1)} 个交易周期)`);
    if (avgDelayModerate > 0) {
      console.log(`   中等信号平均延迟: ${avgDelayModerate.toFixed(1)} 分钟 (≈ ${(avgDelayModerate / currentInterval).toFixed(1)} 个交易周期)`);
    }
    
    // 计算潜在节省
    const totalSavedAtWeak = withWeakSignal.reduce((sum, t) => {
      return sum + (t.pnlPercent - (t.pnlAtWeakSignal || 0));
    }, 0);
    const avgSavedAtWeak = totalSavedAtWeak / withWeakSignal.length;
    
    console.log(`\n2. 提前退出收益:`);
    console.log(`   在弱反转信号时退出，平均可节省: ${avgSavedAtWeak.toFixed(2)}% 亏损`);
    console.log(`   按6笔交易计算，可减少总亏损: ${(avgSavedAtWeak * 6).toFixed(2)}%`);
    
    if (withModerateSignal.length > 0) {
      const totalSavedAtModerate = withModerateSignal.reduce((sum, t) => {
        return sum + (t.pnlPercent - (t.pnlAtModerateSignal || 0));
      }, 0);
      const avgSavedAtModerate = totalSavedAtModerate / withModerateSignal.length;
      console.log(`   在中等反转信号时退出，平均可节省: ${avgSavedAtModerate.toFixed(2)}% 亏损`);
    }
    
    console.log(`\n3. 优化建议:`);
    if (avgDelayWeak > currentInterval) {
      console.log(`   ⚠️  反转信号首次出现到实际响应，延迟了 ${(avgDelayWeak / currentInterval).toFixed(1)} 个交易周期`);
      console.log(`   💡 建议: 缩短交易周期至 ${Math.max(1, Math.floor(currentInterval / 2))} 分钟`);
      console.log(`   💡 或者: 实现独立的"反转监控线程"，检测周期 1-3 分钟`);
    }
    
    // 最优检测周期分析
    const intervalStats = new Map<number, { count: number; avgDelay: number }>();
    for (const trade of withWeakSignal) {
      if (trade.firstWeakSignal) {
        const interval = trade.firstWeakSignal.detectedByInterval;
        if (!intervalStats.has(interval)) {
          intervalStats.set(interval, { count: 0, avgDelay: 0 });
        }
        const stats = intervalStats.get(interval)!;
        stats.count++;
        stats.avgDelay += (trade.weakSignalDelay || 0);
      }
    }
    
    console.log(`\n4. 不同检测周期效果:`);
    const sortedIntervals = Array.from(intervalStats.entries())
      .map(([interval, stats]) => ({
        interval,
        count: stats.count,
        avgDelay: stats.avgDelay / stats.count
      }))
      .sort((a, b) => a.avgDelay - b.avgDelay);
    
    for (const { interval, count, avgDelay } of sortedIntervals) {
      console.log(`   ${interval}min 周期: 检测 ${count} 次, 平均延迟 ${avgDelay.toFixed(1)}min`);
    }
    
    if (sortedIntervals.length > 0) {
      const best = sortedIntervals[0];
      console.log(`\n   ✅ 最优检测周期: ${best.interval} 分钟 (延迟最小)`);
    }
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    logger.info('='.repeat(100));
    logger.info('🔍 开始趋势反转响应延迟分析');
    logger.info('='.repeat(100));
    
    // 1. 获取趋势反转平仓的交易
    logger.info('📊 查询趋势反转平仓交易...');
    const trades = await getReversalTrades();
    logger.info(`找到 ${trades.length} 笔趋势反转平仓交易`);
    
    if (trades.length === 0) {
      logger.warn('⚠️  没有找到趋势反转平仓交易，退出测试');
      logger.warn('提示: 请确保数据库中有趋势反转平仓记录（close_reason = "trend_reversal"）');
      return;
    }
    
    // 2. 对每笔交易进行多周期反转检测模拟
    logger.info('\n🔄 开始模拟不同检测周期下的反转检测...');
    logger.info('📝 注意: 基于统计推算，不调用实时API');
    
    for (const trade of trades) {
      logger.info(`\n处理交易: ${trade.symbol} ${trade.side} (${trade.pnl.toFixed(2)} USDT, 持仓${trade.holdingMinutes.toFixed(0)}分钟)`);
      
      const allEvents: ReversalEvent[] = [];
      
      // 使用多个检测周期进行模拟
      for (const interval of TEST_CONFIG.checkIntervals) {
        const events = await simulateReversalDetection(trade, interval);
        allEvents.push(...events);
        
        if (events.length > 0) {
          logger.debug(`  ${interval}min周期: 检测到 ${events.length} 个信号`);
        }
      }
      
      // 分析响应延迟
      analyzeResponseDelay(trade, allEvents);
    }
    
    // 3. 生成报告
    generateReport(trades);
    
    logger.info('\n✅ 分析完成');
    
  } catch (error) {
    logger.error('❌ 测试失败:', error);
    throw error;
  } finally {
    db.close();
  }
}

// 运行测试
main()
  .then(() => {
    console.log('\n测试完成');
    process.exit(0);
  })
  .catch((error) => {
    console.error('测试失败:', error);
    process.exit(1);
  });

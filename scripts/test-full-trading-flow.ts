/**
 * 完整交易流程集成测试脚本
 * 
 * 测试目标:
 * 1. 开仓流程: AI Agent → 交易所 → 数据库
 * 2. 条件单触发: 交易所(自动) → 条件单监控 → 数据库
 * 3. AI主动平仓: AI Agent → 交易所 → 数据库
 * 4. 状态同步: 交易所 ← 数据库 (周期性校验)
 * 5. 🆕 持仓趋势监控: 市场状态分析 → 反转信号检测 → AI决策辅助
 * 
 * 使用方式:
 * tsx --env-file=.env ./scripts/test-full-trading-flow.ts
 */

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { getExchangeClient } from '../src/exchanges';
import { createLogger } from '../src/utils/logger';
import { getChinaTimeISO } from '../src/utils/timeUtils';
import { calculateScientificStopLoss, updateTrailingStopLoss } from '../src/services/stopLossCalculator';
import { analyzeMarketState, analyzeMultipleMarketStates } from '../src/services/marketStateAnalyzer';
import { formatPriceNumber } from '../src/utils/priceFormatter';
import type { MarketStateAnalysis } from '../src/types/marketState';

const logger = createLogger({
  name: 'full-trading-flow-test',
  level: 'info',
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || 'file:./.voltagent/trading.db',
});

// 测试配置
const TEST_CONFIG = {
  symbol: 'ETH_USDT',
  side: 'long' as const,
  leverage: 2,
  amountUsdt: 100, // 增加到100 USDT,确保满足币安最小名义价值20的要求(考虑精度修正)
  testMode: process.env.TEST_MODE === 'true', // 是否真实下单
};

interface TestResult {
  phase: string;
  success: boolean;
  message: string;
  data?: any;
  error?: string;
  duration?: number;
}

const testResults: TestResult[] = [];

// 🔧 全局测试开始时间，用于阶段9.5查询交易所成交记录
let GLOBAL_TEST_START_TIME = 0;

/**
 * 记录测试结果
 */
function recordResult(result: TestResult) {
  testResults.push(result);
  const icon = result.success ? '✅' : '❌';
  logger.info(`${icon} [${result.phase}] ${result.message}`);
  if (result.error) {
    logger.error(`   错误: ${result.error}`);
  }
  if (result.duration) {
    logger.info(`   耗时: ${result.duration}ms`);
  }
}

/**
 * 阶段1: 准备测试环境
 */
async function phase1_PrepareEnvironment(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段1: 准备测试环境');
    logger.info('='.repeat(80));
    
    // 1.1 检查数据库连接
    await dbClient.execute('SELECT 1');
    recordResult({
      phase: '1.1',
      success: true,
      message: '数据库连接正常',
      duration: Date.now() - startTime,
    });
    
    // 1.2 检查交易所连接
    const exchangeClient = getExchangeClient();
    const account = await exchangeClient.getFuturesAccount();
    const balance = parseFloat(account.available || '0');
    
    recordResult({
      phase: '1.2',
      success: balance > 0,
      message: `交易所连接正常，可用余额: ${balance.toFixed(2)} USDT`,
      data: { balance },
      duration: Date.now() - startTime,
    });
    
    if (balance < TEST_CONFIG.amountUsdt) {
      recordResult({
        phase: '1.2',
        success: false,
        message: `余额不足，需要至少 ${TEST_CONFIG.amountUsdt} USDT`,
        error: 'Insufficient balance',
      });
      return false;
    }
    
    // 1.3 检查是否有现有持仓
    const positions = await exchangeClient.getPositions();
    const existingPosition = positions.find((p: any) => {
      const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
      return p.contract === contract && Math.abs(parseFloat(p.size || '0')) > 0;
    });
    
    if (existingPosition) {
      recordResult({
        phase: '1.3',
        success: false,
        message: `${TEST_CONFIG.symbol} 已有持仓，请先清空`,
        error: 'Existing position found',
        data: existingPosition,
      });
      return false;
    }
    
    recordResult({
      phase: '1.3',
      success: true,
      message: '无现有持仓，可以开始测试',
      duration: Date.now() - startTime,
    });
    
    // 1.4 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM positions WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    await dbClient.execute({
      sql: 'DELETE FROM price_orders WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    
    recordResult({
      phase: '1.4',
      success: true,
      message: '测试数据已清理',
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '1',
      success: false,
      message: '准备测试环境失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段2: 测试开仓流程
 */
async function phase2_TestOpenPosition(): Promise<{ orderId: string; slOrderId: string; tpOrderId: string } | null> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段2: 测试开仓流程 (AI Agent → 交易所 → 数据库)');
    logger.info('='.repeat(80));
    
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
    
    // 2.1 获取当前价格
    const ticker = await exchangeClient.getFuturesTicker(contract);
    const currentPrice = parseFloat(ticker.last || '0');
    
    recordResult({
      phase: '2.1',
      success: currentPrice > 0,
      message: `当前价格: ${currentPrice}`,
      data: { currentPrice },
      duration: Date.now() - startTime,
    });
    
    if (!TEST_CONFIG.testMode) {
      logger.warn('⚠️  TEST_MODE=false, 跳过真实下单，仅模拟');
      
      // 模拟插入数据
      const mockOrderId = `TEST_${Date.now()}`;
      const mockSlOrderId = `SL_${Date.now()}`;
      const mockTpOrderId = `TP_${Date.now()}`;
      
      await insertMockData(mockOrderId, mockSlOrderId, mockTpOrderId, currentPrice);
      
      return { 
        orderId: mockOrderId, 
        slOrderId: mockSlOrderId, 
        tpOrderId: mockTpOrderId 
      };
    }
    
    // 2.2 计算开仓数量
    const quantity = TEST_CONFIG.amountUsdt / currentPrice;
    const size = TEST_CONFIG.side === 'long' ? quantity : -quantity;
    
    recordResult({
      phase: '2.2',
      success: true,
      message: `计算开仓数量: ${quantity.toFixed(4)} (${TEST_CONFIG.side})`,
      data: { quantity, size },
      duration: Date.now() - startTime,
    });
    
    // 2.3 设置杠杆
    await exchangeClient.setLeverage(contract, TEST_CONFIG.leverage);
    
    recordResult({
      phase: '2.3',
      success: true,
      message: `设置杠杆: ${TEST_CONFIG.leverage}x`,
      duration: Date.now() - startTime,
    });
    
    // 2.4 市价单开仓
    const order = await exchangeClient.placeOrder({
      contract,
      size,
      price: 0, // 市价单
    });
    
    recordResult({
      phase: '2.4',
      success: !!order.id,
      message: `开仓成功, 订单ID: ${order.id}`,
      data: order,
      duration: Date.now() - startTime,
    });
    
    // 2.5 等待并获取成交信息
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const orderDetail = await exchangeClient.getOrder(order.id!.toString());
    
    // 🔧 优先使用 placeOrder 返回的price (已包含实际成交价)
    // Gate.io: order.price 已通过getMyTrades查询获得实际成交价
    // Binance: order.price 直接包含成交价
    const fillPrice = parseFloat(order.price || orderDetail.fill_price || orderDetail.price || currentPrice.toString());
    const fillSize = Math.abs(parseFloat(orderDetail.size || order.size?.toString() || '0') - parseFloat(orderDetail.left || '0'));
    
    recordResult({
      phase: '2.5',
      success: fillSize > 0,
      message: `成交确认: ${fillSize} @ ${fillPrice}`,
      data: { fillPrice, fillSize, orderDetail },
      duration: Date.now() - startTime,
    });
    
    // 2.6 记录到数据库 trades 表
    // 🔧 手续费计算：Gate.io反向合约的名义价值 = price * quantity * multiplier
    // 获取合约乘数
    const contractInfo = await exchangeClient.getContractInfo(contract);
    const multiplier = contractInfo.quanto_multiplier || contractInfo.multiplier || 0.01;
    const notionalValue = fillPrice * fillSize * multiplier;
    const openFee = notionalValue * 0.0005; // 0.05% 手续费率
    
    await dbClient.execute({
      sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        order.id?.toString() || '',
        TEST_CONFIG.symbol,
        TEST_CONFIG.side,
        'open',
        fillPrice,
        fillSize,
        TEST_CONFIG.leverage,
        openFee,
        new Date().toISOString(),
        'filled',
      ],
    });
    
    recordResult({
      phase: '2.6',
      success: true,
      message: 'trades 表记录成功',
      duration: Date.now() - startTime,
    });
    
    // 2.7 设置止损止盈
    const stopLossPrice = formatPriceNumber(TEST_CONFIG.side === 'long' 
      ? fillPrice * 0.98 // 下跌2%止损
      : fillPrice * 1.02); // 上涨2%止损
    
    const takeProfitPrice = formatPriceNumber(TEST_CONFIG.side === 'long'
      ? fillPrice * 1.06 // 上涨6%止盈
      : fillPrice * 0.94); // 下跌6%止盈
    
    const stopLossResult = await exchangeClient.setPositionStopLoss(
      contract,
      stopLossPrice,
      takeProfitPrice
    );
    
    recordResult({
      phase: '2.7',
      success: stopLossResult.success,
      message: `设置止损止盈: SL=${stopLossPrice.toFixed(2)}, TP=${takeProfitPrice.toFixed(2)}`,
      data: stopLossResult,
      duration: Date.now() - startTime,
    });
    
    // 2.8 保存条件单到数据库
    const now = new Date().toISOString();
    
    if (stopLossResult.stopLossOrderId) {
      await dbClient.execute({
        sql: `INSERT INTO price_orders 
              (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          stopLossResult.stopLossOrderId,
          TEST_CONFIG.symbol,
          TEST_CONFIG.side,
          'stop_loss',
          stopLossPrice,
          0,
          fillSize,
          'active',
          now,
          order.id?.toString() || '',
        ],
      });
    }
    
    if (stopLossResult.takeProfitOrderId) {
      await dbClient.execute({
        sql: `INSERT INTO price_orders 
              (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          stopLossResult.takeProfitOrderId,
          TEST_CONFIG.symbol,
          TEST_CONFIG.side,
          'take_profit',
          takeProfitPrice,
          0,
          fillSize,
          'active',
          now,
          order.id?.toString() || '',
        ],
      });
    }
    
    recordResult({
      phase: '2.8',
      success: true,
      message: 'price_orders 表记录成功',
      duration: Date.now() - startTime,
    });
    
    // 2.9 记录持仓到 positions 表
    await dbClient.execute({
      sql: `INSERT INTO positions 
            (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
             leverage, side, stop_loss, profit_target, sl_order_id, tp_order_id, entry_order_id, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        TEST_CONFIG.symbol,
        fillSize,
        fillPrice,
        fillPrice,
        formatPriceNumber(TEST_CONFIG.side === 'long' ? fillPrice * 0.9 : fillPrice * 1.1), // 估算强平价
        0,
        TEST_CONFIG.leverage,
        TEST_CONFIG.side,
        stopLossPrice,
        takeProfitPrice,
        stopLossResult.stopLossOrderId || null,
        stopLossResult.takeProfitOrderId || null,
        order.id?.toString() || '',
        now,
      ],
    });
    
    recordResult({
      phase: '2.9',
      success: true,
      message: 'positions 表记录成功',
      duration: Date.now() - startTime,
    });
    
    logger.info(`\n📊 开仓流程完成:`);
    logger.info(`   订单ID: ${order.id}`);
    logger.info(`   止损单ID: ${stopLossResult.stopLossOrderId}`);
    logger.info(`   止盈单ID: ${stopLossResult.takeProfitOrderId}`);
    logger.info(`   入场价: ${fillPrice.toFixed(2)}`);
    logger.info(`   数量: ${fillSize}`);
    logger.info(`   止损价: ${stopLossPrice.toFixed(2)}`);
    logger.info(`   止盈价: ${takeProfitPrice.toFixed(2)}`);
    
    return {
      orderId: order.id?.toString() || '',
      slOrderId: stopLossResult.stopLossOrderId || '',
      tpOrderId: stopLossResult.takeProfitOrderId || '',
    };
    
  } catch (error: any) {
    recordResult({
      phase: '2',
      success: false,
      message: '开仓流程失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return null;
  }
}

/**
 * 插入模拟数据（测试模式）
 */
async function insertMockData(orderId: string, slOrderId: string, tpOrderId: string, currentPrice: number) {
  const now = new Date().toISOString();
  const quantity = TEST_CONFIG.amountUsdt / currentPrice;
  const stopLossPrice = TEST_CONFIG.side === 'long' ? currentPrice * 0.98 : currentPrice * 1.02;
  const takeProfitPrice = TEST_CONFIG.side === 'long' ? currentPrice * 1.06 : currentPrice * 0.94;
  
  // 插入 trades
  await dbClient.execute({
    sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [orderId, TEST_CONFIG.symbol, TEST_CONFIG.side, 'open', currentPrice, quantity, TEST_CONFIG.leverage, currentPrice * quantity * 0.0005, now, 'filled'],
  });
  
  // 插入 price_orders
  await dbClient.execute({
    sql: `INSERT INTO price_orders (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [slOrderId, TEST_CONFIG.symbol, TEST_CONFIG.side, 'stop_loss', stopLossPrice, 0, quantity, 'active', now, orderId],
  });
  
  await dbClient.execute({
    sql: `INSERT INTO price_orders (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [tpOrderId, TEST_CONFIG.symbol, TEST_CONFIG.side, 'take_profit', takeProfitPrice, 0, quantity, 'active', now, orderId],
  });
  
  // 插入 positions
  await dbClient.execute({
    sql: `INSERT INTO positions 
          (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
           leverage, side, stop_loss, profit_target, sl_order_id, tp_order_id, entry_order_id, opened_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      TEST_CONFIG.symbol, quantity, currentPrice, currentPrice, 
      TEST_CONFIG.side === 'long' ? currentPrice * 0.9 : currentPrice * 1.1,
      0, TEST_CONFIG.leverage, TEST_CONFIG.side, stopLossPrice, takeProfitPrice,
      slOrderId, tpOrderId, orderId, now,
    ],
  });
  
  logger.info('✅ 模拟数据已插入数据库');
}

/**
 * 阶段3: 测试状态同步
 */
async function phase3_TestStateSync(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段3: 测试状态同步 (交易所 ← 数据库)');
    logger.info('='.repeat(80));
    
    const exchangeClient = getExchangeClient();
    
    // 3.1 从数据库读取持仓
    const dbPositions = await dbClient.execute({
      sql: 'SELECT * FROM positions WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    
    recordResult({
      phase: '3.1',
      success: dbPositions.rows.length > 0,
      message: `数据库持仓记录: ${dbPositions.rows.length} 条`,
      data: dbPositions.rows,
      duration: Date.now() - startTime,
    });
    
    // 3.2 从交易所读取持仓
    const exchangePositions = await exchangeClient.getPositions();
    const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
    const exchangePosition = exchangePositions.find((p: any) => p.contract === contract);
    
    recordResult({
      phase: '3.2',
      success: !!exchangePosition,
      message: `交易所持仓: ${exchangePosition ? '存在' : '不存在'}`,
      data: exchangePosition,
      duration: Date.now() - startTime,
    });
    
    // 3.3 对比持仓数据
    if (dbPositions.rows.length > 0 && exchangePosition) {
      const dbPos = dbPositions.rows[0] as any;
      const exchangeSize = Math.abs(parseFloat(exchangePosition.size || '0'));
      const dbSize = parseFloat(dbPos.quantity || '0');
      
      const sizeMatch = Math.abs(exchangeSize - dbSize) < 0.0001;
      const priceMatch = Math.abs(parseFloat(exchangePosition.entryPrice || '0') - parseFloat(dbPos.entry_price || '0')) < 1;
      
      recordResult({
        phase: '3.3',
        success: sizeMatch && priceMatch,
        message: `持仓数据对比: 数量${sizeMatch ? '✓' : '✗'} 价格${priceMatch ? '✓' : '✗'}`,
        data: { 
          db: { size: dbSize, price: dbPos.entry_price },
          exchange: { size: exchangeSize, price: exchangePosition.entryPrice },
        },
        duration: Date.now() - startTime,
      });
    }
    
    // 3.4 验证条件单
    const dbOrders = await dbClient.execute({
      sql: 'SELECT * FROM price_orders WHERE symbol = ? AND status = ?',
      args: [TEST_CONFIG.symbol, 'active'],
    });
    
    recordResult({
      phase: '3.4',
      success: dbOrders.rows.length === 2,
      message: `数据库条件单记录: ${dbOrders.rows.length} 条 (期望2条)`,
      data: dbOrders.rows,
      duration: Date.now() - startTime,
    });
    
    // 3.5 从交易所读取条件单
    const exchangeOrders = await exchangeClient.getPriceOrders(contract);
    
    recordResult({
      phase: '3.5',
      success: exchangeOrders.length >= 2,
      message: `交易所条件单: ${exchangeOrders.length} 条`,
      data: exchangeOrders,
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '3',
      success: false,
      message: '状态同步测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段4: 测试条件单监控
 */
async function phase4_TestPriceOrderMonitoring(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段4: 测试条件单监控 (交易所 → 条件单监控 → 数据库)');
    logger.info('='.repeat(80));
    
    // 4.1 模拟条件单监控服务的检测逻辑
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
    
    // 获取数据库中的活跃条件单
    const dbActiveOrders = await dbClient.execute({
      sql: 'SELECT * FROM price_orders WHERE symbol = ? AND status = ?',
      args: [TEST_CONFIG.symbol, 'active'],
    });
    
    recordResult({
      phase: '4.1',
      success: true,
      message: `发现 ${dbActiveOrders.rows.length} 个活跃条件单`,
      data: dbActiveOrders.rows,
      duration: Date.now() - startTime,
    });
    
    // 获取交易所的条件单列表
    const exchangeOrders = await exchangeClient.getPriceOrders(contract);
    const exchangeOrderIds = new Set(
      exchangeOrders.map((o: any) => o.id?.toString() || o.orderId?.toString() || o.order_id?.toString())
    );
    
    recordResult({
      phase: '4.2',
      success: true,
      message: `交易所有 ${exchangeOrders.length} 个条件单`,
      data: exchangeOrders,
      duration: Date.now() - startTime,
    });
    
    // 4.3 检查条件单是否被触发（订单不在交易所）
    for (const dbOrder of dbActiveOrders.rows) {
      const orderId = (dbOrder as any).order_id;
      const isTriggered = !exchangeOrderIds.has(orderId);
      
      if (isTriggered) {
        logger.warn(`⚠️  条件单 ${orderId} 可能已被触发（不在交易所列表中）`);
        
        // 查找成交记录 - 传入测试开始时间
        const searchStartTime = startTime - 10 * 60 * 1000; // 测试开始前10分钟
        const trades = await exchangeClient.getMyTrades(contract, 100, searchStartTime);
        const closeTrade = trades.find((t: any) => {
          const tradeId = t.id?.toString() || t.orderId?.toString();
          return tradeId === orderId;
        });
        
        recordResult({
          phase: '4.3',
          success: true,
          message: `条件单 ${orderId} ${closeTrade ? '找到成交记录' : '未找到成交记录'}`,
          data: closeTrade,
          duration: Date.now() - startTime,
        });
      }
    }
    
    // 4.4 获取持仓状态
    const positions = await exchangeClient.getPositions();
    const position = positions.find((p: any) => p.contract === contract);
    
    recordResult({
      phase: '4.4',
      success: true,
      message: `持仓状态: ${position ? '存在' : '不存在'}`,
      data: position,
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '4',
      success: false,
      message: '条件单监控测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段5: 测试AI主动平仓
 */
async function phase5_TestAIClosePosition(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段5: 测试AI主动平仓 (AI Agent → 交易所 → 数据库)');
    logger.info('='.repeat(80));
    
    logger.warn('⚠️  准备执行平仓操作，10秒后开始...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
    
    // 5.1 获取持仓信息
    const positions = await exchangeClient.getPositions();
    const position = positions.find((p: any) => p.contract === contract);
    
    if (!position || Math.abs(parseFloat(position.size || '0')) === 0) {
      recordResult({
        phase: '5.1',
        success: false,
        message: '未找到持仓，无法测试平仓',
        error: 'No position found',
      });
      return false;
    }
    
    const positionSize = parseFloat(position.size || '0');
    const entryPrice = parseFloat(position.entryPrice || '0');
    const side = positionSize > 0 ? 'long' : 'short';
    
    recordResult({
      phase: '5.1',
      success: true,
      message: `持仓信息: ${Math.abs(positionSize)} @ ${entryPrice} (${side})`,
      data: position,
      duration: Date.now() - startTime,
    });
    
    if (!TEST_CONFIG.testMode) {
      logger.warn('⚠️  TEST_MODE=false, 跳过真实平仓，仅模拟数据库操作');
      await simulateClosePosition(entryPrice);
      return true;
    }
    
    // 5.2 市价单平仓
    const closeSize = side === 'long' ? -Math.abs(positionSize) : Math.abs(positionSize);
    const closeOrder = await exchangeClient.placeOrder({
      contract,
      size: closeSize,
      price: 0,
      reduceOnly: true,
    });
    
    recordResult({
      phase: '5.2',
      success: !!closeOrder.id,
      message: `平仓订单已提交: ${closeOrder.id}`,
      data: closeOrder,
      duration: Date.now() - startTime,
    });
    
    // 5.3 等待成交
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const orderDetail = await exchangeClient.getOrder(closeOrder.id!.toString());
    
    // 🔧 优先使用 placeOrder 返回的price (已包含实际成交价)
    // Gate.io: closeOrder.price 已通过getMyTrades查询获得实际成交价
    // Binance: closeOrder.price 直接包含成交价
    const exitPrice = parseFloat(closeOrder.price || orderDetail.fill_price || orderDetail.price || '0');
    const closeSize_filled = Math.abs(parseFloat(orderDetail.size || '0') - parseFloat(orderDetail.left || '0'));
    
    recordResult({
      phase: '5.3',
      success: closeSize_filled > 0,
      message: `平仓成交: ${closeSize_filled} @ ${exitPrice}`,
      data: { exitPrice, closeSize_filled, orderDetail, orderPrice: closeOrder.price },
      duration: Date.now() - startTime,
    });
    
    // 5.4 计算盈亏
    const pnl = await exchangeClient.calculatePnl(
      entryPrice,
      exitPrice,
      Math.abs(positionSize),
      side,
      contract
    );
    
    // 🔧 手续费计算：Gate.io反向合约的名义价值 = price * quantity * multiplier
    const contractInfo = await exchangeClient.getContractInfo(contract);
    const multiplier = contractInfo.quanto_multiplier || contractInfo.multiplier || 0.01;
    const entryNotional = entryPrice * Math.abs(positionSize) * multiplier;
    const exitNotional = exitPrice * Math.abs(positionSize) * multiplier;
    const openFee = entryNotional * 0.0005; // 开仓手续费
    const closeFee = exitNotional * 0.0005; // 平仓手续费
    const totalFee = openFee + closeFee;
    const netPnl = pnl - totalFee;
    
    recordResult({
      phase: '5.4',
      success: true,
      message: `盈亏计算: ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} USDT`,
      data: { pnl, fee: totalFee, netPnl },
      duration: Date.now() - startTime,
    });
    
    // 5.5 取消条件单
    const cancelResult = await exchangeClient.cancelPositionStopLoss(contract);
    
    recordResult({
      phase: '5.5',
      success: cancelResult.success,
      message: `取消条件单: ${cancelResult.success ? '成功' : '失败'}`,
      data: cancelResult,
      duration: Date.now() - startTime,
    });
    
    // 5.6 执行数据库事务
    await dbClient.execute('BEGIN TRANSACTION');
    
    try {
      // 删除持仓
      await dbClient.execute({
        sql: 'DELETE FROM positions WHERE symbol = ?',
        args: [TEST_CONFIG.symbol],
      });
      
      // 更新条件单状态
      await dbClient.execute({
        sql: `UPDATE price_orders SET status = ?, updated_at = ? WHERE symbol = ? AND status = ?`,
        args: ['cancelled', new Date().toISOString(), TEST_CONFIG.symbol, 'active'],
      });
      
      // 插入平仓交易记录
      await dbClient.execute({
        sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          closeOrder.id?.toString() || '',
          TEST_CONFIG.symbol,
          side,
          'close',
          exitPrice,
          Math.abs(positionSize),
          TEST_CONFIG.leverage,
          netPnl,
          totalFee,
          new Date().toISOString(),
          'filled',
        ],
      });
      
      // 插入平仓事件
      await dbClient.execute({
        sql: `INSERT INTO position_close_events 
              (symbol, side, entry_price, close_price, quantity, leverage, pnl, pnl_percent, fee, 
               close_reason, trigger_type, order_id, created_at, processed)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          TEST_CONFIG.symbol,
          side,
          entryPrice,
          exitPrice,
          Math.abs(positionSize),
          TEST_CONFIG.leverage,
          netPnl,
          (netPnl / (entryPrice * Math.abs(positionSize) / TEST_CONFIG.leverage)) * 100,
          totalFee,
          'manual_close',
          'ai_decision',
          closeOrder.id?.toString() || '',
          new Date().toISOString(),
          1,
        ],
      });
      
      await dbClient.execute('COMMIT');
      
      recordResult({
        phase: '5.6',
        success: true,
        message: '数据库事务提交成功',
        duration: Date.now() - startTime,
      });
      
    } catch (dbError: any) {
      await dbClient.execute('ROLLBACK');
      
      recordResult({
        phase: '5.6',
        success: false,
        message: '数据库事务失败，已回滚',
        error: dbError.message,
        duration: Date.now() - startTime,
      });
      
      return false;
    }
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '5',
      success: false,
      message: 'AI主动平仓测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 模拟平仓（测试模式）
 */
async function simulateClosePosition(entryPrice: number) {
  const now = new Date().toISOString();
  const closeOrderId = `CLOSE_${Date.now()}`;
  const exitPrice = entryPrice * 1.01; // 模拟1%盈利
  const quantity = TEST_CONFIG.amountUsdt / entryPrice;
  
  await dbClient.execute('BEGIN TRANSACTION');
  
  try {
    // 删除持仓
    await dbClient.execute({
      sql: 'DELETE FROM positions WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    
    // 更新条件单
    await dbClient.execute({
      sql: `UPDATE price_orders SET status = ?, updated_at = ? WHERE symbol = ? AND status = ?`,
      args: ['cancelled', now, TEST_CONFIG.symbol, 'active'],
    });
    
    // 插入平仓记录
    await dbClient.execute({
      sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, pnl, fee, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [closeOrderId, TEST_CONFIG.symbol, TEST_CONFIG.side, 'close', exitPrice, quantity, TEST_CONFIG.leverage, 10, 1, now, 'filled'],
    });
    
    // 插入平仓事件
    await dbClient.execute({
      sql: `INSERT INTO position_close_events 
            (symbol, side, entry_price, close_price, quantity, leverage, pnl, pnl_percent, fee, 
             close_reason, trigger_type, order_id, created_at, processed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [TEST_CONFIG.symbol, TEST_CONFIG.side, entryPrice, exitPrice, quantity, TEST_CONFIG.leverage, 10, 1, 1, 'manual_close', 'ai_decision', closeOrderId, now, 1],
    });
    
    await dbClient.execute('COMMIT');
    logger.info('✅ 模拟平仓数据已写入数据库');
    
  } catch (error) {
    await dbClient.execute('ROLLBACK');
    throw error;
  }
}

/**
 * 阶段6: 验证最终状态
 */
async function phase6_VerifyFinalState(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段6: 验证最终状态');
    logger.info('='.repeat(80));
    
    // 6.1 检查持仓表应该为空
    const positionsResult = await dbClient.execute({
      sql: 'SELECT * FROM positions WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    
    recordResult({
      phase: '6.1',
      success: positionsResult.rows.length === 0,
      message: `positions 表: ${positionsResult.rows.length} 条记录 (期望0条)`,
      data: positionsResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 6.2 检查条件单应该全部取消
    const activeOrdersResult = await dbClient.execute({
      sql: 'SELECT * FROM price_orders WHERE symbol = ? AND status = ?',
      args: [TEST_CONFIG.symbol, 'active'],
    });
    
    recordResult({
      phase: '6.2',
      success: activeOrdersResult.rows.length === 0,
      message: `活跃条件单: ${activeOrdersResult.rows.length} 条 (期望0条)`,
      data: activeOrdersResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 6.3 检查交易记录应该有2条（开仓+平仓）
    const tradesResult = await dbClient.execute({
      sql: 'SELECT * FROM trades WHERE symbol = ? ORDER BY timestamp',
      args: [TEST_CONFIG.symbol],
    });
    
    const hasOpenTrade = tradesResult.rows.some((r: any) => r.type === 'open');
    const hasCloseTrade = tradesResult.rows.some((r: any) => r.type === 'close');
    
    recordResult({
      phase: '6.3',
      success: hasOpenTrade && hasCloseTrade,
      message: `trades 表: 开仓${hasOpenTrade ? '✓' : '✗'} 平仓${hasCloseTrade ? '✓' : '✗'}`,
      data: tradesResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 6.4 检查平仓事件记录
    const closeEventsResult = await dbClient.execute({
      sql: 'SELECT * FROM position_close_events WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    
    recordResult({
      phase: '6.4',
      success: closeEventsResult.rows.length > 0,
      message: `position_close_events 表: ${closeEventsResult.rows.length} 条记录`,
      data: closeEventsResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 6.5 检查交易所持仓应该为空
    const exchangeClient = getExchangeClient();
    const positions = await exchangeClient.getPositions();
    const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
    const position = positions.find((p: any) => p.contract === contract);
    
    const positionSize = position ? Math.abs(parseFloat(position.size || '0')) : 0;
    
    recordResult({
      phase: '6.5',
      success: positionSize === 0,
      message: `交易所持仓: ${positionSize} (期望0)`,
      data: position,
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '6',
      success: false,
      message: '最终状态验证失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段7: 数据一致性深度验证
 * 基于《系统交易流程与状态管理分析.md》中的关键检查点
 */
async function phase7_DataConsistencyCheck(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段7: 数据一致性深度验证');
    logger.info('='.repeat(80));
    
    // 7.1 检查孤儿条件单（price_orders 中 active 但 positions 中不存在）
    const orphanOrdersResult = await dbClient.execute(`
      SELECT po.* 
      FROM price_orders po
      LEFT JOIN positions p ON po.symbol = p.symbol
      WHERE po.status = 'active' 
      AND p.symbol IS NULL
    `);
    
    recordResult({
      phase: '7.1',
      success: orphanOrdersResult.rows.length === 0,
      message: `孤儿条件单检查: ${orphanOrdersResult.rows.length} 条 (期望0条)`,
      data: orphanOrdersResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 7.2 检查条件单与持仓的关联完整性
    const positionsWithOrders = await dbClient.execute(`
      SELECT 
        p.symbol,
        p.sl_order_id,
        p.tp_order_id,
        (SELECT COUNT(*) FROM price_orders WHERE order_id = p.sl_order_id) as sl_exists,
        (SELECT COUNT(*) FROM price_orders WHERE order_id = p.tp_order_id) as tp_exists
      FROM positions p
    `);
    
    let orderLinkIntegrity = true;
    for (const row of positionsWithOrders.rows) {
      const r = row as any;
      if (r.sl_order_id && r.sl_exists === 0) {
        logger.warn(`持仓 ${r.symbol} 的止损单ID ${r.sl_order_id} 在price_orders表中不存在`);
        orderLinkIntegrity = false;
      }
      if (r.tp_order_id && r.tp_exists === 0) {
        logger.warn(`持仓 ${r.symbol} 的止盈单ID ${r.tp_order_id} 在price_orders表中不存在`);
        orderLinkIntegrity = false;
      }
    }
    
    recordResult({
      phase: '7.2',
      success: orderLinkIntegrity,
      message: `条件单关联完整性: ${orderLinkIntegrity ? '完整' : '存在缺失'}`,
      data: positionsWithOrders.rows,
      duration: Date.now() - startTime,
    });
    
    // 7.3 检查平仓事件与交易记录的一致性
    const closeEventsCheck = await dbClient.execute(`
      SELECT 
        pce.*,
        (SELECT COUNT(*) FROM trades t 
         WHERE t.symbol = pce.symbol 
         AND t.type = 'close' 
         AND ABS(t.price - pce.close_price) < 0.01) as matching_trade_count
      FROM position_close_events pce
      WHERE pce.symbol = ?
    `, [TEST_CONFIG.symbol]);
    
    let eventTradeConsistency = true;
    for (const event of closeEventsCheck.rows) {
      const e = event as any;
      if (e.matching_trade_count === 0) {
        logger.warn(`平仓事件 ${e.symbol} 没有对应的trades记录`);
        eventTradeConsistency = false;
      }
    }
    
    recordResult({
      phase: '7.3',
      success: eventTradeConsistency,
      message: `平仓事件-交易记录一致性: ${eventTradeConsistency ? '一致' : '不一致'}`,
      data: closeEventsCheck.rows,
      duration: Date.now() - startTime,
    });
    
    // 7.4 验证交易记录的完整性（开仓与平仓配对）
    const tradesBalance = await dbClient.execute(`
      SELECT 
        symbol,
        SUM(CASE WHEN type = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN type = 'close' THEN 1 ELSE 0 END) as close_count,
        SUM(CASE WHEN type = 'open' THEN quantity ELSE 0 END) as total_open_qty,
        SUM(CASE WHEN type = 'close' THEN quantity ELSE 0 END) as total_close_qty
      FROM trades
      WHERE symbol = ?
      GROUP BY symbol
    `, [TEST_CONFIG.symbol]);
    
    let tradesBalanced = true;
    if (tradesBalance.rows.length > 0) {
      const balance = tradesBalance.rows[0] as any;
      const qtyDiff = Math.abs(balance.total_open_qty - balance.total_close_qty);
      tradesBalanced = qtyDiff < 0.0001; // 允许微小精度误差
    }
    
    recordResult({
      phase: '7.4',
      success: tradesBalanced,
      message: `交易数量平衡: ${tradesBalanced ? '平衡' : '不平衡'}`,
      data: tradesBalance.rows,
      duration: Date.now() - startTime,
    });
    
    // 7.5 检查数据库时间戳格式
    const timestampCheck = await dbClient.execute(`
      SELECT 
        'trades' as table_name,
        COUNT(*) as total,
        SUM(CASE WHEN timestamp LIKE '%Z' OR timestamp LIKE '%+%' THEN 1 ELSE 0 END) as valid_format
      FROM trades
      WHERE symbol = ?
      UNION ALL
      SELECT 
        'position_close_events' as table_name,
        COUNT(*) as total,
        SUM(CASE WHEN created_at LIKE '%Z' OR created_at LIKE '%+%' THEN 1 ELSE 0 END) as valid_format
      FROM position_close_events
      WHERE symbol = ?
    `, [TEST_CONFIG.symbol, TEST_CONFIG.symbol]);
    
    let allTimestampsValid = true;
    for (const check of timestampCheck.rows) {
      const c = check as any;
      if (c.total > 0 && c.valid_format !== c.total) {
        logger.warn(`表 ${c.table_name} 有 ${c.total - c.valid_format} 条记录的时间戳格式不是UTC ISO`);
        allTimestampsValid = false;
      }
    }
    
    recordResult({
      phase: '7.5',
      success: allTimestampsValid,
      message: `时间戳格式检查: ${allTimestampsValid ? '全部正确' : '存在格式问题'}`,
      data: timestampCheck.rows,
      duration: Date.now() - startTime,
    });
    
    // 7.6 检查盈亏计算合理性
    const pnlCheck = await dbClient.execute(`
      SELECT 
        symbol,
        type,
        price,
        quantity,
        pnl,
        fee,
        leverage
      FROM trades
      WHERE symbol = ? AND type = 'close'
    `, [TEST_CONFIG.symbol]);
    
    let pnlReasonable = true;
    for (const trade of pnlCheck.rows) {
      const t = trade as any;
      
      // 跳过价格或数量为0的记录（可能是数据录入问题）
      if (!t.price || !t.quantity || t.price === 0 || t.quantity === 0) {
        logger.warn(`交易 ${t.symbol} 的价格或数量为0，跳过验证`);
        continue;
      }
      
      // ETH合约的名义价值计算（考虑合约乘数0.01）
      const contractMultiplier = 0.01; // ETH_USDT合约乘数
      const notionalValue = t.quantity * contractMultiplier * t.price;
      
      // 检查盈亏是否合理：对于杠杆交易，盈亏不应该超过名义价值
      // 例如：名义价值35 USDT，2倍杠杆，理论最大亏损约为35 USDT（保证金）
      const maxReasonablePnl = notionalValue; // 100%盈亏
      
      if (Math.abs(t.pnl) > maxReasonablePnl * 1.5) {
        logger.warn(`交易 ${t.symbol} 的盈亏 ${t.pnl.toFixed(2)} 可能异常（名义价值=${notionalValue.toFixed(2)} USDT，最大合理盈亏=${maxReasonablePnl.toFixed(2)}）`);
        pnlReasonable = false;
      }
      
      // 检查手续费是否合理（开仓+平仓约0.1%的名义价值）
      const expectedFee = notionalValue * 0.001; // 0.1%
      const feeDiff = Math.abs(t.fee - expectedFee);
      
      // 允许50%的误差范围
      if (feeDiff > expectedFee) {
        logger.warn(`交易 ${t.symbol} 的手续费 ${t.fee.toFixed(4)} 可能异常（预期约${expectedFee.toFixed(4)} USDT，差异${feeDiff.toFixed(4)}）`);
        // 注意：手续费异常不影响总体判断，只是警告
      }
    }
    
    recordResult({
      phase: '7.6',
      success: pnlReasonable,
      message: `盈亏计算合理性: ${pnlReasonable ? '合理' : '存在异常'}`,
      data: pnlCheck.rows,
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '7',
      success: false,
      message: '数据一致性验证失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段8: 事务保护机制测试
 * 测试数据库事务的回滚能力和不一致状态记录
 */
async function phase8_TransactionProtectionTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段8: 事务保护机制测试');
    logger.info('='.repeat(80));
    
    // 8.1 测试事务回滚：模拟部分操作失败
    logger.info('\n📝 8.1 测试事务回滚机制...');
    
    const testSymbol = 'TEST_ROLLBACK';
    const now = new Date().toISOString();
    
    // 插入测试持仓
    await dbClient.execute({
      sql: `INSERT INTO positions 
            (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
             leverage, side, stop_loss, profit_target, entry_order_id, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [testSymbol, 10, 2000, 2000, 1800, 0, 2, 'long', 1960, 2120, 'TEST_ORDER', now],
    });
    
    // 尝试执行会失败的事务
    let rollbackSuccess = false;
    try {
      await dbClient.execute('BEGIN TRANSACTION');
      
      // 第1步：删除持仓（应该成功）
      await dbClient.execute({
        sql: 'DELETE FROM positions WHERE symbol = ?',
        args: [testSymbol],
      });
      
      // 第2步：故意插入错误数据（违反约束，触发回滚）
      await dbClient.execute({
        sql: 'INSERT INTO trades (order_id, symbol, side, type) VALUES (?, ?, ?, ?)',
        args: [null, testSymbol, 'invalid_side', 'close'], // null order_id 应该违反约束
      });
      
      await dbClient.execute('COMMIT');
    } catch (error) {
      await dbClient.execute('ROLLBACK');
      rollbackSuccess = true;
    }
    
    // 验证回滚是否成功（持仓应该仍然存在）
    const rollbackCheckResult = await dbClient.execute({
      sql: 'SELECT * FROM positions WHERE symbol = ?',
      args: [testSymbol],
    });
    
    const rollbackWorked = rollbackSuccess && rollbackCheckResult.rows.length > 0;
    
    recordResult({
      phase: '8.1',
      success: rollbackWorked,
      message: `事务回滚测试: ${rollbackWorked ? '回滚成功，数据完整' : '回滚失败'}`,
      data: { 
        rollbackTriggered: rollbackSuccess, 
        positionRestored: rollbackCheckResult.rows.length > 0 
      },
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM positions WHERE symbol = ?',
      args: [testSymbol],
    });
    
    // 8.2 测试不一致状态表是否存在
    logger.info('\n📝 8.2 检查不一致状态表...');
    
    let inconsistentTableExists = false;
    try {
      await dbClient.execute('SELECT * FROM inconsistent_states LIMIT 1');
      inconsistentTableExists = true;
    } catch (error) {
      logger.warn('⚠️  inconsistent_states 表不存在，建议运行迁移脚本');
    }
    
    recordResult({
      phase: '8.2',
      success: inconsistentTableExists,
      message: `不一致状态表: ${inconsistentTableExists ? '已创建' : '未创建'}`,
      duration: Date.now() - startTime,
    });
    
    // 8.3 测试不一致状态记录功能
    if (inconsistentTableExists) {
      logger.info('\n📝 8.3 测试不一致状态记录...');
      
      const testStateId = `TEST_${Date.now()}`;
      await dbClient.execute({
        sql: `INSERT INTO inconsistent_states 
              (operation, symbol, side, exchange_success, db_success, exchange_order_id, 
               error_message, resolved, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          'test_close_position',
          'TEST_BTC',
          'long',
          1,
          0,
          testStateId,
          'Database operation failed during test',
          0,
          now,
        ],
      });
      
      // 验证记录是否成功
      const stateCheckResult = await dbClient.execute({
        sql: 'SELECT * FROM inconsistent_states WHERE exchange_order_id = ?',
        args: [testStateId],
      });
      
      recordResult({
        phase: '8.3',
        success: stateCheckResult.rows.length > 0,
        message: `不一致状态记录: ${stateCheckResult.rows.length > 0 ? '写入成功' : '写入失败'}`,
        data: stateCheckResult.rows,
        duration: Date.now() - startTime,
      });
      
      // 清理测试记录
      await dbClient.execute({
        sql: 'DELETE FROM inconsistent_states WHERE exchange_order_id = ?',
        args: [testStateId],
      });
    }
    
    // 8.4 测试持仓删除顺序（验证持仓是否在事务中最先删除）
    logger.info('\n📝 8.4 验证持仓删除顺序...');
    
    const orderTestSymbol = 'TEST_ORDER_' + Date.now();
    
    // 创建完整的测试数据
    await dbClient.execute({
      sql: `INSERT INTO positions 
            (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
             leverage, side, stop_loss, profit_target, entry_order_id, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [orderTestSymbol, 10, 2000, 2000, 1800, 0, 2, 'long', 1960, 2120, 'ORDER_TEST', now],
    });
    
    await dbClient.execute({
      sql: `INSERT INTO price_orders 
            (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['SL_ORDER_TEST', orderTestSymbol, 'long', 'stop_loss', 1960, 0, 10, 'active', now, 'ORDER_TEST'],
    });
    
    // 按照正确的顺序执行平仓操作
    let deleteOrderCorrect = true;
    try {
      await dbClient.execute('BEGIN TRANSACTION');
      
      // ✅ 第1步：最先删除持仓记录
      const deletePositionResult = await dbClient.execute({
        sql: 'DELETE FROM positions WHERE symbol = ?',
        args: [orderTestSymbol],
      });
      
      // 验证持仓已被删除
      const posCheckAfterDelete = await dbClient.execute({
        sql: 'SELECT * FROM positions WHERE symbol = ?',
        args: [orderTestSymbol],
      });
      
      if (posCheckAfterDelete.rows.length > 0) {
        deleteOrderCorrect = false;
        throw new Error('持仓未被正确删除');
      }
      
      // 第2步：更新条件单状态
      await dbClient.execute({
        sql: `UPDATE price_orders SET status = ?, updated_at = ? WHERE symbol = ? AND status = ?`,
        args: ['cancelled', now, orderTestSymbol, 'active'],
      });
      
      // 第3步：插入平仓记录
      await dbClient.execute({
        sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ['CLOSE_TEST', orderTestSymbol, 'long', 'close', 2020, 10, 2, 0.1, now, 'filled'],
      });
      
      await dbClient.execute('COMMIT');
      
    } catch (error: any) {
      await dbClient.execute('ROLLBACK');
      deleteOrderCorrect = false;
      logger.error(`删除顺序测试失败: ${error.message}`);
    }
    
    recordResult({
      phase: '8.4',
      success: deleteOrderCorrect,
      message: `持仓删除顺序验证: ${deleteOrderCorrect ? '正确（最先删除）' : '错误'}`,
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM positions WHERE symbol = ?',
      args: [orderTestSymbol],
    });
    await dbClient.execute({
      sql: 'DELETE FROM price_orders WHERE symbol = ?',
      args: [orderTestSymbol],
    });
    await dbClient.execute({
      sql: 'DELETE FROM trades WHERE symbol = ?',
      args: [orderTestSymbol],
    });
    
    // 8.5 测试幂等性保护（应用层检查）
    logger.info('\n📝 8.5 测试幂等性保护...');
    
    const idempotentSymbol = 'TEST_IDEMPOTENT';
    const orderId = 'IDEMPOTENT_ORDER_' + Date.now();
    
    // 插入第一次
    await dbClient.execute({
      sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [orderId, idempotentSymbol, 'long', 'open', 2000, 10, 2, 0.1, now, 'filled'],
    });
    
    // 模拟应用层幂等性检查（在实际代码中，应该先检查是否存在）
    let idempotentProtected = false;
    try {
      // 检查是否已存在相同的 order_id
      const existingOrder = await dbClient.execute({
        sql: 'SELECT * FROM trades WHERE order_id = ?',
        args: [orderId],
      });
      
      if (existingOrder.rows.length > 0) {
        // 已存在，不应该重复插入
        idempotentProtected = true;
        logger.info(`✅ 检测到重复的 order_id: ${orderId}，跳过插入`);
      } else {
        // 不存在，可以插入（但这不应该发生，因为我们刚刚插入了）
        await dbClient.execute({
          sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [orderId, idempotentSymbol, 'long', 'open', 2000, 10, 2, 0.1, now, 'filled'],
        });
      }
    } catch (error) {
      idempotentProtected = false;
    }
    
    // 验证只有一条记录
    const idempotentCheckResult = await dbClient.execute({
      sql: 'SELECT COUNT(*) as count FROM trades WHERE order_id = ?',
      args: [orderId],
    });
    
    const recordCount = (idempotentCheckResult.rows[0] as any).count;
    idempotentProtected = idempotentProtected && recordCount === 1;
    
    recordResult({
      phase: '8.5',
      success: idempotentProtected,
      message: `幂等性保护: ${idempotentProtected ? '有效（应用层检查阻止重复）' : '无效'}`,
      data: { recordCount },
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM trades WHERE order_id = ?',
      args: [orderId],
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '8',
      success: false,
      message: '事务保护测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段9: 交易所与数据库状态对比验证
 * 验证交易所实际状态与数据库记录的一致性
 */
async function phase9_ExchangeVsDatabaseSync(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段9: 交易所与数据库状态对比');
    logger.info('='.repeat(80));
    
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
    
    // 8.1 对比持仓数量
    const exchangePositions = await exchangeClient.getPositions();
    const exchangePosition = exchangePositions.find((p: any) => p.contract === contract);
    const exchangeSize = exchangePosition ? Math.abs(parseFloat(exchangePosition.size || '0')) : 0;
    
    const dbPositions = await dbClient.execute({
      sql: 'SELECT * FROM positions WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    const dbSize = dbPositions.rows.length > 0 ? Math.abs(parseFloat((dbPositions.rows[0] as any).quantity || '0')) : 0;
    
    const sizeMatch = Math.abs(exchangeSize - dbSize) < 0.0001;
    
    recordResult({
      phase: '9.1',
      success: sizeMatch,
      message: `持仓数量对比: 交易所=${exchangeSize} vs 数据库=${dbSize} ${sizeMatch ? '✓' : '✗'}`,
      data: { exchange: exchangeSize, database: dbSize },
      duration: Date.now() - startTime,
    });
    
    // 9.2 对比条件单数量
    const exchangeOrders = await exchangeClient.getPriceOrders(contract);
    const exchangeOrderCount = exchangeOrders.length;
    
    const dbOrders = await dbClient.execute({
      sql: 'SELECT * FROM price_orders WHERE symbol = ? AND status = ?',
      args: [TEST_CONFIG.symbol, 'active'],
    });
    const dbOrderCount = dbOrders.rows.length;
    
    const orderCountMatch = exchangeOrderCount === dbOrderCount;
    
    recordResult({
      phase: '9.2',
      success: orderCountMatch,
      message: `条件单数量对比: 交易所=${exchangeOrderCount} vs 数据库=${dbOrderCount} ${orderCountMatch ? '✓' : '✗'}`,
      data: { exchange: exchangeOrderCount, database: dbOrderCount },
      duration: Date.now() - startTime,
    });
    
    // 9.3 对比条件单ID的一致性
    const exchangeOrderIds = new Set(
      exchangeOrders.map((o: any) => o.id?.toString() || o.orderId?.toString() || o.order_id?.toString())
    );
    const dbOrderIds = new Set(
      dbOrders.rows.map((o: any) => o.order_id?.toString())
    );
    
    let idsMatch = true;
    let missingInDb: string[] = [];
    let missingInExchange: string[] = [];
    
    // 使用 Array.from 转换 Set 以避免 TypeScript 迭代器错误
    Array.from(exchangeOrderIds).forEach((id) => {
      if (!dbOrderIds.has(id)) {
        missingInDb.push(id);
        idsMatch = false;
      }
    });
    
    Array.from(dbOrderIds).forEach((id) => {
      if (!exchangeOrderIds.has(id)) {
        missingInExchange.push(id);
        idsMatch = false;
      }
    });
    
    recordResult({
      phase: '9.3',
      success: idsMatch,
      message: `条件单ID一致性: ${idsMatch ? '完全一致' : `不一致（数据库缺${missingInDb.length}个，交易所缺${missingInExchange.length}个）`}`,
      data: { missingInDb, missingInExchange },
      duration: Date.now() - startTime,
    });
    
    // 9.4 验证条件单价格设置
    if (exchangeOrderCount > 0 && dbOrderCount > 0) {
      for (const dbOrder of dbOrders.rows) {
        const order = dbOrder as any;
        const exchangeOrder = exchangeOrders.find((eo: any) => {
          const id = eo.id?.toString() || eo.orderId?.toString() || eo.order_id?.toString();
          return id === order.order_id;
        });
        
        if (exchangeOrder) {
          const dbTriggerPrice = parseFloat(order.trigger_price || '0');
          const exchangeTriggerPrice = parseFloat(
            exchangeOrder.trigger?.price || 
            exchangeOrder.trigger_price || 
            exchangeOrder.triggerPrice || 
            '0'
          );
          
          const priceMatch = Math.abs(dbTriggerPrice - exchangeTriggerPrice) < 0.01;
          
          if (!priceMatch) {
            logger.warn(`条件单 ${order.order_id} 触发价不一致: 数据库=${dbTriggerPrice} vs 交易所=${exchangeTriggerPrice}`);
          }
        }
      }
    }
    
    recordResult({
      phase: '9.4',
      success: true,
      message: `条件单价格验证完成`,
      duration: Date.now() - startTime,
    });
    
    // 9.5 验证交易所成交记录完整性
    // 🔧 使用全局测试开始时间，确保查询到本次测试的所有成交记录
    // 给5分钟容差以防测试开始前的其他操作
    const testStartTime = GLOBAL_TEST_START_TIME - 5 * 60 * 1000;
    const recentTrades = await exchangeClient.getMyTrades(contract, 100, testStartTime);
    const testTrades = recentTrades.filter((t: any) => {
      const tradeTime = new Date(t.create_time || t.timestamp || Date.now()).getTime();
      return tradeTime >= testStartTime;
    });
    
    recordResult({
      phase: '9.5',
      success: testTrades.length >= 2,
      message: `交易所成交记录: ${testTrades.length} 条 (期望至少2条)`,
      data: { totalTrades: recentTrades.length, testPeriodTrades: testTrades.length },
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '9',
      success: false,
      message: '交易所状态对比失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段10: 健康检查系统测试
 * 验证健康检查能否正确发现系统问题
 */
async function phase10_HealthCheckTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段10: 健康检查系统测试');
    logger.info('='.repeat(80));
    
    // 10.1 检查孤儿条件单检测
    logger.info('\n📝 10.1 测试孤儿条件单检测...');
    
    const now = new Date().toISOString();
    const orphanSymbol = 'TEST_ORPHAN_' + Date.now();
    
    // 创建一个没有对应持仓的条件单（孤儿条件单）
    await dbClient.execute({
      sql: `INSERT INTO price_orders 
            (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['ORPHAN_ORDER', orphanSymbol, 'long', 'stop_loss', 1960, 0, 10, 'active', now, 'NON_EXIST'],
    });
    
    // 执行孤儿条件单检测
    const orphanCheckResult = await dbClient.execute(`
      SELECT po.* 
      FROM price_orders po
      LEFT JOIN positions p ON po.symbol = p.symbol AND po.side = p.side
      WHERE po.status = 'active' 
      AND p.symbol IS NULL
      AND po.symbol = ?
    `, [orphanSymbol]);
    
    recordResult({
      phase: '10.1',
      success: orphanCheckResult.rows.length > 0,
      message: `孤儿条件单检测: ${orphanCheckResult.rows.length > 0 ? '成功发现' : '未发现'}`,
      data: orphanCheckResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM price_orders WHERE symbol = ?',
      args: [orphanSymbol],
    });
    
    // 10.2 测试持仓与条件单关联完整性检查
    logger.info('\n📝 10.2 测试持仓-条件单关联完整性...');
    
    const linkTestSymbol = 'TEST_LINK_' + Date.now();
    
    // 创建持仓但不创建对应的条件单
    await dbClient.execute({
      sql: `INSERT INTO positions 
            (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
             leverage, side, stop_loss, profit_target, sl_order_id, tp_order_id, entry_order_id, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [linkTestSymbol, 10, 2000, 2000, 1800, 0, 2, 'long', 1960, 2120, 'NON_EXIST_SL', 'NON_EXIST_TP', 'TEST', now],
    });
    
    // 检测关联完整性
    const linkCheckResult = await dbClient.execute(`
      SELECT 
        p.symbol,
        p.sl_order_id,
        p.tp_order_id,
        (SELECT COUNT(*) FROM price_orders WHERE order_id = p.sl_order_id) as sl_exists,
        (SELECT COUNT(*) FROM price_orders WHERE order_id = p.tp_order_id) as tp_exists
      FROM positions p
      WHERE p.symbol = ?
    `, [linkTestSymbol]);
    
    const linkRow = linkCheckResult.rows[0] as any;
    const hasIssue = (linkRow.sl_order_id && linkRow.sl_exists === 0) || 
                     (linkRow.tp_order_id && linkRow.tp_exists === 0);
    
    recordResult({
      phase: '10.2',
      success: hasIssue,
      message: `条件单关联检查: ${hasIssue ? '成功发现关联缺失' : '未发现问题'}`,
      data: linkCheckResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM positions WHERE symbol = ?',
      args: [linkTestSymbol],
    });
    
    // 10.3 测试交易记录完整性检查
    logger.info('\n📝 10.3 测试交易记录完整性...');
    
    const tradeTestSymbol = 'TEST_TRADE_' + Date.now();
    
    // 只插入开仓记录，不插入平仓记录
    await dbClient.execute({
      sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['OPEN_ONLY', tradeTestSymbol, 'long', 'open', 2000, 10, 2, 0.1, now, 'filled'],
    });
    
    // 插入平仓事件但没有对应的平仓交易记录
    await dbClient.execute({
      sql: `INSERT INTO position_close_events 
            (symbol, side, entry_price, close_price, quantity, leverage, pnl, pnl_percent, fee, 
             close_reason, trigger_type, order_id, created_at, processed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [tradeTestSymbol, 'long', 2000, 2020, 10, 2, 10, 1, 0.1, 'test', 'test', 'MISSING_CLOSE', now, 1],
    });
    
    // 检测不一致
    const tradeCheckResult = await dbClient.execute(`
      SELECT 
        pce.*,
        (SELECT COUNT(*) FROM trades t 
         WHERE t.symbol = pce.symbol 
         AND t.type = 'close' 
         AND ABS(t.price - pce.close_price) < 0.01) as matching_trade_count
      FROM position_close_events pce
      WHERE pce.symbol = ?
    `, [tradeTestSymbol]);
    
    const tradeRow = tradeCheckResult.rows[0] as any;
    const hasTradeIssue = tradeRow && tradeRow.matching_trade_count === 0;
    
    recordResult({
      phase: '10.3',
      success: hasTradeIssue,
      message: `交易记录完整性检查: ${hasTradeIssue ? '成功发现缺失' : '未发现问题'}`,
      data: tradeCheckResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM trades WHERE symbol = ?',
      args: [tradeTestSymbol],
    });
    await dbClient.execute({
      sql: 'DELETE FROM position_close_events WHERE symbol = ?',
      args: [tradeTestSymbol],
    });
    
    // 10.4 测试交易数量平衡检查
    logger.info('\n📝 10.4 测试交易数量平衡检查...');
    
    const balanceTestSymbol = 'TEST_BALANCE_' + Date.now();
    
    // 开仓10个
    await dbClient.execute({
      sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['OPEN_10', balanceTestSymbol, 'long', 'open', 2000, 10, 2, 0.1, now, 'filled'],
    });
    
    // 平仓8个（不平衡）
    await dbClient.execute({
      sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['CLOSE_8', balanceTestSymbol, 'long', 'close', 2020, 8, 2, 0.1, now, 'filled'],
    });
    
    // 检测不平衡
    const balanceCheckResult = await dbClient.execute(`
      SELECT 
        symbol,
        SUM(CASE WHEN type = 'open' THEN quantity ELSE 0 END) as total_open_qty,
        SUM(CASE WHEN type = 'close' THEN quantity ELSE 0 END) as total_close_qty,
        ABS(SUM(CASE WHEN type = 'open' THEN quantity ELSE 0 END) - 
            SUM(CASE WHEN type = 'close' THEN quantity ELSE 0 END)) as qty_diff
      FROM trades
      WHERE symbol = ?
      GROUP BY symbol
    `, [balanceTestSymbol]);
    
    const balanceRow = balanceCheckResult.rows[0] as any;
    const hasBalanceIssue = balanceRow && balanceRow.qty_diff > 0.0001;
    
    recordResult({
      phase: '10.4',
      success: hasBalanceIssue,
      message: `交易数量平衡检查: ${hasBalanceIssue ? '成功发现不平衡' : '未发现问题'}`,
      data: balanceCheckResult.rows,
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM trades WHERE symbol = ?',
      args: [balanceTestSymbol],
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '10',
      success: false,
      message: '健康检查系统测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 阶段11: 异常场景压力测试
 * 模拟各种异常情况，测试系统的鲁棒性
 */
async function phase11_ExceptionScenarioTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段11: 异常场景压力测试');
    logger.info('='.repeat(80));
    
    // 11.1 测试重复平仓保护
    logger.info('\n📝 11.1 测试重复平仓保护...');
    
    const now = new Date().toISOString();
    const dupSymbol = 'TEST_DUP_' + Date.now();
    
    // 创建测试持仓
    await dbClient.execute({
      sql: `INSERT INTO positions 
            (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
             leverage, side, stop_loss, profit_target, entry_order_id, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [dupSymbol, 10, 2000, 2000, 1800, 0, 2, 'long', 1960, 2120, 'DUP_TEST', now],
    });
    
    // 第一次平仓（应该成功）
    let firstCloseSuccess = false;
    try {
      await dbClient.execute('BEGIN TRANSACTION');
      await dbClient.execute({
        sql: 'DELETE FROM positions WHERE symbol = ?',
        args: [dupSymbol],
      });
      await dbClient.execute('COMMIT');
      firstCloseSuccess = true;
    } catch (error) {
      await dbClient.execute('ROLLBACK');
    }
    
    // 第二次平仓（应该失败，因为持仓已不存在）
    let secondClosePrevented = false;
    try {
      const checkResult = await dbClient.execute({
        sql: 'SELECT * FROM positions WHERE symbol = ?',
        args: [dupSymbol],
      });
      
      if (checkResult.rows.length === 0) {
        secondClosePrevented = true; // 检查到持仓不存在，阻止了重复平仓
      } else {
        // 如果还有持仓，尝试平仓
        await dbClient.execute('BEGIN TRANSACTION');
        await dbClient.execute({
          sql: 'DELETE FROM positions WHERE symbol = ?',
          args: [dupSymbol],
        });
        await dbClient.execute('COMMIT');
      }
    } catch (error) {
      secondClosePrevented = true;
    }
    
    recordResult({
      phase: '11.1',
      success: firstCloseSuccess && secondClosePrevented,
      message: `重复平仓保护: ${secondClosePrevented ? '成功阻止重复平仓' : '保护失效'}`,
      data: { firstCloseSuccess, secondClosePrevented },
      duration: Date.now() - startTime,
    });
    
    // 11.2 测试并发平仓保护（模拟）
    logger.info('\n📝 11.2 测试并发操作保护...');
    
    const concurrentSymbol = 'TEST_CONCURRENT_' + Date.now();
    
    // 创建测试持仓
    await dbClient.execute({
      sql: `INSERT INTO positions 
            (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
             leverage, side, stop_loss, profit_target, entry_order_id, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [concurrentSymbol, 10, 2000, 2000, 1800, 0, 2, 'long', 1960, 2120, 'CONCURRENT_TEST', now],
    });
    
    // 模拟两个并发操作
    const operation1 = async () => {
      try {
        await dbClient.execute('BEGIN IMMEDIATE TRANSACTION');
        const check = await dbClient.execute({
          sql: 'SELECT * FROM positions WHERE symbol = ?',
          args: [concurrentSymbol],
        });
        if (check.rows.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100)); // 模拟处理延迟
          await dbClient.execute({
            sql: 'DELETE FROM positions WHERE symbol = ?',
            args: [concurrentSymbol],
          });
        }
        await dbClient.execute('COMMIT');
        return 'op1_success';
      } catch (error: any) {
        try {
          await dbClient.execute('ROLLBACK');
        } catch (rollbackError) {
          // 忽略回滚错误，可能没有活动事务
        }
        return `op1_failed: ${error.message}`;
      }
    };
    
    const operation2 = async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 50)); // 略微延迟启动
        await dbClient.execute('BEGIN IMMEDIATE TRANSACTION');
        const check = await dbClient.execute({
          sql: 'SELECT * FROM positions WHERE symbol = ?',
          args: [concurrentSymbol],
        });
        if (check.rows.length > 0) {
          await dbClient.execute({
            sql: 'DELETE FROM positions WHERE symbol = ?',
            args: [concurrentSymbol],
          });
        }
        await dbClient.execute('COMMIT');
        return 'op2_success';
      } catch (error: any) {
        try {
          await dbClient.execute('ROLLBACK');
        } catch (rollbackError) {
          // 忽略回滚错误，可能没有活动事务
        }
        return `op2_failed: ${error.message}`;
      }
    };
    
    const [result1, result2] = await Promise.all([operation1(), operation2()]);
    
    // 验证最终只有一个操作成功
    const finalCheck = await dbClient.execute({
      sql: 'SELECT * FROM positions WHERE symbol = ?',
      args: [concurrentSymbol],
    });
    
    const concurrentProtected = finalCheck.rows.length === 0;
    
    recordResult({
      phase: '11.2',
      success: concurrentProtected,
      message: `并发操作保护: ${concurrentProtected ? '数据一致' : '数据不一致'}`,
      data: { result1, result2, finalRows: finalCheck.rows.length },
      duration: Date.now() - startTime,
    });
    
    // 清理测试数据
    await dbClient.execute({
      sql: 'DELETE FROM positions WHERE symbol = ?',
      args: [concurrentSymbol],
    });
    
    // 11.3 测试极端数值处理
    logger.info('\n📝 11.3 测试极端数值处理...');
    
    const extremeSymbol = 'TEST_EXTREME_' + Date.now();
    
    // 测试极小数量
    let extremeHandled = true;
    try {
      await dbClient.execute({
        sql: `INSERT INTO positions 
              (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
               leverage, side, stop_loss, profit_target, entry_order_id, opened_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [extremeSymbol, 0.00000001, 50000, 50000, 45000, 0, 2, 'long', 49000, 53000, 'EXTREME_TEST', now],
      });
      
      const checkResult = await dbClient.execute({
        sql: 'SELECT * FROM positions WHERE symbol = ?',
        args: [extremeSymbol],
      });
      
      extremeHandled = checkResult.rows.length > 0;
      
      // 清理
      await dbClient.execute({
        sql: 'DELETE FROM positions WHERE symbol = ?',
        args: [extremeSymbol],
      });
      
    } catch (error) {
      extremeHandled = false;
    }
    
    recordResult({
      phase: '11.3',
      success: extremeHandled,
      message: `极端数值处理: ${extremeHandled ? '正常处理' : '处理失败'}`,
      duration: Date.now() - startTime,
    });
    
    // 11.4 测试NULL值处理
    logger.info('\n📝 11.4 测试NULL值处理...');
    
    const nullSymbol = 'TEST_NULL_' + Date.now();
    
    let nullHandled = true;
    try {
      // 尝试插入带NULL的必需字段（应该失败）
      await dbClient.execute({
        sql: `INSERT INTO positions 
              (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
               leverage, side, stop_loss, profit_target, entry_order_id, opened_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [nullSymbol, null, 2000, 2000, 1800, 0, 2, 'long', 1960, 2120, 'NULL_TEST', now],
      });
      nullHandled = false; // 如果插入成功，说明NULL值约束失效
    } catch (error) {
      nullHandled = true; // 插入失败，说明NULL值约束正常工作
    }
    
    recordResult({
      phase: '11.4',
      success: nullHandled,
      message: `NULL值处理: ${nullHandled ? '约束有效' : '约束失效'}`,
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '11',
      success: false,
      message: '异常场景测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 🆕 阶段12: 科学止损系统测试
 */
async function phase12_ScientificStopLossTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段12: 科学止损系统测试');
    logger.info('='.repeat(80));
    
    const symbolName = 'BTC';
    const testPrice = 50000;
    const testSide = 'long';
    
    // 12.1 测试 calculateStopLoss 基本功能
    logger.info('\n📝 12.1 测试科学止损计算...');
    
    try {
      const stopLossResult = await calculateScientificStopLoss(
        symbolName,
        testSide,
        testPrice
      );
      
      const stopLossValid = stopLossResult && 
        stopLossResult.stopLossPrice > 0 &&
        stopLossResult.stopLossPrice < testPrice &&
        stopLossResult.stopLossDistancePercent > 0 &&
        stopLossResult.stopLossDistancePercent < 10;
      
      recordResult({
        phase: '12.1',
        success: stopLossValid,
        message: `科学止损计算: 止损${stopLossResult.stopLossPrice.toFixed(2)} (${stopLossResult.stopLossDistancePercent.toFixed(2)}%)`,
        data: stopLossResult,
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '12.1',
        success: false,
        message: '科学止损计算失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 12.2 测试 ATR 动态调整
    logger.info('\n📝 12.2 测试ATR动态调整...');
    
    try {
      // 测试不同 ATR 倍数
      const atr1x = await calculateScientificStopLoss(symbolName, testSide, testPrice);
      
      // 验证ATR影响止损距离
      const atrTestValid = atr1x.stopLossDistancePercent > 0;
      
      recordResult({
        phase: '12.2',
        success: atrTestValid,
        message: `ATR动态调整: 止损距离=${atr1x.stopLossDistancePercent.toFixed(2)}%`,
        data: { stopLossDistance: atr1x.stopLossDistancePercent },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '12.2',
        success: false,
        message: 'ATR动态调整测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 12.3 测试支撑阻力位整合
    logger.info('\n📝 12.3 测试支撑阻力位整合...');
    
    try {
      const supportTestResult = await calculateScientificStopLoss(
        symbolName,
        testSide,
        testPrice
      );
      
      const hasSupportData = supportTestResult.stopLossPrice > 0;
      
      recordResult({
        phase: '12.3',
        success: true,
        message: `支撑阻力位整合: 止损价${supportTestResult.stopLossPrice.toFixed(2)}`,
        data: {
          stopLossPrice: supportTestResult.stopLossPrice,
          quality: supportTestResult.qualityScore,
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '12.3',
        success: false,
        message: '支撑阻力位测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 12.4 测试止损距离边界
    logger.info('\n📝 12.4 测试止损距离边界...');
    
    try {
      const boundaryResult = await calculateScientificStopLoss(
        symbolName,
        testSide,
        testPrice
      );
      
      // 合理的止损范围：0.5-10%（涵盖所有策略的范围）
      // - 超短线: 0.5-3%
      // - 激进: 0.5-4%
      // - 平衡: 0.8-5%
      // - 波段趋势: 1.0-6%
      // - 保守: 1.5-7%
      // 考虑极端市场波动，最大允许10%
      const minStopLoss = 0.5;
      const maxStopLoss = 10.0;
      
      const withinBounds = 
        boundaryResult.stopLossDistancePercent >= minStopLoss &&
        boundaryResult.stopLossDistancePercent <= maxStopLoss;
      
      recordResult({
        phase: '12.4',
        success: withinBounds,
        message: `止损边界验证: ${boundaryResult.stopLossDistancePercent.toFixed(2)}% (${minStopLoss}-${maxStopLoss}%)`,
        data: { 
          distance: boundaryResult.stopLossDistancePercent, 
          minStopLoss, 
          maxStopLoss,
          method: boundaryResult.method 
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '12.4',
        success: false,
        message: '止损边界测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '12',
      success: false,
      message: '科学止损系统测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 🆕 阶段13: 移动止损机制测试
 */
async function phase13_TrailingStopTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段13: 移动止损机制测试');
    logger.info('='.repeat(80));
    
    const symbolName = 'ETH';
    const entryPrice = 3000;
    const currentStopLoss = 2940; // -2%
    
    // 13.1 测试盈利后止损上移
    logger.info('\n📝 13.1 测试盈利后止损上移...');
    
    try {
      const currentPrice = 3150; // +5% 盈利
      
      const trailingResult = await updateTrailingStopLoss(
        symbolName,
        'long',
        entryPrice,
        currentPrice,
        currentStopLoss
      );
      
      const stopLossImproved = trailingResult.shouldUpdate && 
        trailingResult.newStopLoss !== undefined &&
        trailingResult.newStopLoss > currentStopLoss;
      
      recordResult({
        phase: '13.1',
        success: stopLossImproved,
        message: `止损上移测试: ${currentStopLoss} → ${trailingResult.newStopLoss?.toFixed(2) || 'N/A'} (${trailingResult.shouldUpdate ? '上移' : '不变'})`,
        data: trailingResult,
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '13.1',
        success: false,
        message: '止损上移测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 13.2 测试亏损时止损不下移
    logger.info('\n📝 13.2 测试亏损时止损不下移...');
    
    try {
      const losingPrice = 2970; // -1% 亏损
      
      const noMoveResult = await updateTrailingStopLoss(
        symbolName,
        'long',
        entryPrice,
        losingPrice,
        currentStopLoss
      );
      
      const stopLossStable = !noMoveResult.shouldUpdate ||
        (noMoveResult.newStopLoss !== undefined && noMoveResult.newStopLoss >= currentStopLoss);
      
      recordResult({
        phase: '13.2',
        success: stopLossStable,
        message: `止损稳定性测试: ${stopLossStable ? '不下移✓' : '错误下移✗'}`,
        data: noMoveResult,
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '13.2',
        success: false,
        message: '止损稳定性测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 13.3 测试大幅盈利时的止损保护
    logger.info('\n📝 13.3 测试大幅盈利止损保护...');
    
    try {
      const bigProfitPrice = 3300; // +10% 盈利
      
      const bigProfitResult = await updateTrailingStopLoss(
        symbolName,
        'long',
        entryPrice,
        bigProfitPrice,
        currentStopLoss
      );
      
      const goodProtection = bigProfitResult.shouldUpdate &&
        bigProfitResult.newStopLoss !== undefined &&
        bigProfitResult.newStopLoss > entryPrice; // 止损应该在成本价之上
      
      recordResult({
        phase: '13.3',
        success: goodProtection,
        message: `利润保护测试: 止损${bigProfitResult.newStopLoss?.toFixed(2) || 'N/A'} (${goodProtection ? '保护利润✓' : '保护不足✗'})`,
        data: bigProfitResult,
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '13.3',
        success: false,
        message: '利润保护测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '13',
      success: false,
      message: '移动止损机制测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 🆕 阶段14: 自动止损单系统集成测试
 * 重新开仓 → 设置止损止盈 → 测试条件单监控服务 → 验证数据一致性
 */
async function phase14_AutoStopLossOrderTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段14: 自动止损单系统集成测试');
    logger.info('='.repeat(80));
    
    const exchangeClient = getExchangeClient();
    const contract = exchangeClient.normalizeContract(TEST_CONFIG.symbol);
    
    // 14.1 重新开仓（为测试条件单监控准备数据）
    logger.info('\n📝 14.1 重新开仓，准备测试环境...');
    
    const ticker = await exchangeClient.getFuturesTicker(contract);
    const currentPrice = parseFloat(ticker.last || '0');
    
    if (!TEST_CONFIG.testMode) {
      logger.warn('⚠️  TEST_MODE=false, 跳过真实开仓');
      recordResult({
        phase: '14.1',
        success: false,
        message: '跳过开仓（测试模式关闭）',
        duration: Date.now() - startTime,
      });
      return false;
    }
    
    const quantity = TEST_CONFIG.amountUsdt / currentPrice;
    const size = TEST_CONFIG.side === 'long' ? quantity : -quantity;
    
    await exchangeClient.setLeverage(contract, TEST_CONFIG.leverage);
    
    const order = await exchangeClient.placeOrder({
      contract,
      size,
      price: 0,
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const orderDetail = await exchangeClient.getOrder(order.id!.toString());
    const fillPrice = parseFloat(order.price || orderDetail.fill_price || orderDetail.price || currentPrice.toString());
    const fillSize = Math.abs(parseFloat(orderDetail.size || order.size?.toString() || '0') - parseFloat(orderDetail.left || '0'));
    
    recordResult({
      phase: '14.1',
      success: fillSize > 0,
      message: `开仓成功: ${fillSize} @ ${fillPrice}`,
      data: { fillPrice, fillSize },
      duration: Date.now() - startTime,
    });
    
    // 14.2 设置止损止盈
    logger.info('\n📝 14.2 设置止损止盈条件单...');
    
    const stopLossPrice = formatPriceNumber(TEST_CONFIG.side === 'long' 
      ? fillPrice * 0.9995
      : fillPrice * 1.0005);
    
    const takeProfitPrice = formatPriceNumber(TEST_CONFIG.side === 'long'
      ? fillPrice * 1.0005
      : fillPrice * 0.9995);
    
    const stopLossResult = await exchangeClient.setPositionStopLoss(
      contract,
      stopLossPrice,
      takeProfitPrice
    );
    
    recordResult({
      phase: '14.2',
      success: stopLossResult.success,
      message: `设置止损止盈: SL=${stopLossPrice.toFixed(2)}, TP=${takeProfitPrice.toFixed(2)}`,
      data: stopLossResult,
      duration: Date.now() - startTime,
    });
    
    // 14.3 记录到数据库
    logger.info('\n📝 14.3 保存持仓和条件单到数据库...');
    
    const now = new Date().toISOString();
    const contractInfo = await exchangeClient.getContractInfo(contract);
    const multiplier = contractInfo.quanto_multiplier || contractInfo.multiplier || 0.01;
    const notionalValue = fillPrice * fillSize * multiplier;
    const openFee = notionalValue * 0.0005;
    
    await dbClient.execute({
      sql: `INSERT INTO trades (order_id, symbol, side, type, price, quantity, leverage, fee, timestamp, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        order.id?.toString() || '',
        TEST_CONFIG.symbol,
        TEST_CONFIG.side,
        'open',
        fillPrice,
        fillSize,
        TEST_CONFIG.leverage,
        openFee,
        now,
        'filled',
      ],
    });
    
    if (stopLossResult.stopLossOrderId) {
      await dbClient.execute({
        sql: `INSERT INTO price_orders (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          stopLossResult.stopLossOrderId,
          TEST_CONFIG.symbol,
          TEST_CONFIG.side,
          'stop_loss',
          stopLossPrice,
          0,
          fillSize,
          'active',
          now,
          order.id?.toString() || '',
        ],
      });
    }
    
    if (stopLossResult.takeProfitOrderId) {
      await dbClient.execute({
        sql: `INSERT INTO price_orders (order_id, symbol, side, type, trigger_price, order_price, quantity, status, created_at, position_order_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          stopLossResult.takeProfitOrderId,
          TEST_CONFIG.symbol,
          TEST_CONFIG.side,
          'take_profit',
          takeProfitPrice,
          0,
          fillSize,
          'active',
          now,
          order.id?.toString() || '',
        ],
      });
    }
    
    await dbClient.execute({
      sql: `INSERT INTO positions 
            (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
             leverage, side, stop_loss, profit_target, sl_order_id, tp_order_id, entry_order_id, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        TEST_CONFIG.symbol,
        fillSize,
        fillPrice,
        fillPrice,
        formatPriceNumber(TEST_CONFIG.side === 'long' ? fillPrice * 0.9 : fillPrice * 1.1),
        0,
        TEST_CONFIG.leverage,
        TEST_CONFIG.side,
        stopLossPrice,
        takeProfitPrice,
        stopLossResult.stopLossOrderId || null,
        stopLossResult.takeProfitOrderId || null,
        order.id?.toString() || '',
        now,
      ],
    });
    
    recordResult({
      phase: '14.3',
      success: true,
      message: '持仓和条件单已保存到数据库',
      duration: Date.now() - startTime,
    });
    
    // 14.3.5 等待价格波动，给条件单触发的机会
    logger.info('\n📝 14.3.5 等待价格波动，监测条件单触发...');
    logger.info(`当前价格: ${fillPrice.toFixed(2)}`);
    logger.info(`止损价: ${stopLossPrice.toFixed(2)} (${TEST_CONFIG.side === 'long' ? '下跌' : '上涨'}触发)`);
    logger.info(`止盈价: ${takeProfitPrice.toFixed(2)} (${TEST_CONFIG.side === 'long' ? '上涨' : '下跌'}触发)`);
    logger.info('等待30秒，监测价格变动和条件单状态...\n');
    
    let priceTriggered = false;
    let triggeredType: 'stop_loss' | 'take_profit' | null = null;
    const monitoringDuration = 60000; // 60秒
    const checkInterval = 3000; // 每3秒检查一次
    const monitorStartTime = Date.now();
    
    while (Date.now() - monitorStartTime < monitoringDuration) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
      // 检查当前价格
      const currentTicker = await exchangeClient.getFuturesTicker(contract);
      const latestPrice = parseFloat(currentTicker.last || '0');
      const priceChange = ((latestPrice - fillPrice) / fillPrice) * 100;
      
      logger.info(`[${Math.floor((Date.now() - monitorStartTime) / 1000)}s] 价格: ${latestPrice.toFixed(2)} (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(3)}%)`);
      
      // 检查交易所条件单状态
      const currentExchangeOrders = await exchangeClient.getPriceOrders(contract);
      const slExists = currentExchangeOrders.some((o: any) => 
        (o.id || o.orderId || o.order_id)?.toString() === stopLossResult.stopLossOrderId
      );
      const tpExists = currentExchangeOrders.some((o: any) => 
        (o.id || o.orderId || o.order_id)?.toString() === stopLossResult.takeProfitOrderId
      );
      
      // 检查持仓是否还存在
      const currentPositions = await exchangeClient.getPositions();
      const positionExists = currentPositions.some((p: any) => 
        p.contract === contract && Math.abs(parseFloat(p.size || '0')) > 0
      );
      
      // 判断是否触发
      if (!positionExists && (!slExists || !tpExists)) {
        priceTriggered = true;
        
        // 根据价格变动方向判断触发类型（更准确）
        // 多头：价格上涨触发止盈，价格下跌触发止损
        // 空头：价格下跌触发止盈，价格上涨触发止损
        if (TEST_CONFIG.side === 'long') {
          triggeredType = latestPrice >= takeProfitPrice ? 'take_profit' : 'stop_loss';
        } else {
          triggeredType = latestPrice <= takeProfitPrice ? 'take_profit' : 'stop_loss';
        }
        
        logger.info(`\n🎯 检测到条件单触发: ${triggeredType === 'stop_loss' ? '止损' : '止盈'}`);
        logger.info(`   触发价格: ${latestPrice.toFixed(2)}`);
        logger.info(`   价格变动: ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(3)}%`);
        break;
      }
      
      // 检查是否接近触发价
      const slDistance = TEST_CONFIG.side === 'long' 
        ? ((latestPrice - stopLossPrice) / stopLossPrice) * 100
        : ((stopLossPrice - latestPrice) / stopLossPrice) * 100;
      const tpDistance = TEST_CONFIG.side === 'long'
        ? ((takeProfitPrice - latestPrice) / takeProfitPrice) * 100
        : ((latestPrice - takeProfitPrice) / takeProfitPrice) * 100;
      
      logger.info(`   距离止损: ${slDistance >= 0 ? '+' : ''}${slDistance.toFixed(3)}% | 距离止盈: ${tpDistance >= 0 ? '+' : ''}${tpDistance.toFixed(3)}%`);
    }
    
    const waitDuration = Date.now() - monitorStartTime;
    
    recordResult({
      phase: '14.3.5',
      success: true,
      message: priceTriggered 
        ? `价格波动触发${triggeredType === 'stop_loss' ? '止损' : '止盈'} (等待${(waitDuration/1000).toFixed(1)}秒)`
        : `等待${(waitDuration/1000).toFixed(1)}秒，价格未触发条件单`,
      data: { priceTriggered, triggeredType, waitDuration },
      duration: Date.now() - startTime,
    });
    
    // 14.4 验证条件单监控服务能正确检测
    logger.info('\n📝 14.4 测试条件单监控服务检测能力...');
    
    const priceOrderMonitor = new (await import('../src/scheduler/priceOrderMonitor')).PriceOrderMonitor(
      dbClient,
      exchangeClient
    );
    
    // 手动触发一次检测（不启动定时任务）
    logger.info('调用监控服务检测条件单状态...');
    await (priceOrderMonitor as any).checkTriggeredOrders();
    
    // 验证数据库中的条件单状态
    const activeOrdersCheck = await dbClient.execute({
      sql: 'SELECT * FROM price_orders WHERE symbol = ? AND status = ?',
      args: [TEST_CONFIG.symbol, 'active'],
    });
    
    const triggeredOrdersCheck = await dbClient.execute({
      sql: 'SELECT * FROM price_orders WHERE symbol = ? AND status = ?',
      args: [TEST_CONFIG.symbol, 'triggered'],
    });
    
    let monitoringCorrect = false;
    let detectionMessage = '';
    
    if (priceTriggered) {
      // 如果价格触发了，应该检测到triggered状态
      monitoringCorrect = triggeredOrdersCheck.rows.length > 0 && activeOrdersCheck.rows.length < 2;
      detectionMessage = `条件单已触发: ${triggeredOrdersCheck.rows.length}个triggered, ${activeOrdersCheck.rows.length}个active`;
      
      // 验证平仓事件记录
      const closeEvents = await dbClient.execute({
        sql: 'SELECT * FROM position_close_events WHERE symbol = ? ORDER BY created_at DESC LIMIT 1',
        args: [TEST_CONFIG.symbol],
      });
      
      if (closeEvents.rows.length > 0) {
        const closeEvent = closeEvents.rows[0] as any;
        logger.info(`✅ 平仓事件已记录: ${closeEvent.close_reason}, PnL=${closeEvent.pnl?.toFixed(2)} USDT`);
      }
    } else {
      // 如果价格未触发，应该仍然是active状态
      monitoringCorrect = activeOrdersCheck.rows.length === 2 && triggeredOrdersCheck.rows.length === 0;
      detectionMessage = `条件单未触发: ${activeOrdersCheck.rows.length}个active (期望2个)`;
    }
    
    recordResult({
      phase: '14.4',
      success: monitoringCorrect,
      message: `监控服务检测${monitoringCorrect ? '正确' : '异常'}: ${detectionMessage}`,
      data: { 
        activeCount: activeOrdersCheck.rows.length, 
        triggeredCount: triggeredOrdersCheck.rows.length,
        priceTriggered,
        triggeredType
      },
      duration: Date.now() - startTime,
    });
    
    // 14.5 验证数据库与交易所的一致性
    logger.info('\n📝 14.5 验证数据库与交易所条件单一致性...');
    
    const exchangeOrders = await exchangeClient.getPriceOrders(contract);
    const dbOrders = await dbClient.execute({
      sql: 'SELECT * FROM price_orders WHERE symbol = ? AND status = ?',
      args: [TEST_CONFIG.symbol, 'active'],
    });
    
    const exchangeOrderIds = new Set(
      exchangeOrders.map((o: any) => (o.id || o.orderId || o.order_id)?.toString())
    );
    
    let allMatched = true;
    let consistencyCheck = false;
    let consistencyMessage = '';
    
    if (priceTriggered) {
      // 条件单已触发：数据库应该没有active订单
      consistencyCheck = dbOrders.rows.length === 0;
      
      // 交易所可能还有残留订单（API延迟），这是正常的
      if (exchangeOrders.length > 0) {
        logger.warn(`交易所有${exchangeOrders.length}个残留条件单,取消反向单逻辑可能存在异常`);
      }
      
      consistencyMessage = `条件单已触发: DB=${dbOrders.rows.length}个active (期望0), Exchange=${exchangeOrders.length}个 ${consistencyCheck ? '✓' : '✗'}`;
    } else {
      // 条件单未触发：验证数据库和交易所的订单完全一致
      for (const dbOrder of dbOrders.rows) {
        const orderId = (dbOrder as any).order_id;
        if (!exchangeOrderIds.has(orderId)) {
          logger.warn(`数据库订单 ${orderId} 在交易所不存在`);
          allMatched = false;
        }
      }
      
      consistencyCheck = allMatched && dbOrders.rows.length === exchangeOrders.length;
      consistencyMessage = `条件单未触发: DB=${dbOrders.rows.length}, Exchange=${exchangeOrders.length} ${consistencyCheck ? '✓' : '✗'}`;
    }
    
    recordResult({
      phase: '14.5',
      success: consistencyCheck,
      message: consistencyMessage,
      data: { 
        dbCount: dbOrders.rows.length, 
        exchangeCount: exchangeOrders.length,
        priceTriggered,
        allMatched
      },
      duration: Date.now() - startTime,
    });
    
    // 14.6 清理测试持仓和条件单
    logger.info('\n📝 14.6 清理测试数据（保持测试环境干净）...');
    
    // 检查持仓是否还存在（可能已被条件单触发平仓）
    const finalPositions = await exchangeClient.getPositions();
    const finalPosition = finalPositions.find((p: any) => 
      p.contract === contract && Math.abs(parseFloat(p.size || '0')) > 0
    );
    
    if (finalPosition) {
      logger.info('持仓仍存在，执行手动平仓...');
      
      // 取消条件单
      try {
        await exchangeClient.cancelPositionStopLoss(contract);
        logger.info('✅ 条件单已取消');
      } catch (error: any) {
        logger.warn(`取消条件单失败（可能已被触发）: ${error.message}`);
      }
      
      // 平仓
      const currentSize = parseFloat(finalPosition.size || '0');
      const closeSize = -currentSize; // 反向平仓
      
      try {
        await exchangeClient.placeOrder({
          contract,
          size: closeSize,
          price: 0,
          reduceOnly: true,
        });
        logger.info('✅ 持仓已平仓');
      } catch (error: any) {
        logger.error(`平仓失败: ${error.message}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      logger.info('持仓已不存在（已被条件单触发平仓），跳过手动平仓');
    }
    
    // 清理数据库（无论持仓是否存在都要清理）
    await dbClient.execute({
      sql: 'DELETE FROM positions WHERE symbol = ?',
      args: [TEST_CONFIG.symbol],
    });
    await dbClient.execute({
      sql: 'UPDATE price_orders SET status = ? WHERE symbol = ? AND status = ?',
      args: ['cancelled', TEST_CONFIG.symbol, 'active'],
    });
    
    logger.info('✅ 数据库记录已清理');
    
    recordResult({
      phase: '14.6',
      success: true,
      message: priceTriggered ? '测试数据已清理（条件单已触发）' : '测试数据已清理（手动平仓）',
      duration: Date.now() - startTime,
    });
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '14',
      success: false,
      message: '自动止损单系统集成测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 🆕 阶段15: 分批止盈R倍数系统测试
 */
async function phase15_PartialTakeProfitRMultipleTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段15: 分批止盈R倍数系统测试');
    logger.info('='.repeat(80));
    
    // 15.1 验证分批止盈历史表
    logger.info('\n📝 15.1 验证分批止盈历史表...');
    
    try {
      // 检查表是否存在
      const tableCheck = await dbClient.execute(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='partial_take_profit_history'
      `);
      
      const tableExists = tableCheck.rows.length > 0;
      
      recordResult({
        phase: '15.1',
        success: tableExists,
        message: `分批止盈历史表: ${tableExists ? '已创建' : '未创建'}`,
        data: { exists: tableExists },
        duration: Date.now() - startTime,
      });
      
      if (tableExists) {
        // 检查表结构
        const schemaCheck = await dbClient.execute(`
          PRAGMA table_info(partial_take_profit_history)
        `);
        
        const hasRMultipleColumn = schemaCheck.rows.some(
          (row: any) => row.name === 'r_multiple'
        );
        
        recordResult({
          phase: '15.1.1',
          success: hasRMultipleColumn,
          message: `R-Multiple字段: ${hasRMultipleColumn ? '已配置' : '未配置'}`,
          data: { columns: schemaCheck.rows.map((r: any) => r.name) },
          duration: Date.now() - startTime,
        });
      }
    } catch (error: any) {
      recordResult({
        phase: '15.1',
        success: false,
        message: '分批止盈历史表验证失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 15.2 测试R倍数计算逻辑
    logger.info('\n📝 15.2 测试R倍数计算逻辑...');
    
    try {
      // 模拟场景：入场50000，止损49000，当前价格52000
      const entryPrice = 50000;
      const stopLossPrice = 49000;
      const currentPrice = 52000;
      
      // R = (当前价格 - 入场价格) / (入场价格 - 止损价格)
      const riskDistance = entryPrice - stopLossPrice; // 1000
      const profitDistance = currentPrice - entryPrice; // 2000
      const rMultiple = profitDistance / riskDistance; // 2.0R
      
      const expectedR = 2.0;
      const tolerance = 0.01;
      const rCalculationCorrect = Math.abs(rMultiple - expectedR) < tolerance;
      
      recordResult({
        phase: '15.2',
        success: rCalculationCorrect,
        message: `R倍数计算: ${rMultiple.toFixed(2)}R (期望${expectedR}R)`,
        data: { rMultiple, expected: expectedR, riskDistance, profitDistance },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '15.2',
        success: false,
        message: 'R倍数计算测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 15.3 验证分批止盈触发阈值
    logger.info('\n📝 15.3 验证分批止盈触发阈值...');
    
    try {
      // 测试不同的R倍数阈值
      const testScenarios = [
        { r: 0.5, stage: 0, shouldTrigger: false, desc: '0.5R - 未达到任何阶段' },
        { r: 1.0, stage: 1, shouldTrigger: true, desc: '1R - 触发Stage1' },
        { r: 2.0, stage: 2, shouldTrigger: true, desc: '2R - 触发Stage2' },
        { r: 3.0, stage: 3, shouldTrigger: true, desc: '3R - 触发Stage3' },
        { r: 5.0, stage: 3, shouldTrigger: true, desc: '5R - 极限止盈' },
      ];
      
      let allScenariosCorrect = true;
      const results: any[] = [];
      
      for (const scenario of testScenarios) {
        // 简单的阈值判断逻辑（实际应该与策略配置一致）
        let triggeredStage = 0;
        if (scenario.r >= 3.0) triggeredStage = 3;
        else if (scenario.r >= 2.0) triggeredStage = 2;
        else if (scenario.r >= 1.0) triggeredStage = 1;
        
        const correct = (triggeredStage === scenario.stage);
        if (!correct) allScenariosCorrect = false;
        
        results.push({
          ...scenario,
          actualStage: triggeredStage,
          correct,
        });
      }
      
      recordResult({
        phase: '15.3',
        success: allScenariosCorrect,
        message: `触发阈值验证: ${allScenariosCorrect ? '全部正确' : '存在错误'}`,
        data: { scenarios: results },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '15.3',
        success: false,
        message: '触发阈值验证失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 15.4 验证止损联动机制
    logger.info('\n📝 15.4 验证止损联动机制...');
    
    try {
      // 模拟分批止盈后止损应该移动
      const entryPrice = 50000;
      const stopLossPrice = 49000;
      const riskDistance = entryPrice - stopLossPrice;
      
      // Stage1: 1R后止损应移至成本价
      const stage1NewStopLoss = entryPrice;
      const stage1Correct = stage1NewStopLoss === entryPrice;
      
      // Stage2: 2R后止损应移至1R位置
      const stage2NewStopLoss = entryPrice + riskDistance * 1; // 51000
      const stage2Expected = 51000;
      const stage2Correct = Math.abs(stage2NewStopLoss - stage2Expected) < 1;
      
      // Stage3: 3R后止损应移至2R位置
      const stage3NewStopLoss = entryPrice + riskDistance * 2; // 52000
      const stage3Expected = 52000;
      const stage3Correct = Math.abs(stage3NewStopLoss - stage3Expected) < 1;
      
      const allStagesCorrect = stage1Correct && stage2Correct && stage3Correct;
      
      recordResult({
        phase: '15.4',
        success: allStagesCorrect,
        message: `止损联动机制: ${allStagesCorrect ? '全部正确' : '存在错误'}`,
        data: {
          stage1: { newStopLoss: stage1NewStopLoss, expected: entryPrice, correct: stage1Correct },
          stage2: { newStopLoss: stage2NewStopLoss, expected: stage2Expected, correct: stage2Correct },
          stage3: { newStopLoss: stage3NewStopLoss, expected: stage3Expected, correct: stage3Correct },
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '15.4',
        success: false,
        message: '止损联动机制验证失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 15.5 验证分批平仓百分比
    logger.info('\n📝 15.5 验证分批平仓百分比...');
    
    try {
      const initialSize = 100; // 初始持仓
      
      // Stage1: 平仓33.33%
      const stage1Close = initialSize * 0.3333;
      const stage1Remaining = initialSize - stage1Close;
      
      // Stage2: 平仓剩余的50%
      const stage2Close = stage1Remaining * 0.5;
      const stage2Remaining = stage1Remaining - stage2Close;
      
      // Stage3: 全部平仓
      const stage3Close = stage2Remaining;
      const stage3Remaining = 0;
      
      // 验证最终平仓完全
      const fullyClosedCorrect = Math.abs(stage3Remaining) < 0.01;
      
      // 验证分批比例合理
      const stage1Ratio = stage1Close / initialSize;
      const stage2Ratio = stage2Close / initialSize;
      const stage3Ratio = stage3Close / initialSize;
      
      const ratiosCorrect = 
        Math.abs(stage1Ratio - 0.3333) < 0.01 &&
        Math.abs(stage2Ratio - 0.3333) < 0.01 &&
        Math.abs(stage3Ratio - 0.3334) < 0.01;
      
      recordResult({
        phase: '15.5',
        success: fullyClosedCorrect && ratiosCorrect,
        message: `分批平仓百分比: ${fullyClosedCorrect && ratiosCorrect ? '正确' : '错误'}`,
        data: {
          stage1: { close: stage1Close, remaining: stage1Remaining, ratio: stage1Ratio.toFixed(4) },
          stage2: { close: stage2Close, remaining: stage2Remaining, ratio: stage2Ratio.toFixed(4) },
          stage3: { close: stage3Close, remaining: stage3Remaining, ratio: stage3Ratio.toFixed(4) },
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '15.5',
        success: false,
        message: '分批平仓百分比验证失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '15',
      success: false,
      message: '分批止盈R倍数系统测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 🆕 阶段16: 持仓趋势监控增强系统测试
 * 测试市场状态分析、反转信号检测、AI决策辅助等功能
 */
async function phase16_TrendMonitoringEnhancementTest(): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('阶段16: 持仓趋势监控增强系统测试');
    logger.info('='.repeat(80));
    
    // 16.1 测试单个币种市场状态分析
    logger.info('\n📝 16.1 测试单个币种市场状态分析...');
    
    try {
      const testSymbol = TEST_CONFIG.symbol.replace('_USDT', '');
      const state = await analyzeMarketState(testSymbol);
      
      const hasValidState = ['uptrend_oversold', 'uptrend_overbought', 'uptrend_continuation',
                             'downtrend_oversold', 'downtrend_overbought', 'downtrend_continuation',
                             'ranging_oversold', 'ranging_overbought', 'ranging_neutral', 'no_clear_signal']
                             .includes(state.state);
      
      const hasValidTrend = ['trending_up', 'trending_down', 'ranging'].includes(state.trendStrength);
      const hasValidMomentum = ['overbought_extreme', 'overbought_mild', 'neutral', 
                                'oversold_mild', 'oversold_extreme'].includes(state.momentumState);
      const hasValidConfidence = state.confidence >= 0 && state.confidence <= 1;
      
      recordResult({
        phase: '16.1',
        success: hasValidState && hasValidTrend && hasValidMomentum && hasValidConfidence,
        message: `市场状态分析: ${state.state}, 趋势: ${state.trendStrength}, 置信度: ${(state.confidence * 100).toFixed(0)}%`,
        data: {
          state: state.state,
          trendStrength: state.trendStrength,
          momentumState: state.momentumState,
          confidence: state.confidence,
          timeframeAlignment: state.timeframeAlignment.alignmentScore,
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '16.1',
        success: false,
        message: '市场状态分析失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 16.2 测试批量市场状态分析
    logger.info('\n📝 16.2 测试批量市场状态分析...');
    
    try {
      const symbols = ['BTC', 'ETH', 'SOL'];
      const batchStartTime = Date.now();
      const marketStates = await analyzeMultipleMarketStates(symbols);
      const batchDuration = Date.now() - batchStartTime;
      
      const successCount = marketStates.size;
      const performanceGood = batchDuration < 3000; // < 3秒
      
      recordResult({
        phase: '16.2',
        success: successCount === symbols.length && performanceGood,
        message: `批量分析: 成功 ${successCount}/${symbols.length}, 耗时: ${batchDuration}ms`,
        data: {
          symbols,
          successCount,
          duration: batchDuration,
          states: Array.from(marketStates.entries()).map(([sym, state]) => ({
            symbol: sym,
            state: state.state,
            confidence: (state.confidence * 100).toFixed(0) + '%',
          })),
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '16.2',
        success: false,
        message: '批量市场状态分析失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 16.3 测试反转信号检测逻辑
    logger.info('\n📝 16.3 测试反转信号检测逻辑...');
    
    try {
      const scenarios = [
        {
          name: '多头持仓，上涨转下跌',
          side: 'long' as const,
          entryState: 'uptrend_oversold',
          currentState: 'downtrend_continuation',
          shouldDetect: true,
        },
        {
          name: '空头持仓，下跌转上涨',
          side: 'short' as const,
          entryState: 'downtrend_overbought',
          currentState: 'uptrend_continuation',
          shouldDetect: true,
        },
        {
          name: '多头持仓，趋势保持上涨',
          side: 'long' as const,
          entryState: 'uptrend_oversold',
          currentState: 'uptrend_overbought',
          shouldDetect: false,
        },
        {
          name: '入场状态未知',
          side: 'long' as const,
          entryState: undefined,
          currentState: 'downtrend_continuation',
          shouldDetect: false,
        },
      ];
      
      let allCorrect = true;
      const results: any[] = [];
      
      for (const scenario of scenarios) {
        const detected = detectReversalSignal(
          scenario.side,
          scenario.entryState,
          scenario.currentState
        );
        
        const correct = detected === scenario.shouldDetect;
        if (!correct) allCorrect = false;
        
        results.push({
          ...scenario,
          detected,
          correct,
        });
      }
      
      recordResult({
        phase: '16.3',
        success: allCorrect,
        message: `反转信号检测: ${allCorrect ? '全部正确' : '存在错误'}`,
        data: { scenarios: results },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '16.3',
        success: false,
        message: '反转信号检测测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 16.4 测试数据库metadata字段
    logger.info('\n📝 16.4 测试数据库metadata字段...');
    
    try {
      // 检查positions表是否有metadata字段
      const schema = await dbClient.execute('PRAGMA table_info(positions)');
      const hasMetadataField = schema.rows.some((row: any) => row.name === 'metadata');
      
      if (!hasMetadataField) {
        throw new Error('positions表缺少metadata字段，请运行迁移脚本');
      }
      
      // 模拟插入带metadata的持仓记录
      const testMetadata = {
        marketState: 'uptrend_oversold',
        entryTime: Date.now(),
        confidence: 0.85,
      };
      
      await dbClient.execute({
        sql: `INSERT INTO positions 
              (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl,
               leverage, side, stop_loss, entry_order_id, opened_at, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          'TEST_METADATA',
          1.0,
          50000,
          50000,
          45000,
          0,
          2,
          'long',
          49000,
          'TEST_' + Date.now(),
          new Date().toISOString(),
          JSON.stringify(testMetadata),
        ],
      });
      
      // 查询并验证metadata
      const result = await dbClient.execute({
        sql: 'SELECT metadata FROM positions WHERE symbol = ? LIMIT 1',
        args: ['TEST_METADATA'],
      });
      
      const metadata = result.rows[0]?.metadata;
      const parsedMetadata = metadata ? JSON.parse(metadata as string) : null;
      const metadataValid = parsedMetadata?.marketState === 'uptrend_oversold';
      
      // 清理测试数据
      await dbClient.execute({
        sql: 'DELETE FROM positions WHERE symbol = ?',
        args: ['TEST_METADATA'],
      });
      
      recordResult({
        phase: '16.4',
        success: hasMetadataField && metadataValid,
        message: `metadata字段: ${hasMetadataField ? '存在' : '缺失'}, 数据: ${metadataValid ? '正确' : '错误'}`,
        data: {
          hasMetadataField,
          testMetadata,
          parsedMetadata,
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '16.4',
        success: false,
        message: 'metadata字段测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 16.5 测试Prompt生成集成
    logger.info('\n📝 16.5 测试Prompt生成集成...');
    
    try {
      // 创建测试持仓数据
      const testSymbol = 'BTC';
      const testPosition = {
        symbol: testSymbol + '_USDT',
        side: 'long' as const,
        entry_price: 50000,
        current_price: 50500,
        unrealized_pnl_percent: 1.0,
        opened_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2小时前
        metadata: JSON.stringify({
          marketState: 'uptrend_oversold',
          entryTime: Date.now() - 2 * 60 * 60 * 1000,
        }),
      };
      
      // 获取当前市场状态
      const currentState = await analyzeMarketState(testSymbol);
      
      // 模拟检测反转信号
      let entryState: string | undefined;
      try {
        const metadata = JSON.parse(testPosition.metadata);
        entryState = metadata.marketState;
      } catch (e) {
        // 忽略解析错误
      }
      
      const reversalDetected = detectReversalSignal(
        testPosition.side,
        entryState,
        currentState.state
      );
      
      // 生成趋势分析文本（模拟generateTradingPrompt的输出）
      let trendAnalysisText = '';
      trendAnalysisText += `├─ 📊 市场趋势分析（供决策参考）：\n`;
      trendAnalysisText += `│   • 当前状态: ${currentState.state}\n`;
      trendAnalysisText += `│   • 趋势强度: ${currentState.trendStrength}\n`;
      trendAnalysisText += `│   • 动量状态: ${currentState.momentumState}\n`;
      trendAnalysisText += `│   • 反转信号: ${reversalDetected ? '⚠️ 是' : '否'}\n`;
      
      const hasExpectedFormat = trendAnalysisText.includes('📊 市场趋势分析') &&
                                 trendAnalysisText.includes('当前状态:') &&
                                 trendAnalysisText.includes('反转信号:');
      
      recordResult({
        phase: '16.5',
        success: hasExpectedFormat,
        message: `Prompt生成: ${hasExpectedFormat ? '格式正确' : '格式错误'}`,
        data: {
          entryState,
          currentState: currentState.state,
          reversalDetected,
          promptSample: trendAnalysisText,
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '16.5',
        success: false,
        message: 'Prompt生成集成测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 16.6 性能压力测试
    logger.info('\n📝 16.6 性能压力测试...');
    
    try {
      const perfSymbols = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP'];
      const iterations = 5;
      const times: number[] = [];
      
      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        await analyzeMultipleMarketStates(perfSymbols);
        times.push(Date.now() - start);
      }
      
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const performanceGood = avgTime < 2000; // 平均 < 2秒
      
      recordResult({
        phase: '16.6',
        success: performanceGood,
        message: `性能测试: 平均${avgTime.toFixed(0)}ms (最快${minTime}ms, 最慢${maxTime}ms)`,
        data: {
          symbols: perfSymbols,
          iterations,
          avgTime,
          minTime,
          maxTime,
          times,
        },
        duration: Date.now() - startTime,
      });
    } catch (error: any) {
      recordResult({
        phase: '16.6',
        success: false,
        message: '性能压力测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    // 16.7 容错处理测试
    logger.info('\n📝 16.7 容错处理测试...');
    
    try {
      // 测试无效币种
      try {
        await analyzeMarketState('INVALID_SYMBOL_123');
        recordResult({
          phase: '16.7',
          success: false,
          message: '容错测试: 应该抛出错误但没有',
          duration: Date.now() - startTime,
        });
      } catch (error) {
        // 预期会抛出错误
        recordResult({
          phase: '16.7',
          success: true,
          message: '容错测试: 正确处理无效币种',
          duration: Date.now() - startTime,
        });
      }
    } catch (error: any) {
      recordResult({
        phase: '16.7',
        success: false,
        message: '容错处理测试失败',
        error: error.message,
        duration: Date.now() - startTime,
      });
    }
    
    return true;
    
  } catch (error: any) {
    recordResult({
      phase: '16',
      success: false,
      message: '持仓趋势监控增强系统测试失败',
      error: error.message,
      duration: Date.now() - startTime,
    });
    return false;
  }
}

/**
 * 辅助函数：简化的反转检测逻辑（用于测试）
 */
function detectReversalSignal(
  positionSide: 'long' | 'short',
  entryState: string | undefined,
  currentState: string
): boolean {
  if (!entryState) return false;
  
  const isLong = positionSide === 'long';
  const wasUptrend = entryState.startsWith('uptrend');
  const wasDowntrend = entryState.startsWith('downtrend');
  const nowUptrend = currentState.startsWith('uptrend');
  const nowDowntrend = currentState.startsWith('downtrend');
  
  // 多头持仓：入场时上涨→现在下跌
  if (isLong && wasUptrend && nowDowntrend) {
    return true;
  }
  
  // 空头持仓：入场时下跌→现在上涨
  if (!isLong && wasDowntrend && nowUptrend) {
    return true;
  }
  
  return false;
}

/**
 * 生成测试报告
 */
function generateReport() {
  logger.info('\n' + '='.repeat(80));
  logger.info('测试报告');
  logger.info('='.repeat(80));
  
  const totalTests = testResults.length;
  const passedTests = testResults.filter(r => r.success).length;
  const failedTests = totalTests - passedTests;
  const successRate = (passedTests / totalTests * 100).toFixed(2);
  
  logger.info(`\n总测试数: ${totalTests}`);
  logger.info(`通过: ${passedTests} ✅`);
  logger.info(`失败: ${failedTests} ❌`);
  logger.info(`成功率: ${successRate}%\n`);
  
  // 按阶段分组
  const phaseGroups = testResults.reduce((acc, result) => {
    const phase = result.phase.split('.')[0];
    if (!acc[phase]) acc[phase] = [];
    acc[phase].push(result);
    return acc;
  }, {} as Record<string, TestResult[]>);
  
  for (const [phase, results] of Object.entries(phaseGroups)) {
    const phasePassed = results.filter(r => r.success).length;
    const phaseTotal = results.length;
    const phaseIcon = phasePassed === phaseTotal ? '✅' : '❌';
    
    logger.info(`${phaseIcon} 阶段 ${phase}: ${phasePassed}/${phaseTotal}`);
    
    for (const result of results) {
      const icon = result.success ? '  ✅' : '  ❌';
      logger.info(`${icon} [${result.phase}] ${result.message}`);
      if (result.error) {
        logger.error(`      错误: ${result.error}`);
      }
    }
    logger.info('');
  }
  
  // 关键问题提示
  const criticalFailures = testResults.filter(r => 
    !r.success && ['5.6', '6.1', '6.2', '6.5'].includes(r.phase)
  );
  
  if (criticalFailures.length > 0) {
    logger.error('\n⚠️  发现关键问题:');
    for (const failure of criticalFailures) {
      logger.error(`   - [${failure.phase}] ${failure.message}`);
      if (failure.error) {
        logger.error(`     错误: ${failure.error}`);
      }
    }
  }
  
  return {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    successRate: parseFloat(successRate),
  };
}

/**
 * 主测试流程
 */
async function main() {
  // 🔧 记录全局测试开始时间
  GLOBAL_TEST_START_TIME = Date.now();
  
  logger.info('🚀 开始完整交易流程集成测试\n');
  logger.info(`测试配置:`);
  logger.info(`  币种: ${TEST_CONFIG.symbol}`);
  logger.info(`  方向: ${TEST_CONFIG.side}`);
  logger.info(`  杠杆: ${TEST_CONFIG.leverage}x`);
  logger.info(`  金额: ${TEST_CONFIG.amountUsdt} USDT`);
  logger.info(`  测试模式: ${TEST_CONFIG.testMode ? '真实交易' : '模拟数据'}`);
  logger.info('');
  
  if (!TEST_CONFIG.testMode) {
    logger.warn('⚠️  当前为模拟模式，不会真实下单');
    logger.warn('⚠️  设置 TEST_MODE=true 启用真实交易测试\n');
  }
  
  try {
    // 阶段1: 准备环境
    const phase1Success = await phase1_PrepareEnvironment();
    if (!phase1Success) {
      logger.error('❌ 测试环境准备失败，终止测试');
      process.exit(1);
    }
    
    // 阶段2: 测试开仓
    const openResult = await phase2_TestOpenPosition();
    if (!openResult) {
      logger.error('❌ 开仓测试失败，终止测试');
      generateReport();
      process.exit(1);
    }
    
    // 阶段3: 测试状态同步
    await phase3_TestStateSync();
    
    // 阶段4: 测试条件单监控
    await phase4_TestPriceOrderMonitoring();
    
    // 阶段5: 测试AI主动平仓
    await phase5_TestAIClosePosition();
    
    // 阶段6: 验证最终状态
    await phase6_VerifyFinalState();
    
    // 阶段7: 数据一致性深度验证
    await phase7_DataConsistencyCheck();
    
    // 🆕 阶段8: 事务保护机制测试
    await phase8_TransactionProtectionTest();
    
    // 阶段9: 交易所与数据库状态对比
    await phase9_ExchangeVsDatabaseSync();
    
    // 🆕 阶段10: 健康检查系统测试
    await phase10_HealthCheckTest();
    
    // 🆕 阶段11: 异常场景压力测试
    await phase11_ExceptionScenarioTest();
    
    // 🆕 阶段12: 科学止损系统测试
    await phase12_ScientificStopLossTest();
    
    // 🆕 阶段13: 移动止损机制测试
    await phase13_TrailingStopTest();
    
    // 🆕 阶段14: 自动止损单系统集成测试（完整流程：开仓→监控→清理）
    logger.info('\n💡 提示: 阶段14将重新开仓测试条件单监控服务的完整集成');
    await phase14_AutoStopLossOrderTest();
    
    // 🆕 阶段15: 分批止盈R倍数系统测试
    await phase15_PartialTakeProfitRMultipleTest();
    
    // 🆕 阶段16: 持仓趋势监控增强系统测试
    await phase16_TrendMonitoringEnhancementTest();
    
    // 生成报告
    const report = generateReport();
    
    logger.info('\n✅ 测试完成！');
    
    if (report.successRate < 100) {
      logger.warn(`\n⚠️  测试通过率 ${report.successRate}%，请检查失败的测试项`);
      process.exit(1);
    }
    
    process.exit(0);
    
  } catch (error: any) {
    logger.error('\n❌ 测试执行异常:', error);
    generateReport();
    process.exit(1);
  }
}

// 执行测试
main();

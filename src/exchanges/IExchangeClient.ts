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
 * 统一交易所接口
 * 定义所有交易所客户端必须实现的方法
 */

/**
 * 交易所配置
 */
export interface ExchangeConfig {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  exchangeName: 'gate' | 'binance';
}

/**
 * Ticker 价格信息
 */
export interface TickerInfo {
  contract: string;
  last: string;
  markPrice: string;
  indexPrice?: string;
  volume24h?: string;
  high24h?: string;
  low24h?: string;
  change24h?: string;
}

/**
 * K线数据
 */
export interface CandleData {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * 账户信息
 */
export interface AccountInfo {
  currency: string;
  total: string;
  available: string;
  positionMargin: string;
  orderMargin: string;
  unrealisedPnl: string;
}

/**
 * 持仓信息
 */
export interface PositionInfo {
  contract: string;
  size: string;
  leverage: string;
  entryPrice: string;
  markPrice: string;
  liqPrice: string;
  unrealisedPnl: string;
  realisedPnl: string;
  margin: string;
}

/**
 * 订单参数
 */
export interface OrderParams {
  contract: string;
  size: number;
  price?: number;
  tif?: string;
  reduceOnly?: boolean;
  autoSize?: string;
  stopLoss?: number;
  takeProfit?: number;
}

/**
 * 订单响应
 */
export interface OrderResponse {
  id: string;
  contract: string;
  size: number;
  price: string;
  status: string;
  [key: string]: any;
}

/**
 * 合约信息
 */
export interface ContractInfo {
  name: string;
  quantoMultiplier: string;
  orderSizeMin: number;
  orderSizeMax: number;
  orderPriceDeviate?: string;
  orderPriceRound?: string;  // 价格步长（如 "0.1" 表示价格必须是0.1的整数倍）
  markPriceRound?: string;   // 标记价格精度
  [key: string]: any;
}

/**
 * 交易记录
 */
export interface TradeRecord {
  id: string;
  contract: string;
  create_time?: number;  // 交易创建时间（毫秒时间戳）
  order_id?: string;     // 订单ID
  size: string | number; // 交易数量（可以是正负数表示买卖方向）
  price: string;
  role?: string;         // maker or taker
  fee?: string;
  timestamp: number;     // 通用时间戳字段
  [key: string]: any;
}

/**
 * 统一交易所客户端接口
 */
export interface IExchangeClient {
  [x: string]: any;
  /**
   * 获取交易所名称
   */
  getExchangeName(): string;

  /**
   * 获取是否为测试网
   */
  isTestnet(): boolean;

  /**
   * 获取合约ticker价格
   * @param contract 合约名称（如 BTC_USDT 或 BTCUSDT）
   * @param retries 重试次数
   */
  getFuturesTicker(contract: string, retries?: number): Promise<TickerInfo>;

  /**
   * 获取合约K线数据
   * @param contract 合约名称
   * @param interval 时间间隔（如 5m, 15m, 1h, 4h）
   * @param limit 数据条数
   * @param retries 重试次数
   */
  getFuturesCandles(
    contract: string,
    interval: string,
    limit: number,
    retries?: number
  ): Promise<CandleData[]>;

  /**
   * 获取账户余额
   * @param retries 重试次数
   */
  getFuturesAccount(retries?: number): Promise<AccountInfo>;

  /**
   * 获取当前持仓（只返回允许的币种）
   * @param retries 重试次数
   */
  getPositions(retries?: number): Promise<PositionInfo[]>;

  /**
   * 下单（开仓或平仓）
   * @param params 订单参数
   */
  placeOrder(params: OrderParams): Promise<OrderResponse>;

  /**
   * 获取合约信息
   * @param contract 合约名称
   */
  getContractInfo(contract: string): Promise<ContractInfo>;

  /**
   * 设置合约杠杆
   * @param contract 合约名称
   * @param leverage 杠杆倍数
   */
  setLeverage(contract: string, leverage: number): Promise<any>;

  /**
   * 取消所有订单
   * @param contract 合约名称（可选，不传则取消所有合约的订单）
   */
  cancelAllOrders(contract?: string): Promise<any>;

  /**
   * 获取交易历史
   * @param contract 合约名称（可选）
   * @param limit 返回数量
   * @param startTime 起始时间戳（毫秒），用于过滤指定时间后的交易
   */
  getMyTrades(contract?: string, limit?: number, startTime?: number): Promise<TradeRecord[]>;

  /**
   * 标准化合约名称（转换为交易所格式）
   * @param symbol 币种符号（如 BTC）
   */
  normalizeContract(symbol: string): string;

  /**
   * 从合约名称提取币种符号
   * @param contract 合约名称（如 BTC_USDT 或 BTCUSDT）
   */
  extractSymbol(contract: string): string;

  /**
   * 获取订单详情
   * @param orderId 订单ID
   */
  getOrder(orderId: string): Promise<any>;

  /**
   * 取消订单
   * @param orderId 订单ID
   */
  cancelOrder(orderId: string): Promise<any>;

  /**
   * 获取未成交订单
   * @param contract 合约名称（可选）
   */
  getOpenOrders(contract?: string): Promise<any[]>;

  /**
   * 获取资金费率
   * @param contract 合约名称
   */
  getFundingRate(contract: string): Promise<any>;

  /**
   * 获取所有合约列表
   */
  getAllContracts(): Promise<any[]>;

  /**
   * 获取订单簿
   * @param contract 合约名称
   * @param limit 返回深度
   */
  getOrderBook(contract: string, limit?: number): Promise<any>;

  /**
   * 获取历史仓位记录（已平仓的仓位）
   * @param contract 合约名称（可选）
   * @param limit 返回数量
   * @param offset 偏移量
   */
  getPositionHistory(contract?: string, limit?: number, offset?: number): Promise<any[]>;

  /**
   * 获取历史结算记录
   * @param contract 合约名称（可选）
   * @param limit 返回数量
   * @param offset 偏移量
   */
  getSettlementHistory(contract?: string, limit?: number, offset?: number): Promise<any[]>;

  /**
   * 获取已完成的订单历史
   * @param contract 合约名称（可选）
   * @param limit 返回数量
   */
  getOrderHistory(contract?: string, limit?: number): Promise<any[]>;

  /**
   * 获取合约计价类型
   * @returns 'inverse' = 反向合约(币本位), 'linear' = 正向合约(USDT本位)
   */
  getContractType(): 'inverse' | 'linear';

  /**
   * 计算开仓所需数量
   * @param amountUsdt 保证金金额 (USDT)
   * @param price 当前价格
   * @param leverage 杠杆倍数
   * @param contract 合约名称
   * @returns 数量（Gate.io=张数, Binance=币数量）
   */
  calculateQuantity(
    amountUsdt: number,
    price: number,
    leverage: number,
    contract: string
  ): Promise<number>;

  /**
   * 计算盈亏
   * @param entryPrice 开仓价
   * @param exitPrice 平仓价
   * @param quantity 数量
   * @param side 方向
   * @param contract 合约名称
   * @returns 盈亏 (USDT)
   */
  calculatePnl(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    side: 'long' | 'short',
    contract: string
  ): Promise<number>;

  /**
   * 设置持仓的止损止盈价格
   * 注意：不同交易所实现方式不同
   * - Gate.io: 修改持仓的止损止盈参数
   * - Binance: 下独立的条件单（STOP_MARKET/TAKE_PROFIT_MARKET）
   * 
   * @param contract 合约名称
   * @param stopLoss 止损价格（可选）
   * @param takeProfit 止盈价格（可选）
   * @returns 设置结果
   */
  setPositionStopLoss(
    contract: string,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<{
    success: boolean;
    stopLossOrderId?: string;
    takeProfitOrderId?: string;
    actualStopLoss?: number; // 实际使用的止损价格（可能被交易所调整）
    actualTakeProfit?: number; // 实际使用的止盈价格（可能被交易所调整）
    message?: string;
  }>;

  /**
   * 取消持仓的止损止盈订单
   * 
   * @param contract 合约名称
   * @returns 取消结果
   */
  cancelPositionStopLoss(contract: string): Promise<{
    success: boolean;
    message?: string;
  }>;

  /**
   * 获取持仓的止损止盈订单状态
   * 
   * @param contract 合约名称
   * @returns 止损止盈订单信息
   */
  getPositionStopLossOrders(contract: string): Promise<{
    stopLossOrder?: any;
    takeProfitOrder?: any;
  }>;

  /**
   * 获取条件单列表
   * @param contract 合约名称（可选）
   * @param status 状态过滤（可选）：'open'=活跃, 'finished'=已触发
   * @returns 条件单列表
   */
  getPriceOrders(contract?: string, status?: string): Promise<any[]>;
}

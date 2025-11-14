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
 * Gate.io 交易所客户端实现
 */
// @ts-ignore - gate-api 的类型定义可能不完整
import * as GateApi from "gate-api";
import { createLogger } from "../utils/logger";
import { RISK_PARAMS } from "../config/riskParams";
import type {
  IExchangeClient,
  ExchangeConfig,
  TickerInfo,
  CandleData,
  AccountInfo,
  PositionInfo,
  OrderParams,
  OrderResponse,
  ContractInfo,
  TradeRecord,
} from "./IExchangeClient";

const logger = createLogger({
  name: "gate-exchange",
  level: "info",
});

export class GateExchangeClient implements IExchangeClient {
  private readonly client: any;
  private readonly futuresApi: any;
  private readonly spotApi: any;
  private readonly settle = "usdt";
  private readonly config: ExchangeConfig;
  private readonly contractInfoCache: Map<string, ContractInfo> = new Map();

  constructor(config: ExchangeConfig) {
    this.config = config;
    
    // @ts-ignore
    this.client = new GateApi.ApiClient();
    
    // 设置API地址（必须在setApiKeySecret之前设置）
    if (config.isTestnet) {
      this.client.basePath = "https://api-testnet.gateapi.io/api/v4";
      logger.info("使用 Gate.io 测试网");
    } else {
      this.client.basePath = "https://api.gateio.ws/api/v4";
      logger.info("使用 Gate.io 正式网");
    }
    
    // 设置超时时间（30秒）
    this.client.timeout = 30000;
    
    // 设置API密钥和密钥（必须在设置basePath之后）
    this.client.setApiKeySecret(config.apiKey, config.apiSecret);

    // @ts-ignore
    this.futuresApi = new GateApi.FuturesApi(this.client);
    // @ts-ignore
    this.spotApi = new GateApi.SpotApi(this.client);

    logger.info("Gate.io API 客户端初始化完成");
  }

  getExchangeName(): string {
    return "gate";
  }

  isTestnet(): boolean {
    return this.config.isTestnet;
  }

  normalizeContract(symbol: string): string {
    // Gate.io 使用下划线格式：BTC_USDT
    // 如果已经是正确格式（包含_USDT），直接返回
    if (symbol.includes('_USDT')) {
      return symbol;
    }
    
    // 处理斜杠格式：BTC/USDT -> BTC_USDT
    if (symbol.includes('/')) {
      return symbol.replace('/', '_');
    }
    
    // 处理其他格式：移除 USDT 后缀再添加 _USDT
    const cleanSymbol = symbol.replace(/USDT$/, '');
    return `${cleanSymbol}_USDT`;
  }

  extractSymbol(contract: string): string {
    // 从 BTC_USDT 提取 BTC
    return contract.split('_')[0];
  }

  async getFuturesTicker(contract: string, retries: number = 2): Promise<TickerInfo> {
    let lastError: any;
    
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await this.futuresApi.listFuturesTickers(this.settle, {
          contract,
        });
        const ticker = result.body[0];
        
        // 🔧 Gate.io API 字段映射修复
        // Gate.io 返回的字段是下划线命名（snake_case），需要正确映射
        return {
          contract: ticker.contract,
          last: ticker.last || "0",
          markPrice: ticker.mark_price || ticker.last || "0", // mark_price 而不是 markPrice
          indexPrice: ticker.index_price || "0", // index_price 而不是 indexPrice
          volume24h: ticker.volume_24h || ticker.total || "0", // volume_24h 或 total
          high24h: ticker.high_24h || "0", // high_24h 而不是 high24h
          low24h: ticker.low_24h || "0", // low_24h 而不是 low24h
          change24h: ticker.change_percentage || "0", // change_percentage 而不是 changePercentage
        };
      } catch (error) {
        lastError = error;
        if (i < retries) {
          logger.warn(`获取 ${contract} 价格失败，重试 ${i + 1}/${retries}...`);
          // 使用指数退避策略：1秒、2秒、4秒
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      }
    }
    
    logger.error(`获取 ${contract} 价格失败（${retries}次重试）:`, lastError);
    throw lastError;
  }

  async getFuturesCandles(
    contract: string,
    interval: string = "5m",
    limit: number = 100,
    retries: number = 2
  ): Promise<CandleData[]> {
    let lastError: any;
    
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await this.futuresApi.listFuturesCandlesticks(
          this.settle,
          contract,
          {
            interval: interval as any,
            limit,
          }
        );
        const candles = result.body.map((candle: any) => ({
          timestamp: Number.parseInt(candle.t) * 1000,
          open: candle.o,
          high: candle.h,
          low: candle.l,
          close: candle.c,
          volume: candle.v,
        }));
        
        return candles;
      } catch (error) {
        lastError = error;
        if (i < retries) {
          logger.debug(`获取 ${contract} K线数据失败，重试 ${i + 1}/${retries}...`);
          // 使用指数退避策略
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      }
    }
    
    logger.debug(`获取 ${contract} K线数据失败（${retries}次重试）:`, lastError);
    throw lastError;
  }

  async getFuturesAccount(retries: number = 2): Promise<AccountInfo> {
    let lastError: any;
    
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await this.futuresApi.listFuturesAccounts(this.settle);
        const account = result.body;
        return {
          currency: account.currency,
          total: account.total || "0",
          available: account.available || "0",
          positionMargin: account.positionMargin || "0",
          orderMargin: account.orderMargin || "0",
          unrealisedPnl: account.unrealisedPnl || "0",
        };
      } catch (error: any) {
        lastError = error;
        
        // 401 错误通常是认证问题，不需要重试
        if (error?.status === 401 || error?.response?.status === 401) {
          logger.error(`❌ Gate.io API 认证失败 (401)`);
          logger.error(`请检查：`);
          logger.error(`1. API Key 和 Secret 是否正确`);
          logger.error(`2. 是否使用了正确的测试网/正式网密钥`);
          logger.error(`3. API 密钥是否有期货交易权限`);
          logger.error(`当前使用: ${this.config.isTestnet ? '测试网' : '正式网'}`);
          logger.error(`API Key: ${this.config.apiKey.substring(0, 8)}...`);
          throw error;
        }
        
        if (i < retries) {
          logger.warn(`获取账户余额失败，重试 ${i + 1}/${retries}...`);
          // 使用指数退避策略
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      }
    }
    
    logger.error(`获取账户余额失败（${retries}次重试）:`, lastError);
    throw lastError;
  }

  async getPositions(retries: number = 2): Promise<PositionInfo[]> {
    let lastError: any;
    
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await this.futuresApi.listPositions(this.settle);
        const allPositions = result.body;
        
        // 过滤：只保留允许的币种
        const allowedSymbols = RISK_PARAMS.TRADING_SYMBOLS;
        const filteredPositions = allPositions?.filter((p: any) => {
          const symbol = p.contract?.split('_')[0];
          return symbol && allowedSymbols.includes(symbol);
        }) || [];
        
        return filteredPositions.map((p: any) => ({
          contract: p.contract,
          size: p.size || "0",
          leverage: p.leverage || "1",
          entryPrice: p.entryPrice || "0",
          markPrice: p.markPrice || "0",
          liqPrice: p.liqPrice || "0",
          unrealisedPnl: p.unrealisedPnl || "0",
          realisedPnl: p.realisedPnl || "0",
          margin: p.margin || "0",
        }));
      } catch (error) {
        lastError = error;
        if (i < retries) {
          logger.warn(`获取持仓失败，重试 ${i + 1}/${retries}...`);
          // 使用指数退避策略
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      }
    }
    
    logger.error(`获取持仓失败（${retries}次重试）:`, lastError);
    throw lastError;
  }

  async placeOrder(params: OrderParams): Promise<OrderResponse> {
    let adjustedSize = params.size;
    
    try {
      // 获取合约信息以验证数量
      const contractInfo = await this.getContractInfo(params.contract);
      
      const absSize = Math.abs(params.size);
      const API_MAX_SIZE = 10000000;
      const minQty = contractInfo.orderSizeMin || 1;
      
      // 🔧 反向合约特殊处理：按张数交易，数量必须为整数
      // 如果是反向合约(multiplier > 0)且最小数量≥1，说明按张数交易
      const isContractBasedTrading = minQty >= 1;
      
      if (isContractBasedTrading) {
        // 反向合约：直接向上取整到最小张数
        if (absSize < minQty) {
          logger.debug(`反向合约数量 ${absSize.toFixed(8)} 小于最小张数 ${minQty}，调整为最小值`);
          adjustedSize = params.size > 0 ? minQty : -minQty;
        } else {
          // 向上取整到最接近的整数张数
          const roundedSize = Math.ceil(absSize);
          adjustedSize = params.size > 0 ? roundedSize : -roundedSize;
        }
      } else {
        // 正向合约/小数精度合约：使用原有的精度修正逻辑
        const decimalPlaces = Math.abs(Math.floor(Math.log10(minQty)));
        const multiplier = Math.pow(10, decimalPlaces);
        const precisionCorrectedSize = Math.round(absSize * multiplier) / multiplier;
        
        if (precisionCorrectedSize < minQty) {
          logger.warn(`订单数量 ${precisionCorrectedSize.toFixed(decimalPlaces)} 小于最小限制 ${minQty}，调整为最小值`);
          adjustedSize = params.size > 0 ? minQty : -minQty;
        } else {
          adjustedSize = params.size > 0 ? precisionCorrectedSize : -precisionCorrectedSize;
        }
      }
      
      // 检查最大数量限制
      const maxSize = contractInfo.orderSizeMax 
        ? Math.min(contractInfo.orderSizeMax, API_MAX_SIZE)
        : API_MAX_SIZE;
        
      if (Math.abs(adjustedSize) > maxSize) {
        logger.warn(`订单数量 ${Math.abs(adjustedSize).toFixed(2)} 超过最大限制 ${maxSize}，调整为最大值`);
        adjustedSize = params.size > 0 ? maxSize : -maxSize;
      }
      
      logger.debug(`Gate.io 下单数量修正: 原始=${Math.abs(params.size).toFixed(8)} -> 修正=${Math.abs(adjustedSize)} (minQty=${minQty}, 合约类型=${isContractBasedTrading ? '按张数' : '按数量'})`);

      // 验证价格偏离
      let adjustedPrice = params.price;
      if (params.price && params.price > 0) {
        const ticker = await this.getFuturesTicker(params.contract);
        const markPrice = Number.parseFloat(ticker.markPrice || ticker.last || "0");
        
        if (markPrice > 0) {
          const priceDeviation = Math.abs(params.price - markPrice) / markPrice;
          const maxDeviation = 0.015;
          
          if (priceDeviation > maxDeviation) {
            if (params.size > 0) {
              adjustedPrice = markPrice * (1 + maxDeviation);
            } else {
              adjustedPrice = markPrice * (1 - maxDeviation);
            }
            logger.warn(
              `订单价格 ${params.price.toFixed(6)} 偏离标记价格 ${markPrice} 超过 ${maxDeviation * 100}%，调整为 ${adjustedPrice.toFixed(6)}`
            );
          }
        }
      }

      // 格式化价格
      const formatPrice = (price: number | undefined): string => {
        if (!price || price === 0) return "0";
        const roundedPrice = Math.round(price * 100000000) / 100000000;
        let priceStr = roundedPrice.toString();
        if (priceStr.includes('.')) {
          priceStr = priceStr.replace(/\.?0+$/, "");
        }
        return priceStr;
      };

      const order: any = {
        contract: params.contract,
        size: adjustedSize,
      };
      
      // Gate.io 期货订单参数规则：
      // 市价单：price="0" + tif="ioc" + reduce_only=true（平仓）
      // 限价单：price=实际价格 + tif="gtc"
      const formattedPrice = formatPrice(adjustedPrice);
      const isMarketOrder = formattedPrice === "0";
      
      // price 字段总是必需的（即使是市价单）
      order.price = formattedPrice;
      
      // 设置 tif（Time in Force）
      if (isMarketOrder) {
        order.tif = "ioc";  // 市价单：立即成交或取消
      } else {
        order.tif = params.tif || "gtc";  // 限价单：Good Till Cancel
      }

      // 平仓标记（使用 reduce_only 而不是 close）
      if (params.reduceOnly === true) {
        order.reduce_only = true;
      }

      if (params.autoSize !== undefined) {
        order.autoSize = params.autoSize;
      }

      if (params.stopLoss !== undefined && params.stopLoss > 0) {
        order.stopLoss = params.stopLoss.toString();
        logger.info(`设置止损价格: ${params.stopLoss}`);
      }
      
      if (params.takeProfit !== undefined && params.takeProfit > 0) {
        order.takeProfit = params.takeProfit.toString();
        logger.info(`设置止盈价格: ${params.takeProfit}`);
      }

      logger.info(`下单: ${JSON.stringify(order)}`);
      const result = await this.futuresApi.createFuturesOrder(
        this.settle,
        order
      );
      
      const orderResult = result.body;
      
      // 🔧 Gate.io的订单返回不包含实际成交价，需要查询成交记录
      // 对于市价单，等待一下确保成交完成
      if (isMarketOrder) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒确保成交
        
        // 查询最近的成交记录获取实际成交价
        // 传入当前时间减去10秒，只查询最近的交易
        const recentTime = Date.now() - 10000;
        try {
          const trades = await this.getMyTrades(params.contract, 20, recentTime);
          logger.debug(`查询到 ${trades.length} 条成交记录，订单ID: ${orderResult.id}`);
          
          // 尝试通过order_id或时间匹配
          const orderId = orderResult.id.toString();
          let matchingTrade = trades.find(t => t.order_id === orderId);
          
          // 如果没找到，取最新的一条（刚刚成交的）
          if (!matchingTrade && trades.length > 0) {
            matchingTrade = trades[0];
            logger.debug(`使用最新成交记录: trade_id=${matchingTrade.id}, price=${matchingTrade.price}`);
          }
          
          if (matchingTrade) {
            logger.info(`✅ 获取到订单成交价: ${matchingTrade.price}`);
            // 🔧 修复：...orderResult 必须在前面，避免覆盖我们设置的 price
            return {
              ...orderResult,
              id: orderResult.id,
              contract: orderResult.contract,
              size: orderResult.size,
              price: matchingTrade.price, // 使用实际成交价 - 放在最后确保不被覆盖
              status: orderResult.status,
            };
          } else {
            logger.warn(`⚠️ 未找到订单 ${orderId} 的成交记录`);
          }
        } catch (error) {
          logger.warn(`获取订单成交价失败:`, error as Error);
        }
      }
      
      // 🔧 修复：...orderResult 必须在前面，避免覆盖我们设置的 price
      return {
        ...orderResult,
        id: orderResult.id,
        contract: orderResult.contract,
        size: orderResult.size,
        price: orderResult.price || "0", // 放在最后确保不被覆盖
        status: orderResult.status,
      };
    } catch (error: any) {
      const errorDetails = {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        apiError: error.response?.body || error.response?.data,
      };
      logger.error("下单失败:", errorDetails);
      
      if (errorDetails.apiError?.label === "INSUFFICIENT_AVAILABLE") {
        const msg = errorDetails.apiError.message || "可用保证金不足";
        throw new Error(`资金不足，无法开仓 ${params.contract}: ${msg}`);
      }
      
      const detailedMessage = errorDetails.apiError?.message || errorDetails.apiError?.label || error.message;
      throw new Error(`下单失败: ${detailedMessage} (${params.contract}, size: ${adjustedSize})`);
    }
  }

  async getContractInfo(contract: string): Promise<ContractInfo> {
    // 先检查缓存
    if (this.contractInfoCache.has(contract)) {
      return this.contractInfoCache.get(contract)!;
    }
    
    try {
      const result = await this.futuresApi.getFuturesContract(
        this.settle,
        contract
      );
      const info = result.body;
      
      // Gate.io API返回的字段：
      // - order_price_round: 价格步长（如 "0.1" 表示价格必须是0.1的整数倍）
      // - mark_price_round: 标记价格精度
      // - quanto_multiplier: 合约乘数
      const contractInfo: ContractInfo = {
        name: info.name,
        quantoMultiplier: info.quanto_multiplier || "0.0001",
        orderSizeMin: Number.parseFloat(info.order_size_min || "1"),
        orderSizeMax: Number.parseFloat(info.order_size_max || "1000000"),
        orderPriceDeviate: info.order_price_deviate,
        orderPriceRound: info.order_price_round || "0.01",
        markPriceRound: info.mark_price_round || "0.01",
        ...info,
      };
      
      // 缓存合约信息
      this.contractInfoCache.set(contract, contractInfo);
      
      return contractInfo;
    } catch (error) {
      logger.error(`获取 ${contract} 合约信息失败:`, error as any);
      throw error;
    }
  }

  /**
   * 根据合约的价格步长格式化价格
   * @param contract 合约名称
   * @param price 原始价格
   * @returns 格式化后符合交易所要求的价格字符串
   */
  private async formatPriceByTickSize(contract: string, price: number): Promise<string> {
    try {
      const contractInfo = await this.getContractInfo(contract);
      const tickSize = parseFloat(contractInfo.orderPriceRound || "0.01");
      
      // 将价格调整为tickSize的整数倍
      const roundedPrice = Math.round(price / tickSize) * tickSize;
      
      // 确定小数位数
      const decimals = tickSize.toString().split('.')[1]?.length || 0;
      
      return roundedPrice.toFixed(decimals);
    } catch (error) {
      logger.error(`格式化价格失败，使用默认精度: ${error}`);
      // 如果获取合约信息失败，使用默认精度
      return price.toFixed(2);
    }
  }

  async setLeverage(contract: string, leverage: number): Promise<any> {
    try {
      logger.info(`设置 ${contract} 杠杆为 ${leverage}x`);
      const result = await this.futuresApi.updatePositionLeverage(
        this.settle,
        contract,
        leverage.toString()
      );
      return result.body;
    } catch (error: any) {
      logger.warn(`设置 ${contract} 杠杆失败（可能已有持仓）:`, error.message);
      return null;
    }
  }

  async cancelAllOrders(contract?: string): Promise<any> {
    try {
      const options: any = {};
      if (contract) {
        options.contract = contract;
      }
      
      const result = await this.futuresApi.cancelPriceTriggeredOrderList(
        this.settle,
        options
      );
      return result.body;
    } catch (error) {
      logger.error("取消所有订单失败:", error as any);
      throw error;
    }
  }

  async getMyTrades(contract?: string, limit: number = 100, startTime?: number): Promise<TradeRecord[]> {
    try {
      const opts: any = { limit };
      if (contract) {
        opts.contract = contract;
      }
      
      // Gate.io API支持from参数（秒级时间戳）用于过滤时间
      if (startTime) {
        opts.from = Math.floor(startTime / 1000); // 转换为秒
      }
      
      // Gate.io API: getMyTrades - 获取我的历史成交记录
      const result = await this.futuresApi.getMyTrades(
        this.settle,
        opts
      );
      
      return result.body.map((trade: any) => ({
        id: trade.id?.toString() || "",
        contract: trade.contract,
        create_time: trade.create_time ? Number.parseInt(trade.create_time) * 1000 : Date.now(),
        order_id: trade.order_id?.toString() || "",
        size: parseFloat(trade.size || "0"),
        price: trade.price || "0",
        role: trade.role, // maker or taker
        fee: trade.fee || "0",
        timestamp: trade.create_time ? Number.parseInt(trade.create_time) * 1000 : Date.now(),
        ...trade,
      }));
    } catch (error) {
      logger.error(`获取我的历史成交记录失败:`, error as any);
      throw error;
    }
  }

  async getOrder(orderId: string): Promise<any> {
    try {
      const result = await this.futuresApi.getFuturesOrder(
        this.settle,
        orderId
      );
      return result.body;
    } catch (error: any) {
      // 404 表示订单不存在或已被执行/取消，这是正常情况
      if (error.status === 404 || error.code === 'ERR_BAD_REQUEST') {
        logger.debug(`订单 ${orderId} 不存在或已完成 (404)`);
        return {
          id: orderId,
          status: 'finished', // 假设已完成
        };
      }
      logger.error(`获取订单 ${orderId} 详情失败:`, error);
      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<any> {
    try {
      const result = await this.futuresApi.cancelFuturesOrder(
        this.settle,
        orderId
      );
      return result.body;
    } catch (error: any) {
      // 404 表示订单不存在或已被执行，无需取消
      if (error.status === 404 || error.code === 'ERR_BAD_REQUEST') {
        logger.debug(`订单 ${orderId} 不存在或已完成，无需取消 (404)`);
        return { id: orderId, status: 'finished' };
      }
      logger.error(`取消订单 ${orderId} 失败:`, error);
      throw error;
    }
  }

  async getOpenOrders(contract?: string): Promise<any[]> {
    try {
      const result = await this.futuresApi.listFuturesOrders(this.settle, "open", {
        contract,
      });
      return result.body;
    } catch (error) {
      logger.error("获取未成交订单失败:", error as any);
      throw error;
    }
  }

  async getFundingRate(contract: string): Promise<any> {
    try {
      const result = await this.futuresApi.listFuturesFundingRateHistory(
        this.settle,
        contract,
        { limit: 1 }
      );
      return result.body[0];
    } catch (error) {
      logger.error(`获取 ${contract} 资金费率失败:`, error as any);
      throw error;
    }
  }

  async getAllContracts(): Promise<any[]> {
    try {
      const result = await this.futuresApi.listFuturesContracts(this.settle);
      return result.body;
    } catch (error) {
      logger.error("获取合约列表失败:", error as any);
      throw error;
    }
  }

  async getOrderBook(contract: string, limit: number = 10): Promise<any> {
    try {
      const result = await this.futuresApi.listFuturesOrderBook(
        this.settle,
        contract,
        { limit }
      );
      return result.body;
    } catch (error) {
      logger.error(`获取 ${contract} 订单簿失败:`, error as any);
      throw error;
    }
  }

  async getPositionHistory(contract?: string, limit: number = 100, offset: number = 0): Promise<any[]> {
    try {
      const options: any = { limit, offset };
      if (contract) {
        options.contract = contract;
      }
      
      const result = await this.futuresApi.listFuturesLiquidatedOrders(
        this.settle,
        options
      );
      return result.body;
    } catch (error) {
      logger.error(`获取历史仓位记录失败:`, error as any);
      throw error;
    }
  }

  async getSettlementHistory(contract?: string, limit: number = 100, offset: number = 0): Promise<any[]> {
    try {
      const options: any = { limit, offset };
      if (contract) {
        options.contract = contract;
      }
      
      const result = await this.futuresApi.listFuturesSettlementHistory(
        this.settle,
        options
      );
      return result.body;
    } catch (error) {
      logger.error(`获取历史结算记录失败:`, error as any);
      throw error;
    }
  }

  async getOrderHistory(contract?: string, limit: number = 10): Promise<any[]> {
    try {
      const options: any = { limit };
      if (contract) {
        options.contract = contract;
      }
      
      const result = await this.futuresApi.listFuturesOrders(
        this.settle,
        "finished",
        options
      );
      return result.body;
    } catch (error) {
      logger.error(`获取订单历史失败:`, error as any);
      throw error;
    }
  }

  /**
   * 获取合约计价类型
   * Gate.io 使用反向合约（币本位）
   */
  getContractType(): 'inverse' | 'linear' {
    return 'inverse';
  }

  /**
   * 计算开仓所需数量（Gate.io 反向合约）
   * Gate.io 使用"张数"作为单位，每张合约代表一定数量的币
   * 例如：BTC_USDT: 1张 = 0.0001 BTC
   * 
   * 公式：quantity = (amountUsdt * leverage) / (quantoMultiplier * price)
   * 
   * @param amountUsdt 保证金金额 (USDT)
   * @param price 当前价格
   * @param leverage 杠杆倍数
   * @param contract 合约名称
   * @returns 张数（整数）
   */
  async calculateQuantity(
    amountUsdt: number,
    price: number,
    leverage: number,
    contract: string
  ): Promise<number> {
    const { getQuantoMultiplier } = await import('../utils/contractUtils.js');
    const quantoMultiplier = await getQuantoMultiplier(contract);
    
    // 计算张数
    let quantity = (amountUsdt * leverage) / (quantoMultiplier * price);
    
    // Gate.io 要求张数必须是整数，向下取整
    return Math.floor(quantity);
  }

  /**
   * 计算盈亏（Gate.io 反向合约）
   * 
   * 公式：
   * - 做多: (exitPrice - entryPrice) * quantity * quantoMultiplier
   * - 做空: (entryPrice - exitPrice) * quantity * quantoMultiplier
   * 
   * @param entryPrice 开仓价
   * @param exitPrice 平仓价
   * @param quantity 张数
   * @param side 方向
   * @param contract 合约名称
   * @returns 盈亏 (USDT)
   */
  async calculatePnl(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    side: 'long' | 'short',
    contract: string
  ): Promise<number> {
    const { getQuantoMultiplier } = await import('../utils/contractUtils.js');
    const quantoMultiplier = await getQuantoMultiplier(contract);
    
    const priceChange = side === 'long' 
      ? (exitPrice - entryPrice) 
      : (entryPrice - exitPrice);
    
    return priceChange * quantity * quantoMultiplier;
  }

  /**
   * 设置持仓的止损止盈价格
   * Gate.io 注意：开仓时设置止损止盈，开仓后无法直接修改
   * 需要通过取消原单并重新下单的方式实现
   */
  async setPositionStopLoss(
    contract: string,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<{
    success: boolean;
    stopLossOrderId?: string;
    takeProfitOrderId?: string;
    actualStopLoss?: number;
    actualTakeProfit?: number;
    message?: string;
  }> {
    try {
      // Gate.io 的止损止盈是在开仓时设置的
      // 开仓后无法直接修改，需要通过条件单（price trigger orders）实现
      
      // 获取当前持仓
      const positions = await this.getPositions();
      const position = positions.find(p => p.contract === contract);
      
      if (!position || Math.abs(parseFloat(position.size)) === 0) {
        return {
          success: false,
          message: `未找到 ${contract} 的持仓`
        };
      }

      const posSize = parseFloat(position.size);
      const side = posSize > 0 ? 'long' : 'short';
      
      logger.info(`📊 ${contract} 当前持仓信息: size=${position.size}, posSize=${posSize}, side=${side}`);
      
      // 🔧 Gate.io 条件单 size 字段说明：
      // 根据Gate.io API文档和实际测试：
      // - size 可以是正数或负数
      // - 正数表示买入（做多），负数表示卖出（做空）
      // - 平仓需要反向操作：多单平仓用负数，空单平仓用正数
      //
      // 示例：
      // - 持有100张多单(posSize=+100) → 平仓需要-100（卖出）
      // - 持有100张空单(posSize=-100) → 平仓需要+100（买入）
      //
      // 注意：size 必须是整数，Gate.io 不接受小数张数
      const closeSize = -Math.round(posSize); // 取相反方向进行平仓，并确保是整数

      // 提取币种符号（如 BTC_USDT -> BTC）
      const symbol = this.extractSymbol(contract);

      // 取消现有的条件单（如果有）
      try {
        // 注意：必须传递 options 对象，而不是直接传递 contract 字符串
        const options: any = { contract: contract };
        await this.futuresApi.cancelPriceTriggeredOrderList(
          this.settle,
          options
        );
        logger.info(`已取消 ${contract} 的现有条件单`);
      } catch (error) {
        // 可能没有条件单，忽略错误
        logger.debug(`取消条件单失败（可能不存在）: ${error}`);
      }

      let stopLossOrderId: string | undefined;
      let takeProfitOrderId: string | undefined;

      // 创建止损条件单
      if (stopLoss !== undefined && stopLoss > 0) {
        // 在 try 块外部定义变量，确保在 catch 块中也能访问
        let currentPrice = 0;
        let formattedStopLoss = '';
        let stopLossOrder: any = null;
        
        try {
          // 获取当前价格用于验证
          const ticker = await this.getFuturesTicker(contract);
          currentPrice = parseFloat(ticker.markPrice || ticker.last || "0");
          
          if (currentPrice <= 0) {
            throw new Error(`无法获取 ${contract} 的当前价格`);
          }
          
          // 验证止损价格的合理性 - 确保止损在正确的方向
          // 多单止损必须低于当前价，空单止损必须高于当前价
          const isInvalidStopLoss = (side === 'long' && stopLoss >= currentPrice) || 
                                    (side === 'short' && stopLoss <= currentPrice);
          
          if (isInvalidStopLoss) {
            // 🔧 修复：价格已突破止损位，调整止损价到当前价附近（留0.1%缓冲）
            const buffer = 0.001; // 0.1%缓冲
            const adjustedStopLoss = side === 'long' 
              ? currentPrice * (1 - buffer)  // 多单：略低于当前价
              : currentPrice * (1 + buffer); // 空单：略高于当前价
            
            logger.warn(`⚠️ ${contract} 价格已突破止损位: 原止损=${stopLoss.toFixed(6)}, 当前价=${currentPrice.toFixed(6)}`);
            logger.info(`🔧 自动调整止损价: ${stopLoss.toFixed(6)} → ${adjustedStopLoss.toFixed(6)} (${side}单，缓冲${(buffer*100).toFixed(1)}%)`);
            
            // 使用调整后的止损价
            stopLoss = adjustedStopLoss;
          }
          
          // 检查止损距离是否合理（至少0.05%的距离，放宽要求）
          const priceDeviation = Math.abs(stopLoss - currentPrice) / currentPrice;
          const minSafeDistance = 0.0005; // 最小0.05%的安全距离（从0.3%放宽）
          
          if (priceDeviation < minSafeDistance) {
            logger.warn(`⚠️ 止损价格 ${stopLoss.toFixed(6)} 距离当前价 ${currentPrice.toFixed(6)} 太近(${(priceDeviation * 100).toFixed(2)}%)，可能立即触发`);
          }
          
          // 格式化止损价格 - 使用合约的价格步长精度
          formattedStopLoss = await this.formatPriceByTickSize(contract, stopLoss);
          
          // 🔧 根据 Gate.io 官方文档要求:
          // 1. trigger.price 和 trigger.rule 是必需字段
          // 2. initial.price = "0" 表示市价单,必须配合 tif = "ioc"
          // 3. 市价单不需要设置 size_type(文档中未明确要求此字段)
          stopLossOrder = {
            initial: {
              contract: contract,
              size: closeSize, // 负数=卖出平多单，正数=买入平空单
              price: '0', // 0 表示市价单
              tif: 'ioc', // 市价单必须用 ioc (Immediate or Cancel)
            },
            trigger: {
              strategy_type: 0, // 0=价格触发
              price_type: 0, // 0=最新成交价, 1=标记价格, 2=指数价格
              price: formattedStopLoss, // 触发价格 - 必需字段
              rule: side === 'long' ? 2 : 1, // 必需字段: long用2(<=触发), short用1(>=触发)
              expiration: 86400 * 7, // 7天过期时间(秒)
            },
          };

          logger.info(`📤 创建止损单: contract=${contract}, posSize=${posSize}, closeSize=${closeSize} (${closeSize < 0 ? '卖出' : '买入'}), 触发价=${formattedStopLoss}, 当前价=${currentPrice}, side=${side}`);

          // 优化：增加重试机制（最多3次，渐进式延迟）
          const maxRetries = 3;
          let retryCount = 0;
          let lastError: any = null;

          while (retryCount < maxRetries) {
            try {
              const result = await this.futuresApi.createPriceTriggeredOrder(
                this.settle,
                stopLossOrder as any
              );
              
              stopLossOrderId = result.body.id?.toString();
              logger.info(`✅ ${contract} 止损单已创建: ID=${stopLossOrderId}, 触发价=${formattedStopLoss}${retryCount > 0 ? ` (第${retryCount + 1}次尝试)` : ''}`);
              break; // 成功，跳出循环
            } catch (error: any) {
              lastError = error;
              retryCount++;
              
              const errorMsg = error.response?.body?.message || error.message;
              const errorStatus = error.status || error.response?.status;
              const isTimeoutError = errorStatus === 408 || errorStatus === 504 || errorStatus === 503 || 
                                     errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT');
              
              if (isTimeoutError && retryCount < maxRetries) {
                // 渐进式延迟：3秒、5秒、8秒
                const delay = Math.min(3000 * Math.pow(1.5, retryCount - 1), 8000);
                logger.warn(`⚠️ 止损单创建超时 (${retryCount}/${maxRetries})，等待${(delay/1000).toFixed(1)}秒后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
              } else {
                // 非超时错误或已达最大重试次数，记录详细错误并跳出
                logger.error(`❌ 创建止损单失败 (尝试${retryCount}/${maxRetries}): ${errorMsg}`, { 
                  contract, 
                  errorStatus,
                  errorLabel: error.response?.body?.label,
                  stopLossPrice: formattedStopLoss,
                  currentPrice,
                  side
                });
                break;
              }
            }
          }

          // 所有重试失败后的处理
          if (!stopLossOrderId && lastError) {
            const errorMsg = lastError.response?.body?.message || lastError.message;
            const errorStatus = lastError.status || lastError.response?.status;
            const isTimeoutError = errorStatus === 408 || errorStatus === 504 || errorStatus === 503;
            
            if (isTimeoutError) {
              // 超时错误：持仓已存在，只是条件单未创建
              logger.warn(`⚠️ ${contract} 止损单创建超时(${maxRetries}次尝试)，持仓已存在，稍后会自动重试`);
              return {
                success: false,
                message: `创建止损单超时(${maxRetries}次尝试)，系统稍后会自动重试`
              };
            }
            
            // 价格相关错误：尝试调整价格
            const isPriceError = errorMsg.includes('price') || errorMsg.includes('invalid') || errorStatus === 400;
            if (isPriceError) {
              logger.warn(`⚠️ 价格相关错误，尝试最后一次调整价格...`);
              
              try {
                // 更激进地调整价格：增加到1.5%的安全距离
                const safeDistance = 0.015;
                const adjustedStopLoss = side === 'long' 
                  ? currentPrice * (1 - safeDistance)
                  : currentPrice * (1 + safeDistance);
                
                formattedStopLoss = await this.formatPriceByTickSize(contract, adjustedStopLoss);
                
                const retryOrder = {
                  initial: {
                    contract: contract,
                    size: closeSize,
                    price: '0',
                    tif: 'ioc',
                  },
                  trigger: {
                    strategy_type: 0,
                    price_type: 0,
                    price: formattedStopLoss,
                    rule: side === 'long' ? 2 : 1,
                    expiration: 86400 * 7,
                  },
                };
                
                logger.info(`🔄 最后尝试创建止损单 (价格调整): 触发价=${formattedStopLoss}`);
                
                const retryResult = await this.futuresApi.createPriceTriggeredOrder(
                  this.settle,
                  retryOrder as any
                );
                
                stopLossOrderId = retryResult.body.id?.toString();
                logger.info(`✅ ${contract} 止损单创建成功(价格调整): ID=${stopLossOrderId}`);
              } catch (retryError: any) {
                logger.error(`❌ 价格调整后仍失败: ${retryError.message}`);
                return {
                  success: false,
                  message: `创建止损单失败(价格调整后): ${retryError.message}`
                };
              }
            } else {
              // 其他错误类型
              return {
                success: false,
                message: `创建止损单失败: ${errorMsg}`
              };
            }
          }
        } catch (error: any) {
          const errorMsg = error.response?.body?.message || error.message;
          logger.error(`❌ 止损单创建异常: ${errorMsg}`);
          return {
            success: false,
            message: `止损单创建异常: ${errorMsg}`
          };
        }
      }

      // 创建止盈条件单
      if (takeProfit !== undefined && takeProfit > 0) {
        // 在 try 块外部定义变量，确保在 catch 块中也能访问
        let currentPrice = 0;
        let formattedTakeProfit = '';
        
        try {
          // 获取当前价格用于验证
          const ticker = await this.getFuturesTicker(contract);
          currentPrice = parseFloat(ticker.markPrice || ticker.last || "0");
          
          if (currentPrice <= 0) {
            throw new Error(`无法获取 ${contract} 的当前价格`);
          }
          
          // 验证止盈价格的合理性 - 确保止盈在正确的方向
          // 多单止盈必须高于当前价，空单止盈必须低于当前价
          const isInvalidTakeProfit = (side === 'long' && takeProfit <= currentPrice) || 
                                      (side === 'short' && takeProfit >= currentPrice);
          
          if (isInvalidTakeProfit) {
            // 🔧 修复：价格已突破止盈位，调整止盈价到当前价附近（留0.1%缓冲）
            const buffer = 0.001; // 0.1%缓冲
            const adjustedTakeProfit = side === 'long' 
              ? currentPrice * (1 + buffer)  // 多单：略高于当前价
              : currentPrice * (1 - buffer); // 空单：略低于当前价
            
            logger.warn(`⚠️ ${contract} 价格已突破止盈位: 原止盈=${takeProfit.toFixed(6)}, 当前价=${currentPrice.toFixed(6)}`);
            logger.info(`🔧 自动调整止盈价: ${takeProfit.toFixed(6)} → ${adjustedTakeProfit.toFixed(6)} (${side}单，缓冲${(buffer*100).toFixed(1)}%)`);
            
            // 使用调整后的止盈价
            takeProfit = adjustedTakeProfit;
          }
          
          // 检查止盈距离是否合理（至少0.05%的距离）
          const priceDeviation = Math.abs(takeProfit - currentPrice) / currentPrice;
          const minSafeDistance = 0.0005; // 最小0.05%的安全距离
          
          if (priceDeviation < minSafeDistance) {
            logger.warn(`⚠️ 止盈价格 ${takeProfit.toFixed(6)} 距离当前价 ${currentPrice.toFixed(6)} 太近(${(priceDeviation * 100).toFixed(2)}%)，可能立即触发`);
          }
          
          // 格式化止盈价格 - 使用合约的价格步长精度
          formattedTakeProfit = await this.formatPriceByTickSize(contract, takeProfit);
          
          const takeProfitOrder = {
            initial: {
              contract: contract,
              size: closeSize, // 负数=卖出平多单，正数=买入平空单
              price: '0', // 市价单
              tif: 'ioc', // immediate or cancel，市价单必需
            },
            trigger: {
              strategy_type: 0, // 0=by price
              price_type: 0, // 0=last price
              price: formattedTakeProfit,
              rule: side === 'long' ? 1 : 2, // long: >=止盈价触发, short: <=止盈价触发
            },
            size_type: 0, // 🔧 重要：0=合约数量(张), 放在外层
          };

          logger.info(`📤 创建止盈单: contract=${contract}, posSize=${posSize}, closeSize=${closeSize} (${closeSize < 0 ? '卖出' : '买入'}), 触发价=${formattedTakeProfit}, 当前价=${currentPrice}, side=${side}`);
          logger.debug(`止盈单完整数据:`, takeProfitOrder);

          const result = await this.futuresApi.createPriceTriggeredOrder(
            this.settle,
            takeProfitOrder as any
          );
          
          takeProfitOrderId = result.body.id?.toString();
          logger.info(`✅ ${contract} 止盈单已创建: ID=${takeProfitOrderId}, 触发价=${formattedTakeProfit}, 当前价=${currentPrice}`);
        } catch (error: any) {
          const errorMsg = error.response?.body?.message || error.message;
          const errorDetail = error.response?.body || error.message;
          logger.error(`创建止盈单失败: ${errorMsg}`, { 
            contract, 
            posSize,
            closeSize: closeSize,
            takeProfitPrice: formattedTakeProfit || takeProfit,
            currentPrice,
            side,
            error: errorDetail
          });
          // 如果止盈单失败但止损单成功，仍返回成功（止损更重要）
          if (stopLossOrderId) {
            return {
              success: true,
              stopLossOrderId,
              message: `止损单已创建，止盈单创建失败: ${errorMsg}`
            };
          }
          return {
            success: false,
            message: `创建止盈单失败: ${errorMsg}`
          };
        }
      }

      return {
        success: true,
        stopLossOrderId,
        takeProfitOrderId,
        actualStopLoss: stopLoss, // 返回实际使用的止损价格
        actualTakeProfit: takeProfit, // 返回实际使用的止盈价格
        message: `止损止盈已设置${stopLoss ? ` 止损=${stopLoss}` : ''}${takeProfit ? ` 止盈=${takeProfit}` : ''}`
      };

    } catch (error: any) {
      logger.error(`设置止损止盈失败: ${error.message}`);
      return {
        success: false,
        message: `设置失败: ${error.message}`
      };
    }
  }

  /**
   * 取消持仓的止损止盈订单
   */
  async cancelPositionStopLoss(contract: string): Promise<{
    success: boolean;
    message?: string;
  }> {
    try {
      await this.futuresApi.cancelPriceTriggeredOrderList(
        this.settle,
        contract
      );
      
      logger.info(`✅ 已取消 ${contract} 的止损止盈订单`);
      return {
        success: true,
        message: `已取消 ${contract} 的止损止盈订单`
      };
    } catch (error: any) {
      logger.error(`取消止损止盈订单失败: ${error.message}`);
      return {
        success: false,
        message: `取消失败: ${error.message}`
      };
    }
  }

  /**
   * 获取持仓的止损止盈订单状态
   */
  async getPositionStopLossOrders(contract: string): Promise<{
    stopLossOrder?: any;
    takeProfitOrder?: any;
  }> {
    try {
      // 先检查是否有持仓，没有持仓则直接返回空
      const positions = await this.getPositions();
      const position = positions.find(p => p.contract === contract);
      
      if (!position) {
        return {
          stopLossOrder: undefined,
          takeProfitOrder: undefined
        };
      }

      const posSize = parseFloat(position.size);
      const side = posSize > 0 ? 'long' : 'short';

      // 查询条件单
      const result = await this.futuresApi.listPriceTriggeredOrders(
        this.settle,
        {
          contract: contract,
          status: 'open' // 只查询活跃的条件单
        }
      );

      const orders = result.body || [];
      let stopLossOrder: any;
      let takeProfitOrder: any;

      for (const order of orders) {
        // 判断是止损还是止盈
        // 止损：多单时 <= 触发价，空单时 >= 触发价
        // 止盈：多单时 >= 触发价，空单时 <= 触发价
        const rule = order.trigger?.rule;
        
        if (side === 'long') {
          if (rule === 2) { // <=
            stopLossOrder = order;
          } else if (rule === 1) { // >=
            takeProfitOrder = order;
          }
        } else {
          if (rule === 1) { // >=
            stopLossOrder = order;
          } else if (rule === 2) { // <=
            takeProfitOrder = order;
          }
        }
      }

      return {
        stopLossOrder,
        takeProfitOrder
      };
    } catch (error: any) {
      // 如果是404或400错误，说明没有条件单，这是正常情况
      if (error.message?.includes('400') || error.message?.includes('404')) {
        logger.debug(`${contract} 暂无止损止盈订单`);
        return {
          stopLossOrder: undefined,
          takeProfitOrder: undefined
        };
      }
      
      // 其他错误才记录为error
      logger.error(`获取止损止盈订单失败: ${error.message}`);
      return {
        stopLossOrder: undefined,
        takeProfitOrder: undefined
      };
    }
  }

  /**
   * 获取条件单列表（Gate.io实现）
   * @param contract 合约名称（可选）
   * @param status 状态过滤：'open'=活跃, 'finished'=已触发
   */
  async getPriceOrders(contract?: string, status: string = 'open'): Promise<any[]> {
    // Gate.io API: listPriceTriggeredOrders(settle, status, opts)
    const opts: any = {};
    if (contract) {
      opts.contract = contract;
    }
    
    const result = await this.futuresApi.listPriceTriggeredOrders(
      this.settle,
      status,  // status 作为第二个参数，不是在options中
      opts
    );
    
    return result.body || [];
  }
}

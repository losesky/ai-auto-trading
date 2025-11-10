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
 * 价格格式化工具 - 智能价格精度管理
 * 
 * 核心功能：
 * 1. 根据价格大小自动选择合适的小数位数
 * 2. 确保低价币种（如DOGE、XRP）有足够的精度
 * 3. 避免因精度问题导致的计算误差和显示问题
 * 4. 提供统一的价格格式化接口
 */

/**
 * 根据价格自动确定合适的小数位数
 * 
 * 规则：
 * - 价格 >= 1000: 保留2位小数（如 BTC: 45000.12）
 * - 100 <= 价格 < 1000: 保留2位小数（如 ETH: 234.56）
 * - 10 <= 价格 < 100: 保留3位小数（如 BNB: 45.678）
 * - 1 <= 价格 < 10: 保留4位小数（如 ADA: 2.3456）
 * - 0.1 <= 价格 < 1: 保留5位小数（如 DOGE: 0.16234）
 * - 0.01 <= 价格 < 0.1: 保留6位小数（如 SHIB: 0.000123）
 * - 价格 < 0.01: 保留8位小数（如超低价币）
 * 
 * @param price 价格
 * @returns 建议的小数位数
 */
export function getDecimalPlaces(price: number): number {
  const absPrice = Math.abs(price);
  
  if (absPrice >= 1000) return 2;
  if (absPrice >= 100) return 2;
  if (absPrice >= 10) return 3;
  if (absPrice >= 1) return 4;
  if (absPrice >= 0.1) return 5;
  if (absPrice >= 0.01) return 6;
  if (absPrice >= 0.001) return 7;
  return 8;  // 超低价币
}

/**
 * 格式化价格（自动选择精度）
 * 
 * @param price 价格
 * @param forceDecimals 强制使用指定的小数位数（可选）
 * @returns 格式化后的价格字符串
 */
export function formatPrice(price: number, forceDecimals?: number): string {
  if (!Number.isFinite(price)) {
    return "0.00";
  }
  
  const decimals = forceDecimals !== undefined ? forceDecimals : getDecimalPlaces(price);
  return price.toFixed(decimals);
}

/**
 * 格式化价格为数字（用于计算）
 * 保留足够的精度避免计算误差
 * 
 * @param price 价格
 * @returns 精确的数字（保留8位小数）
 */
export function formatPriceNumber(price: number): number {
  if (!Number.isFinite(price)) {
    return 0;
  }
  
  // 保留8位小数用于计算（避免浮点误差）
  return Math.round(price * 100000000) / 100000000;
}

/**
 * 格式化百分比
 * 
 * @param percent 百分比值
 * @param decimals 小数位数（默认2位）
 * @returns 格式化后的百分比字符串
 */
export function formatPercent(percent: number, decimals: number = 2): string {
  if (!Number.isFinite(percent)) {
    return "0.00";
  }
  
  return percent.toFixed(decimals);
}

/**
 * 格式化 USDT 金额
 * 
 * @param amount 金额
 * @param decimals 小数位数（默认2位）
 * @returns 格式化后的金额字符串
 */
export function formatUSDT(amount: number, decimals: number = 2): string {
  if (!Number.isFinite(amount)) {
    return "0.00";
  }
  
  return amount.toFixed(decimals);
}

/**
 * 格式化 ATR 值
 * ATR 通常比价格小很多，需要更高的精度
 * 
 * @param atr ATR值
 * @param currentPrice 当前价格（用于确定精度）
 * @returns 格式化后的ATR字符串
 */
export function formatATR(atr: number, currentPrice: number): string {
  if (!Number.isFinite(atr)) {
    return "0.0000";
  }
  
  // ATR 至少需要比价格多2位精度
  const priceDecimals = getDecimalPlaces(currentPrice);
  const atrDecimals = Math.min(priceDecimals + 2, 8);
  
  return atr.toFixed(atrDecimals);
}

/**
 * 智能格式化数字（自动选择合适的格式）
 * 
 * @param value 数值
 * @param type 数值类型（'price' | 'percent' | 'usdt' | 'atr'）
 * @param referencePrice 参考价格（用于ATR等需要基准的类型）
 * @returns 格式化后的字符串
 */
export function formatNumber(
  value: number,
  type: 'price' | 'percent' | 'usdt' | 'atr' = 'price',
  referencePrice?: number
): string {
  switch (type) {
    case 'price':
      return formatPrice(value);
    case 'percent':
      return formatPercent(value);
    case 'usdt':
      return formatUSDT(value);
    case 'atr':
      return formatATR(value, referencePrice || value);
    default:
      return value.toFixed(2);
  }
}

/**
 * 比较两个价格是否相等（考虑精度误差）
 * 
 * @param price1 价格1
 * @param price2 价格2
 * @param tolerance 容差（默认0.0001，即0.01%）
 * @returns 是否相等
 */
export function isPriceEqual(price1: number, price2: number, tolerance: number = 0.0001): boolean {
  return Math.abs(price1 - price2) / Math.max(price1, price2) < tolerance;
}

/**
 * 根据交易对符号确定价格精度
 * 某些交易对有特定的精度要求
 * 
 * @param symbol 交易对符号（如 BTC、ETH、DOGE）
 * @param price 当前价格
 * @returns 建议的小数位数
 */
export function getDecimalPlacesBySymbol(symbol: string, price: number): number {
  // 特殊处理某些币种
  const symbolUpper = symbol.toUpperCase();
  
  // SHIB、PEPE等超低价币
  if (['SHIB', 'PEPE', 'FLOKI', 'BABYDOGE'].includes(symbolUpper)) {
    return 8;
  }
  
  // DOGE、XRP等低价币
  if (['DOGE', 'XRP', 'TRX', 'ADA'].includes(symbolUpper)) {
    return Math.max(5, getDecimalPlaces(price));
  }
  
  // BTC 价格通常很高，但 Gate.io 要求使用整数价格（0位小数）
  // 这是因为 BTC_USDT 合约的 order_price_round = "0.1"
  if (symbolUpper === 'BTC') {
    // 对于 BTC，使用2位小数（Gate.io 要求）
    return 2;
  }
  
  // ETH、BNB等高价币
  if (['ETH', 'BNB'].includes(symbolUpper)) {
    return Math.max(2, Math.min(4, getDecimalPlaces(price)));
  }
  
  // 默认使用价格自动判断
  return getDecimalPlaces(price);
}

/**
 * 格式化止损价格（带符号的价格）
 * 
 * @param symbol 交易对符号
 * @param price 价格
 * @returns 格式化后的价格字符串
 */
export function formatStopLossPrice(symbol: string, price: number): string {
  const decimals = getDecimalPlacesBySymbol(symbol, price);
  return formatPrice(price, decimals);
}

/**
 * 根据最小交易数量计算精度（小数位数）
 * 
 * 例如：
 * - minQty = 1 -> 0位小数（整数）
 * - minQty = 0.1 -> 1位小数
 * - minQty = 0.01 -> 2位小数
 * - minQty = 0.001 -> 3位小数
 * 
 * @param minQty 最小交易数量
 * @returns 小数位数
 */
export function getQuantityDecimalPlaces(minQty: number): number {
  if (minQty >= 1) return 0;
  return Math.abs(Math.floor(Math.log10(minQty)));
}

/**
 * 根据合约最小交易数量修正数量精度
 * 
 * 核心功能：
 * 1. 根据 minQty 确定精度（小数位数）
 * 2. 向下取整到指定精度，确保不超过原始数量
 * 3. 避免浮点数精度累积误差（如 956.8100000000001）
 * 4. 确保修正后的数量符合交易所要求
 * 
 * @param quantity 原始数量
 * @param minQty 合约最小交易数量
 * @returns 修正后的数量
 */
export function adjustQuantityPrecision(quantity: number, minQty: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return 0;
  }
  
  // 根据 minQty 确定小数位数
  const decimalPlaces = getQuantityDecimalPlaces(minQty);
  const multiplier = Math.pow(10, decimalPlaces);
  
  // 向下取整到指定精度（防止浮点数累积误差）
  const adjusted = Math.floor(quantity * multiplier) / multiplier;
  
  return adjusted;
}

/**
 * 计算分批平仓数量（带精度修正）
 * 
 * 功能：
 * 1. 计算持仓的百分比数量
 * 2. 自动应用精度修正
 * 3. 验证是否满足最小交易数量
 * 4. 验证剩余数量是否满足最小持仓要求
 * 
 * @param currentSize 当前持仓数量
 * @param closePercent 平仓百分比（0-100）
 * @param minQty 合约最小交易数量
 * @returns 包含平仓数量、剩余数量、精度信息的对象
 */
export function calculatePartialCloseQuantity(
  currentSize: number,
  closePercent: number,
  minQty: number
): {
  closeQuantity: number;
  remainingQuantity: number;
  decimalPlaces: number;
  meetsMinQuantity: boolean;
  remainingMeetsMin: boolean;
  error?: string;
} {
  // 参数验证
  if (!Number.isFinite(currentSize) || currentSize <= 0) {
    return {
      closeQuantity: 0,
      remainingQuantity: 0,
      decimalPlaces: 0,
      meetsMinQuantity: false,
      remainingMeetsMin: false,
      error: "无效的持仓数量",
    };
  }
  
  if (!Number.isFinite(closePercent) || closePercent <= 0 || closePercent > 100) {
    return {
      closeQuantity: 0,
      remainingQuantity: currentSize,
      decimalPlaces: 0,
      meetsMinQuantity: false,
      remainingMeetsMin: true,
      error: "无效的平仓百分比（必须在0-100之间）",
    };
  }
  
  // 计算精度
  const decimalPlaces = getQuantityDecimalPlaces(minQty);
  
  // 计算原始平仓数量
  const rawCloseQuantity = (currentSize * closePercent) / 100;
  
  // 应用精度修正
  const closeQuantity = adjustQuantityPrecision(rawCloseQuantity, minQty);
  
  // 计算剩余数量
  const remainingQuantity = adjustQuantityPrecision(currentSize - closeQuantity, minQty);
  
  // 验证最小数量要求
  const meetsMinQuantity = closeQuantity >= minQty;
  const remainingMeetsMin = remainingQuantity === 0 || remainingQuantity >= minQty;
  
  return {
    closeQuantity,
    remainingQuantity,
    decimalPlaces,
    meetsMinQuantity,
    remainingMeetsMin,
  };
}

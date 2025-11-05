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
 * 前端价格格式化工具 - 与后端 priceFormatter.ts 保持一致
 * 
 * 核心功能：
 * 1. 根据价格大小自动选择合适的小数位数
 * 2. 确保低价币种（如DOGE、XRP）有足够的精度
 * 3. 提供统一的价格格式化接口
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
 * @param {number} price 价格
 * @returns {number} 建议的小数位数
 */
function getDecimalPlaces(price) {
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
 * @param {number} price 价格
 * @param {number} forceDecimals 强制使用指定的小数位数（可选）
 * @returns {string} 格式化后的价格字符串
 */
function formatPrice(price, forceDecimals) {
  if (!Number.isFinite(price)) {
    return "0.00";
  }
  
  const decimals = forceDecimals !== undefined ? forceDecimals : getDecimalPlaces(price);
  return price.toFixed(decimals);
}

/**
 * 格式化百分比
 * 
 * @param {number} percent 百分比值
 * @param {number} decimals 小数位数（默认2位）
 * @returns {string} 格式化后的百分比字符串
 */
function formatPercent(percent, decimals = 2) {
  if (!Number.isFinite(percent)) {
    return "0.00";
  }
  
  return percent.toFixed(decimals);
}

/**
 * 格式化 USDT 金额
 * 
 * @param {number} amount 金额
 * @param {number} decimals 小数位数（默认2位）
 * @returns {string} 格式化后的金额字符串
 */
function formatUSDT(amount, decimals = 2) {
  if (!Number.isFinite(amount)) {
    return "0.00";
  }
  
  return amount.toFixed(decimals);
}

/**
 * 根据交易对符号确定价格精度
 * 某些交易对有特定的精度要求
 * 
 * @param {string} symbol 交易对符号（如 BTC、ETH、DOGE）
 * @param {number} price 当前价格
 * @returns {number} 建议的小数位数
 */
function getDecimalPlacesBySymbol(symbol, price) {
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
  
  // BTC、ETH等高价币
  if (['BTC', 'ETH', 'BNB'].includes(symbolUpper)) {
    return Math.max(2, Math.min(4, getDecimalPlaces(price)));
  }
  
  // 默认使用价格自动判断
  return getDecimalPlaces(price);
}

/**
 * 根据币种格式化价格
 * 
 * @param {string} symbol 交易对符号
 * @param {number} price 价格
 * @returns {string} 格式化后的价格字符串
 */
function formatPriceBySymbol(symbol, price) {
  const decimals = getDecimalPlacesBySymbol(symbol, price);
  return formatPrice(price, decimals);
}

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

// AI Trading Monitor - 使用真实 API
class TradingMonitor {
    constructor() {
        this.cryptoPrices = new Map();
        this.accountData = null;
        this.equityChart = null;
        this.chartTimeframe = '24'; // 固定24小时
        this.init();
    }

    async init() {
        await this.loadInitialData();
        this.initEquityChart();
        this.initTimeframeSelector();
        this.startDataUpdates();
        this.initTabs();
        this.initChat();
        this.duplicateTicker();
        this.loadGitHubStars(); // 加载 GitHub 星标数
    }

    // 加载初始数据
    async loadInitialData() {
        try {
            await Promise.all([
                this.loadAccountData(),
                this.loadPositionsData(),
                this.loadTradesData(),
                this.loadLogsData(),
                this.loadTickerPrices()
            ]);
        } catch (error) {
            console.error('加载初始数据失败:', error);
        }
    }

    // 加载 GitHub 星标数
    async loadGitHubStars() {
        try {
            const response = await fetch('https://api.github.com/repos/losesky/ai-auto-trading');
            const data = await response.json();
            const starsCount = document.getElementById('stars-count');
            if (starsCount && data.stargazers_count !== undefined) {
                // 格式化星标数（超过1000显示 k）
                const count = data.stargazers_count;
                starsCount.textContent = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count;
            }
        } catch (error) {
            console.error('加载 GitHub 星标数失败:', error);
            const starsCount = document.getElementById('stars-count');
            if (starsCount) {
                starsCount.textContent = '-';
            }
        }
    }

    // 加载账户数据
    async loadAccountData() {
        try {
            const response = await fetch('/api/account');
            const data = await response.json();
            
            if (data.error) {
                console.error('API错误:', data.error);
                return;
            }

            this.accountData = data;
            
            // 使用和 app.js 相同的算法计算总资产
            // API 返回的 totalBalance 不包含未实现盈亏
            // 显示的总资产需要加上未实现盈亏，以便实时反映持仓盈亏
            const totalBalanceWithPnl = data.totalBalance + data.unrealisedPnl;
            
            // 更新总资产
            const accountValueEl = document.getElementById('account-value');
            if (accountValueEl) {
                accountValueEl.textContent = totalBalanceWithPnl.toFixed(2);
            }

            // 计算总盈亏和盈亏比例
            const totalPnl = totalBalanceWithPnl - data.initialBalance;
            const pnlPercent = (totalPnl / data.initialBalance) * 100;
            const isProfit = totalPnl >= 0;
            
            // 更新总盈亏
            const balancePnlEl = document.getElementById('balance-pnl');
            if (balancePnlEl) {
                balancePnlEl.textContent = `${isProfit ? '+' : ''}${totalPnl.toFixed(2)}`;
                balancePnlEl.className = 'balance-pnl ' + (isProfit ? 'positive' : 'negative');
            }
            
            // 更新盈亏比例
            const balancePercentEl = document.getElementById('balance-percent');
            if (balancePercentEl) {
                balancePercentEl.textContent = `(${isProfit ? '+' : ''}${pnlPercent.toFixed(2)}%)`;
                balancePercentEl.className = 'balance-percent ' + (isProfit ? 'positive' : 'negative');
            }

            // 更新可用余额
            const availableBalanceEl = document.getElementById('available-balance');
            if (availableBalanceEl) {
                availableBalanceEl.textContent = `${data.availableBalance.toFixed(2)} USDT`;
            }

            // 更新未实现盈亏（带符号和颜色）
            const unrealisedPnlEl = document.getElementById('unrealised-pnl');
            if (unrealisedPnlEl) {
                const pnlValue = (data.unrealisedPnl >= 0 ? '+' : '') + data.unrealisedPnl.toFixed(2);
                unrealisedPnlEl.textContent = `${pnlValue} USDT`;
                unrealisedPnlEl.className = 'metric-value ' + (data.unrealisedPnl >= 0 ? 'positive' : 'negative');
            }

            // 计算保证金比率
            // 保证金比率 = (已用保证金 / 总资产) * 100
            // 已用保证金 = 总资产 - 可用余额
            const usedMargin = totalBalanceWithPnl - data.availableBalance;
            const marginRatio = totalBalanceWithPnl > 0 ? (usedMargin / totalBalanceWithPnl) * 100 : 0;
            
            const marginRatioEl = document.getElementById('margin-ratio');
            if (marginRatioEl) {
                marginRatioEl.textContent = `${marginRatio.toFixed(2)}%`;
                // 根据保证金比率设置颜色
                if (marginRatio < 50) {
                    marginRatioEl.className = 'metric-value';
                } else if (marginRatio < 180) {
                    marginRatioEl.className = 'metric-value';
                } else {
                    marginRatioEl.className = 'metric-value negative';
                }
            }

            // 更新风险状态
            this.updateRiskStatus(marginRatio);
            
        } catch (error) {
            console.error('加载账户数据失败:', error);
        }
    }

    // 加载持仓数据
    async loadPositionsData() {
        try {
            const response = await fetch('/api/positions');
            const data = await response.json();
            
            if (data.error) {
                console.error('API错误:', data.error);
                return;
            }

            const positionsBody = document.getElementById('positions-body');
            const positionsCardsContainer = document.getElementById('positions-cards-container');
            
            if (!data.positions || data.positions.length === 0) {
                // 更新表格
                if (positionsBody) {
                    positionsBody.innerHTML = '<tr><td colspan="8" class="empty-state">暂无持仓</td></tr>';
                }
                // 更新小卡片
                if (positionsCardsContainer) {
                    positionsCardsContainer.innerHTML = '<div class="positions-cards-empty">暂无持仓</div>';
                }
                return;
            }

            // 更新加密货币价格
            data.positions.forEach(pos => {
                this.cryptoPrices.set(pos.symbol, pos.currentPrice);
            });
            this.updateTickerPrices();

            // 价格显示 - 智能精度（与交易历史统一）
            const formatPrice = (price) => {
                if (price >= 1000) {
                    return price.toFixed(2);
                } else if (price >= 1) {
                    return price.toFixed(2);
                } else if (price >= 0.1) {
                    return price.toFixed(3);
                } else if (price >= 0.01) {
                    return price.toFixed(4);
                } else if (price >= 0.001) {
                    return price.toFixed(5);
                } else {
                    return price.toFixed(6);
                }
            };

            // 更新持仓表格
            if (positionsBody) {
                positionsBody.innerHTML = data.positions.map(pos => {
                    const profitPercent = ((pos.unrealizedPnl / pos.openValue) * 100).toFixed(2);
                    
                    // 方向显示 - 与交易历史统一样式
                    const sideText = pos.side === 'long' ? 'LONG' : 'SHORT';
                    const sideClass = pos.side === 'long' ? 'long' : 'short';
                    const leverage = pos.leverage || '-';
                    
                    // 盈亏显示
                    const pnlClass = pos.unrealizedPnl >= 0 ? 'profit' : 'loss';
                    const pnlText = pos.unrealizedPnl >= 0 ? `+$${pos.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(pos.unrealizedPnl).toFixed(2)}`;
                    
                    return `
                        <tr>
                            <td><span class="symbol">${pos.symbol}</span></td>
                            <td><span class="side ${sideClass}">${sideText}</span></td>
                            <td>${leverage}x</td>
                            <td>$${formatPrice(pos.entryPrice)}</td>
                            <td>$${pos.openValue.toFixed(2)}</td>
                            <td>$${formatPrice(pos.currentPrice)}</td>
                            <td><span class="${pnlClass}">${pnlText}</span></td>
                            <td class="${pnlClass}">
                                ${pos.unrealizedPnl >= 0 ? '+' : ''}${profitPercent}%
                            </td>
                        </tr>
                    `;
                }).join('');
            }

            // 更新持仓小卡片
            if (positionsCardsContainer) {
                positionsCardsContainer.innerHTML = data.positions.map(pos => {
                    const profitPercent = ((pos.unrealizedPnl / pos.openValue) * 100).toFixed(2);
                    const sideClass = pos.side;
                    const sideText = pos.side === 'long' ? '多' : '空';
                    const pnlClass = pos.unrealizedPnl >= 0 ? 'positive' : 'negative';
                    const leverage = pos.leverage || '-';
                    
                    return `
                        <div class="position-card ${sideClass} ${pnlClass}">
                            <span class="position-card-symbol">${pos.symbol} ${leverage}x</span>
                            <span class="position-card-pnl ${pnlClass}">
                                ${sideText} ${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)} (${pos.unrealizedPnl >= 0 ? '+' : ''}${profitPercent}%)
                            </span>
                        </div>
                    `;
                }).join('');
            }
            
        } catch (error) {
            console.error('加载持仓数据失败:', error);
        }
    }

    // 加载交易记录 - 使用和 index.html 相同的布局
    async loadTradesData() {
        try {
            const response = await fetch('/api/completed-trades?limit=25');
            const data = await response.json();
            
            if (data.error) {
                console.error('API错误:', data.error);
                return;
            }

            const tradesBody = document.getElementById('trades-body');
            const countEl = document.getElementById('tradesCount');
            
            if (!data.trades || data.trades.length === 0) {
                if (tradesBody) {
                    tradesBody.innerHTML = '<tr><td colspan="10" class="empty-state">暂无交易记录</td></tr>';
                }
                if (countEl) {
                    countEl.textContent = '';
                }
                return;
            }
            
            if (countEl) {
                countEl.textContent = `(最近${data.trades.length}条)`;
            }
            
            if (tradesBody) {
                tradesBody.innerHTML = data.trades.map(trade => {
                    // 平仓时间
                    const closeDate = new Date(trade.closeTime);
                    const timeStr = `${String(closeDate.getMonth() + 1).padStart(2, '0')}/${String(closeDate.getDate()).padStart(2, '0')} ${String(closeDate.getHours()).padStart(2, '0')}:${String(closeDate.getMinutes()).padStart(2, '0')}`;
                    
                    // 方向显示
                    const sideText = trade.side === 'long' ? 'LONG' : 'SHORT';
                    const sideClass = trade.side === 'long' ? 'long' : 'short';
                    
                    // 价格显示 - 智能精度（根据价格大小动态调整小数位）
                    const formatPrice = (price) => {
                        if (price >= 1000) {
                            // 大于等于1000（如BTC），显示2位小数
                            return price.toFixed(2);
                        } else if (price >= 1) {
                            // 1到1000之间（如ETH、BNB），显示2位小数
                            return price.toFixed(2);
                        } else if (price >= 0.1) {
                            // 0.1到1之间，显示4位小数
                            return price.toFixed(4);
                        } else if (price >= 0.01) {
                            // 0.01到0.1之间，显示4位小数
                            return price.toFixed(4);
                        } else if (price >= 0.001) {
                            // 0.001到0.01之间，显示5位小数
                            return price.toFixed(5);
                        } else {
                            // 小于0.001，显示6位小数
                            return price.toFixed(6);
                        }
                    };
                    
                    // 数量显示 - 智能精度
                    let quantityText;
                    if (trade.quantity >= 1) {
                        // 大于等于1，显示整数或1位小数
                        quantityText = trade.quantity % 1 === 0 ? trade.quantity.toFixed(0) : trade.quantity.toFixed(1);
                    } else if (trade.quantity >= 0.01) {
                        // 0.01到1之间，显示2位小数
                        quantityText = trade.quantity.toFixed(2);
                    } else {
                        // 小于0.01，显示4位小数
                        quantityText = trade.quantity.toFixed(4);
                    }
                    
                    // 盈亏显示
                    const pnl = trade.pnl || 0;
                    const pnlClass = pnl >= 0 ? 'profit' : 'loss';
                    const pnlText = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
                    
                    return `
                        <tr>
                            <td>${timeStr}</td>
                            <td><span class="symbol">${trade.symbol}</span></td>
                            <td><span class="side ${sideClass}">${sideText}</span></td>
                            <td>${trade.leverage}x</td>
                            <td>$${formatPrice(trade.openPrice)}</td>
                            <td>$${formatPrice(trade.closePrice)}</td>
                            <td>${quantityText}</td>
                            <td>${trade.holdingTime}</td>
                            <td>$${trade.totalFee.toFixed(2)}</td>
                            <td><span class="${pnlClass}">${pnlText}</span></td>
                        </tr>
                    `;
                }).join('');
            }
            
        } catch (error) {
            console.error('加载交易记录失败:', error);
        }
    }

    // 加载 AI 决策日志 - 显示最新一条完整内容
    async loadLogsData() {
        try {
            const response = await fetch('/api/logs?limit=1');
            const data = await response.json();
            
            if (data.error) {
                console.error('API错误:', data.error);
                return;
            }

            const decisionContent = document.getElementById('decision-content');
            const decisionMeta = document.getElementById('decision-meta');
            
            if (data.logs && data.logs.length > 0) {
                const log = data.logs[0]; // 只取最新一条
                
                // 更新决策元信息
                if (decisionMeta) {
                    const timestamp = new Date(log.timestamp).toLocaleString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                    
                    decisionMeta.innerHTML = `
                        <span class="decision-time">${timestamp}</span>
                        <span class="decision-iteration">#${log.iteration}</span>
                    `;
                }
                
                // 更新决策详细内容
                if (decisionContent) {
                    const decision = log.decision || log.actionsTaken || '暂无决策内容';
                    // 使用 marked 库将 markdown 转换为 HTML
                    const htmlContent = marked.parse(decision);
                    
                    decisionContent.innerHTML = `<div class="decision-text markdown-content">${htmlContent}</div>`;
                }
            } else {
                if (decisionContent) {
                    decisionContent.innerHTML = '<p class="no-data">暂无 AI 决策记录</p>';
                }
                if (decisionMeta) {
                    decisionMeta.innerHTML = '<span class="decision-time">无数据</span>';
                }
            }
            
        } catch (error) {
            console.error('加载日志失败:', error);
            const decisionContent = document.getElementById('decision-content');
            if (decisionContent) {
                decisionContent.innerHTML = `<p class="error">加载失败: ${error.message}</p>`;
            }
        }
    }

    // 加载顶部 Ticker 价格（从 API 获取）
    async loadTickerPrices() {
        try {
            // 从 HTML 中获取所有需要显示价格的币种
            const tickerItems = document.querySelectorAll('.ticker-item .crypto-name');
            const symbols = Array.from(tickerItems).map(el => el.textContent.trim()).join(',');
            const response = await fetch(`/api/prices?symbols=${symbols}`);
            const data = await response.json();
            
            if (data.error) {
                console.error('获取价格失败:', data.error);
                return;
            }
            
            // 更新价格缓存
            Object.entries(data.prices).forEach(([symbol, price]) => {
                this.cryptoPrices.set(symbol, price);
            });
            
            // 更新显示
            this.updateTickerPrices();
        } catch (error) {
            console.error('加载 Ticker 价格失败:', error);
        }
    }

    // 更新价格滚动条
    updateTickerPrices() {
        this.cryptoPrices.forEach((price, symbol) => {
                const priceElements = document.querySelectorAll(`[data-symbol="${symbol}"]`);
                priceElements.forEach(el => {
                const decimals = price < 1 ? 4 : 2;
                el.textContent = '$' + price.toFixed(decimals);
            });
        });
    }

    // 启动数据更新
    startDataUpdates() {
        // 每3秒更新账户和持仓（实时数据）
        setInterval(async () => {
            await Promise.all([
                this.loadAccountData(),
                this.loadPositionsData()
            ]);
        }, 3000);

        // 每10秒更新价格（实时价格）
        setInterval(async () => {
            await this.loadTickerPrices();
        }, 10000);

        // 每30秒更新交易记录和日志
        setInterval(async () => {
            await Promise.all([
                this.loadTradesData(),
                this.loadLogsData()
            ]);
        }, 30000);

        // 每30秒更新资产曲线图表
        setInterval(async () => {
            await this.updateEquityChart();
        }, 30000);
    }

    // 复制ticker内容实现无缝滚动
    duplicateTicker() {
        const ticker = document.getElementById('ticker');
        if (ticker) {
            const tickerContent = ticker.innerHTML;
            ticker.innerHTML = tickerContent + tickerContent + tickerContent;
        }
    }

    // 初始化选项卡（简化版，只有一个选项卡）
    initTabs() {
        // 已经只有一个选项卡，不需要切换功能
    }

    // 初始化聊天功能（已移除）
    initChat() {
        // 聊天功能已移除
    }

    // 初始化资产曲线图表
    async initEquityChart() {
        const ctx = document.getElementById('equityChart');
        if (!ctx) {
            console.error('未找到图表canvas元素');
            return;
        }

        // 加载历史数据
        const historyData = await this.loadEquityHistory();
        
        console.log('资产历史数据:', historyData);
        
        if (!historyData || historyData.length === 0) {
            console.log('暂无历史数据，图表将在有数据后显示');
            // 显示提示信息
            const container = ctx.parentElement;
            if (container) {
                const message = document.createElement('div');
                message.className = 'no-data';
                message.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #00cc88; text-align: center;';
                message.innerHTML = '暂无历史数据<br><small style="color: #008866;">系统将每10分钟自动记录账户资产</small>';
                container.appendChild(message);
            }
            return;
        }

        // 创建图表
        this.equityChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: historyData.map(d => {
                    const date = new Date(d.timestamp);
                    return date.toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                }),
                datasets: [
                    {
                        label: '总资产 (USDT)',
                        data: historyData.map(d => parseFloat(d.totalValue.toFixed(2))),
                        borderColor: 'rgb(0, 255, 170)',
                        backgroundColor: 'rgba(0, 255, 170, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#fff',
                            usePointStyle: true,
                            padding: 15
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(17, 24, 39, 0.95)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgb(59, 130, 246)',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += '$' + context.parsed.y;
                                }
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#9ca3af',
                            maxRotation: 45,
                            minRotation: 0,
                            maxTicksLimit: 10
                        }
                    },
                    y: {
                        display: true,
                        position: 'left',
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#9ca3af',
                            callback: function(value) {
                                return '$' + value.toFixed(2);
                            }
                        }
                    }
                }
            }
        });
    }

    // 加载资产历史数据
    async loadEquityHistory() {
        try {
            // 获取全部历史数据
            const response = await fetch(`/api/history`);
            const data = await response.json();
            
            if (data.error) {
                console.error('API错误:', data.error);
                return [];
            }
            
            return data.history || [];
        } catch (error) {
            console.error('加载资产历史数据失败:', error);
            return [];
        }
    }

    // 更新资产曲线图表
    async updateEquityChart() {
        if (!this.equityChart) {
            await this.initEquityChart();
            return;
        }

        const historyData = await this.loadEquityHistory();
        
        if (!historyData || historyData.length === 0) {
            return;
        }

        // 更新图表数据
        this.equityChart.data.labels = historyData.map(d => {
            const date = new Date(d.timestamp);
            return date.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        });
        
        this.equityChart.data.datasets[0].data = historyData.map(d => 
            parseFloat(d.totalValue.toFixed(2))
        );
        
        // 固定不显示圆点
        this.equityChart.data.datasets[0].pointRadius = 0;
        
        this.equityChart.update('none'); // 无动画更新
    }

    // 更新风险状态
    updateRiskStatus(marginRatio) {
        const riskStatusEl = document.querySelector('.risk-status');
        const statusLabelEl = document.querySelector('.status-label');
        const statusDescEl = document.getElementById('risk-status-desc');
        
        if (!riskStatusEl || !statusLabelEl || !statusDescEl) return;
        
        // 移除所有状态类
        riskStatusEl.classList.remove('safe', 'warning', 'danger');
        
        if (marginRatio < 50) {
            // 安全状态
            riskStatusEl.classList.add('safe');
            statusLabelEl.textContent = '风险状态：安全';
            statusDescEl.textContent = '保证金比率低于50%为安全，超过180%需警惕';
        } else if (marginRatio < 180) {
            // 警告状态
            riskStatusEl.classList.add('warning');
            statusLabelEl.textContent = '风险状态：警告';
            statusDescEl.textContent = '保证金比率在50%-180%之间，建议关注仓位';
        } else {
            // 危险状态
            riskStatusEl.classList.add('danger');
            statusLabelEl.textContent = '风险状态：危险';
            statusDescEl.textContent = '保证金比率超过180%，强烈建议降低仓位！';
        }
    }
}

// 初始化监控系统
document.addEventListener('DOMContentLoaded', () => {
    const monitor = new TradingMonitor();
});

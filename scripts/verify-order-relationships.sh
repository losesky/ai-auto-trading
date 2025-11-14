#!/bin/bash

# ai-auto-trading - AI 加密货币自动交易系统
# Copyright (C) 2025 losesky
# 
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
# 
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

# =====================================================
# 订单关系验证脚本
# 用于验证 trades, price_orders, position_close_events 之间的关联关系
# =====================================================

set -e

echo "=================================================="
echo "  订单ID关联关系验证"
echo "=================================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 检查 .env 文件
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  未找到 .env 文件${NC}"
    exit 1
fi

source .env

DATABASE_URL=${DATABASE_URL:-"file:./.voltagent/trading.db"}

# 检查数据库文件
if [[ $DATABASE_URL == file:* ]]; then
    DB_FILE="${DATABASE_URL#file:}"
else
    echo -e "${RED}❌ 不支持的数据库类型: $DATABASE_URL${NC}"
    exit 1
fi

if [ ! -f "$DB_FILE" ]; then
    echo -e "${RED}❌ 数据库文件不存在: $DB_FILE${NC}"
    exit 1
fi

# =====================================================
# 1. 验证平仓事件的 order_id 与 trades 表一致性
# =====================================================
echo -e "${CYAN}📊 1. 验证平仓事件与交易记录一致性${NC}"
echo "=================================================="

CONSISTENCY_CHECK=$(sqlite3 "$DB_FILE" <<EOF
.headers on
.mode column
SELECT 
  pce.id as event_id,
  pce.order_id as close_event_order_id,
  t.order_id as trade_order_id,
  pce.close_reason,
  pce.trigger_type,
  CASE 
    WHEN t.order_id IS NULL THEN '❌ 不一致'
    ELSE '✅ 一致'
  END as consistency_status
FROM position_close_events pce
LEFT JOIN trades t ON pce.order_id = t.order_id AND t.type = 'close'
ORDER BY pce.created_at DESC;
EOF
)

if [ -z "$CONSISTENCY_CHECK" ]; then
    echo -e "${YELLOW}(无平仓事件记录)${NC}"
else
    echo "$CONSISTENCY_CHECK"
    
    # 检查是否有不一致的记录
    INCONSISTENT_COUNT=$(sqlite3 "$DB_FILE" <<EOF
SELECT COUNT(*) 
FROM position_close_events pce
LEFT JOIN trades t ON pce.order_id = t.order_id AND t.type = 'close'
WHERE t.order_id IS NULL;
EOF
)
    
    echo ""
    if [ "$INCONSISTENT_COUNT" -gt 0 ]; then
        echo -e "${RED}❌ 发现 $INCONSISTENT_COUNT 条不一致记录${NC}"
    else
        echo -e "${GREEN}✅ 所有平仓事件与交易记录一致${NC}"
    fi
fi

echo ""
echo ""

# =====================================================
# 2. 验证条件单与持仓的关联关系
# =====================================================
echo -e "${CYAN}📊 2. 验证条件单与开仓订单关联${NC}"
echo "=================================================="

PRICE_ORDER_LINKS=$(sqlite3 "$DB_FILE" <<EOF
.headers on
.mode column
SELECT 
  po.order_id as condition_order_id,
  po.position_order_id,
  po.type as order_type,
  po.status,
  t.order_id as open_trade_id,
  t.price as open_price,
  t.timestamp as open_time,
  CASE 
    WHEN t.order_id IS NULL AND po.position_order_id IS NOT NULL THEN '⚠️  未找到开仓记录'
    WHEN po.position_order_id IS NULL THEN '⚠️  未关联开仓订单'
    ELSE '✅ 正常关联'
  END as link_status
FROM price_orders po
LEFT JOIN trades t ON po.position_order_id = t.order_id AND t.type = 'open'
ORDER BY po.created_at DESC;
EOF
)

if [ -z "$PRICE_ORDER_LINKS" ]; then
    echo -e "${YELLOW}(无条件单记录)${NC}"
else
    echo "$PRICE_ORDER_LINKS"
    
    # 检查是否有未关联的条件单
    UNLINKED_COUNT=$(sqlite3 "$DB_FILE" <<EOF
SELECT COUNT(*) 
FROM price_orders po
WHERE po.position_order_id IS NULL;
EOF
)
    
    echo ""
    if [ "$UNLINKED_COUNT" -gt 0 ]; then
        echo -e "${YELLOW}⚠️  发现 $UNLINKED_COUNT 条未关联开仓订单的条件单${NC}"
    else
        echo -e "${GREEN}✅ 所有条件单已正确关联开仓订单${NC}"
    fi
fi

echo ""
echo ""

# =====================================================
# 3. 追溯完整交易链路（最近3条）
# =====================================================
echo -e "${CYAN}📊 3. 完整交易链路追溯（最近3条平仓）${NC}"
echo "=================================================="

RECENT_CLOSES=$(sqlite3 "$DB_FILE" <<EOF
SELECT id, symbol, side, close_reason, order_id, created_at
FROM position_close_events
ORDER BY created_at DESC
LIMIT 3;
EOF
)

if [ -z "$RECENT_CLOSES" ]; then
    echo -e "${YELLOW}(无平仓记录)${NC}"
else
    # 遍历每条平仓记录，展示完整链路
    echo "$RECENT_CLOSES" | while IFS='|' read -r event_id symbol side close_reason order_id created_at; do
        echo ""
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${YELLOW}🔍 平仓事件 #$event_id: $symbol $side${NC}"
        echo -e "   平仓原因: $close_reason"
        echo -e "   平仓时间: $created_at"
        echo ""
        
        # 查找关联的开仓记录
        OPEN_TRADE=$(sqlite3 "$DB_FILE" <<EOF2
.mode list
.separator '|'
SELECT order_id, price, quantity, timestamp
FROM trades
WHERE symbol = '$symbol' AND side = '$side' AND type = 'open'
ORDER BY timestamp DESC
LIMIT 1;
EOF2
)
        
        if [ -n "$OPEN_TRADE" ]; then
            echo "$OPEN_TRADE" | while IFS='|' read -r open_order_id open_price open_qty open_time; do
                echo -e "   ${GREEN}1️⃣ 开仓订单:${NC}"
                echo -e "      订单ID: $open_order_id"
                echo -e "      价格: $open_price"
                echo -e "      数量: $open_qty"
                echo -e "      时间: $open_time"
                echo ""
                
                # 查找关联的条件单
                CONDITIONS=$(sqlite3 "$DB_FILE" <<EOF3
.mode list
.separator '|'
SELECT order_id, type, trigger_price, status
FROM price_orders
WHERE position_order_id = '$open_order_id'
ORDER BY type;
EOF3
)
                
                if [ -n "$CONDITIONS" ]; then
                    echo -e "   ${GREEN}2️⃣ 条件单:${NC}"
                    echo "$CONDITIONS" | while IFS='|' read -r cond_id cond_type trigger_price cond_status; do
                        status_icon="⚪"
                        if [ "$cond_status" = "triggered" ]; then
                            status_icon="🔴"
                        elif [ "$cond_status" = "cancelled" ]; then
                            status_icon="⚫"
                        fi
                        
                        type_name="止损"
                        if [ "$cond_type" = "take_profit" ]; then
                            type_name="止盈"
                        fi
                        
                        echo -e "      $status_icon $type_name单 ($cond_id): 触发价=$trigger_price, 状态=$cond_status"
                    done
                    echo ""
                fi
            done
        fi
        
        # 查找平仓交易记录
        CLOSE_TRADE=$(sqlite3 "$DB_FILE" <<EOF4
.mode list
.separator '|'
SELECT order_id, price, quantity, pnl, fee, timestamp
FROM trades
WHERE order_id = '$order_id' AND type = 'close'
LIMIT 1;
EOF4
)
        
        if [ -n "$CLOSE_TRADE" ]; then
            echo "$CLOSE_TRADE" | while IFS='|' read -r close_order_id close_price close_qty pnl fee close_time; do
                echo -e "   ${GREEN}3️⃣ 平仓交易:${NC}"
                echo -e "      订单ID: $close_order_id"
                echo -e "      价格: $close_price"
                echo -e "      数量: $close_qty"
                echo -e "      盈亏: $pnl USDT"
                echo -e "      手续费: $fee USDT"
                echo -e "      时间: $close_time"
            done
        else
            echo -e "   ${RED}❌ 未找到平仓交易记录 (order_id: $order_id)${NC}"
        fi
        
        echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    done
fi

echo ""
echo ""

# =====================================================
# 4. 数据完整性汇总
# =====================================================
echo -e "${CYAN}📊 4. 数据完整性汇总${NC}"
echo "=================================================="

TOTAL_TRADES=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM trades;")
TOTAL_OPENS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM trades WHERE type = 'open';")
TOTAL_CLOSES=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM trades WHERE type = 'close';")
TOTAL_PRICE_ORDERS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM price_orders;")
TOTAL_CLOSE_EVENTS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM position_close_events;")
TOTAL_INCONSISTENT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM inconsistent_states WHERE resolved = 0;")

echo "📝 交易记录总数: $TOTAL_TRADES"
echo "   ├─ 开仓: $TOTAL_OPENS"
echo "   └─ 平仓: $TOTAL_CLOSES"
echo ""
echo "📋 条件单总数: $TOTAL_PRICE_ORDERS"
ACTIVE_ORDERS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM price_orders WHERE status = 'active';")
TRIGGERED_ORDERS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM price_orders WHERE status = 'triggered';")
CANCELLED_ORDERS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM price_orders WHERE status = 'cancelled';")
echo "   ├─ 活跃: $ACTIVE_ORDERS"
echo "   ├─ 已触发: $TRIGGERED_ORDERS"
echo "   └─ 已取消: $CANCELLED_ORDERS"
echo ""
echo "🔔 平仓事件总数: $TOTAL_CLOSE_EVENTS"
echo ""

if [ "$TOTAL_INCONSISTENT" -gt 0 ]; then
    echo -e "${RED}⚠️  未解决的数据不一致: $TOTAL_INCONSISTENT 条${NC}"
else
    echo -e "${GREEN}✅ 无数据不一致记录${NC}"
fi

echo ""

# =====================================================
# 5. 关键指标验证
# =====================================================
echo -e "${CYAN}📊 5. 关键指标验证${NC}"
echo "=================================================="

# 验证1: 平仓数量 = 平仓事件数量
if [ "$TOTAL_CLOSES" -eq "$TOTAL_CLOSE_EVENTS" ]; then
    echo -e "${GREEN}✅ 平仓交易数 = 平仓事件数 ($TOTAL_CLOSES)${NC}"
else
    echo -e "${RED}❌ 平仓交易数 ($TOTAL_CLOSES) ≠ 平仓事件数 ($TOTAL_CLOSE_EVENTS)${NC}"
fi

# 验证2: 每个开仓应该有对应的条件单（除非是测试数据）
OPENS_WITHOUT_CONDITIONS=$(sqlite3 "$DB_FILE" <<EOF
SELECT COUNT(DISTINCT t.order_id)
FROM trades t
LEFT JOIN price_orders po ON t.order_id = po.position_order_id
WHERE t.type = 'open' AND po.order_id IS NULL;
EOF
)

if [ "$OPENS_WITHOUT_CONDITIONS" -eq 0 ]; then
    echo -e "${GREEN}✅ 所有开仓订单都有关联的条件单${NC}"
else
    echo -e "${YELLOW}⚠️  发现 $OPENS_WITHOUT_CONDITIONS 个开仓订单没有关联条件单${NC}"
fi

# 验证3: 检查是否有孤儿条件单（position_order_id 指向不存在的开仓订单）
ORPHAN_CONDITIONS=$(sqlite3 "$DB_FILE" <<EOF
SELECT COUNT(*)
FROM price_orders po
LEFT JOIN trades t ON po.position_order_id = t.order_id AND t.type = 'open'
WHERE po.position_order_id IS NOT NULL AND t.order_id IS NULL;
EOF
)

if [ "$ORPHAN_CONDITIONS" -eq 0 ]; then
    echo -e "${GREEN}✅ 无孤儿条件单${NC}"
else
    echo -e "${RED}❌ 发现 $ORPHAN_CONDITIONS 个孤儿条件单（关联的开仓订单不存在）${NC}"
fi

echo ""
echo "=================================================="
echo -e "${GREEN}✅ 验证完成${NC}"
echo "=================================================="

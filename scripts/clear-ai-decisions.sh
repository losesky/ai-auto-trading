#!/bin/bash
# 清理AI决策记录表中的所有数据（SQLite版本）

# 数据库文件路径
DB_PATH="/home/losesky/ai-auto-trading/.voltagent/trading.db"

echo "正在清理 agent_decisions 表中的所有数据..."

# 执行 SQL 删除操作
sqlite3 "$DB_PATH" << EOF
DELETE FROM agent_decisions;
EOF

echo "清理完成！"
echo ""
echo "验证清理结果："
sqlite3 "$DB_PATH" << EOF
SELECT COUNT(*) as remaining_records FROM agent_decisions;
EOF


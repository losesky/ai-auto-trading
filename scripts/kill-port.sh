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

# 清理占用端口的进程

PORT=${1:-3101}

echo "🔍 查找占用端口 $PORT 的进程..."

PID=$(lsof -ti :$PORT)

if [ -z "$PID" ]; then
    echo "✅ 端口 $PORT 未被占用"
    exit 0
fi

echo "⚠️  发现进程 $PID 占用端口 $PORT"
echo "正在终止进程..."

kill -9 $PID

if [ $? -eq 0 ]; then
    echo "✅ 进程已终止，端口已释放"
else
    echo "❌ 终止进程失败"
    exit 1
fi


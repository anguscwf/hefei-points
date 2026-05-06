#!/bin/bash
# ===================================================
# 赫菲积分 - 开发环境部署脚本（在服务器上执行）
# ===================================================
# 功能：为小程序开发创建独立的 3002 端口服务
# 不影响生产环境 3001 端口
# ===================================================

set -e

PROD_DIR="$HOME/hefei-points"
DEV_DIR="$HOME/hefei-points-dev"

echo "=== 1. 创建开发环境目录 ==="
if [ -d "$DEV_DIR" ]; then
  echo "⚠️  $DEV_DIR 已存在，跳过复制"
else
  cp -r "$PROD_DIR" "$DEV_DIR"
  echo "✅ 已复制 $PROD_DIR → $DEV_DIR"
fi

echo ""
echo "=== 2. 修改开发环境端口为 3002 ==="
cd "$DEV_DIR"
# 把 server.js 里的 3001 改为 3002
sed -i 's/3001/3002/g' server.js
echo "✅ 端口已改为 3002"

echo ""
echo "=== 3. 清空开发数据（从生产复制一份干净的） ==="
rm -rf data/
cp -r "$PROD_DIR/data/" ./data/
echo "✅ 开发数据已初始化（和生产当前数据一致）"

echo ""
echo "=== 4. 停止旧的开发服务器（如果有） ==="
sudo fuser -k 3002/tcp 2>/dev/null && echo "已停止旧进程" || echo "无旧进程"

echo ""
echo "=== 5. 启动开发服务器 ==="
nohup node server.js > /dev/null 2>&1 &
sleep 2

echo ""
echo "=== 6. 验证 ==="
if curl -s --noproxy '*' "http://localhost:3002/api/config" | grep -q '"success":true'; then
  echo "✅ 开发服务器启动成功！"
  echo "   API: http://159.75.102.145:3002"
  echo "   数据目录: $DEV_DIR/data/"
else
  echo "❌ 启动失败，请检查日志"
fi

echo ""
echo "=== 完成 ==="
echo "生产环境: http://159.75.102.145:3001 (不变)"
echo "开发环境: http://159.75.102.145:3002 (新建)"
echo ""
echo "⚠️ 开发环境的 data/ 是生产数据的副本，之后完全独立"

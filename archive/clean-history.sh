#!/bin/bash
# ===================================================
# 糖罐积分 - 清理测试历史记录
# 在服务器上执行: bash clean-history.sh
# ===================================================
# 
# 步骤：
# 1. 备份当前 history.json
# 2. 更新 server.js（添加删除接口）
# 3. 重启服务
# 4. 删除 6 条测试记录
# 5. 验证
# ===================================================

set -e

APP_DIR="$HOME/hefei-points"
DATA_DIR="$APP_DIR/data"
BACKUP_DIR="$APP_DIR/backups"
HISTORY_FILE="$DATA_DIR/history.json"

echo "=== 1. 备份 history.json ==="
cp "$HISTORY_FILE" "$BACKUP_DIR/history_before_clean_$(date +%Y%m%d_%H%M%S).json"
echo "✅ 已备份"

echo ""
echo "=== 2. 更新 server.js（添加 /api/history/delete） ==="
# 注入删除端点到 server.js（在 /api/history/note 后面）
cd "$APP_DIR"

# 检查是否已有 delete 端点
if grep -q "/api/history/delete" server.js; then
  echo "✅ delete 端点已存在，跳过"
else
  # 使用 sed 在 /api/history/note 闭包后插入 delete 端点
  # 找到 "// ============== 获取配置" 这行，在它前面插入
  INSERT_MARKER="// ============== 获取配置"
  DELETE_CODE=$(cat <<'ENDOFCODE'

// ============== 删除历史记录（admin + parent） ==============
app.post('/api/history/delete', (req, res) => {
  const { token, recordId } = req.body;
  const user = requireRole(token, ['admin', 'parent']);
  if (!user) return res.status(403).json({ success: false, message: '无操作权限' });
  try {
    withLock('history_delete', () => {
      const history = loadJSON(HISTORY_FILE, []);
      const idx = history.findIndex(r => r.id === recordId);
      if (idx === -1) throw new Error('记录不存在');
      history.splice(idx, 1);
      saveJSON(HISTORY_FILE, history);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.message === '记录不存在' ? 404 : 503).json({ success: false, message: e.message || '删除失败' });
  }
});

ENDOFCODE
)
  sed -i "/^${INSERT_MARKER}/i ${DELETE_CODE}" server.js
  echo "✅ delete 端点已添加"
fi

echo ""
echo "=== 3. 重启服务 ==="
sudo fuser -k 3001/tcp 2>/dev/null && echo "已停止旧进程" || echo "无旧进程"
sleep 1
nohup node server.js > /dev/null 2>&1 &
sleep 2

# 验证服务启动
if curl -s --noproxy '*' "http://localhost:3001/api/config" | grep -q '"success":true'; then
  echo "✅ 服务已重启"
else
  echo "❌ 服务启动失败！请检查日志"
  exit 1
fi

echo ""
echo "=== 4. 登录获取 token ==="
LOGIN_RESP=$(curl -s --noproxy '*' -X POST http://localhost:3001/api/auth \
  -H "Content-Type: application/json" \
  -d '{"userId":"ceshijiazhang","password":"123456"}')
TOKEN=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:30}..."

echo ""
echo "=== 5. 删除 6 条测试记录 ==="

IDS=(
  1778053319846  # 恩赫 -1 测试扣1 (15:41:59)
  1778053319715  # 恩赫 +1 v4.0测试 (15:41:59)
  1778078120561  # 恩菲 -5 测试用 (22:35:20)
  1778078120397  # 恩赫 +3 测试用 (22:35:20)
  1778078721204  # 恩菲 +5 测试扣的分给补回来 (22:45:21)
  1778078782633  # 恩赫 -3 测试加的分给补回来 (22:46:22)
)

for id in "${IDS[@]}"; do
  result=$(curl -s --noproxy '*' -X POST http://localhost:3001/api/history/delete \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$TOKEN\",\"recordId\":$id}")
  if echo "$result" | grep -q '"success":true'; then
    echo "✅ 已删除: $id"
  else
    echo "⚠️  删除失败: $id → $result"
  fi
done

echo ""
echo "=== 6. 验证历史记录 ==="
REMAINING=$(curl -s --noproxy '*' "http://localhost:3001/api/history?token=$TOKEN")
COUNT=$(echo "$REMAINING" | grep -o '"id":' | wc -l)
echo "当前历史记录数: $COUNT 条"
echo ""
echo "近期记录："
curl -s --noproxy '*' "http://localhost:3001/api/history?token=$TOKEN" | \
  grep -oP '"time":"[^"]*"|"kidName":"[^"]*"|"amount":-?[0-9]+|"reason":"[^"]*"' | \
  paste - - - - | head -15

echo ""
echo "=== 完成 ==="
echo "⚠️  服务器重启后 token 已失效，全家人需要重新登录"

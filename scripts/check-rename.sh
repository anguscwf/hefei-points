#!/usr/bin/env bash
# -*- coding: utf-8 -*-
# ============================================================
# 糖罐积分 · 改名验收自检脚本（A0-13）
# ------------------------------------------------------------
# 用途：DeepSeek 跑完 A0 改名补丁包后，跑此脚本验收
# 期望：「赫菲」「恩霖」在生产/开发代码中 0 残留
# 例外：archive/ 目录 + 旧路线图文件（v1/v2）保留作历史
#
# 用法：bash scripts/check-rename.sh
# ============================================================

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || { echo "❌ 切换到项目根目录失败：$ROOT"; exit 2; }

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}=== 糖罐积分改名验收自检 ===${NC}"
echo "项目根：$ROOT"
echo "时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ============== 检查项 ==============
EXCLUDE_PATHS=(
  "archive/"
  "赫菲积分变现路线图v1-20260506.md"
  "赫菲积分变现路线图v2-20260507.md"
  "scripts/check-rename.sh"
  ".git/"
  "node_modules/"
)

build_grep_args() {
  local args=""
  for p in "${EXCLUDE_PATHS[@]}"; do
    args+=" --exclude-dir=${p%/}"
  done
  echo "$args"
}

EXCL=$(build_grep_args)

# ---- 检查 1 · 赫菲 残留 ----
echo -e "${BOLD}[1/4] 检查「赫菲」残留（应 0 命中）${NC}"
HEFEI_HITS=$(grep -rn "赫菲" $EXCL . 2>/dev/null | grep -v "^Binary file" | grep -vE "(archive/|赫菲积分变现路线图v[12])")
if [ -z "$HEFEI_HITS" ]; then
  echo -e "  ${GREEN}✓ 「赫菲」0 命中${NC}"
  HEFEI_PASS=1
else
  CNT=$(echo "$HEFEI_HITS" | wc -l)
  echo -e "  ${RED}✗ 「赫菲」残留 $CNT 处：${NC}"
  echo "$HEFEI_HITS" | sed 's/^/    /'
  HEFEI_PASS=0
fi
echo ""

# ---- 检查 2 · 恩霖 残留 ----
echo -e "${BOLD}[2/4] 检查「恩霖」残留（应 0 命中）${NC}"
ENLIN_HITS=$(grep -rn "恩霖" $EXCL . 2>/dev/null | grep -v "^Binary file" | grep -vE "(archive/|赫菲积分变现路线图v[12])")
if [ -z "$ENLIN_HITS" ]; then
  echo -e "  ${GREEN}✓ 「恩霖」0 命中${NC}"
  ENLIN_PASS=1
else
  CNT=$(echo "$ENLIN_HITS" | wc -l)
  echo -e "  ${RED}✗ 「恩霖」残留 $CNT 处：${NC}"
  echo "$ENLIN_HITS" | sed 's/^/    /'
  ENLIN_PASS=0
fi
echo ""

# ---- 检查 3 · 糖罐落地度（应 ≥ 5 命中）----
echo -e "${BOLD}[3/4] 检查「糖罐」落地度（期望 ≥ 5 处）${NC}"
TANGGUAN_HITS=$(grep -rn "糖罐" $EXCL . 2>/dev/null | grep -v "^Binary file" | wc -l)
echo "  「糖罐」命中数：$TANGGUAN_HITS"
if [ "$TANGGUAN_HITS" -ge 5 ]; then
  echo -e "  ${GREEN}✓ 糖罐已落地${NC}"
  TANGGUAN_PASS=1
else
  echo -e "  ${YELLOW}⚠ 糖罐落地数偏少，请检查 A0 补丁包是否漏改${NC}"
  TANGGUAN_PASS=0
fi
echo ""

# ---- 检查 4 · 文件名残留（enlin-avatar）----
echo -e "${BOLD}[4/4] 检查 enlin-avatar 文件名（应已重命名为 tangguan-avatar）${NC}"
if [ -f hefei-miniapp/images/enlin-avatar.svg ] || [ -f hefei-miniapp/images/enlin-avatar.png ]; then
  echo -e "  ${YELLOW}⚠ enlin-avatar.svg/png 仍存在（A0-5 待执行：git mv enlin-avatar.* tangguan-avatar.*）${NC}"
  AVATAR_PASS=0
elif [ -f hefei-miniapp/images/tangguan-avatar.svg ] || [ -f hefei-miniapp/images/tangguan-avatar.png ]; then
  echo -e "  ${GREEN}✓ tangguan-avatar 已存在${NC}"
  AVATAR_PASS=1
else
  echo -e "  ${YELLOW}⚠ 头像文件不存在（既无 enlin- 也无 tangguan-）${NC}"
  AVATAR_PASS=0
fi
echo ""

# ============== 总结 ==============
echo -e "${BOLD}=== 验收总结 ===${NC}"
TOTAL_PASS=$((HEFEI_PASS + ENLIN_PASS + TANGGUAN_PASS + AVATAR_PASS))
echo "通过项：$TOTAL_PASS / 4"
echo ""

if [ "$HEFEI_PASS" -eq 1 ] && [ "$ENLIN_PASS" -eq 1 ]; then
  echo -e "${GREEN}${BOLD}✅ A0 改名验收通过：赫菲/恩霖在生产/开发代码中 0 残留${NC}"
  echo "   仅 archive/ 与历史路线图保留旧名（设计如此）"
  if [ "$AVATAR_PASS" -eq 0 ]; then
    echo -e "${YELLOW}   注：A0-5 头像替换可后续补做${NC}"
  fi
  exit 0
else
  echo -e "${RED}${BOLD}❌ A0 改名验收未通过：请按补丁包逐条修复${NC}"
  echo "   补丁包：~/wb-soul/docs/糖罐积分-A0改名补丁包v1-20260515.md"
  exit 1
fi

#!/usr/bin/env bash
# dmg 装订（staple）：electron-builder 的 notarize 只作用于 .app，dmg 必须单独补一次。
# 前置：公证已成功（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD 凭据齐全）。
# 用法：npm run staple   （构建并公证成功后执行）
set -euo pipefail
# 项目根按脚本自身位置定位（同 release.sh：$0 被 source 时指向父 shell，会 cd 错目录）
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

shopt -s nullglob
dmgs=(dist/*.dmg)
if [[ ${#dmgs[@]} -eq 0 ]]; then
  echo "✗ dist/ 里没有 dmg，先 npm run package" >&2
  exit 1
fi

for f in "${dmgs[@]}"; do
  echo "▸ stapler staple $(basename "$f")"
  xcrun stapler staple "$f"
  xcrun stapler validate "$f"
  echo "✓ 已装订并验证 $(basename "$f")"
done
echo "完成：$((${#dmgs[@]})) 个 dmg 已装订，Gatekeeper 离线校验可通过"

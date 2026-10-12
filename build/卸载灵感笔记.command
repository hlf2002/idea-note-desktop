#!/bin/bash
# ============================================================
# 灵感笔记 · macOS 卸载脚本
# 彻底卸载：删除应用本体 + 全部本地数据（登录态、缓存等）
# 执行后重新安装即为全新状态，需要重新扫码登录
# ============================================================

APP="/Applications/灵感笔记.app"
APP_USER="$HOME/Applications/灵感笔记.app"

# 三个已知数据目录（登录态互为镜像，全部删除才能保证下次安装必须重新登录）
DATA_DIRS=(
  "$HOME/Library/Application Support/flomo-local"
  "$HOME/Library/Application Support/idea-note-local"
  "$HOME/Library/Application Support/灵感笔记"
)

# 缓存 / 日志 / 偏好设置
OTHER_DIRS=(
  "$HOME/Library/Caches/灵感笔记"
  "$HOME/Library/Caches/idea-note-local"
  "$HOME/Library/Logs/灵感笔记"
)
PREFS=(
  "$HOME/Library/Preferences/com.ideanote.desktop.plist"
)

echo "============================================================"
echo " 灵感笔记 卸载"
echo " 将删除：应用本体 + 全部本地数据（登录态、笔记缓存）"
echo " 删除后无法恢复，重新安装需重新扫码登录。"
echo "============================================================"

# 应用运行中则拒绝，避免删除不完整
if pgrep -f "灵感笔记.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "灵感笔记正在运行，请先退出应用（菜单栏/活动监视器退出）后再执行本脚本。"
  exit 1
fi

read -p "确认彻底卸载？输入 y 继续，其它任意键取消: " ans
if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
  echo "已取消，未做任何删除。"
  exit 0
fi

# 1) 应用本体
for p in "$APP" "$APP_USER"; do
  if [ -e "$p" ]; then
    rm -rf "$p" && echo "已删除应用: $p"
  fi
done

# 2) 数据目录（登录态 / 缓存 / 窗口状态）
for d in "${DATA_DIRS[@]}" "${OTHER_DIRS[@]}"; do
  if [ -e "$d" ]; then
    rm -rf "$d" && echo "已删除数据: $d"
  fi
done

# 3) 偏好设置
for f in "${PREFS[@]}"; do
  if [ -e "$f" ]; then
    rm -f "$f" && echo "已删除偏好: $f"
  fi
done

echo "------------------------------------------------------------"
echo "卸载完成。灵感笔记及其本地数据已全部清除，"
echo "重新安装后将需要重新扫码登录。"

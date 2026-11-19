#!/usr/bin/env bash
# 补票入口：对已生成的交付目录补「签名 + 公证 + 装订」并按实际字节重算清单
#
# 正常打包（npm run package:mac）不需要它：release.sh 在 stage 之前就已就地装订
# dist/*.dmg，随后复制进 dist/package 的是最终字节，清单 sha512 一次算准。
# 本脚本用于两类补票场景：
#   1) 历史产物（构建时未配公证凭据，事后补票）
#   2) 装订 / 换包之后需要按实际字节重算 latest-mac.yml
#
# 签名/公证/装订的机制在 scripts/dmg-notarize.sh，本脚本只额外负责
# dmg.blockmap 重生成与清单刷新，避免两套提交逻辑漂移。
#
# 用法：
#   set -a; . ./.env; set +a; npm run staple     # 默认处理 dist/package
#   DRY_RUN=1 npm run staple                     # 只打印计划，不上传不改文件
#   NOTARY_PROFILE=idea-notary npm run staple    # 用 keychain profile 代替 apple-id 三件套
#   npm run staple -- dist                       # 指定目录
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DIR="${1:-dist/package}"
DRY_RUN="${DRY_RUN:-0}"
MANIFEST="$DIR/latest-mac.yml"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -d "$DIR" ]] || die "目录不存在：${DIR}（先 npm run package）"
DIR_ABS="$(cd "$DIR" && pwd)"

# blockmap 重生成用 electron-builder 自带的那份二进制，保证格式一致
AB=""
case "$(uname -m)" in
  arm64)  AB="node_modules/app-builder-bin/mac/app-builder_arm64" ;;
  x86_64) AB="node_modules/app-builder-bin/mac/app-builder_amd64" ;;
esac
if [[ ! -x "$AB" ]]; then
  warn "找不到 app-builder，装订后不重生成 dmg.blockmap（macOS 自动更新走 zip，不影响升级）"
  AB=""
fi

DRY_RUN="$DRY_RUN" bash "$REPO_ROOT/scripts/dmg-notarize.sh" "$DIR_ABS" \
  || die "dmg 签名 / 公证 / 装订失败：${DIR}"

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] release-manifest.js refresh ${MANIFEST}"
  log "dry-run 结束：未上传、未改动任何文件"
  exit 0
fi

# ---- blockmap：装订改了字节，旧映射失真。
# 默认目录 dist/package 里没有 dmg.blockmap（stage 只复制 zip 的），本段必然跳过；
# 显式对构建目录补票（npm run staple -- dist）时才会真正重生成。留作兜底 ——
# dmg.blockmap 目前不在投放链路里（electron-updater 在 mac 上只消费 zip），
# 但一旦有人把它加进分发，这里不会漏掉重建。
shopt -s nullglob
for f in "$DIR"/*.dmg; do
  if [[ -n "$AB" && -f "${f}.blockmap" ]]; then
    "$AB" blockmap --input "$f" --output "${f}.blockmap" >/dev/null
    log "已重生成 $(basename "$f").blockmap"
  fi
done

# ---- 清单：不重算 sha512，electron-updater 会以「哈希不匹配」拒绝这次更新
if [[ -f "$MANIFEST" ]]; then
  node scripts/release-manifest.js refresh "$MANIFEST" "$DIR" >/dev/null
  node scripts/release-manifest.js verify "$MANIFEST" "$DIR" >/dev/null \
    || die "清单与实际产物不一致：${MANIFEST}"
  log "清单 sha512 / 字节数已按装订后的产物重算"
else
  warn "没有 ${MANIFEST}，跳过清单刷新"
fi

log "完成：$(ls -1 "$DIR"/*.dmg | wc -l | tr -d ' ') 个 dmg 已具备「签名 + 公证 + 装订」"

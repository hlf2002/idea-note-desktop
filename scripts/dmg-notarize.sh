#!/usr/bin/env bash
# dmg 公证装订（纯机制）：对目录内每个 dmg 依次做「签名 → 提交公证 → 装订」，幂等。
#
# 为什么需要：
#   electron-builder 的 mac.notarize:true 只把 .app 交给 notarytool
#   （@electron/notarize 提交后还会装订 app，见 node_modules/@electron/notarize/lib/index.js）。
#   dmg 是之后用 hdiutil 打出来的新字节流，cdhash 与 app 不同，Apple 侧没有它的票 ——
#   直接 `xcrun stapler staple *.dmg` 必然报 "Record not found" / Error 65。
#
# 本脚本只做机制，不碰清单与 blockmap：清单由 release.sh 在 stage 之后一次算准。
# 因此可以在构建产物刚落地时就地处理 dist/*.dmg，让随后的 stage/cp 直接拿到最终字节。
# 补票场景（历史产物、事后改目录）走 notarize-dmg.sh，它在此之上重算清单。
#
# 用法：
#   bash scripts/dmg-notarize.sh                  # 默认处理 dist/
#   bash scripts/dmg-notarize.sh dist/package     # 指定目录
#   DRY_RUN=1 bash scripts/dmg-notarize.sh        # 只打印计划，不签名不上传
#   NOTARY_PROFILE=idea-notary bash scripts/dmg-notarize.sh   # keychain profile 替代三件套
#
# 幂等：已签名的跳过 codesign；已有票的跳过 submit 与 staple。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DIR="${1:-dist}"
DRY_RUN="${DRY_RUN:-0}"
PROFILE="${NOTARY_PROFILE:-}"
ERR_LOG="$(mktemp -t dmg-notarize-err)"
trap 'rm -f "$ERR_LOG"' EXIT

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -d "$DIR" ]] || die "目录不存在：${DIR}"

shopt -s nullglob
dmgs=("$DIR"/*.dmg)
[[ ${#dmgs[@]} -gt 0 ]] || die "${DIR} 里没有 dmg"

# 凭据：keychain profile 优先，否则要 apple-id 三件套（dry-run 不校验）
if [[ -z "$PROFILE" ]] \
  && [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    warn "未提供公证凭据（dry-run 允许），真实执行需要 set -a; . ./.env; set +a"
  else
    die "缺公证凭据：先 set -a; . ./.env; set +a；或用 NOTARY_PROFILE=<keychain profile>"
  fi
fi

find_identity() {
  security find-identity -v -p codesigning ${CSC_KEYCHAIN:+"$CSC_KEYCHAIN"} 2>/dev/null \
    | grep 'Developer ID Application' | head -1 | awk '{print $2}'
}

for f in "${dmgs[@]}"; do
  name="$(basename "$f")"
  log "处理 ${name}"

  # 文件缺失必须在此处显式失败：否则 codesign -dv 输出 "No such file or directory"，
  # 不匹配 "not signed at all"，会被误判成「已签名，跳过 codesign」，把问题拖到 notarytool。
  [[ -f "$f" ]] || die "  文件不存在：${f}（构建未产出，先查 dist/ 与 package-mac.log）"

  # ---- 1) 签名（electron-builder 只签 .app，dmg 通常裸着；签名会改字节，必须在提交前做）
  # 注意：不能写 `codesign -dv "$f" | grep -q ...` —— 未签名时 codesign 退出码为 1，
  # pipefail 会把整条管道判成失败，分支永远走不到「需要签名」。先落变量再匹配。
  sig_info="$(codesign -dv "$f" 2>&1 || true)"
  case "$sig_info" in
    *"not signed at all"*) NEED_SIGN=1 ;;
    *) NEED_SIGN=0 ;;
  esac
  if [[ "$NEED_SIGN" == "1" ]]; then
    id="$(find_identity || true)"
    [[ -n "$id" ]] || die "${name} 未签名，且钥匙串里找不到 Developer ID Application 身份"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "  [dry-run] codesign --sign ${id} --timestamp ${name}"
    else
      codesign --sign "$id" --timestamp --force \
        ${CSC_KEYCHAIN:+--keychain "$CSC_KEYCHAIN"} "$f" \
        || die "  签名失败：${name}"
      codesign --verify --strict "$f" || die "${name} 签名校验失败"
      log "  已签名"
    fi
  else
    log "  已签名，跳过 codesign"
  fi

  # ---- 2) 公证：只对「本地还没有票」的 dmg 提交，天然幂等
  if xcrun stapler validate "$f" >/dev/null 2>&1; then
    log "  已有票据，跳过 submit"
  elif [[ "$DRY_RUN" == "1" ]]; then
    log "  [dry-run] notarytool submit ${name} --wait"
  else
    if [[ -n "$PROFILE" ]]; then
      if ! out="$(xcrun notarytool submit "$f" --keychain-profile "$PROFILE" \
          --wait --output-format json 2>"$ERR_LOG")"; then
        die "  notarytool 提交失败（${name}）：$(head -n 4 "$ERR_LOG")"
      fi
    else
      if ! out="$(xcrun notarytool submit "$f" \
          --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" \
          --wait --output-format json 2>"$ERR_LOG")"; then
        die "  notarytool 提交失败（${name}）：$(head -n 4 "$ERR_LOG")"
      fi
    fi
    verdict="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.status||"?")+" "+(j.id||""))}catch(e){console.log("? ")}})')"
    case "$verdict" in
      Accepted*) log "  公证通过（${verdict#* }）" ;;
      *) die "  公证未通过（${verdict}）：${name}" ;;
    esac
  fi

  # ---- 3) 装订
  if xcrun stapler validate "$f" >/dev/null 2>&1; then
    log "  票据已在本地，跳过 staple"
  elif [[ "$DRY_RUN" == "1" ]]; then
    log "  [dry-run] stapler staple ${name}"
  else
    xcrun stapler staple "$f" || die "  装订失败：${name}"
    xcrun stapler validate "$f" >/dev/null || die "  装订后校验失败：${name}"
    log "  已装订并验证"
  fi
done

log "完成：${#dmgs[@]} 个 dmg 已具备「签名 + 公证 + 装订」（${DIR}）"

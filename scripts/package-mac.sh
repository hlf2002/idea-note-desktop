#!/usr/bin/env bash
# 打包机 mac 入口：载入凭据 → 签名就绪 → 打包 → 按需装订 dmg
#
# 用法（仓库根或任意目录）：
#   bash scripts/package-mac.sh                  # 正常打包：签名 + 公证（取决于 .env）
#   SKIP_SIGNING=1 bash scripts/package-mac.sh   # 跳过签名，出未签名包
#
# 由 deploy/deploy.sh 的 mac 分支经 SSH 调用；本地手动跑效果一致。
#
# 为什么需要这层：
#   SSH 会话（launchctl managername=Background）下 login keychain 默认锁定，而本项目的
#   Developer ID 身份只在专用钥匙串 qassistant-build.keychain-db 里。codesign 不带
#   --keychain 时会在搜索列表里逐个找，命中锁着的那份就报 errSecInternalComponent(-2070)，
#   而 electron-builder 只会重试 4 次后抛栈，看不出是「锁了」还是「没身份」。
#   本脚本先解锁并钉住钥匙串，再用临时文件真签一次，把三类失败区分开。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

SKIP_SIGNING="${SKIP_SIGNING:-0}"
PACKAGER_ENV="${PACKAGER_ENV:-$HOME/.config/qassistant-packager/packager.env}"
LOG_FILE="${PACKAGE_LOG:-$REPO_ROOT/dist/package-mac.log}"
PROBE_FILE="$(mktemp -t idea-sign-probe)"
PROBE_ERR="$(mktemp -t idea-sign-probe-err)"
mkdir -p "$(dirname "$LOG_FILE")"
cleanup() { rm -f "$PROBE_FILE" "$PROBE_ERR"; }
trap cleanup EXIT

# ---------------------------------------------------------------- 1. 模式与凭据
if [ "$SKIP_SIGNING" = "1" ]; then
  # 跳过签名时必须一并清掉全部公证凭据：electron-builder 的 notarize 不看签名结果，
  # 只要 APPLE_ID 在环境里就会去公证未签名的包，notarytool 必然拒绝，构建反而失败。
  # NOTARY_PROFILE 也要清 —— release.sh 的 notarize_dmgs 优先看它，漏清同样会去公证未签名包。
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID \
        APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER NOTARY_PROFILE
  warn "SKIP_SIGNING=1：跳过签名与公证，产物未签名（Gatekeeper 首次打开需手动放行）"
elif [ -f .env ]; then
  set -a
  . ./.env
  set +a
  # 只报「有没有」，不打印值
  log "已载入 .env（APPLE_ID=${APPLE_ID:+已设置} / TEAM_ID=${APPLE_TEAM_ID:-未设置}）"
else
  warn "未找到 .env —— 公证会因缺凭据被跳过（签名不受影响）"
fi

# ---------------------------------------------------------------- 2. 签名钥匙串
if [ "$SKIP_SIGNING" != "1" ]; then
  if [ -f "$PACKAGER_ENV" ]; then
    set -a
    . "$PACKAGER_ENV"
    set +a
    log "已载入打包机凭据 ${PACKAGER_ENV}"
  fi

  KEYCHAIN="${CSC_KEYCHAIN:-${QASSISTANT_KEYCHAIN:-}}"
  KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-${QASSISTANT_KEYCHAIN_PASSWORD:-}}"
  if [ -n "$KEYCHAIN" ]; then
    case "$KEYCHAIN" in
      /*) KC_PATH="$KEYCHAIN" ;;
      *)  KC_PATH="$HOME/Library/Keychains/$KEYCHAIN" ;;
    esac
    [ -f "$KC_PATH" ] || die "钥匙串不存在：$KC_PATH
  处置：核对 $PACKAGER_ENV 里的 QASSISTANT_KEYCHAIN，或显式传 CSC_KEYCHAIN=<路径>"
    if [ -n "$KEYCHAIN_PASSWORD" ]; then
      security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KC_PATH" \
        || die "解锁失败：${KC_PATH}（密码不对或钥匙串被重建）
  处置：核对 $PACKAGER_ENV 的 QASSISTANT_KEYCHAIN_PASSWORD；重建见 q_assistant 的 bootstrap-packager.sh"
    else
      warn "未提供钥匙串密码，假定 $KEYCHAIN 已解锁（长时间构建可能中途回锁）"
    fi
    export CSC_KEYCHAIN="$KC_PATH"
    log "签名钥匙串：$KC_PATH"
  else
    warn "未配置专用钥匙串，走系统搜索列表 —— SSH 会话下易命中锁定的 login keychain"
  fi

  # ------------------------------------------------------------ 3. 真签自测
  IDENTITY="${CSC_NAME:-}"
  if [ -z "$IDENTITY" ]; then
    ID_LINE="$(security find-identity -v -p codesigning ${CSC_KEYCHAIN:+"$CSC_KEYCHAIN"} 2>/dev/null \
      | grep 'Developer ID Application' | head -n 1)"
    [ -n "$ID_LINE" ] || die "没有可用的 Developer ID Application 身份
  处置：1) 查身份：security find-identity -v -p codesigning ${CSC_KEYCHAIN:+"$CSC_KEYCHAIN"}
        2) 证书/私钥不在该钥匙串时，按 docs 重新导入 .p12
        3) 只想先出包：SKIP_SIGNING=1 bash scripts/package-mac.sh"
    IDENTITY="$(printf '%s' "$ID_LINE" | awk '{print $2}')"
  fi
  log "签名身份：$IDENTITY"

  printf 'probe' > "$PROBE_FILE"
  if ! codesign -s "$IDENTITY" --force --timestamp \
      ${CSC_KEYCHAIN:+--keychain "$CSC_KEYCHAIN"} "$PROBE_FILE" 2>"$PROBE_ERR"; then
    ERR_TEXT="$(cat "$PROBE_ERR")"
    case "$ERR_TEXT" in
      *errSecInternalComponent*)
        die "试签失败：errSecInternalComponent(-2070) —— 私钥取不到（钥匙串锁着或 ACL 未放行）
  处置：1) 显式指定钥匙串试签：codesign --keychain ${CSC_KEYCHAIN:-<keychain>} -s $IDENTITY --force /tmp/x
        2) 授权 codesign 免交互：security set-key-partition-list -S apple-tool:,apple:,codesign: -s \\
             -k <钥匙串密码> ${CSC_KEYCHAIN:-<keychain>}
        3) 身份若在别的钥匙串，用 CSC_KEYCHAIN 指过去" ;;
      *"no identity found"*)
        die "试签失败：指定钥匙串里没有 $IDENTITY 的可用身份（可能只有证书、缺私钥）
  处置：换正确的钥匙串，或重新导入 .p12" ;;
      *[Tt]imestamp*)
        die "试签失败：时间戳服务不可达（参考日志：${ERR_TEXT}）
  codesign --timestamp 需访问 timestamp.apple.com:80；检查代理/TUN 规则" ;;
      *)
        die "试签失败：$ERR_TEXT" ;;
    esac
  fi
  log "签名自测通过（含时间戳）"
fi

# ---------------------------------------------------------------- 4. 打包
log "npm run package（完整输出同时写入 ${LOG_FILE}）"
if ! npm run package 2>&1 | tee "$LOG_FILE"; then
  die "npm run package 失败，完整日志：$LOG_FILE"
fi

# ---------------------------------------------------------------- 5. 交付目录票据复核
# release.sh 已在 stage 之前就地完成 dmg 的「签名 → 公证 → 装订」，复制进 dist/package
# 的就是最终字节、清单 sha512 也已按它算好。这里只做独立复核：只对缺票的包补跑，
# 防止「脚本报成功、包其实不能离线校验」。
MISSING_TICKET=0
shopt -s nullglob
for f in dist/package/*.dmg; do
  xcrun stapler validate "$f" >/dev/null 2>&1 || MISSING_TICKET=1
done
shopt -u nullglob

CREDS_OK=0
if [ -n "${NOTARY_PROFILE:-}" ] \
  || { [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; }; then
  CREDS_OK=1
fi

if [ "$SKIP_SIGNING" = "1" ]; then
  warn "SKIP_SIGNING=1，未签名也未公证 —— 产物仅供本机验证，不可投放"
elif [ "$CREDS_OK" != "1" ]; then
  warn "缺公证凭据（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID 或 NOTARY_PROFILE），dmg 未装订 —— 仅本地验证，不可投放"
elif [ "$MISSING_TICKET" = "1" ]; then
  log "dist/package 有 dmg 缺票，补「签名 → 公证 → 装订」并按实际字节重算清单（npm run notarize:dmg）"
  npm run notarize:dmg || die "dmg 公证装订失败：dist/package 里的包没有票，不要投放（日志 ${LOG_FILE}）"
else
  log "票据复核通过：dist/package 的 dmg 已签名、已公证、已装订"
fi

log "完成：$(ls -1 dist/package 2>/dev/null | wc -l | tr -d ' ') 个交付文件在 dist/package/"
log "投放只认 dist/package/；dist/ 根目录是同一份字节（dmg 已是中文名、zip 是 ASCII 名），但缺清单，不要直接分发"

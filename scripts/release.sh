#!/usr/bin/env bash
# 打包与发布：
#   npm run package                 # 只打包：跑测试 → 出 mac 双架构安装包 → ASCII 改名 → 同目录清单 → 校验 sha512
#   npm run package -- 1.2.3        # 打包前先把版本号改成 1.2.3（只改 package.json，不提交）
#   npm run release -- patch        # 打包 + 分发（建 Release、推清单到更新服务器、push）
#   npm run release:dry             # 分发链路预演：只改写清单，不提交/上传/推送
#
# 分发用的服务器连接信息写在 .release.config.json（已 gitignore），模板见 .release.config.example.json
# 发布各步骤可重入：Release 已存在会补传资产，清单整体覆盖。

set -euo pipefail
cd "$(dirname "$0")/.."

MODE=release
BUMP=patch
BUMP_GIVEN=0
for arg in "$@"; do
  case "$arg" in
    --package) MODE=package ;;
    --dry-run) MODE=dry ;;
    --*) echo "未知参数: $arg" >&2; exit 2 ;;
    *) BUMP="$arg"; BUMP_GIVEN=1 ;;
  esac
done

CONFIG_FILE=".release.config.json"
PRODUCT_NAME="灵感笔记"
DEFAULT_SSH_DIR="/var/www/ideanote/autoupdates/"
FEED_URL=$(node -p "require('./package.json').build.publish.url")
[[ "$MODE" == "package" ]] && OUT_DIR="dist/package" || OUT_DIR="dist/release"
DEPLOY_MANIFEST="$OUT_DIR/latest-mac.yml"

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cfg() { node -e '
  let c = {};
  try { c = JSON.parse(require("fs").readFileSync(".release.config.json", "utf8")); } catch (e) {}
  const v = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), c);
  console.log(v == null || v === "" ? (process.argv[2] || "") : v);
' "$1" "${2-}"; }

remote_repo() {
  git remote get-url origin 2>/dev/null | node -e '
    const s = require("fs").readFileSync(0, "utf8").trim();
    const m = s.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/);
    console.log(m ? m[1] : "");
  '
}

read_config() {
  REPO=""
  SSH_HOST=""
  SSH_USER=""
  SSH_PORT=22
  SSH_IDENTITY=""
  SSH_DIR="$DEFAULT_SSH_DIR"
  if [[ ! -f "$CONFIG_FILE" ]]; then
    # 没有配置文件时，package/dry 仍可用：仓库取 origin，服务器信息留空（dry 不连服务器）
    if [[ $MODE == "release" ]]; then
      die "缺少 $CONFIG_FILE（模板见 .release.config.example.json）"
    fi
    REPO=$(remote_repo)
    return 0
  fi
  REPO=$(cfg repo "$(remote_repo)")
  SSH_HOST=$(cfg ssh.host)
  SSH_USER=$(cfg ssh.user)
  SSH_PORT=$(cfg ssh.port 22)
  SSH_IDENTITY=$(cfg ssh.identity)
  SSH_IDENTITY="${SSH_IDENTITY/#\~/$HOME}"
  SSH_DIR=$(cfg ssh.dir "$DEFAULT_SSH_DIR")
  [[ "$SSH_DIR" == */ ]] || SSH_DIR="$SSH_DIR/"
}

preflight() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "不在 git 仓库内"
  [[ -d node_modules ]] || die "缺少 node_modules，先 npm install"
  node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' \
    || die "需要 Node.js 20+，当前 $(node -v)"
  [[ -x node_modules/.bin/electron-builder ]] || die "缺少 electron-builder，先 npm install"

  [[ $MODE == "release" || $MODE == "dry" ]] || return 0
  [[ -n "$REPO" ]] || die "无法识别 GitHub 仓库，请在 $CONFIG_FILE 设置 repo"

  command -v gh >/dev/null || die "未安装 gh：brew install gh"
  gh auth status >/dev/null 2>&1 || die "gh 未登录：gh auth login"
  if [[ $MODE == "release" ]]; then
    [[ -z "$(git status --porcelain)" ]] || die "工作区有未提交改动，先提交或 stash"
    command -v scp >/dev/null || die "未找到 scp"
    git fetch --tags --quiet origin
    PUSH=$(gh api "repos/$REPO" -q .permissions.push 2>/dev/null || echo unknown)
    [[ "$PUSH" == "true" ]] || die "gh 账号对 $REPO 无 push 权限（$PUSH），建不了 Release；请授予 Write 或 gh auth login 换账号"
  fi
}

resolve_version() {
  CURRENT=$(node -p "require('./package.json').version")
  if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    [[ "$BUMP" != "$CURRENT" ]] || die "版本 $BUMP 与当前相同，semver 不递增不会触发升级"
  fi
  if [[ $MODE == "dry" ]] || { [[ $MODE == "package" ]] && [[ $BUMP_GIVEN -eq 0 ]]; }; then
    VERSION="$CURRENT"
  else
    npm version "$BUMP" --no-git-tag-version >/dev/null
    VERSION=$(node -p "require('./package.json').version")
  fi
  TAG="v$VERSION"
  [[ $MODE == "release" ]] || return 0
  ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "tag $TAG 已存在，请递增版本号"
  [[ "$VERSION" == "$CURRENT" ]] || log "版本 $CURRENT → $VERSION"
}

run_tests() {
  if [[ "${SKIP_TESTS:-0}" == "1" ]]; then
    log "SKIP_TESTS=1，跳过单元测试"
  else
    log "npm test"
    npm test 2>&1 | tail -n 25 | sed 's/^/  /' || die "单元测试未通过"
  fi
}

build() {
  log "electron-builder --mac（arm64 + x64）"
  npx electron-builder --mac
  [[ -f dist/latest-mac.yml ]] || die "构建未产出 dist/latest-mac.yml"
}

stage_assets() {
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR"
  local n=0
  for f in dist/*.dmg dist/*.zip dist/*.zip.blockmap; do
    [[ -f "$f" ]] || continue
    base=$(basename "$f")
    [[ "$base" == "$PRODUCT_NAME-$VERSION"* ]] || continue
    cp "$f" "$OUT_DIR/$(node -e 'console.log(require("./scripts/release-manifest.js").asciiName(process.argv[1]))' "$base")"
    n=$((n + 1))
  done
  [[ $n -gt 0 ]] || die "dist/ 里没有版本 $VERSION 的产物"
  log "已收齐 $(ls "$OUT_DIR" | tr '\n' ' ')"
}

write_package_manifest() {
  node scripts/release-manifest.js relative dist/latest-mac.yml "$DEPLOY_MANIFEST" "$VERSION"
  log "校验产物 sha512 / 字节数"
  node scripts/release-manifest.js verify "$DEPLOY_MANIFEST" "$OUT_DIR" | sed 's/^/  /'
}

write_deploy_manifest() {
  node scripts/release-manifest.js github dist/latest-mac.yml "$DEPLOY_MANIFEST" "$REPO" "$TAG" "$VERSION"
  node -e '
    const m = require("js-yaml").load(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const f of m.files) console.log("  " + f.url.split("/").pop() + "  " + Math.round(f.size / 1048576) + "MB");
  ' "$DEPLOY_MANIFEST"
}

commit_version() {
  git add package.json package-lock.json
  git commit -m "chore(release): v$VERSION" >/dev/null
  git tag "$TAG"
  log "已提交并打 tag $TAG"
}

push_git() {
  # tag 必须先于 Release 推到远端：否则 gh 会在旧提交上自建同名 tag，本地 tag 再推会被拒
  # 另外轻量 tag 不会被 --follow-tags 推上去，需显式指定
  git push origin HEAD "refs/tags/$TAG"
  log "已推送分支与 $TAG"
}

publish_release() {
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    log "Release $TAG 已存在，补传资产"
  else
    gh release create "$TAG" --repo "$REPO" --title "$PRODUCT_NAME v$VERSION" --notes "$PRODUCT_NAME v$VERSION"
    log "已创建 Release $TAG"
  fi
  gh release upload "$TAG" --repo "$REPO" --clobber "$OUT_DIR"/*
  log "已上传 $(ls "$OUT_DIR" | grep -vc latest-mac) 个资产到 $REPO"
}

verify_assets() {
  node -e '
    const { execFileSync } = require("child_process");
    const m = require("js-yaml").load(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const f of m.files) {
      const code = execFileSync("curl", ["-s", "--max-time", "30", "-r", "0-1023", "-L",
        "-o", "/dev/null", "-w", "%{http_code}", f.url]).toString();
      if (code !== "200" && code !== "206") throw new Error("资产不可下载 (" + code + ") " + f.url);
      console.log("  " + code + " " + f.url.split("/").pop());
    }
  ' "$DEPLOY_MANIFEST"
}

deploy_manifest() {
  [[ -n "$SSH_HOST" && -n "$SSH_USER" ]] \
    || die "缺少服务器信息：在 $CONFIG_FILE 配置 ssh.host / ssh.user（域名被本地代理劫持时填真实 IP）"
  OPTS=()
  while IFS= read -r o; do OPTS+=("$o"); done < <(printf '%s\n' -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
  if [[ -n "$SSH_IDENTITY" ]]; then OPTS+=(-i "$SSH_IDENTITY"); fi

  # 先传临时文件再原子改名，避免客户端拉到写了一半的清单
  # 端口参数不同：scp 用 -P，ssh 用 -p
  log "scp 清单到 $SSH_USER@$SSH_HOST:$SSH_DIR"
  scp "${OPTS[@]}" -P "$SSH_PORT" -q "$DEPLOY_MANIFEST" "$SSH_USER@$SSH_HOST:${SSH_DIR}latest-mac.yml.tmp"
  REMOTE_SHA=$(ssh "${OPTS[@]}" -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" \
    "mv -f ${SSH_DIR}latest-mac.yml.tmp ${SSH_DIR}latest-mac.yml && sha256sum ${SSH_DIR}latest-mac.yml" | cut -d' ' -f1)
  LOCAL_SHA=$(shasum -a 256 "$DEPLOY_MANIFEST" | cut -d' ' -f1)
  [[ "$REMOTE_SHA" == "$LOCAL_SHA" ]] || die "远端清单 sha256 不一致：$REMOTE_SHA ≠ $LOCAL_SHA"
  log "远端清单已就位 $LOCAL_SHA"
}

verify_feed() {
  LIVE=$(curl -s --max-time 20 "$FEED_URL/latest-mac.yml") || die "更新地址不可访问：$FEED_URL"
  grep -q "^version: $VERSION$" <<<"$LIVE" \
    || die "线上清单版本不是 $VERSION，客户端不会升级。线上开头：$(head -3 <<<"$LIVE" | tr '\n' ' ')"
  log "线上清单已是 v$VERSION（$FEED_URL）"
}

read_config
preflight
resolve_version

case "$MODE" in
  package)
    run_tests
    build
    stage_assets
    write_package_manifest
    cat <<EOF

打包完成 ${PRODUCT_NAME} v${VERSION}（未提交、未上传）
  产物目录   $OUT_DIR/  —— 安装包 + blockmap + latest-mac.yml，整目录可直接投放
  安装包     dist/
EOF
    ;;
  dry)
    [[ -f dist/latest-mac.yml ]] || die "dry-run 需要已有的 dist/latest-mac.yml，先 npm run package"
    log "dry-run · 仓库 $REPO · 版本 $VERSION · 服务器 ${SSH_USER:-未配置}@${SSH_HOST:-未配置}:${SSH_DIR}"
    write_deploy_manifest
    log "dry-run 结束：未提交、未上传、未推送"
    ;;
  release)
    commit_version
    run_tests
    build
    stage_assets
    push_git
    publish_release
    write_deploy_manifest
    log "验证 GitHub 资产可下载"
    verify_assets
    deploy_manifest
    verify_feed
    cat <<EOF

发布完成 ${PRODUCT_NAME} v${VERSION}
  Release    https://github.com/$REPO/releases/tag/$TAG
  更新清单   ${FEED_URL}latest-mac.yml
  安装包     dist/
EOF
    ;;
esac

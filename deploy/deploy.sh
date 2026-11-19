#!/usr/bin/env bash
# 多机打包调度 + 七牛投放：控制多台构建机分别打包对应平台安装包，产物回收回本机做
# sha512 校验，校验通过后按「包在前、清单在后」的顺序投放到七牛 Kodo 更新源。
# 风格与 q_assistant_desktop_dev/deploy/deploy.sh 对齐（Jenkins 环境变量直接注入，大小写兼容）。
#
# 参数（环境变量，支持小写；也可用位置参数，见下）：
#   TARGET / target    win | mac | all（默认 all：双机串行，单机失败不影响另一台，最终汇总退出码）
#   REF                tag 或 main；TAG/tag/BRANCH/branch/GIT_BRANCH 均可注入，缺省由本仓库 HEAD 推断
#   COLLECT_ARTIFACTS  1 收产物（默认）/ 0 只打包不回收
#   ARTIFACTS_DIR      产物回收目录（默认 deploy/artifacts-<时间戳>）
#   DRY_RUN            1 = 只打印将执行的远程命令，不连接机器、不联网
#   UPLOAD / UPLOAD_QINIU  1 = 回收校验通过后上传七牛（默认 0，只构建不发布）
#   UPLOAD_REQUIRE_ALL 1 = TARGET=all 时任一平台失败则整批跳过上传（默认 1，避免半个 feed）
#   UPLOAD_SKIP_UNCHANGED  1 = 远端同名同大小对象跳过上传（默认 0，一律覆盖写）
#   UPLOAD_STRICT_PUBLIC   1 = 公网 HEAD 校验失败即判失败（默认只告警，避免 CDN 缓存误伤）
#   QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET / QINIU_PREFIX / QINIU_PUBLIC_BASE
#                      七牛凭据与投放参数；不设则读 .release.config.json 的 qiniu 段
#
# 位置参数（顺序无关，键名大小写不敏感；应对 `deploy.sh target mac REF main` 这类调用）：
#   deploy/deploy.sh target mac REF main          # 只构建 mac 的 main
#   deploy/deploy.sh mac upload 1                 # 裸平台名等价于 TARGET=mac
#   deploy/deploy.sh target all ref v1.2.4 upload 1
#   deploy/deploy.sh target mac dry               # 只演练
#   键：target / ref（tag|branch 同义）/ collect / upload / dry
#
# 机器配置（可用同名环境变量覆盖；平台→机器一一对应，加机器时复制一段并接入 run_task）：
#   WINDOWS_HOST/PORT/USER/PROJECT_DIR   Windows 打包机（SSH 默认 shell 为 cmd，命令用 cd /d 与 call npm）
#   MAC_HOST/PORT/USER/PROJECT_DIR       macOS 打包机
#   CLONE_URL                            首跑目录缺失时的 clone 地址（默认 GitHub origin）
#
# 认证：与参考脚本一致，走你本机的 ssh-agent 密钥或交互密码（不强制 BatchMode）。
# 注意：本机须持有两台构建机的授权；打包机首次使用 SimplySign 需先登录并跑一次
#       node scripts/win-sign.js --warmup 完成 OTP/PIN 缓存。
#
# 打包命令：
#   win -> npm run package:win   （win-sign.js 自动 SimplySign 签名 + PIN 预热 + 收尾三断言校验）
#   mac -> npm run package       （测试 + electron-builder + ASCII 收尾 + 清单 sha512 校验）
#
# 退出码：0 全部成功；1 至少一台失败（含上传失败）；2 参数错误
set -uo pipefail

# 项目根按脚本自身位置定位，先于一切使用路径的默认值计算
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="${TARGET:-${target:-all}}"
MODE_COLLECT="${COLLECT_ARTIFACTS:-1}"
DRY_RUN="${DRY_RUN:-0}"
UPLOAD="${UPLOAD:-${UPLOAD_QINIU:-0}}"
UPLOAD_REQUIRE_ALL="${UPLOAD_REQUIRE_ALL:-1}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$SCRIPT_DIR/artifacts-$(date +%Y%m%d-%H%M%S)}"

# ---- 位置参数（每个键吃掉一个值；裸 win|mac|all 视为 TARGET）----
# 旧版直接忽略位置参数，导致 `deploy.sh target mac REF main` 静默按 TARGET=all 跑两台机，
# 白等一轮 Windows 才看到失败。这里显式解析并对未知参数报错，不猜。
REF_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    target|TARGET)
      [ $# -ge 2 ] || { printf 'target 缺少取值（win|mac|all）\n' >&2; exit 2; }
      TARGET="$2"; shift 2 ;;
    ref|REF|tag|TAG|branch|BRANCH)
      [ $# -ge 2 ] || { printf 'ref 缺少取值（main 或 tag）\n' >&2; exit 2; }
      REF_ARG="$2"; shift 2 ;;
    collect|COLLECT|collect_artifacts|COLLECT_ARTIFACTS)
      [ $# -ge 2 ] || { printf 'collect 缺少取值（0|1）\n' >&2; exit 2; }
      MODE_COLLECT="$2"; shift 2 ;;
    upload|UPLOAD|upload_qiniu|UPLOAD_QINIU)
      [ $# -ge 2 ] || { printf 'upload 缺少取值（0|1）\n' >&2; exit 2; }
      UPLOAD="$2"; shift 2 ;;
    artifacts_dir|ARTIFACTS_DIR)
      [ $# -ge 2 ] || { printf 'artifacts_dir 缺少取值\n' >&2; exit 2; }
      ARTIFACTS_DIR="$2"; shift 2 ;;
    dry|dry_run|DRY_RUN)
      DRY_RUN=1; shift ;;
    win|mac|all)
      TARGET="$1"; shift ;;
    *)
      printf '未知参数：%s\n  支持 target/ref/collect/upload/artifacts_dir/dry 与 win|mac|all，或用同名环境变量\n' "$1" >&2
      exit 2 ;;
  esac
done

# ---- 机器配置区（环境变量可覆盖）----
CLONE_URL="${CLONE_URL:-https://github.com/hlf2002/idea-note-desktop.git}"
WINDOWS_HOST="${WINDOWS_HOST:-106.52.168.174}"
WINDOWS_PORT="${WINDOWS_PORT:-23491}"
WINDOWS_USER="${WINDOWS_USER:-keke}"
WINDOWS_PROJECT_DIR="${WINDOWS_PROJECT_DIR:-D:\\work\\test\\idea-note-desktop}"

MAC_HOST="${MAC_HOST:-106.52.168.174}"
MAC_PORT="${MAC_PORT:-23490}"
MAC_USER="${MAC_USER:-hulifeng}"
MAC_PROJECT_DIR="${MAC_PROJECT_DIR:-~/dev/idea-note-desktop}"
# ------------------------------------

case "$TARGET" in
  win|mac|all) ;;
  *)
    printf 'TARGET 仅支持 win/mac/all，当前 TARGET=%s\n' "$TARGET" >&2
    exit 2
    ;;
esac

for flag in "$MODE_COLLECT" "$DRY_RUN" "$UPLOAD" "$UPLOAD_REQUIRE_ALL"; do
  case "$flag" in
    0|1) ;;
    *)
      printf '开关类参数只接受 0/1，当前收到：%s\n' "$flag" >&2
      exit 2
      ;;
  esac
done

# REF：位置参数 > 显式环境变量；未传时由本仓库实际 HEAD 推断，不猜版本号
# 不用 git -C：需要 git >= 1.8.5，Jenkins 主控（CentOS 7）的 git 1.8.3.1 报 Unknown option
REF="${REF_ARG:-${TAG:-${tag:-${BRANCH:-${branch:-${GIT_BRANCH:-}}}}}}"
if [ -z "$REF" ]; then
  REF="$(cd "$REPO_ROOT" && git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -z "$REF" ]; then
    REF="$(cd "$REPO_ROOT" && git describe --tags --exact-match 2>/dev/null || true)"
  fi
fi
case "$REF" in
  main|origin/main|refs/heads/main|refs/remotes/origin/main) REF="main" ;;
  refs/tags/*) REF="${REF#refs/tags/}" ;;
esac
# REF 进入远程 shell，限制字符并验证 Git ref，防止参数被当作命令注入
if [[ ! "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
   ! git check-ref-format "refs/tags/$REF"; then
  printf '请选择 main 或有效的 tag，当前 REF=%s\n' "$REF" >&2
  exit 2
fi
# 非 main 一律按 tag 检出：本地须先见到该 tag，否则远程按 refs/tags/<分支> fetch
# 才失败，报错位置误导排障（git -C 兼容性同上，改用 cd 子 shell）
if [ "$REF" != "main" ] &&
   ! (cd "$REPO_ROOT" && git rev-parse -q --verify "refs/tags/$REF") >/dev/null; then
  printf 'REF=%s 不是本仓库已知 tag（先 git fetch --tags 再试），仅支持 main 或已存在的 tag\n' "$REF" >&2
  exit 2
fi

echo "========== 构建参数 =========="
printf 'TARGET=%s REF=%s COLLECT=%s UPLOAD=%s DRY_RUN=%s\n' \
  "$TARGET" "$REF" "$MODE_COLLECT" "$UPLOAD" "$DRY_RUN"
printf '产物目录=%s\n' "$ARTIFACTS_DIR"
if [ "$UPLOAD" = "1" ]; then
  printf '七牛前缀=%s 桶=%s\n' \
    "${QINIU_PREFIX:-（读 .release.config.json，缺省 autoupdates/）}" "${QINIU_BUCKET:-（读 .release.config.json）}"
fi

# 认证与参考脚本一致：不强制 BatchMode，密钥（agent）或交互密码均可。
# StrictHostKeyChecking=accept-new 需 OpenSSH >= 7.6；CentOS 7 主控的 7.4p1 在解析
# 选项值这一步即报 unsupported option 退出 255（与 known_hosts 内容无关）。探测到
# 不支持时降级为「keyscan 预注入 + yes」组合：首次自动接受（TOFU）、密钥变化仍
# 拒绝，语义与 accept-new 对齐。
SSH_STRICT="accept-new"
ssh -G -o StrictHostKeyChecking=accept-new nonexistent.invalid >/dev/null 2>&1 \
  || SSH_STRICT="yes"
SSH_OPTS=(-o StrictHostKeyChecking="$SSH_STRICT" -o ConnectTimeout=15)

# 仅降级路径（SSH_STRICT=yes）使用：幂等注入打包机 host key，使后续 ssh/scp 的
# 严格校验在首次连接即可通过；重复调用不产生重复条目。
# 用管道而非 < <(...) 进程替换：Jenkins Execute shell 以 sh 调用本脚本（bash POSIX
# 模式禁用进程替换，报 syntax error near unexpected token '<'）；循环在子 shell 中
# 执行不影响结果——循环体只有写文件的副作用，无变量回传需求。
ensure_known_host() {  # host port
  local kh="${HOME}/.ssh/known_hosts" entry
  mkdir -p "${HOME}/.ssh" && touch "$kh"
  ssh-keyscan -p "$2" "$1" 2>/dev/null | while IFS= read -r entry; do
    grep -qxF "$entry" "$kh" || printf '%s\n' "$entry" >> "$kh"
  done
}

# 远程检出（阶段 1/2）：目录缺失先 clone（首跑自举）；脏树直接失败不覆盖打包机上的修改；
# fetch 后确保工作区处于目标 ref 最新——main 取 origin/main，其余按 tag 取
#
# 脏树判定排除 **/.qzhuli-manifest.json：该文件由 qzhuli-cli 安装时重写 installed_at
# 时间戳，属生成物（已在 .gitignore，但历史提交仍跟踪过）。2026-11-19 首跑即因这台
# 打包机残留 4 个时间戳差异被判脏树、误报「检出失败」，排除后不再阻断重跑。
# 用 pathspec 排除而非 git checkout 还原：不改动打包机上的任何文件，语义更安全。
remote_checkout() {
  local platform="$1" proj="$2"
  local git_fetch tgt_ref
  if [ "$REF" = "main" ]; then
    git_fetch="git fetch origin +refs/heads/main:refs/remotes/origin/main"
    tgt_ref="refs/remotes/origin/main"
  else
    git_fetch="git fetch --force origin refs/tags/$REF:refs/tags/$REF"
    tgt_ref="refs/tags/$REF"
  fi
  if [ "$platform" = "win" ]; then
    # cmd 方言做 SHA 串比较语法脆弱且无法在本机验证；无条件 detach 检出同样保证
    # 工作区处于最新，git rev-parse HEAD 即留痕证明
    printf 'if not exist "%s\\.git" git clone %s "%s" & cd /d %s && git diff --exit-code -- . ":(exclude)**/.qzhuli-manifest.json" && git diff --cached --exit-code && %s && git checkout --detach %s && git rev-parse HEAD && call npm ci' \
      "$proj" "$CLONE_URL" "$proj" "$proj" "$git_fetch" "$tgt_ref"
  else
    # sh 方言：fetch 后显式比对 HEAD 与目标 ref——相同报「已是最新」跳过检出，
    # 不同则 detach 检出并报「已更新」，两种情况均以 rev-parse HEAD 收口留痕。
    # mac 侧 $proj 不加引号：路径含 ~ 时需在远程 shell 展开；因此 MAC_PROJECT_DIR 不支持空格
    printf '([ -d %s/.git ] || git clone %s %s) && cd %s && git diff --exit-code -- . ":(exclude)**/.qzhuli-manifest.json" && git diff --cached --exit-code && %s && tgt=$(git rev-parse %s) && cur=$(git rev-parse HEAD) && { [ "$cur" = "$tgt" ] && echo "仓库已是最新：$tgt" || { git checkout --detach "$tgt" && echo "已更新至最新：$cur -> $tgt"; }; } && git rev-parse HEAD && npm ci' \
      "$proj" "$CLONE_URL" "$proj" "$proj" "$git_fetch" "$tgt_ref"
  fi
}

# 单平台任务：远程检出校验 -> 远程打包 -> 回收产物 -> 本地清单校验。状态写入 STATUS_<PLATFORM>
run_task() {
  local platform="$1" host="$2" port="$3" user="$4" proj="$5" package_dir="$6" manifest="$7"
  local checkout_cmd package_cmd scp_path status="FAIL" rc=0
  # 状态变量统一大写键：bash 变量区分大小写，STATUS_win 写入不会被 STATUS_WIN 读到
  local status_key
  status_key="$(printf '%s' "$platform" | tr '[:lower:]' '[:upper:]')"

  echo ""
  echo "========== ${platform} 1/2：$user@$host:$port 检出 ${REF}（存在性/最新性校验）=========="

  if [ "$platform" = "win" ]; then
    checkout_cmd="$(remote_checkout win "$proj")"
    package_cmd="cd /d $proj && call npm run package:win && tar -czf dist/pkg-win.tgz -C dist package-win"
    scp_path="$user@$host:$(printf '%s' "$proj" | sed 's#\\\\#/#g; s#\\#/#g')/dist/pkg-win.tgz"
  else
    checkout_cmd="$(remote_checkout mac "$proj")"
    package_cmd="cd $proj && npm run package && tar -czf dist/pkg-mac.tgz -C dist package"
    scp_path="$user@$host:$proj/dist/pkg-mac.tgz"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] ssh -p $port $user@$host \"$checkout_cmd\""
    echo "[dry-run] ssh -p $port $user@$host \"$package_cmd\""
    echo "[dry-run] scp -P $port \"$scp_path\" -> $ARTIFACTS_DIR/$platform/"
    eval "STATUS_${status_key}=DRY"
    return 0
  fi

  # 降级路径（老 OpenSSH）首次连接前注入 host key；dry-run 已在上面提前返回
  [ "$SSH_STRICT" = "accept-new" ] || ensure_known_host "$host" "$port"

  echo "--- 远程检出（日志实时回传）---"
  if ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" "$checkout_cmd"; then
    echo "--- 检出完成：仓库已处于 $REF 最新 ---"
  else
    rc=$?
    echo "✗ $platform 仓库检出/最新性校验失败（SSH 退出码 ${rc}）。" >&2
    if [ "$rc" = "255" ]; then
      echo "  原因：SSH 连接或认证失败（与仓库状态无关）。处置：" >&2
      echo "    1) 装公钥（无人值守必需）：ssh-copy-id -p $port $user@$host" >&2
      echo "    2) Windows 管理员组账号：公钥须写入 C:\\ProgramData\\ssh\\administrators_authorized_keys 并收紧 ACL" >&2
      echo "    3) 交互密码模式：密码错 3 次即 Permission denied；本轮所有 SSH 调用都会重复询问" >&2
    else
      echo "  原因：远程命令返回非 0，多为打包机工作区有未提交改动（git diff 输出见上）。处置：" >&2
      echo "    1) 在打包机 git status 看清改动后提交或还原（脚本不覆盖打包机上的修改）" >&2
      echo "    2) *.qzhuli-manifest.json 已从脏树判定排除；仍报脏即源码真实改动，须人工处置" >&2
    fi
    eval "STATUS_${status_key}=FAIL"
    return 1
  fi

  echo ""
  echo "========== ${platform} 2/2：执行打包流程 =========="
  echo "--- 远程打包（日志实时回传）---"
  if ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" "$package_cmd"; then
    echo "--- 远程打包成功 ---"
  else
    rc=$?
    echo "✗ $platform 远程打包失败（SSH 退出码 ${rc}）。" >&2
    if [ "$platform" = "win" ]; then
      echo "  提示：win 失败先看是否 SimplySign 未登录/PIN 未预热（脚本会打印排查清单）。" >&2
      echo "        证书不可用时可 WIN_ALLOW_UNSIGNED=1 出未签名包（SmartScreen 会拦截）。" >&2
    else
      echo "  提示：codesign errSecInternalComponent = SSH 会话拿不到证书私钥（login keychain 未解锁）。处置：" >&2
      echo "        1) 在打包机 GUI 终端执行 security unlock-keychain ~/Library/Keychains/login.keychain-db" >&2
      echo "        2) 钥匙串访问里把该证书私钥的访问控制设为 Always Allow" >&2
      echo "        3) 公证失败另查 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD 是否就绪" >&2
    fi
    eval "STATUS_${status_key}=FAIL"
    return 1
  fi

  if [ "$MODE_COLLECT" = "1" ]; then
    mkdir -p "$ARTIFACTS_DIR/$platform"
    echo "--- 回收产物 $scp_path ---"
    if scp -P "$port" "$scp_path" "$ARTIFACTS_DIR/$platform/pkg.tgz"; then
      # 解包失败（传输截断等）单独报因，不落入 sha512 校验误导排障
      if tar -xzf "$ARTIFACTS_DIR/$platform/pkg.tgz" -C "$ARTIFACTS_DIR/$platform"; then
        rm -f "$ARTIFACTS_DIR/$platform/pkg.tgz"
        echo "--- 本地校验清单 sha512（${manifest}）---"
        if node "$REPO_ROOT/scripts/release-manifest.js" verify \
          "$ARTIFACTS_DIR/$platform/$package_dir/$manifest" "$ARTIFACTS_DIR/$platform/$package_dir"; then
          status="PASS（产物已回收至 $ARTIFACTS_DIR/$platform/${package_dir}）"
        else
          echo "✗ $platform 清单与产物 sha512 不配对，产物不可投放！" >&2
          status="FAIL（sha512 不配对）"
        fi
      else
        echo "✗ ${platform} 回收包解压失败（tar，疑似传输截断）。" >&2
        rm -f "$ARTIFACTS_DIR/$platform/pkg.tgz"
        status="FAIL（回收包解压失败）"
      fi
    else
      echo "✗ ${platform} 产物回收失败（scp）。" >&2
      status="FAIL（scp 回收失败）"
    fi
  else
    status="PASS（COLLECT_ARTIFACTS=0，产物留在打包机 $proj/dist）"
  fi

  eval "STATUS_${status_key}=\"\$status\""
}

# 七牛投放（阶段 3）：只投「已回收 + sha512 配对」的平台目录。
# 顺序由 scripts/qiniu-upload.js 保证：安装包/blockmap 在前，latest*.yml 最后。
upload_artifacts() {  # pkgdir
  local pkgdir="$1" args=()
  args=(--dir "$pkgdir")
  [ "${UPLOAD_SKIP_UNCHANGED:-0}" = "1" ] && args+=(--skip-unchanged)
  [ "${UPLOAD_STRICT_PUBLIC:-0}" = "1" ] && args+=(--strict-public)
  node "$REPO_ROOT/scripts/qiniu-upload.js" "${args[@]}"
}

STATUS_WIN="SKIP"; STATUS_MAC="SKIP"
STEP=0

if [ "$TARGET" = "win" ] || [ "$TARGET" = "all" ]; then
  STEP=$((STEP + 1))
  echo "========== 任务 $STEP: Windows =========="
  run_task win "$WINDOWS_HOST" "$WINDOWS_PORT" "$WINDOWS_USER" "$WINDOWS_PROJECT_DIR" "package-win" "latest.yml" || true
fi
if [ "$TARGET" = "mac" ] || [ "$TARGET" = "all" ]; then
  STEP=$((STEP + 1))
  echo "========== 任务 $STEP: macOS =========="
  run_task mac "$MAC_HOST" "$MAC_PORT" "$MAC_USER" "$MAC_PROJECT_DIR" "package" "latest-mac.yml" || true
fi

if [ "$UPLOAD" = "1" ]; then
  STEP=$((STEP + 1))
  echo ""
  echo "========== 任务 ${STEP}：上传七牛（generic 更新源）=========="
  BLOCK_UPLOAD=""
  if [ "$UPLOAD_REQUIRE_ALL" = "1" ] && [ "$TARGET" = "all" ]; then
    case "$STATUS_WIN $STATUS_MAC" in
      *FAIL*) BLOCK_UPLOAD="有平台未通过构建/回收，整批跳过上传（UPLOAD_REQUIRE_ALL=0 可只发布成功平台）" ;;
    esac
  fi
  if [ -n "$BLOCK_UPLOAD" ]; then
    echo "  ! $BLOCK_UPLOAD" >&2
  fi

  for platform in win mac; do
    case "$platform:$TARGET" in
      win:mac|mac:win) continue ;;
    esac
    if [ "$platform" = "win" ]; then
      cur="$STATUS_WIN"; pkgdir="$ARTIFACTS_DIR/win/package-win"
    else
      cur="$STATUS_MAC"; pkgdir="$ARTIFACTS_DIR/mac/package"
    fi

    if [ -n "$BLOCK_UPLOAD" ]; then
      echo "  - $platform 跳过上传：$BLOCK_UPLOAD"
      continue
    fi
    if [ "${cur#FAIL}" != "$cur" ]; then
      echo "  - $platform 跳过上传：构建/回收未通过（${cur}）"
      continue
    fi
    if [ "$MODE_COLLECT" = "0" ]; then
      echo "  - $platform 跳过上传：COLLECT_ARTIFACTS=0，产物未回收到本机"
      continue
    fi
    if [ "$DRY_RUN" != "1" ] && [ ! -d "$pkgdir" ]; then
      echo "  ✗ $platform 上传失败：找不到产物目录 $pkgdir" >&2
      eval "STATUS_$(printf '%s' "$platform" | tr '[:lower:]' '[:upper:]')=FAIL（上传前缺产物目录）"
      continue
    fi

    echo "--- ${platform}：$pkgdir ---"
    if [ "$DRY_RUN" = "1" ]; then
      echo "[dry-run] node scripts/qiniu-upload.js --dir $pkgdir"
      new_status="$cur · 已演练上传（dry-run）"
    elif upload_artifacts "$pkgdir"; then
      new_status="$cur · 已上传七牛"
    else
      echo "  ✗ $platform 七牛投放失败。处置：核对 .release.config.json 的 qiniu 段或 QINIU_* 环境变量；" >&2
      echo "    脚本按 key 覆盖写，修好后可直接重跑本命令（可重复执行）。" >&2
      new_status="FAIL（七牛投放失败）"
    fi
    eval "STATUS_$(printf '%s' "$platform" | tr '[:lower:]' '[:upper:]')=\"\$new_status\""
  done
else
  echo ""
  echo "（未启用七牛投放：加位置参数 upload 1，或 UPLOAD=1 重跑）"
fi

echo ""
echo "========== 汇总 =========="
printf '%-8s %-24s %s\n' "平台" "机器" "结果"
printf '%-8s %-24s %s\n' "win" "$WINDOWS_USER@$WINDOWS_HOST:$WINDOWS_PORT" "${STATUS_WIN}"
printf '%-8s %-24s %s\n' "mac" "$MAC_USER@$MAC_HOST:$MAC_PORT" "${STATUS_MAC}"

case "$TARGET" in
  win) [ "${STATUS_WIN#FAIL}" != "${STATUS_WIN}" ] && exit 1 || exit 0 ;;
  mac) [ "${STATUS_MAC#FAIL}" != "${STATUS_MAC}" ] && exit 1 || exit 0 ;;
  *) { [ "${STATUS_WIN#FAIL}" != "${STATUS_WIN}" ] || [ "${STATUS_MAC#FAIL}" != "${STATUS_MAC}" ]; } && exit 1 || exit 0 ;;
esac

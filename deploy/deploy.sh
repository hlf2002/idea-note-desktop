#!/usr/bin/env bash
# 多机打包调度：控制多台构建机分别打包对应平台安装包，产物回收回本机并做 sha512 校验。
# 风格与 q_assistant_desktop_dev/deploy/deploy.sh 对齐（Jenkins 环境变量直接注入，大小写兼容）。
#
# 参数（环境变量，支持小写）：
#   TARGET / target    win | mac | all（默认 all：双机串行，单机失败不影响另一台，最终汇总退出码）
#   REF                tag 或 main；TAG/tag/BRANCH/branch/GIT_BRANCH 均可注入，缺省由本仓库 HEAD 推断
#   COLLECT_ARTIFACTS  1 收产物（默认）/ 0 只打包不回收
#   ARTIFACTS_DIR      产物回收目录（默认 deploy/artifacts-<时间戳>）
#   DRY_RUN            1 = 只打印将执行的远程命令，不连接机器
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
# 退出码：0 全部成功；1 至少一台失败；2 参数错误
set -uo pipefail

# 项目根按脚本自身位置定位，先于一切使用路径的默认值计算
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="${TARGET:-${target:-all}}"
MODE_COLLECT="${COLLECT_ARTIFACTS:-1}"
DRY_RUN="${DRY_RUN:-0}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$SCRIPT_DIR/artifacts-$(date +%Y%m%d-%H%M%S)}"

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

# REF：显式参数优先；未传时由本仓库实际 HEAD 推断，不猜版本号
# 不用 git -C：需要 git >= 1.8.5，Jenkins 主控（CentOS 7）的 git 1.8.3.1 报 Unknown option
REF="${TAG:-${tag:-${BRANCH:-${branch:-${GIT_BRANCH:-}}}}}"
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
printf 'TARGET=%s REF=%s COLLECT=%s DRY_RUN=%s\n' "$TARGET" "$REF" "$MODE_COLLECT" "$DRY_RUN"
printf '产物目录=%s\n' "$ARTIFACTS_DIR"

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
    printf 'if not exist "%s\\.git" git clone %s "%s" & cd /d %s && git diff --exit-code && git diff --cached --exit-code && %s && git checkout --detach %s && git rev-parse HEAD && call npm ci' \
      "$proj" "$CLONE_URL" "$proj" "$proj" "$git_fetch" "$tgt_ref"
  else
    # sh 方言：fetch 后显式比对 HEAD 与目标 ref——相同报「已是最新」跳过检出，
    # 不同则 detach 检出并报「已更新」，两种情况均以 rev-parse HEAD 收口留痕。
    # mac 侧 $proj 不加引号：路径含 ~ 时需在远程 shell 展开；因此 MAC_PROJECT_DIR 不支持空格
    printf '([ -d %s/.git ] || git clone %s %s) && cd %s && git diff --exit-code && git diff --cached --exit-code && %s && tgt=$(git rev-parse %s) && cur=$(git rev-parse HEAD) && { [ "$cur" = "$tgt" ] && echo "仓库已是最新：$tgt" || { git checkout --detach "$tgt" && echo "已更新至最新：$cur -> $tgt"; }; } && git rev-parse HEAD && npm ci' \
      "$proj" "$CLONE_URL" "$proj" "$proj" "$git_fetch" "$tgt_ref"
  fi
}

# 单平台任务：远程检出校验 -> 远程打包 -> 回收产物 -> 本地清单校验。状态写入 STATUS_<PLATFORM>
run_task() {
  local platform="$1" host="$2" port="$3" user="$4" proj="$5" package_dir="$6" manifest="$7"
  local checkout_cmd package_cmd scp_path status="FAIL"
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
    echo "✗ $platform 仓库检出/最新性校验失败（SSH 退出码 $?）。" >&2
    eval "STATUS_${status_key}=FAIL"
    return 1
  fi

  echo ""
  echo "========== ${platform} 2/2：执行打包流程 =========="
  echo "--- 远程打包（日志实时回传）---"
  if ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" "$package_cmd"; then
    echo "--- 远程打包成功 ---"
  else
    echo "✗ $platform 远程打包失败（SSH 退出码 $?）。" >&2
    echo "  提示：win 失败先看是否 SimplySign 未登录/PIN 未预热（脚本会打印排查清单）。" >&2
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

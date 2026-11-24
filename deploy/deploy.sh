#!/usr/bin/env bash
# 多机打包调度：跳板机（Jenkins）只负责触发，通过 SSH 驱动各打包机完成
# 「检出 → 打包(签名/公证/装订) → 校验(node verify) → 可选上传七牛」全流程。
# 跳板机不回收产物、不校验、不上传，全程零 Node、零产物落盘。
#
#   PLATFORM=mac MODE=local  REF=main bash deploy/deploy.sh    # 只构建
#   PLATFORM=all MODE=publish REF=main bash deploy/deploy.sh   # 构建 + 打包机上传七牛
#
# 参数（环境变量，支持小写）：
#   PLATFORM / platform   win | mac | all（默认 win）；all = 双机串行
#   MODE / mode           local（默认）只构建；publish 构建后由打包机上传七牛；
#                         publish-feishu 构建后由打包机上传 IPA + 飞书公告（不投七牛，
#                         与 publish 是两个互斥渠道，各管一个发布面）
#   REF                   tag 或 main；TAG/tag/BRANCH/branch/GIT_BRANCH 同样有效，
#                         缺省由本仓库 HEAD 推断
#
# 可选：
#   DRY_RUN               1 = 只打印远程命令，不连机
#   UPLOAD / UPLOAD_QINIU 0|1，覆盖由 MODE 推导的上传开关
#   WIN_SIMPLYSIGN_LOGIN  off|auto|force（默认 auto，仅 win）：打包机上 SimplySign 自动登录
#                         auto  = 无可用证书时才登录（避免重复消耗 TOTP）
#                         force = 无视现有证书强制重登
#                         off   = 完全不碰，要求机上已人工登录（排障/回滚用）
#   WIN_SIMPLYSIGN_LOGIN_TIMEOUT  登录等待上限秒数（默认 180）
#   WIN_SIMPLYSIGN_LOGIN_TOOL     打包机上 login_signing_tool.py 的绝对路径
#                                 （默认 D:\work\sign\login_signing_tool.py；
#                                  该脚本含打包机专有配置，不随本仓库分发）
#   WIN_SIMPLYSIGN_PYTHON         打包机上的 Python 解释器（默认 python；
#                                 依赖 pywinauto + pillow，路径不在 PATH 时给绝对路径）
#
# 位置参数（可选，等价于同名环境变量）：platform / mode / ref / dry，或裸 win|mac|all|local|publish
#
# 机器配置（可用同名环境变量覆盖）：
#   WINDOWS_HOST/PORT/USER/PROJECT_DIR   Windows 打包机（SSH 默认 shell 为 cmd）
#   MAC_HOST/PORT/USER/PROJECT_DIR       macOS 打包机
#   CLONE_URL                            首跑目录缺失时的 clone 地址（默认 GitHub origin）
#
# 认证：走你本机的 ssh-agent 密钥或交互密码（不强制 BatchMode）；本机须持两台打包机授权。
#
# 打包命令（全部在打包机上执行）：
#   win -> npm run package:win（win-sign.js 签名 + finalize-win.js 收尾三断言：
#          latest.yml 存在、files[] 逐条 sha512/size 配对）
#   mac -> bash scripts/package-mac.sh（.env + 钥匙串 + 自签探针 + npm run package + staple；
#          release.sh 内已做 refresh + verify；老 ref 无该脚本时回退 npm run package）
#   MODE=publish 时两台机各自追加 `node scripts/qiniu-upload.js --dir dist/package[-win]`，
#   凭据读打包机本地的 .release.config.json（qiniu 段）或 QINIU_* 环境变量。
#
# 退出码：0 全部成功；1 至少一台失败（含打包机上校验/上传失败）；2 参数错误
set -uo pipefail

# 项目根按脚本自身位置定位，先于一切使用路径的默认值计算
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 变量名与样本对齐：PLATFORM / MODE / REF；TARGET、UPLOAD 作为旧调用方式的兼容别名
# 默认 win，与样本一致：裸跑只构建 Windows 包。需要双平台必须显式传 PLATFORM=all，
# 因此「未显式指定」时会多打一行提示，避免误以为两个平台都发了。
PLATFORM_GIVEN=0
if [ -n "${PLATFORM:-}${platform:-}${TARGET:-}${target:-}" ]; then
  PLATFORM_GIVEN=1
fi
PLATFORM="${PLATFORM:-${platform:-${TARGET:-${target:-win}}}}"
MODE="${MODE:-${mode:-local}}"
DRY_RUN="${DRY_RUN:-0}"
UPLOAD_OVERRIDE="${UPLOAD:-${UPLOAD_QINIU:-}}"
# SimplySign 自动登录开关：由 win-sign.js 读取；默认 auto，TOOL 路径固定在仓库内，
# 因此这里只透传策略，不需要把打包机上的绝对路径拼进远程命令。
WIN_SIMPLYSIGN_LOGIN="${WIN_SIMPLYSIGN_LOGIN:-auto}"
WIN_SIMPLYSIGN_LOGIN_TIMEOUT="${WIN_SIMPLYSIGN_LOGIN_TIMEOUT:-180}"
WIN_SIMPLYSIGN_LOGIN_TOOL="${WIN_SIMPLYSIGN_LOGIN_TOOL:-}"

# ---- 位置参数（每个键吃掉一个值；裸 win|mac|all 视为 PLATFORM，裸 local|publish 视为 MODE）----
REF_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    platform|PLATFORM|target|TARGET)
      [ $# -ge 2 ] || { printf 'platform 缺少取值（win|mac|all）\n' >&2; exit 2; }
      PLATFORM="$2"; PLATFORM_GIVEN=1; shift 2 ;;
    mode|MODE)
      [ $# -ge 2 ] || { printf 'mode 缺少取值（local|publish）\n' >&2; exit 2; }
      MODE="$2"; shift 2 ;;
    ref|REF|tag|TAG|branch|BRANCH)
      [ $# -ge 2 ] || { printf 'ref 缺少取值（main 或 tag）\n' >&2; exit 2; }
      REF_ARG="$2"; shift 2 ;;
    dry|dry_run|DRY_RUN)
      DRY_RUN=1; shift ;;
    win|mac|all)
      PLATFORM="$1"; PLATFORM_GIVEN=1; shift ;;
    local|publish|publish-feishu)
      MODE="$1"; shift ;;
    *)
      printf '未知参数：%s\n  支持 platform/mode/ref/dry，或裸 win|mac|all|local|publish\n' "$1" >&2
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

case "$PLATFORM" in
  win|mac|all) ;;
  *)
    printf 'PLATFORM 仅支持 win/mac/all，当前 PLATFORM=%s\n' "$PLATFORM" >&2
    exit 2
    ;;
esac

# MODE 决定发布渠道（对齐 q_assistant 的 mode 语义）：
#   local           只构建
#   publish         构建后由打包机投七牛（electron-updater 自动更新仓）
#   publish-feishu  构建后由打包机上传 IPA + 飞书公告（不投七牛）
# 两个发布渠道互斥，各管一个发布面。IPA 凭据读打包机本地 .release.config.json 的
# ipa 段（appId/token）或 IPA_APP_ID / IPA_TOKEN 环境变量，跳板机不持有凭据。
case "$MODE" in
  local) MODE_UPLOAD=0; MODE_FEISHU=0 ;;
  publish) MODE_UPLOAD=1; MODE_FEISHU=0 ;;
  publish-feishu) MODE_UPLOAD=0; MODE_FEISHU=1 ;;
  *)
    printf 'MODE 仅支持 local/publish/publish-feishu，当前 MODE=%s\n' "$MODE" >&2
    exit 2
    ;;
esac
# 显式 UPLOAD 优先于 MODE 推导（兼容旧调用方式）；与 publish-feishu 互斥
UPLOAD="${UPLOAD_OVERRIDE:-$MODE_UPLOAD}"
if [ "$MODE_FEISHU" = "1" ] && [ "$UPLOAD" = "1" ]; then
  printf 'MODE=publish-feishu 与 UPLOAD=1（七牛）互斥：IPA 发布与七牛更新仓是两个独立渠道\n' >&2
  exit 2
fi

for flag in "$DRY_RUN" "$UPLOAD"; do
  case "$flag" in
    0|1) ;;
    *)
      printf '开关类参数只接受 0/1，当前收到：%s\n' "$flag" >&2
      exit 2
      ;;
  esac
done

# SimplySign 策略值会进入远程 cmd 的 set "K=V"，只允许固定枚举，杜绝引号注入
case "$WIN_SIMPLYSIGN_LOGIN" in
  off|auto|force) ;;
  *)
    printf 'WIN_SIMPLYSIGN_LOGIN 仅支持 off/auto/force，当前=%s\n' "$WIN_SIMPLYSIGN_LOGIN" >&2
    exit 2
    ;;
esac
case "$WIN_SIMPLYSIGN_LOGIN_TIMEOUT" in
  ''|*[!0-9]*)
    printf 'WIN_SIMPLYSIGN_LOGIN_TIMEOUT 必须是整数秒，当前=%s\n' "$WIN_SIMPLYSIGN_LOGIN_TIMEOUT" >&2
    exit 2
    ;;
esac

# 远程路径可能含空格（set "K=V" 能安全承载），但 cmd 元字符会破坏该赋值——
# 提前拒绝，而不是让远程命令静默变形
check_remote_path() {  # 变量名 值
  case "$2" in
    *'"'*|*'&'*|*'|'*|*'<'*|*'>'*|*'^'*|*'%'*)
      printf '%s 含 cmd 元字符（" & | < > ^ %%）：%s\n' "$1" "$2" >&2
      exit 2
      ;;
  esac
}
check_remote_path WIN_SIMPLYSIGN_PYTHON "${WIN_SIMPLYSIGN_PYTHON:-}"
check_remote_path WIN_SIMPLYSIGN_LOGIN_TOOL "$WIN_SIMPLYSIGN_LOGIN_TOOL"

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
# 才失败，报错位置误导排障
if [ "$REF" != "main" ] &&
   ! (cd "$REPO_ROOT" && git rev-parse -q --verify "refs/tags/$REF") >/dev/null; then
  printf 'REF=%s 不是本仓库已知 tag（先 git fetch --tags 再试），仅支持 main 或已存在的 tag\n' "$REF" >&2
  exit 2
fi

echo "========== 构建参数 =========="
printf 'PLATFORM=%s MODE=%s REF=%s UPLOAD=%s DRY_RUN=%s\n' \
  "$PLATFORM" "$MODE" "$REF" "$UPLOAD" "$DRY_RUN"
printf 'WIN_SIMPLYSIGN_LOGIN=%s TIMEOUT=%ss\n' \
  "$WIN_SIMPLYSIGN_LOGIN" "$WIN_SIMPLYSIGN_LOGIN_TIMEOUT"
if [ "$PLATFORM_GIVEN" = "0" ]; then
  printf '提示：未指定 PLATFORM，按默认只构建 %s；要双平台请传 PLATFORM=all\n' "$PLATFORM"
fi

# 认证与参考脚本一致：不强制 BatchMode，密钥（agent）或交互密码均可。
# StrictHostKeyChecking=accept-new 需 OpenSSH >= 7.6；CentOS 7 主控的 7.4p1 在解析
# 选项值这一步即报 unsupported option 退出 255。探测到不支持时降级为「keyscan 预注入
# + yes」组合：首次自动接受（TOFU）、密钥变化仍拒绝，语义与 accept-new 对齐。
SSH_STRICT="accept-new"
ssh -G -o StrictHostKeyChecking=accept-new nonexistent.invalid >/dev/null 2>&1 \
  || SSH_STRICT="yes"
SSH_OPTS=(-o StrictHostKeyChecking="$SSH_STRICT" -o ConnectTimeout=15)

# 仅降级路径（SSH_STRICT=yes）使用：幂等注入打包机 host key，使后续 ssh 的严格校验
# 在首次连接即可通过。用管道而非 < <(...) 进程替换：Jenkins Execute shell 以 sh 调用
# 本脚本（bash POSIX 模式禁用进程替换）。
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
# 生成物归一（**/.qzhuli-manifest.json，qzhuli-cli 装 skill 时重写 installed_at）：
# 该文件曾被 git 跟踪（7a36240 引入），d92c47b 才移出版本库并入 .gitignore。打包机若
# 停在 d92c47b 之前，工作区里这 4 个文件就是「已跟踪 + 已修改」——此时 git checkout
# 会因目标提交删除它们而中止（error: Your local changes ... would be overwritten）。
# 结论：守卫与动作必须同源——先把生成物按 HEAD 还原（只动生成物，不碰源码与
# .env/dist/node_modules 等未跟踪文件），再由不带排除的守卫判定真干净。
# win 侧等效改法需要 cmd 的 for/xargs 方言，未在 Windows 宿主验证，故不盲改：
# win 打包机若报同类错误，按提示人工在机上前置还原一次即可。
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
    # 工作区处于最新，git rev-parse HEAD 即留痕证明。
    # [deps] 标记：检出段历来是静默的，npm ci 若被跳过或失败会表现为「检出完成但依赖缺失」
    # （后续 win-sign 报找不到 node_modules/electron-builder）。标记让每步在日志里可辨。
    #
    # 关键约束（2026-11-24 实锤）：Windows OpenSSH 把远程命令交给 cmd.exe /c 时，命令里的
    # 引号与 * 会被命令行引号规则破坏，导致整条命令静默失败、sshd 仍返回 0，deploy 误判
    # 「检出完成」。因此 win 方言不写引号、不写 pathspec：
    #   - 路径默认无空格，clone/checkout 都不需要引号
    #   - .qzhuli-manifest.json 自 d92c47b 起已 untracked（.gitignore），git diff 天然忽略，
    #     无需 :(exclude) pathspec
    # 开头 echo [deps] start 是判据：连这行都没有 = 命令根本没被 cmd 执行，仍属 ssh 传输问题。
    printf 'echo [deps] start & if not exist %s\\.git git clone %s %s & cd /d %s && git diff --exit-code && git diff --cached --exit-code && echo [deps] git fetch && %s && echo [deps] checkout %s && git checkout --detach %s && echo [deps] HEAD && git rev-parse HEAD && echo [deps] npm ci start && call npm ci && echo [deps] npm ci done' \
      "$proj" "$CLONE_URL" "$proj" "$proj" "$git_fetch" "$tgt_ref" "$tgt_ref"
  else
    # sh 方言：fetch 后显式比对 HEAD 与目标 ref——相同报「已是最新」跳过检出，
    # 不同则 detach 检出并报「已更新」，两种情况均以 rev-parse HEAD 收口留痕。
    # mac 侧 $proj 不加引号：路径含 ~ 时需在远程 shell 展开；因此 MAC_PROJECT_DIR 不支持空格
    printf '([ -d %s/.git ] || git clone %s %s) && cd %s && git ls-files -z "*/.qzhuli-manifest.json" | xargs -0 git checkout -- && git diff --exit-code && git diff --cached --exit-code && echo "[deps] git fetch" && %s && tgt=$(git rev-parse %s) && cur=$(git rev-parse HEAD) && { [ "$cur" = "$tgt" ] && echo "仓库已是最新：$tgt" || { git checkout --detach "$tgt" && echo "已更新至最新：$cur -> $tgt"; }; } && echo "[deps] HEAD $cur -> $tgt" && git rev-parse HEAD && echo "[deps] npm ci start" && npm ci && echo "[deps] npm ci done"' \
      "$proj" "$CLONE_URL" "$proj" "$proj" "$git_fetch" "$tgt_ref"
  fi
}

# 单平台任务：远程检出 -> 远程打包（打包 + 校验 + 可选上传，全部在打包机）。状态写入 STATUS_<PLATFORM>
run_task() {
  local platform="$1" host="$2" port="$3" user="$4" proj="$5"
  local checkout_cmd package_cmd status="FAIL" rc=0
  # 状态变量统一大写键：bash 变量区分大小写，STATUS_win 写入不会被 STATUS_WIN 读到
  local status_key
  status_key="$(printf '%s' "$platform" | tr '[:lower:]' '[:upper:]')"

  echo ""
  echo "========== ${platform} 1/2：$user@$host:$port 检出 ${REF} =========="

  if [ "$platform" = "win" ]; then
    checkout_cmd="$(remote_checkout win "$proj")"
    # win 校验在 finalize-win.js 收尾三断言（latest.yml 存在 + files[] 逐条 sha512/size 配对）
    # SimplySign 策略经远程 cmd 的 set 透传（值已限定为 off|auto|force，无注入面）；
    # 登录入口固定在仓库内 scripts/simplysign-login.py，无需传绝对路径。
    package_cmd="cd /d $proj && set \"WIN_SIMPLYSIGN_LOGIN=$WIN_SIMPLYSIGN_LOGIN\" && set \"WIN_SIMPLYSIGN_LOGIN_TIMEOUT=$WIN_SIMPLYSIGN_LOGIN_TIMEOUT\""
    if [ -n "${WIN_SIMPLYSIGN_LOGIN_TOOL:-}" ]; then
      package_cmd="$package_cmd && set \"WIN_SIMPLYSIGN_LOGIN_TOOL=$WIN_SIMPLYSIGN_LOGIN_TOOL\""
    fi
    if [ -n "${WIN_SIMPLYSIGN_PYTHON:-}" ]; then
      package_cmd="$package_cmd && set \"WIN_SIMPLYSIGN_PYTHON=$WIN_SIMPLYSIGN_PYTHON\""
    fi
    package_cmd="$package_cmd && call npm run package:win"
    [ "$UPLOAD" = "1" ] && package_cmd="$package_cmd && node scripts/qiniu-upload.js --dir dist/package-win"
    [ "$MODE_FEISHU" = "1" ] && package_cmd="$package_cmd && node scripts/publish-ipa.js --platform win --dir dist/package-win"
  else
    checkout_cmd="$(remote_checkout mac "$proj")"
    # mac 校验在 release.sh 内（refresh + verify）；老 ref 无 package-mac.sh 时回退裸 npm run package
    package_cmd="cd $proj && if [ -f scripts/package-mac.sh ]; then bash scripts/package-mac.sh; else npm run package; fi"
    [ "$UPLOAD" = "1" ] && package_cmd="$package_cmd && node scripts/qiniu-upload.js --dir dist/package"
    [ "$MODE_FEISHU" = "1" ] && package_cmd="$package_cmd && node scripts/publish-ipa.js --platform mac --dir dist/package"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] ssh -p $port $user@$host \"$checkout_cmd\""
    echo "[dry-run] ssh -p $port $user@$host \"$package_cmd\""
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
      echo "  原因：远程命令返回非 0（多为打包机工作区有未提交改动；git 原始输出见上）。处置：" >&2
      echo "    · 若最后一条 [deps] 标记是 npm ci start，则为依赖安装失败（锁文件/网络/磁盘），不是仓库脏" >&2
      echo "--- 打包机工作区快照（只读取证）---" >&2
      if [ "$platform" = "win" ]; then
        ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" "cd /d $proj && git status --short && git rev-parse --short HEAD" >&2 || true
      else
        ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" "cd $proj && git status --short && git rev-parse --short HEAD" >&2 || true
      fi
      echo "  1) mac 侧生成物 .qzhuli-manifest.json 已自动按 HEAD 还原；仍失败即源码真实改动，" >&2
      echo "     须在打包机人工处置（脚本不覆盖打包机上的改动）" >&2
      echo "  2) 人工还原生成物（保留 .env / dist / node_modules 等未跟踪文件）：" >&2
      echo "     ssh -p $port $user@$host 'cd $proj && git ls-files -z \"*/.qzhuli-manifest.json\" | xargs -0 git checkout --'" >&2
      echo "  3) 确认机上无热修时的钝刀方案（丢弃所有已跟踪改动）：git checkout -f --detach <ref>" >&2
    fi
    eval "STATUS_${status_key}=FAIL"
    return 1
  fi

  echo ""
  echo "========== ${platform} 2/2：打包 + 校验 + [上传]（打包机执行）=========="
  echo "--- 远程打包（日志实时回传）---"
  if ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" "$package_cmd"; then
    echo "--- 远程打包成功 ---"
    if [ "$MODE_FEISHU" = "1" ]; then
      status="PASS（打包 + 校验 + 上传 IPA + 飞书公告完成）"
    elif [ "$UPLOAD" = "1" ]; then
      status="PASS（打包 + 校验 + 上传七牛完成）"
    else
      status="PASS（打包 + 校验完成）"
    fi
  else
    rc=$?
    echo "✗ $platform 远程打包失败（SSH 退出码 ${rc}）。" >&2
    if [ "$platform" = "win" ]; then
      echo "  提示：win 失败先看是否 SimplySign 未登录/PIN 未预热（脚本会打印排查清单）。" >&2
      echo "        证书不可用时可 WIN_ALLOW_UNSIGNED=1 出未签名包（SmartScreen 会拦截）。" >&2
      echo "        依赖缺失（node_modules/electron-builder 不存在）：win-sign 已不走 npx 兜底，会直接拒绝构建；" >&2
      echo "        确认检出段 [deps] 标记走到了 npm ci done，否则在打包机上手动 npm ci 后重跑。" >&2
    else
      echo "  提示：codesign 相关失败已由 scripts/package-mac.sh 分类（试签探针先跑），看它上一行结论：" >&2
      echo "        - errSecInternalComponent = 钥匙串锁着或私钥 ACL 未放行" >&2
      echo "        - no identity found        = 该钥匙串里没有可用身份（只有证书、缺私钥）" >&2
      echo "        - timestamp 相关            = timestamp.apple.com:80 被代理/TUN 拦截" >&2
      echo "        修好后本章节可直接重跑；只想先出未签名包用 SKIP_SIGNING=1 bash scripts/package-mac.sh" >&2
    fi
    eval "STATUS_${status_key}=FAIL"
    return 1
  fi

  eval "STATUS_${status_key}=\"\$status\""
}

STATUS_WIN="SKIP"; STATUS_MAC="SKIP"
STEP=0

if [ "$PLATFORM" = "win" ] || [ "$PLATFORM" = "all" ]; then
  STEP=$((STEP + 1))
  echo "========== 任务 $STEP: Windows =========="
  run_task win "$WINDOWS_HOST" "$WINDOWS_PORT" "$WINDOWS_USER" "$WINDOWS_PROJECT_DIR" || true
fi
if [ "$PLATFORM" = "mac" ] || [ "$PLATFORM" = "all" ]; then
  STEP=$((STEP + 1))
  echo "========== 任务 $STEP: macOS =========="
  run_task mac "$MAC_HOST" "$MAC_PORT" "$MAC_USER" "$MAC_PROJECT_DIR" || true
fi

if [ "$UPLOAD" = "0" ] && [ "$MODE_FEISHU" = "0" ]; then
  echo ""
  echo "（未启用发布：MODE=publish 由打包机上传七牛；MODE=publish-feishu 由打包机上传 IPA + 飞书公告）"
fi

echo ""
echo "========== 汇总 =========="
printf '%-8s %-24s %s\n' "平台" "机器" "结果"
printf '%-8s %-24s %s\n' "win" "$WINDOWS_USER@$WINDOWS_HOST:$WINDOWS_PORT" "${STATUS_WIN}"
printf '%-8s %-24s %s\n' "mac" "$MAC_USER@$MAC_HOST:$MAC_PORT" "${STATUS_MAC}"

case "$PLATFORM" in
  win) [ "${STATUS_WIN#FAIL}" != "${STATUS_WIN}" ] && exit 1 || exit 0 ;;
  mac) [ "${STATUS_MAC#FAIL}" != "${STATUS_MAC}" ] && exit 1 || exit 0 ;;
  *) { [ "${STATUS_WIN#FAIL}" != "${STATUS_WIN}" ] || [ "${STATUS_MAC#FAIL}" != "${STATUS_MAC}" ]; } && exit 1 || exit 0 ;;
esac

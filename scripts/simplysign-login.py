# -*- coding: utf-8 -*-
r"""Windows 打包机：确保 SimplySign Desktop 已登录（win-sign.js 的签名前置步骤）。

为什么需要这一层：login_signing_tool.py 用 pywinauto 驱动 SimplySign Desktop 的
GUI，并通过 adb 从手机读取 6 位动态验证码。GUI 只存在于交互桌面会话，而 SSH / CI
子进程落在 session 0 —— 在那种会话里 Desktop(backend="uia") 看不到托盘图标，脚本
必然失败。所以：

    SSH / 非交互会话 -> schtasks 登记一次性任务，把脚本投递到已登录用户的
                        交互桌面会话执行，轮询结果文件取退出码
    交互会话         -> 直接在当前进程运行

用法：
    python scripts/simplysign-login.py [--timeout 180] [--in-process] [--tool <path>]

login_signing_tool.py 不随本仓库分发（本仓库是公开的，该脚本含打包机专有的 GUI
驱动与设备配置），默认从 D:\work\sign\ 读取，可用 --tool 或环境变量改路径。

退出码：0 已登录（或本来就已登录）；1 登录失败或超时；2 参数错误。

环境变量：
    SIMPLYSIGN_LOGIN_TOOL   login_signing_tool.py 的路径（默认 D:\work\sign\）
    SIMPLYSIGN_PYTHON       投递任务时使用的解释器（默认沿用当前 sys.executable）
    —— 以下由 login_signing_tool.py 自行读取，仅当打包机上那份脚本支持时生效：
    SIMPLYSIGN_ADB_DEVICE   目标手机序列号
    SIMPLYSIGN_APP_PATH     SimplySignDesktop.exe 路径
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# login_signing_tool.py 含打包机专有的 GUI 驱动与设备配置，不随本仓库开源，因此不放在
# scripts/ 下。默认读打包机的固定部署目录；换位置或多份并存时用环境变量或命令行指定。
TOOL_ENV = "SIMPLYSIGN_LOGIN_TOOL"
# raw string 保留反斜杠字面量：普通字符串里的 \s \l 虽当前不是转义序列，但一旦路径
# 换成 \t \n \b 开头就会静默变形，这里不给自己留坑。
DEFAULT_LOGIN_TOOL = Path(r"D:\work\sign\login_signing_tool.py")
# 由 resolve_login_tool() 按脚本实际位置覆盖：日志与登录脚本同目录，排查时只找一处。
SIGN_LOG = DEFAULT_LOGIN_TOOL.parent / "sign.log"
TASK_NAME = "IdeaNoteSigningLogin"
TEMP_SUBDIR = "idea_note_signing"
DEFAULT_TIMEOUT = 180
RESULT_FILE_NAME = "sign_task_result.txt"
WRAPPER_FILE_NAME = "run_signing_login.cmd"

# Windows 控制台默认 GBK，脚本里的 ✓/✗ 会抛 UnicodeEncodeError；统一 UTF-8 后
# SSH 侧按 UTF-8 捕获日志时中文不乱码。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def resolve_login_tool(cli_value: str = "") -> Path:
    """定位 login_signing_tool.py：--tool > SIMPLYSIGN_LOGIN_TOOL > D:\\work\\sign\\。

    该脚本不随仓库分发（含 GUI 驱动逻辑与打包机专有配置），路径由打包机本地提供。
    相对路径按当前工作目录解析——deploy.sh 已 cd 到项目根。
    """
    raw = (cli_value or os.environ.get(TOOL_ENV, "")).strip()
    if raw:
        tool = Path(raw).expanduser()
        if not tool.is_absolute():
            tool = (Path.cwd() / tool).resolve()
    else:
        tool = DEFAULT_LOGIN_TOOL

    # 日志跟随脚本位置：login_signing_tool.py 自己把 sign.log 写在同目录。
    global SIGN_LOG
    SIGN_LOG = tool.parent / "sign.log"
    return tool


def is_non_interactive_session() -> bool:
    """当前进程没有交互桌面会话（例如通过 SSH 执行）时返回 True。"""
    if any(key in os.environ for key in ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY")):
        return True
    # 兜底：Windows 的 session 0 是非交互服务会话——SSH 守护进程及其子进程都在这，
    # 而控制台/桌面进程在 session 1 及以后。直接用 ctypes，不引入额外依赖。
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        session_id = ctypes.c_ulong()
        if kernel32.ProcessIdToSessionId(kernel32.GetCurrentProcessId(), ctypes.byref(session_id)):
            return session_id.value == 0
    except (OSError, AttributeError):
        pass
    return False


def sign_log_size() -> int:
    """sign.log 当前字节数（不存在则 0）。"""
    try:
        return SIGN_LOG.stat().st_size
    except OSError:
        return 0


def read_sign_log_since(offset: int) -> str:
    """读取 sign.log 自 offset 字节之后的新增内容。

    用二进制按字节定位，避免文本模式 seek 到任意字节偏移时的未定义行为
    （换行翻译、多字节 UTF-8 都会让文本模式 seek 产生偏差）。
    """
    try:
        with SIGN_LOG.open("rb") as handle:
            handle.seek(offset)
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def read_sign_log_tail(limit: int = 20) -> str:
    """sign.log 末尾若干行，用于登录失败时直接给出原因。"""
    try:
        lines = SIGN_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return "    (sign.log 不存在)"
    tail = lines[-limit:] if len(lines) > limit else lines
    if not tail:
        return "    (sign.log 为空)"
    return "\n".join(f"    {line}" for line in tail)


def run_in_process(tool: Path) -> int:
    """在当前交互会话里直接运行 login_signing_tool.py。"""
    print(f"    in-process: python {tool}", flush=True)
    try:
        completed = subprocess.run([sys.executable, str(tool)], cwd=str(tool.parent))
    except OSError as error:
        print(f"✗ 启动 login_signing_tool.py 失败：{error}", file=sys.stderr)
        print("  依赖未装时执行：pip install pywinauto pillow", file=sys.stderr)
        return 1

    if completed.returncode != 0:
        print(f"✗ login_signing_tool.py 退出码 {completed.returncode}；最近日志：", file=sys.stderr)
        print(read_sign_log_tail(), file=sys.stderr)
        return 1
    return 0


def run_via_scheduled_task(tool: Path, timeout: int) -> int:
    """把 login_signing_tool.py 投递到已登录用户的交互桌面会话执行。

    登录脚本用 pywinauto 驱动 SimplySign Desktop 窗口，而该窗口只存在于交互桌面会话。
    SSH 会话直接运行会落到 session 0，看不到托盘图标。这里用 schtasks 注册「仅当前
    用户登录时运行」（无 /ru、无密码 = 交互令牌）的一次性任务，让它在控制台会话里
    执行；登录脚本的退出码由一个临时 cmd 包一层写进结果文件，再回读。
    """
    schtasks = shutil.which("schtasks.exe") or shutil.which("schtasks")
    if not schtasks:
        print("✗ 未找到 schtasks.exe，无法把登录脚本投递到交互会话", file=sys.stderr)
        return 1

    temp_dir = Path(tempfile.gettempdir()) / TEMP_SUBDIR
    temp_dir.mkdir(parents=True, exist_ok=True)
    wrapper_file = temp_dir / WRAPPER_FILE_NAME
    result_file = temp_dir / RESULT_FILE_NAME

    python_exe = os.environ.get("SIMPLYSIGN_PYTHON") or sys.executable

    # 包一层 cmd：跑完登录脚本后把退出码写进结果文件（批处理按行展开 %errorlevel%）。
    wrapper_file.write_text(
        "\r\n".join(
            [
                "@echo off",
                f'"{python_exe}" "{tool}"',
                f'> "{result_file}" echo %errorlevel%',
            ]
        )
        + "\r\n",
        encoding="utf-8",
    )
    try:
        result_file.unlink()
    except OSError:
        pass

    def run_schtasks(*args: str) -> None:
        completed = subprocess.run([schtasks, *args], capture_output=True, text=True)
        if completed.returncode != 0:
            detail = f"{completed.stdout} {completed.stderr}".strip()
            raise RuntimeError(f"schtasks {' '.join(args)} 失败（{completed.returncode}）：{detail}")

    # /sc once + /st 00:00 只是占位，真正触发靠 /run。不指定 /ru，任务按「当前用户、
    # 仅登录时运行」注册，因此会落到交互桌面会话执行。
    try:
        run_schtasks(
            "/create", "/tn", TASK_NAME,
            "/tr", f'"{wrapper_file}"',
            "/sc", "once", "/st", "00:00", "/f",
        )
    except RuntimeError as error:
        print(f"✗ {error}", file=sys.stderr)
        return 1

    # 记录 sign.log 当前偏移，轮询时把登录脚本新增的日志逐段打印出来（近似 tail）。
    log_offset = sign_log_size()
    print(f"    已登记计划任务 {TASK_NAME}，投递到交互桌面会话（超时 {timeout}s）", flush=True)

    try:
        run_schtasks("/run", "/tn", TASK_NAME)
    except RuntimeError as error:
        print(f"✗ {error}", file=sys.stderr)
        subprocess.run([schtasks, "/delete", "/tn", TASK_NAME, "/f"], capture_output=True)
        return 1

    header_printed = False

    def print_new_log() -> None:
        """把 sign.log 自上次偏移之后新增的内容实时打印出来（近似 tail -f）。"""
        nonlocal log_offset, header_printed
        chunk = read_sign_log_since(log_offset)
        log_offset = sign_log_size()
        if not chunk:
            return
        if not header_printed:
            print("    sign.log（login_signing_tool.py 输出）:")
            header_printed = True
        for line in chunk.rstrip().splitlines():
            print(f"      {line}")

    deadline = time.time() + timeout
    while not result_file.exists() and time.time() < deadline:
        print_new_log()
        time.sleep(1)

    # 清理任务（尽力而为，删除失败不掩盖真正的登录结果）。
    subprocess.run([schtasks, "/delete", "/tn", TASK_NAME, "/f"], capture_output=True)

    # 收尾：打印轮询结束前可能残留的最后一段日志。
    print_new_log()

    if not result_file.exists():
        print(
            f"✗ SimplySign 登录超时（{timeout}s）：任务未在交互会话完成。排查清单：\n"
            "  ① 桌面会话是否已登录（query user）：登录脚本只能在交互桌面里操作 GUI\n"
            "  ② adb devices 是否能看到目标手机且状态为 device\n"
            "  ③ SimplySign Desktop 是否在运行、托盘图标是否存在\n"
            f"  ④ {SIGN_LOG} 尾部：\n{read_sign_log_tail()}",
            file=sys.stderr,
        )
        return 1

    try:
        task_result = int(result_file.read_text(encoding="utf-8", errors="replace").strip() or "-1")
    except ValueError:
        task_result = -1
    try:
        result_file.unlink()
    except OSError:
        pass

    if task_result != 0:
        print(f"✗ SimplySign 登录失败：login_signing_tool.py 退出码 {task_result}；最近日志：", file=sys.stderr)
        print(read_sign_log_tail(), file=sys.stderr)
        return 1
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="确保 Windows 打包机的 SimplySign Desktop 已登录")
    parser.add_argument(
        "--timeout", type=int, default=DEFAULT_TIMEOUT,
        help=f"投递到交互会话后的等待上限，秒（默认 {DEFAULT_TIMEOUT}）",
    )
    parser.add_argument(
        "--in-process", action="store_true",
        help="强制在当前会话直接运行（仅调试用；SSH 会话下会因看不到 GUI 而失败）",
    )
    parser.add_argument(
        "--tool", default="",
        help=f"login_signing_tool.py 的路径（默认 {DEFAULT_LOGIN_TOOL}；也可用 {TOOL_ENV} 指定）",
    )
    args = parser.parse_args(argv)

    tool = resolve_login_tool(args.tool)
    if not tool.is_file():
        print(f"✗ 未找到登录脚本：{tool}", file=sys.stderr)
        print("  该脚本不随本仓库分发（含 GUI 驱动与打包机专有配置），需在打包机上单独放置：", file=sys.stderr)
        print(r"    mkdir D:\work\sign", file=sys.stderr)
        print(r"    copy <来源>\login_signing_tool.py D:\work\sign", file=sys.stderr)
        print(f"  或用 {TOOL_ENV} / --tool 指定绝对路径。", file=sys.stderr)
        return 1
    if args.timeout < 30:
        print("✗ --timeout 至少 30 秒（手机唤醒 + 验证码读取需要时间）", file=sys.stderr)
        return 2

    if args.in_process or not is_non_interactive_session():
        print("    session: interactive → in-process", flush=True)
        return run_in_process(tool)

    print("    session: non-interactive (SSH/CI) → scheduled task", flush=True)
    return run_via_scheduled_task(tool, args.timeout)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Aborted.", file=sys.stderr)
        sys.exit(130)

# -*- coding: utf-8 -*-
r"""Windows 打包机：检出目标 ref 并安装依赖（deploy.sh 的 win 检出阶段）。

被 deploy.sh 通过 SSH 单行触发：
    python scripts\checkout-win.py --ref main [--clone-url <url>] [--proj <dir>]

为什么是 Python 而不是 cmd 字符串：远程命令里的引号/空格/* 会被 cmd.exe /c 的
引号规则破坏，整条命令静默失败且 sshd 仍返回 0，deploy 误判「检出完成」。这里用
subprocess 的 argv 数组，不做 shell 拼接，每一步校验真实退出码，最后显式断言
HEAD 与目标 ref 一致——防止再次出现「命令没生效却被当成功」。

退出码：0 检出成功（HEAD == 目标 ref 且 npm ci 完成）；1 任何一步失败。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def run(args, cwd: Path, label: str) -> None:
    """执行一条命令（argv 数组，不经 shell），stdout/stderr 直接透传，失败即退出。"""
    print(f"[deps] {label}", flush=True)
    completed = subprocess.run([str(a) for a in args], cwd=str(cwd))
    if completed.returncode != 0:
        print(f"✗ {label} 失败（退出码 {completed.returncode}）", file=sys.stderr)
        sys.exit(1)


def run_capture(args, cwd: Path, label: str) -> str:
    """执行并捕获 stdout（用于读 rev-parse 的 40 位 hex），失败即退出。"""
    print(f"[deps] {label}", flush=True)
    completed = subprocess.run(
        [str(a) for a in args], cwd=str(cwd),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if completed.returncode != 0:
        print(f"✗ {label} 失败（退出码 {completed.returncode}）：{completed.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return completed.stdout.strip()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Windows 打包机：检出目标 ref 并安装依赖")
    parser.add_argument("--ref", required=True, help="目标（main 或 tag 名）")
    parser.add_argument("--clone-url", default="", help="目录缺失时首跑的 clone 地址")
    parser.add_argument("--proj", default=".", help="项目目录（默认当前目录）")
    parser.add_argument("--skip-npm", action="store_true", help="只检出不装依赖（本地验证用）")
    args = parser.parse_args(argv)

    proj = Path(args.proj).resolve()
    ref = args.ref.strip()

    # ① 目录缺失先 clone（首跑自举）。触发命令通常已 cd 到项目目录，此分支只在
    #    手动调用或全新机器时命中。
    if not (proj / ".git").exists():
        if not args.clone_url:
            print("✗ 目录不存在且未提供 --clone-url，无法自举", file=sys.stderr)
            return 1
        run(["git", "clone", args.clone_url, str(proj)], proj.parent, "clone")

    # ② 脏树直接失败，不覆盖打包机上的修改
    run(["git", "diff", "--exit-code"], proj, "worktree clean")
    run(["git", "diff", "--cached", "--exit-code"], proj, "index clean")

    # ③ fetch 到目标 ref（main 或 tag 两种 refspec）
    if ref == "main":
        fetch_refspec = "+refs/heads/main:refs/remotes/origin/main"
        target_ref = "refs/remotes/origin/main"
    else:
        fetch_refspec = f"refs/tags/{ref}:refs/tags/{ref}"
        target_ref = f"refs/tags/{ref}"
    run(["git", "fetch", "origin", fetch_refspec], proj, f"git fetch {ref}")

    # ④ detach 检出
    run(["git", "checkout", "--detach", target_ref], proj, f"checkout {target_ref}")

    # ⑤ 关键断言：HEAD 必须等于目标 ref。之前的静默失败就卡在这——命令没生效
    #    却仍返回 0，这里显式比对，不一致立即失败。
    head = run_capture(["git", "rev-parse", "HEAD"], proj, "HEAD")
    target = run_capture(["git", "rev-parse", target_ref], proj, "target rev")
    if head != target:
        print(f"✗ 检出未生效：HEAD={head} 目标={target}", file=sys.stderr)
        return 1
    print(f"[deps] HEAD {head} == 目标 ref", flush=True)

    # ⑥ 安装依赖（--skip-npm 用于本地验证检出逻辑，跳过耗时的 npm ci）
    if args.skip_npm:
        print("[deps] npm ci skipped (--skip-npm)", flush=True)
        return 0
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        print("✗ 未找到 npm", file=sys.stderr)
        return 1
    run([npm, "ci"], proj, "npm ci")

    print("[deps] npm ci done", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Aborted.", file=sys.stderr)
        sys.exit(130)

# 打包与发布手册

三条链路的完整用法：本地打包、单机发版（GitHub Release + 服务器清单）、多机打包 + 七牛投放。
本文与 `deploy/deploy.sh`、`scripts/qiniu-upload.js`、`scripts/qiniu-artifact.js`、`scripts/release.sh` 的代码同步维护——参数含义以脚本为准，改脚本时请同改本文。

---

## 0. 先选链路

| 目标 | 命令 | 副作用 | 产物落点 |
|---|---|---|---|
| 只出 mac 安装包 | `npm run package` | 写 `dist/`，不碰 git；有公证凭据时会联网提交 Apple 公证 | `dist/package/` |
| 出 win 安装包 | `npm run package:win` | 写 `dist/`，需 Windows 宿主 + SimplySign | `dist/package-win/` |
| 单机完整发版 | `npm run release -- patch` | 改版本、本地 commit + tag、**push 远端**、建 Release、scp 清单到服务器 | `dist/release/` |
| 双机打包（SSH 调度） | `PLATFORM=all MODE=local REF=main deploy/deploy.sh` | 两台打包机各自检出 + 打包 + 校验，产物留打包机（跳板机不回收） | 打包机 `dist/package[-win]/` |
| 双机打包 + 七牛投放 | `PLATFORM=all MODE=publish REF=main deploy/deploy.sh` | 上一行 + 打包机上传七牛 | 同上 + 对象存储 |

`release.sh` 与 `deploy.sh` 是**两条独立链路**：前者在本机出 mac 包、发 GitHub Release；后者调度两台打包机、回收到调度机、可选投七牛。两者不共享产物目录，也不互相调用。

---

## 1. 架构：跳板机 vs 打包机

`deploy.sh` 把「调度」与「构建」彻底分离：跳板机（Jenkins 或任意调度节点）只做无状态编排，全部需要工具链与运行时依赖的工作落在两台独立打包机上。这一节的职责边界是所有校验/配置取舍的判据。

### 1.1 职责边界

| 节点 | 职责 | 运行时依赖 | 明确不承担 |
|---|---|---|---|
| 跳板机（Jenkins） | 参数解析、SSH 调度（只下发命令、读退出码） | `bash/git/ssh` | 构建、签名、公证、校验、上传、回收产物 |
| macOS 打包机 | 检出、`npm ci`、打包、签名/公证/装订、票据复核、`node verify`、`MODE=publish` 时上传七牛 | Node≥21 + Xcode CLT + 证书 + 公证三件套 + 七牛凭据 | 无（发版走独立 `release.sh`） |
| Windows 打包机 | 同上（win 侧签名 + `finalize-win.js` 收尾三断言校验） | Node≥21 + SimplySign + Windows SDK + 七牛凭据 | 无 |

### 1.2 访问 / 构建 / 发布链路

- **访问**：跳板机 → 打包机走 SSH（免密），只下发命令；不回收产物到跳板机。
- **构建**：打包机本地完成（electron-builder + 签名/公证 + 校验），跳板机不参与。
- **发布**：`MODE=publish` 时打包机本地直接 `node scripts/qiniu-upload.js` 投七牛；GitHub Release 仍走 mac 单机 `release.sh`。两者不共享产物。

### 1.3 关键差异与注意事项

- **跳板机纯触发、零 Node、零产物落盘**：只做参数解析 + SSH 调度 + 读退出码，只需 `bash/git/ssh`，不需要 Node、`shasum`、`node_modules`、七牛凭据。
- **校验在打包机**：mac 走 `release.sh` 内的 `refresh` + `verify`（base64 sha512 权威摘要）；win 走 `finalize-win.js` 收尾三断言（`latest.yml` 存在 + `files[]` 逐条 sha512/size 配对）。跳板机不做任何校验。
- **上传在打包机**：`MODE=publish` 时打包机本地追加 `node scripts/qiniu-upload.js --dir dist/package[-win]`（默认**不带** `--with-manifest`，只传安装包、不动 `latest*.yml`；发自动升级才用 `MODE=publish-manifest`），凭据读打包机本地的 `.release.config.json`（qiniu 段）或 `QINIU_*` 环境变量。
- **打包机本地状态不可覆盖**：打包机的 `.env`（公证凭据）、`.release.config.json`（七牛凭据）、`node_modules`、`dist` 都是不入库的本地状态；检出守卫只按 HEAD 归一生成物，绝不覆盖源码或这些未跟踪文件。

---

## 2. 前置条件

### 调度机（跑 `deploy/deploy.sh`）

| 项 | 要求 | 不满足时 |
|---|---|---|
| bash / git / ssh | 任意近期版本 | 脚本启动即报错 |
| 免密登录打包机 | `ssh-agent` 密钥；密码模式仅适合手动 | 退出码 255，脚本给 `ssh-copy-id` 提示 |

跳板机**不回收产物、不校验、不上传**，因此不需要 Node、`shasum`、`node_modules`、七牛凭据。

### macOS 打包机

| 项 | 要求 |
|---|---|
| Node.js | ≥ 21（`npm test` 依赖运行器展开 glob） |
| Xcode CLT | `codesign`、`xcrun` 可用 |
| 签名证书 | 钥匙串有 Developer ID Application；**SSH 会话下 login keychain 必须已解锁**，否则 `errSecInternalComponent` |
| 公证凭据 | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`（三件套缺一不可，`mac.notarize: true` 时必需）；或 `NOTARY_PROFILE` 指向 keychain profile |
| 七牛凭据 | **仅 `MODE=publish` 需要**：`.release.config.json` 的 `qiniu` 段或 `QINIU_*` 环境变量（打包机本地，跳板机不持） |

### Windows 打包机

| 项 | 要求 |
|---|---|
| Node.js | ≥ 21 |
| SimplySign | 安装于默认路径；证书只有在**桌面客户端登录后**才挂进 `Cert:\CurrentUser\My` |
| SimplySign 自动登录 | `scripts/simplysign-login.py` 负责投递：Python 3.9+、`pip install pywinauto pillow`、`adb` 在 PATH、目标手机 USB 在线并已授权调试、打包机保留一个已登录的桌面会话（SSH 落在 session 0，脚本经 schtasks 投递到交互会话）。手机序列号 / 客户端路径等参数以打包机上那份脚本内的取值为准 |
| 登录脚本（不入库） | `login_signing_tool.py` 含 GUI 驱动与设备配置，**不随本仓库分发**：放到 `D:\work\sign\`，或用 `WIN_SIMPLYSIGN_LOGIN_TOOL` 指定绝对路径 |
| PIN 缓存 | 登录成功后首跑 `node scripts/win-sign.js --warmup`，把 OTP/PIN 交互前置（约 3 小时有效） |
| Windows SDK | 含 `signtool.exe` |
| SSH | OpenSSH Server；管理员组账号的公钥要写 `C:\ProgramData\ssh\administrators_authorized_keys` 并收紧 ACL |
| 七牛凭据 | **仅 `MODE=publish` 需要**：`.release.config.json` 的 `qiniu` 段或 `QINIU_*` 环境变量（打包机本地） |

> **Windows 流水线不要并行**：q_assistant 与本项目共用同一台打包机、同一部手机、同一个
> SimplySign 账号。两条流水线同时登录会抢 adb 前台，并可能在同一 30s TOTP 窗口内二次
> 登录而被 Certum 拒绝。计划任务名已按项目区分（`IdeaNoteSigningLogin` vs
> `QAssistantSigningLogin`），但手机只有一部。

`D:\work\sign\` 目录（全部不入库）：

```
D:\work\sign\
├─ login_signing_tool.py     # 登录脚本，win-sign.js 默认调它
├─ sign.log                  # 运行日志（脚本自动写）
└─ sign_file.bat             # 手动签名验证（可选，供排障）
```

登录脚本通过 schtasks 投递到交互桌面会话执行，退出码由临时 cmd 写进结果文件回读。

---

## 3. `deploy/deploy.sh`

### 3.1 执行流程

```
参数解析 → 校验本地 REF → [win] 检出 → 打包+校验+[上传] → [mac] 同上 → 汇总
```

- 单平台失败**不影响**另一平台，最终按汇总表决定退出码。
- 打包、校验、上传都在**打包机**上执行，跳板机只下发命令、读退出码，不回收产物。
- 上传在打包机打包命令尾部，仅 `MODE=publish` / `MODE=publish-manifest`（或 `UPLOAD=1`）追加：`node scripts/qiniu-upload.js --dir dist/package[-win]`；只有 `publish-manifest` 会再带 `--with-manifest`（覆盖 `latest*.yml`）。

### 3.2 调用方式（与 `q_assistant_desktop_dev/deploy/deploy.sh` 一致）

```bash
PLATFORM=mac MODE=publish REF=main bash deploy/deploy.sh
PLATFORM=win MODE=local   REF=v1.2.4 bash deploy/deploy.sh
```

| 参数 | 取值 | 说明 |
|---|---|---|
| `PLATFORM` / `platform` | `win`（默认）\| `mac` \| `all` | 与样本一致：默认只构建 Windows。双平台须显式传 `PLATFORM=all`（未显式指定时脚本会打印提示），双机串行、互不阻塞 |
| `MODE` / `mode` | `local`（默认）\| `publish` \| `publish-manifest` \| `publish-feishu` | `local` 只构建（打包 + 校验）；`publish` 追加打包机上传七牛**安装包**（不带 `--with-manifest`，即不动 `latest*.yml`，客户端不触发自动升级）；`publish-manifest` 同上并额外上传 `latest*.yml`（**发自动升级才用**）；`publish-feishu` 本项目未接飞书，传入即报错退出 2 |
| `REF` | `main` 或已存在的 tag | `TAG` / `tag` / `BRANCH` / `branch` / `GIT_BRANCH` 同样有效；缺省由调度机 HEAD 推断 |

`MODE` 与上传开关的对应：`local` → `UPLOAD=0`，`publish` → `UPLOAD=1`；显式传 `UPLOAD=0|1` 可覆盖（兼容旧调用）。

位置参数（可选，等价于同名环境变量，键名不区分大小写、顺序无关）：

| 键 | 取值 |
|---|---|
| `platform`（`target` 同义） | `win` \| `mac` \| `all` |
| `mode` | `local` \| `publish` |
| `ref`（`tag`/`branch` 同义） | `main` 或 tag |
| `dry` | `1` 只演练 |
| `dry` | 无值，等价 `DRY_RUN=1` |

裸写 `win`/`mac`/`all` 等价 `platform <值>`，裸 `local`/`publish` 等价 `mode <值>`。未知键报错退出 2，不静默忽略。

```bash
deploy/deploy.sh platform mac mode publish REF main   # 等价于上一节的环境变量写法
deploy/deploy.sh mac publish                          # 裸平台 + 裸模式
```

### 3.3 环境变量全表

| 变量 | 默认 | 说明 |
|---|---|---|
| `PLATFORM` | `win` | `win` / `mac` / `all`（双机串行） |
| `MODE` | `local` | `local` 只构建（打包 + 校验）；`publish` 追加打包机上传七牛安装包（不动 `latest*.yml`）；`publish-manifest` 额外上传 `latest*.yml`（发自动升级） |
| `REF` / `TAG` / `BRANCH` / `GIT_BRANCH` | 由调度机 HEAD 推断 | 只接受 `main` 或**调度机本地已存在**的 tag |
| `DRY_RUN` | `0` | `1` = 只打印远程命令，不连机 |
| `UPLOAD` / `UPLOAD_QINIU` | 由 `MODE` 推导 | `1` 强制上传，`0` 强制不传（覆盖 `MODE`） |
| `WIN_SIMPLYSIGN_LOGIN` | `auto` | 仅 win：`off` 完全不碰；`auto` 无可用证书才登录；`force` 无视现有证书强制重登 |
| `WIN_SIMPLYSIGN_LOGIN_TIMEOUT` | `180` | 登录脚本投递到交互会话后的等待上限（秒） |
| `WIN_SIMPLYSIGN_LOGIN_TOOL` | `D:\work\sign\login_signing_tool.py` | 打包机登录脚本的绝对路径（该脚本不入库） |
| `WIN_SIMPLYSIGN_PYTHON` | `python` | 打包机上的解释器；不在 PATH 时给绝对路径（含 `& " < > ^ %` 会被拒） |
| `TARGET` | 无 | 旧调用方式别名，等价 `PLATFORM` |
| `CLONE_URL` | GitHub origin | 打包机首跑目录缺失时的 clone 地址 |
| `WINDOWS_HOST` / `_PORT` / `_USER` / `_PROJECT_DIR` | `106.52.168.174:23491 keke D:\work\test\idea-note-desktop` | win 打包机 |
| `MAC_HOST` / `_PORT` / `_USER` / `_PROJECT_DIR` | `106.52.168.174:23490 hulifeng ~/dev/idea-note-desktop` | mac 打包机 |

七牛凭据（`QINIU_*` 或 `.release.config.json` 的 `qiniu` 段）配置在**打包机本地**，由打包机上的 `qiniu-upload.js` 读取，见 §4.2；跳板机不持有、不转发。

**优先级**：位置参数 > 环境变量 > 脚本默认；`REF` 缺省时才由仓库 HEAD 推断，不猜版本号。

### 3.4 常用命令

| 场景 | 命令 |
|---|---|
| 只演练，看会执行什么 | `PLATFORM=all MODE=publish REF=main DRY_RUN=1 deploy/deploy.sh` |
| 只构建两台机，不发布 | `PLATFORM=all MODE=local REF=main deploy/deploy.sh` |
| 只重跑 mac | `PLATFORM=mac MODE=local REF=main deploy/deploy.sh` |
| 构建并投七牛（打包机上传） | `PLATFORM=all MODE=publish REF=main deploy/deploy.sh` |
| 只投、不想重建（在打包机手动跑） | `node scripts/qiniu-upload.js --dir dist/package` |
| 只验证 SimplySign 登录（在打包机跑） | `python scripts\simplysign-login.py` 或 `node scripts/win-sign.js --login-only` |

### 3.5 产物结构

产物不再回收到跳板机：mac 落在打包机 `dist/package/`，win 落在 `dist/package-win/`，`MODE=publish` 时由打包机直接投七牛。每次打包成功收尾后会自动按 SemVer 排序清理 `dist/` 与投放目录的历史版本（仅保留最近 2 个版本，且保护本次构建版本；清理失败只打告警日志，不阻断打包结果）。

```
（mac 打包机）dist/package/
├── 灵感笔记-1.2.4-arm64.dmg          # 安装包保留中文名（人工下载）
├── 灵感笔记-1.2.4.dmg                # x64
├── idea-note-1.2.4-arm64-mac.zip     (+ .blockmap)
├── idea-note-1.2.4-mac.zip           (+ .blockmap)   # x64
└── latest-mac.yml

（win 打包机）dist/package-win/
├── idea-note-Setup-1.2.4.exe         (+ .blockmap)
├── idea-note-1.2.4-win.zip           # zip target 产出时才存在
└── latest.yml
```

命名分两套，原因不同（`release-manifest.js` 的 `assetName()` 是唯一定义处）：

| 资产 | 名字 | 原因 |
|---|---|---|
| `.dmg` | 中文原名 `灵感笔记-*` | 只供人工下载；electron-updater 在 mac 上只消费 zip，不碰 dmg |
| `.zip` / `.exe` / `.blockmap` / `latest*.yml` 里的 `path` | ASCII `idea-note-*` | 走自动更新，URL 要过 CDN / GitHub / 客户端解析，中文需 percent-encode，任一环不一致就是静默 404 |

GitHub Release 绝对地址里，中文 dmg 段会 percent-encode（`%E7%81%B5...`），清单里存的就是编码后的形式。

### 3.6 各阶段校验

| 阶段 | 校验内容（执行方） | 失败表现 |
|---|---|---|
| 检出 | 打包机：mac 先按 HEAD 还原生成物 `**/.qzhuli-manifest.json`，再由**不带排除**的守卫判定工作区干净；`git rev-parse HEAD` 留痕 | SSH 非 0：255 = 认证/连接，其余多为脏树（脚本补一次只读 `git status` 取证） |
| 打包 | 打包机：打包命令退出码 | 退出码非 0；按平台给排障提示 |
| 校验 | 打包机：mac 走 `release.sh` 的 `refresh` + `verify`；win 走 `finalize-win.js` 收尾三断言（`latest.yml` 存在 + `files[]` 逐条 sha512/size 配对） | 退出码非 0 |
| 上传 | 打包机：`qiniu-upload.js` 见 §4.5 | `FAIL（七牛投放失败）` |

### 3.7 退出码

| 码 | 含义 |
|---|---|
| 0 | 全部成功（含上传，若启用） |
| 1 | 至少一台失败：检出/打包/回收/sha512/上传任一环节 |
| 2 | 参数错误：未知键、非法取值、`REF` 非法或本地无此 tag |

---

### 3.8 mac 打包入口（`scripts/package-mac.sh`）

SSH 场景下裸跑 `npm run package` 会死在 codesign（`errSecInternalComponent(-2070)`），因为签名身份在专用钥匙串里、而该钥匙串在非 GUI 会话下是锁着的，electron-builder 只会重试 4 次再抛栈。打包机的 mac 分支已改走本脚本：

| 步骤 | 行为 | 失败时 |
|---|---|---|
| 载入 `.env` | `set -a; . ./.env; set +a`，提供公证凭据 | 无 `.env` → 仅告警，公证被跳过 |
| 选钥匙串 | `CSC_KEYCHAIN` > `QASSISTANT_KEYCHAIN` > 系统搜索列表 | 路径不存在 → 退出 1，提示核对 `~/.config/qassistant-packager/packager.env` |
| 解锁 | 读到密码才执行 `security unlock-keychain` | 密码错 → 退出 1，指明是密码问题而非证书问题 |
| 真签自测 | 临时文件跑一次带 `--timestamp` 的 `codesign` | 按 `-2070` / `no identity found` / `timestamp` 三类分别给处置 |
| 打包 | `npm run package`，完整输出同时写 `dist/package-mac.log` | 退出 1，直接给出日志路径 |
| 票据复核 | `stapler validate` 逐个检查 `dist/package/*.dmg` | 缺票则补跑 `npm run notarize:dmg`；补跑失败即退出 1（不产出无票的包） |

```bash
bash scripts/package-mac.sh                 # 签名 + 公证（取决于 .env）
npm run package:mac                         # 同上
SKIP_SIGNING=1 bash scripts/package-mac.sh  # 未签名包，同时清掉公证凭据
```

> `SKIP_SIGNING=1` 会 unset `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` / `NOTARY_PROFILE`。这不是保险措施而是必需：electron-builder 的 `notarize` 不看签名结果，只要凭据在就会尝试公证未签名的包，必然失败；`notarize_dmgs` 又优先看 `NOTARY_PROFILE`，漏清同样会去公证未签名包。

## 4. `scripts/qiniu-upload.js`

零依赖（Node 20 自带 `fetch` / `crypto`），直接调七牛 Kodo 上传与 `rs` 查询接口，不需要 `qshell` 或 SDK。

### 4.1 命令行选项

| 选项 | 说明 |
|---|---|
| `--dir <dir>` | 必填。产物目录，须含 `latest*.yml` 与安装包 |
| `--prefix <p>` | 覆盖对象 key 前缀（默认取配置，缺省 `autoupdates/`） |
| `--dry-run` | 只打印上传计划，不联网、不要求凭据 |
| `--check` | 不写数据，只核对远端是否存在且大小一致 |
| `--skip-unchanged` | 远端同名同大小则跳过上传 |
| `--with-manifest` | **同时上传 `latest*.yml`**（开启客户端自动升级）。默认只传安装包/blockmap、不动清单——用户 2026-11-25 要求：只有明确「发自动升级」时才换清单 |
| `--strict-public` | 公网 HEAD 失败即判失败（默认只告警） |
| `--no-cdn` | 跳过清单 Content-Type 修正与 CDN 刷新 |
| `--strict-cdn` | Content-Type / CDN 刷新失败即判失败（默认只告警） |
| `--retries <n>` | 单文件重试次数，默认 3 |
| `-h, --help` | 帮助 |

### 4.2 配置项

优先级：**环境变量 > `.release.config.json` 的 `qiniu` 段 > 默认值**。

| 配置键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `accessKey` | `QINIU_ACCESS_KEY` | 无（必填） | 七牛密钥 AK；建议用只授予目标 bucket 写权限的子账号 |
| `secretKey` | `QINIU_SECRET_KEY` | 无（必填） | 七牛密钥 SK |
| `bucket` | `QINIU_BUCKET` | 无（必填） | 目标空间名 |
| `prefix` | `QINIU_PREFIX` | `autoupdates/` | 对象 key 前缀，**必须与 `build.publish.url` 的路径一致** |
| `uploadHost` | `QINIU_UPLOAD_HOST` | `https://upload.qiniup.com` | 上传入口；指定区域可用 `upload-z0/z1/z2.qiniup.com` |
| `rsHost` | `QINIU_RS_HOST` | `https://rs.qiniu.com` | 管理接口（stat 校验、`chgm` 改 MIME） |
| `cdnHost` | `QINIU_CDN_HOST` | `https://fusion.qiniuapi.com` | CDN 刷新入口（融合 CDN） |
| `publicBase` | `QINIU_PUBLIC_BASE` | 空 | 桶的公开域名根（不含 prefix）。配了才做公网 HEAD 校验与 CDN 刷新 |

另：`QINIU_UPLOAD_TIMEOUT_MS`（默认 600000）控制单文件上传超时；stat 固定 30s、HEAD 固定 10s。

`.release.config.json` 片段（模板见 `.release.config.example.json`，该文件已 gitignore）：

```json
{
  "qiniu": {
    "accessKey": "…",
    "secretKey": "…",
    "bucket": "…",
    "prefix": "autoupdates/",
    "uploadHost": "https://upload.qiniup.com",
    "publicBase": "https://cdn.example.com"
  }
}
```

### 4.3 发布生效（Content-Type 与 CDN 刷新）

上传成功 ≠ 客户端能看到新版本。全部对象传完后脚本还会做两件事：

1. **清单 MIME**：`POST /chgm/...` 把 `latest*.yml` 的 Content-Type 钉成 `text/yaml; charset=utf-8`。
   七牛对 `.yml` 推断的 `text/yaml` 不带 charset，浏览器按系统码页（zh-CN 是 GBK）解码，
   清单里的中文文件名会显示成乱码。electron-updater 一律按 UTF-8 读，不受影响，这条是为人肉排障。
2. **CDN 刷新**：`POST /v2/tune/refresh` 刷新本次上传的全部 URL（含清单）。
   清单若被 CDN 缓存，客户端会继续拿到旧版本——这是「发了版但没人升级」最常见的原因。

两者失败默认**只告警**（CDN 未绑定、测试域名、刷新配额用尽都不该阻断发布）；
`--strict-cdn` 可升级为失败。签名细节：`chgm` 与刷新都只签 `path + "\n"`，
**刷新接口的 JSON body 不参与签名**（与官方 SDK `generateAccessToken(mac, url, '')` 一致）。

### 4.4 对象 key 与 feed 对齐

key = `prefix + 文件名`，清单内是**相对文件名**，所以清单与安装包必须落在同一前缀：

```
autoupdates/latest-mac.yml                 ← 客户端拉这个
autoupdates/灵感笔记-1.2.4-arm64.dmg        ← 中文名，仅人工下载
autoupdates/idea-note-1.2.4-arm64-mac.zip  ← ASCII 名，自动更新走这个
...
```

cdn 刷新与 HEAD 校验用的 URL 由 `publicBase + '/' + 逐段 encodeURIComponent(key)` 得到，
中文 dmg 会编码成 `%E7%81%B5%E6%84%9F%E7%AC%94%E8%AE%B0-…`；对象 key 本身仍是原始 UTF-8。

对应 `package.json`：

```json
"publish": { "provider": "generic", "url": "https://ideanote.7373.com.cn/autoupdates/" }
```

**这条必须对齐**：桶的访问域名 + 前缀要等于 `build.publish.url`。若换桶/换域名，先改 `build.publish.url` 再重新打包，否则客户端仍去旧地址。

### 4.5 校验矩阵

| 校验 | 时机 | 判定 | 失败处理 |
|---|---|---|---|
| 目录完整性 | 上传前 | 必须有 `latest*.yml` 且至少一个安装包 | 退出 2（拒绝上传，避免清单指向 404） |
| 本地 sha512 | 上传前 | `release-manifest.js verify` 逐条比对 | 退出 1，一个对象都不传 |
| 上传顺序 | 全程 | 安装包/blockmap 在前，`latest*.yml` 最后 | 客户端不会先看到指向 404 的清单 |
| 远端 stat | 每个对象上传后 | `fsize` == 本地字节数 | 退出 1，不继续（凭据类错误直接中断） |
| 公网 HEAD | 配了 `publicBase` 时 | 200 且 `content-length` 一致 | 默认告警；`--strict-public` 时判失败 |
| 清单 MIME | 全部上传后 | `chgm` 返回 2xx | 默认告警；`--strict-cdn` 时判失败 |
| CDN 刷新 | 全部上传后 | `/v2/tune/refresh` 返回 `code=200` | 默认告警；`--strict-cdn` 时判失败 |

### 4.6 可重复执行

- 写入用 putPolicy `insertOnly=0`，**同 key 覆盖**，重跑不会产生 `-1` 副本；
- 中途失败可直接重跑同一条命令，已上传对象被覆盖为同一份内容；
- `--skip-unchanged` 按「远端大小 == 本地大小」跳过，适合只补传清单的场景；
- 清单永远最后写，因此「包没传完就中断」不会让客户端拉到半套版本。

### 4.7 输出与退出码

```
▸ 七牛投放 · bucket=ideanote · 前缀=autoupdates/ · 目标=https://upload.qiniup.com
  凭据 AK_a****（env QINIU_ACCESS_KEY）· 共 7 个对象 · 清单最后上传
  ✓ latest-mac.yml 与目录内 4 个产物 sha512 配对
  ✓ autoupdates/idea-note-1.2.4-arm64-mac.zip  108MB  fsize=112901957
  ✓ autoupdates/灵感笔记-1.2.4-arm64.dmg  113MB  fsize=118602579
  ✓ autoupdates/latest-mac.yml  1KB  fsize=503
▸ 完成：7 个对象已就位并校验（bucket=ideanote 前缀=autoupdates/）
```

| 码 | 含义 |
|---|---|
| 0 | 全部上传并校验通过（`--dry-run` / `--check` 通过也返回 0） |
| 1 | 上传或校验失败（含 stat 大小不一致、本地 sha512 不配对） |
| 2 | 参数/配置错误（缺 `--dir`、缺凭据、目录不存在、清单缺失） |

### 4.8 产物单传（`scripts/qiniu-artifact.js`）

用于把**单个或一组构建/生成产物**（QA 包、截图、报告、归档）单独投到对象存储，不与发版耦合。
入口：`npm run upload:artifact -- <文件|目录>…`。

与发布链路的边界：

| | 发布链路 `qiniu-upload.js` | 产物单传 `qiniu-artifact.js` |
|---|---|---|
| 输入 | 整个产物目录，**必须**含 `latest*.yml` | 任意文件/目录，无清单要求 |
| 校验 | sha512 门禁 + stat 大小 | stat 大小 + 七牛 etag（内容级） |
| 前缀 | `qiniu.prefix`（默认 `autoupdates/`） | `qiniu.artifactPrefix`（默认 `artifacts/`） |
| 副作用 | 清单 MIME 修正 + CDN 刷新 | 默认无；`--cdn` 才刷新 |
| 触发 | `npm run upload:qiniu` / `deploy.sh MODE=publish` | `npm run upload:artifact`，独立命令 |

脚本只复用 `qiniu-upload.js` 的纯函数（签名、配置优先级、stat、上传原语），**不调用它的流程**，
因此两条链路可以各自独立执行、互不改变对方的远端状态。

**对象 key 规则**：`<prefix><subdir><[YYYY-MM-DD/]><name>`

| 调用 | key |
|---|---|
| `upload:artifact -- shot.png` | `artifacts/shot.png` |
| `... -- shot.png --dated` | `artifacts/2026-11-20/shot.png` |
| `... -- shot.png --subdir qa/1.2.4 --dated` | `artifacts/qa/1.2.4/2026-11-20/shot.png` |
| `... -- shot.png --name 首屏.png` | `artifacts/首屏.png` |
| `... -- shot.png --prefix tmp/` | `tmp/shot.png` |

`name` 默认取源文件名：去路径、空白折叠为 `-`、去控制字符；中文原样保留（URL 侧逐段 percent-encode）。
`--name` 只允许单文件；子目录用 `--subdir`。以下情况直接拒绝（退出 2）：

- `latest*.yml`：防止把清单当普通文件传到错误前缀，误以为更新源已更新（`--allow-manifest` 可绕过）；
- 产物前缀与更新源前缀互相包含：默认配置下 overlaps 即报错，`--prefix` 显式指定时仅告警；
- 多个输入清洗后同名、或落到同一个 key：避免静默互相覆盖；
- 单文件 > 512MB：现实现整文件读入内存，大文件请用 `qsctl` 分片。

**重复上传**（幂等）：先 `stat` 远端，用七牛 etag 比对内容。

| 远端状态 | 默认行为 | 覆盖方式 |
|---|---|---|
| 不存在 | 上传 | — |
| 同名且 etag 一致 | 跳过，打印 `↷` | `--force` 强制重传 |
| 同名同大小、etag 不同 | 告警并覆盖写 | — |
| 同名不同大小 | 覆盖写（提示大小差异） | `--skip-existing` 可改为一律跳过 |

写入仍是 `insertOnly=0`，重跑不会产生 `-1` 副本；`--check` 只核对、`--dry-run` 不联网。

**输出**：

```
▸ 七牛产物单传 · bucket=ideanote · 前缀=artifacts/ · 目标=https://upload.qiniup.com
  凭据 AK_a****（env QINIU_ACCESS_KEY）· 前缀来源 .release.config.json qiniu.artifactPrefix · 2 个文件
  ✓ artifacts/qa/2026-11-20/screenshot.png  412KB  etag=Fabc…
    https://cdn.example.com/artifacts/qa/2026-11-20/screenshot.png
  ↷ artifacts/qa/2026-11-20/report.pdf  远端已存在且内容一致（--force 可强制重传）
▸ 完成：1 上传 / 1 跳过 / 0 失败 · 合计 412KB
```

失败时逐条打印 `key + 原因 + 处置`，最后提示可原命令重跑；`--json` 输出结构化结果
（`items[].status` = `uploaded` / `skipped` / `failed` / `aborted`，附 `summary`），供 CI 消费。
退出码与 §4.7 一致：0 成功（含跳过）、1 上传/校验失败、2 参数/配置错误。

配置项（复用 §4.2 的凭据，仅新增前缀）：

| 配置键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `artifactPrefix` | `QINIU_ARTIFACT_PREFIX` | `artifacts/` | 产物前缀，必须与 `prefix` 分离 |

```bash
npm run upload:artifact -- dist/package/灵感笔记-1.2.4-arm64.dmg --subdir qa --dated
npm run upload:artifact -- screenshot.png --dry-run
npm run upload:artifact -- --dir reports --check
```

---

## 5. `scripts/release.sh`（单机发版）

### 5.1 三种模式

| 模式 | 命令 | 远端副作用 | 产物目录 |
|---|---|---|---|
| `package` | `npm run package` | 无 | `dist/package/` |
| `dry` | `npm run release:dry` | 无（只改写清单） | `dist/release/latest-mac.yml` |
| `release` | `npm run release -- patch` | 有：commit、tag、push、GitHub Release、scp 清单 | `dist/release/` |

### 5.2 release 模式步骤

1. `resolve_version`：`npm version <bump> --no-git-tag-version` 改 `package.json`
2. 检查 tag `v$VERSION` 不存在
3. `commit_version`：本地 commit + 打 tag
4. `run_tests`（`SKIP_TESTS=1` 可跳过）
5. `build`：`npx electron-builder --mac`
6. `notarize_dmgs`：就地对 `dist/*.dmg` 签名 → notarytool 提交 dmg 本体 → staple（有凭据才跑）
7. `stage_assets`：收 dmg/zip/blockmap；dmg 保留中文名，zip/blockmap 转 ASCII
8. `cleanup_old_artifacts`：保留最近 2 个版本（保护当前版本），清理更早旧包及衍生产物（非阻断）
8. `push_git`：**push 分支与 tag**
9. `publish_release`：`gh release create` + `upload --clobber`
10. `write_deploy_manifest`：清单 url 改 GitHub 绝对地址，并按磁盘实际重算 sha512
11. `verify_assets`：`curl -r 0-1023` 逐条验证资产可下载
12. `deploy_manifest`：scp 到服务器，先传 `.tmp` 再原子 `mv`，比对 sha256
13. `verify_feed`：线上清单版本必须等于本次版本

### 5.3 参数与前置

| 项 | 说明 |
|---|---|
| 版本参数 | `patch` / `minor` / `major` / `x.y.z`；与当前相同会被拒绝 |
| 工作区 | `release` 模式要求干净，脏则退出 |
| `.release.config.json` | `release` 必需：`repo` + `ssh.{host,user,port,identity,dir}` |
| `gh` | 已登录且对仓库有 Write 权限 |
| `SKIP_TESTS` | `1` = 跳过单测（不建议） |

> `release.sh` 自带的 `git push` 是**这条命令的显式语义**（发版必须推 tag），不是自动行为；只跑 `npm run package` 不会碰远端。

---

## 6. 典型场景

### 6.1 打包机首跑

```bash
PLATFORM=all MODE=local REF=main DRY_RUN=1 deploy/deploy.sh   # 先看命令对不对
PLATFORM=all MODE=local REF=main deploy/deploy.sh             # 目录缺失会自动 git clone
```
首次 clone 走 GitHub 全量（约 58 MiB pack），慢链路可能超时；可先手工在打包机放好仓库。

### 6.2 日常发版（双平台 + 七牛）

```bash
git fetch --tags && git tag --sort=-v:refname | head -5   # 确认目标 tag 在本地存在（脚本只认本地 tag）
PLATFORM=all MODE=publish REF=v1.2.5 deploy/deploy.sh
```

### 6.3 只补传产物（不重新打包）

产物始终留在打包机 `dist/package[-win]`。补传/重传只需在打包机手动对产物目录跑一次上传（幂等，按 key 覆盖写）：

```bash
node scripts/qiniu-upload.js --dir dist/package       # 在 mac 打包机上（只传包，不动 latest*.yml）
node scripts/qiniu-upload.js --dir dist/package-win   # 在 win 打包机上（同上）
node scripts/qiniu-upload.js --dir dist/package --with-manifest   # 发自动升级：连 latest*.yml 一起覆盖
```

### 6.4 只重试上传

上传失败后直接重跑同命令即可；只想跳过已一致对象可加 `--skip-unchanged`：

```bash
node scripts/qiniu-upload.js --dir dist/package --skip-unchanged
```

### 6.5 线上核验

```bash
curl -s https://ideanote.7373.com.cn/autoupdates/latest-mac.yml | head -5   # 版本号与 files
curl -sI "https://ideanote.7373.com.cn/autoupdates/灵感笔记-1.2.5-arm64.dmg" | head -3   # dmg 是中文名，不是 idea-note-*
```

### 6.6 回滚

| 场景 | 做法 |
|---|---|
| 只投错清单、包没错 | 用旧版本目录的 `latest*.yml` 重投（覆盖写），客户端即回到旧版 |
| 版本号写错、尚未推送 | 本地 `git checkout -- package.json package-lock.json`，清 `dist/` 重跑 |
| 已发 tag/Release | Release 可删，tag 保留以保证可追溯；客户端已升级的只能发更高版本修复 |
| 已投七牛的包有问题 | 上传同版本重建产物会换 sha512，**必须连同清单一起重投**，不能只换包 |

---

## 7. 排障

| 现象 | 根因 | 处置 |
|---|---|---|
| 上传阶段 `缺少七牛凭据` / `bad token` / 401 | 打包机本地无七牛凭据（`.release.config.json` 的 `qiniu` 段或 `QINIU_*`）或 AK/SK 不匹配 | 上传在**打包机**执行：到打包机配 `.release.config.json` 或注入 `QINIU_*`，核对同账号/子账号授权 |
| `Permission denied (publickey,password…)`，退出码 255 | 未装公钥 / 密码错 3 次 | `ssh-copy-id -p <port> <user>@<host>`；Windows 管理员组见 §2 |
| 检出阶段退出码 1，日志有 `error: Your local changes to the following files would be overwritten by checkout` | 打包机停在 `d92c47b` 之前，4 个 `.qzhuli-manifest.json` 仍是「已跟踪+已修改」（qzhuli-cli 装 skill 时重写了 `installed_at`），而目标提交删除它们 → checkout 中止 | mac 侧已由脚本自动归一，无需干预；win 侧（或旧脚本）在机上前置还原：`git ls-files -z "*/.qzhuli-manifest.json" \| xargs -0 git checkout --`，再重跑。确认机上无热修才可用 `git checkout -f --detach <ref>` |
| 检出阶段退出码 1，日志有 `git diff` 输出 | 打包机工作区有源码真实改动 | 在打包机 `git status` 后提交或还原（脚本不覆盖打包机上的改动） |
| `codesign … errSecInternalComponent` | SSH 会话拿不到证书私钥 | 打包机 GUI 终端 `security unlock-keychain ~/Library/Keychains/login.keychain-db`；或把私钥访问控制设为 Always Allow |
| `试签失败：errSecInternalComponent(-2070)`（package-mac.sh） | 钥匙串锁定，或私钥 ACL 未放行，或 codesign 命中了别的钥匙串 | 解锁 + `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <密码> <钥匙串>`；身份若在专用钥匙串，用 `CSC_KEYCHAIN` 指过去 |
| `试签失败：no identity found`（package-mac.sh） | 指定钥匙串里只有证书、没有配对私钥 | 换到含私钥的钥匙串，或重新导入 `.p12` |
| `试签失败：时间戳服务不可达` | `--timestamp` 需要 `timestamp.apple.com:80` | 放通该域名（代理/TUN 加直连）；不能去掉时间戳，公证要求安全时间戳 |
| 构建日志 `skipped macOS notarization` | 三类：`.env` 未载入（`build:mac` 不读 `.env`）、未配 `APPLE_*` 三件套、或 `notarize:false` | 预期行为之一。需要公证则用 `bash scripts/package-mac.sh`（会 source `.env`）并补齐三件套；补票用 `npm run notarize:dmg` |
| Windows 报「证书存储中没有可用代码签名证书」 | SimplySign 未登录 / 自动登录失败 / PIN 过期 | 先看登录脚本同目录的 `sign.log`（默认 `D:\work\sign\sign.log`）尾部与 deploy 日志；手工验证 `python scripts\simplysign-login.py` → `node scripts/win-sign.js --login-only`。临时关自动登录：`WIN_SIMPLYSIGN_LOGIN=off`（要求机上已人工登录）；急用可 `--allow-unsigned` |
| 预热报 `No certificates were found that met all the given criteria` | SimplySign 会话已断开，但证书仍残留在存储里（`HasPrivateKey` 仍为 true）；旧逻辑按证书数量跳过登录就会走到这一步 | 当前版本每次打包都先拉起连接，日志应有 `▸ SimplySign 登录：auto：先确保连接状态` 与 `session: non-interactive → scheduled task`。若两者都没有，说明打包机代码没更新到含该逻辑的提交 |
| 登录报「未找到登录脚本」 | `login_signing_tool.py` 没放到打包机，或路径没传对 | 放到 `D:\work\sign\`；或传 `WIN_SIMPLYSIGN_LOGIN_TOOL=D:\work\sign\login_signing_tool.py` |
| `SimplySign 登录超时` / 「任务未在交互会话完成」 | 桌面会话未登录、adb 设备掉线、或计划任务没落到 session 1 | `query user` 确认打包用户处于活动会话；`adb devices` 确认手机为 `device`；`schtasks /query /tn IdeaNoteSigningLogin` 看任务是否存在；重跑 `python scripts/simplysign-login.py` |
| 自动登录报「找不到 Python 解释器」 | 打包机 PATH 里没有 `python`，或只有 Microsoft Store 别名 | deploy 时传 `WIN_SIMPLYSIGN_PYTHON=C:\Python311\python.exe`（含 `& " < > ^ %` 会被拒绝） |
| `no such bucket` / 631 | bucket 名或区域不符 | 核对 `QINIU_BUCKET`；换 `upload-z*.qiniup.com` |
| 产物单传报「产物前缀与更新源前缀重叠」 | `artifactPrefix` 配到了 `autoupdates/` 下 | 改成独立前缀（默认 `artifacts/`）；确需落更新源目录时用 `--prefix` 显式指定（仅告警） |
| 产物单传报「拒绝单传发布清单 latest*.yml」 | 把发版清单喂给了产物链路 | 发版用 `npm run upload:qiniu -- --dir <产物目录>`；仅留档时加 `--allow-manifest` |
| `--cdn 需要 QINIU_PUBLIC_BASE` | 未配公开域名，拼不出刷新 URL | 配 `publicBase`，或去掉 `--cdn`（产物单传默认不刷新） |
| 产物单传 `etag 不一致` | 同名文件已被别的内容占用 | 脚本已按覆盖写重传；仍失败查是否有外部程序并发改写该 key |
| `file exists` / 614 | 策略禁止覆盖 | 脚本默认 `insertOnly=0`，检查是否被外部策略覆盖 |
| stat 大小不一致 | 上传被截断或对象被并发改写 | 重跑同命令（覆盖写）；持续失败查网络/代理 |
| 公网 HEAD 403/404 但 stat 正常 | 未绑域名 / CDN 未刷新 / 防盗链 | 对象已落盘；刷新 CDN 后复验 |
| 客户端仍拉到旧版本 | 清单被 CDN 缓存 | 对 `latest*.yml` 做刷新或该前缀配置不缓存 |

---

## 8. 凭据与安全

- AK/SK 只允许出现在 `.release.config.json`（gitignore）或 CI 环境变量中，**不得写入 `package.json`、脚本、README**。
- 日志只输出掩码（`AK_a****`），完整密钥不会出现在 stdout/stderr。
- 建议用子账号密钥，仅授予目标 bucket 的写入权限；不要用账号主密钥。
- 上传走 HTTPS；`uploadHost` 若改成 http，凭证会在明文链路传输，脚本不做拦截，勿这么配。

# Jenkins 部署与配置指南

流水线定义在仓库根目录 `Jenkinsfile`（Pipeline script from SCM），Jenkins 侧只做调度配置，零脚本维护。
双平台节点分别构建：Windows 出 NSIS 安装包（SimplySign 自动签名），macOS 出 dmg/zip（Developer ID 签名 + 可选公证）。

## 一、Jenkins 主控安装（一次性）

1. 安装 Jenkins LTS（需 JDK 17 或 21）：https://www.jenkins.io/download/
2. 初始密码在首次启动日志里；插件至少装：**Pipeline、Git、Git client、Credentials Binding**。
3. 建议主控只做调度，构建全部分发到 agent 节点（主控不需要 Node.js）。

## 二、构建节点接入

### Windows 节点（标签 `windows`）

| 项 | 要求 |
|---|---|
| Node.js | ≥ 21（`node -v` 验证；测试脚本依赖运行器展开 glob） |
| Git | 任意近期版本 |
| SimplySign 客户端 | 已安装并登录（登录后证书挂载进 `Cert:\CurrentUser\My`，`npm run package:win` 会自动发现并签名） |
| Windows SDK | 含 signtool（构建机已有 10.0.26100 版） |

节点接入：Manage Jenkins → Nodes → New Node → 名称自定、**Labels 填 `windows`** → Launch method 按实际（JNLP / SSH）。

**首次构建前（人工，一次性）**：节点上手动跑
```bash
node scripts/win-sign.js --warmup
```
完成 SimplySign 的 OTP/PIN 缓存（约 3 小时有效）。之后流水线内每轮自动预热续期。

### macOS 节点（标签 `macos`）

| 项 | 要求 |
|---|---|
| Node.js | ≥ 21 |
| Git / Xcode CLT | codesign、xcrun 可用 |
| 钥匙串 | Developer ID Application 证书（本仓库已有 Shooter Technology 的证书可用） |

## 三、新建 Pipeline 任务

New Item → **Pipeline** → Configure：

- **Pipeline** → Definition: `Pipeline script from SCM`
- **SCM**: Git → `https://github.com/hlf2002/idea-note-desktop.git`
- **Branch Specifier**: `*/main`
- **Script Path**: `Jenkinsfile`
- 仓库若转私有：Credentials 添加 GitHub Token（repo 权限）并在 SCM 处选用
- 触发方式：默认手动 *Build with Parameters*；要自动触发可配 GitHub webhook 或 `H/5 * * * *` 轮询

## 四、构建参数（Jenkinsfile 已定义，无需另行创建）

| 参数 | 说明 | 建议值 |
|---|---|---|
| `TARGET` | `all` / `win` / `mac` | `all` |
| `RUN_TESTS` | 打包前跑全量单元测试（290 项） | `true` |
| `NOTARIZE` | mac 是否公证 | 先 `false`，凭据配好后再开 |
| `WIN_SIGN_SHA1` | 证书指纹；**留空 = 自动发现**（SimplySign 登录即自动签名） | 留空 |
| `WIN_PUBLISHER_NAME` | 发布者名；自动模式自动取证书 Subject | 留空 |
| `WIN_ALLOW_UNSIGNED` | 无证书时仍出未签名包（SmartScreen 会拦截） | `false` |

## 五、凭据（Manage Jenkins → Credentials）

| 凭据 ID | 类型 | 用途 |
|---|---|---|
| `apple-id` | Username with password | mac 公证：用户名 = Apple ID，密码 = App 专用密码（appleid.apple.com 生成）。`NOTARIZE=true` 时必需 |

凭据只经 `withCredentials` 注入环境变量，不落任何代码/配置文件。

## 六、产物与归档

| 平台 | 归档路径 | 内容 |
|---|---|---|
| Windows | `dist/package-win/*` | idea-note-Setup-x.y.z.exe + blockmap + latest.yml |
| macOS | `dist/package/*` | 双架构 dmg/zip + blockmap + latest-mac.yml |

在构建页 *Artifacts* 直接下载。产物名统一 ASCII（构建原始中文名在收尾阶段改名，清单同步改写并做 sha512 配对校验）。构建历史默认保留 20 次。

## 七、常见问题速查

| 现象 | 处置 |
|---|---|
| Windows 停在「证书存储中没有可用代码签名证书」 | SimplySign 未登录；登录后重跑。退出码 2 + 排查清单 |
| 卡在 `Submitting digest for signing` | PIN 缓存过期；节点上 `node scripts/win-sign.js --warmup` |
| mac 日志 `skipped macOS notarization` | 预期：未配 apple-id 凭据或 NOTARIZE=false。构建成功但未公证，dmg 需公证后 `npm run staple` |
| `npm test` 报 glob/参数错误 | 节点 Node 版本 < 21，升级 |
| 测试挂了想跳过 | RUN_TESTS=false（不建议，发布门禁靠它） |
| 想只构建一个平台 | TARGET=win 或 mac（分别跑，收尾目录互相独立） |
| deploy.sh 报 Permission denied (publickey,…) | 调度机公钥未装到打包机；见第九节前置 1 |
| deploy.sh 报 `Unknown option: -C`（随后误报「不是本仓库已知 tag」） | 调度机 git < 1.8.5（如 CentOS 7 的 1.8.3.1）不支持 `git -C`；脚本已改用 cd 子 shell 规避（2026-11-17），其他脚本再报此错则升级调度机 git |
| deploy.sh 只跑一台却报两台、或参数像没生效 | 旧版忽略位置参数（`target mac REF main` 被静默当成 `TARGET=all`）。当前版本已支持位置参数并对未知键报错退出 2 |
| deploy.sh 报「工作区有未提交改动」但打包机上只有 `.qzhuli-manifest.json` 的 `installed_at` 差异 | 该文件是 qzhuli-cli 安装生成的，已从脏树判定中排除（`:(exclude)**/.qzhuli-manifest.json`）。若仍报脏，说明是源码真实改动，须人工处置 |
| mac 打包 `codesign` 报 `errSecInternalComponent` | SSH 会话拿不到证书私钥：login keychain 未解锁。在打包机 GUI 终端 `security unlock-keychain ~/Library/Keychains/login.keychain-db`，或把私钥访问控制设为 Always Allow |

## 八、发布到自动更新服务器（当前未接，人工执行）

Jenkins 目前只做**构建 + 归档 + 校验**；发布（GitHub Release + 推清单到 ideanote.7373.com.cn/autoupdates/）涉及远端写操作，仍由人工在 mac 上执行 `npm run release -- patch`（内置版本递增、tag 先行、清单原子上传、线上校验）。如需把发布接进流水线，另行评审凭据与放行门禁（技能铁律 5：远端写操作前必须人工确认）。

## 九、多机打包调度（deploy/deploy.sh，SSH 直连打包机）

不依赖 Jenkins 节点：本机（或任意调度节点）执行 `deploy/deploy.sh`，由它 SSH 到两台打包机检出、打包、scp 回收产物并做 sha512 校验。调度模式与 q_assistant_desktop 的 deploy.sh 一致；两台打包机与 q_assistant 共用（仅项目目录不同）。

| 项 | Windows 机 | macOS 机 |
|---|---|---|
| 地址 | keke@106.52.168.174:23491 | hulifeng@106.52.168.174:23490 |
| 项目目录 | `D:\work\test\idea-note-desktop` | `~/dev/idea-note-desktop` |
| 打包命令 | `npm run package:win`（SimplySign 自动签名） | `npm run package` |

### 触发方式与参数（环境变量注入，大小写兼容）

| 变量 | 说明 | 示例 |
|---|---|---|
| `TARGET` | win / mac / all（默认 all；单机失败不影响另一台，汇总退出码） | `TARGET=win bash deploy/deploy.sh` |
| `TAG`/`BRANCH`/`GIT_BRANCH` | 构建哪个 tag 或 main；缺省由调度机仓库 HEAD 推断 | `TAG=v1.2.3 TARGET=win bash deploy/deploy.sh` |
| `DRY_RUN` | 1 = 只打印将执行的远程命令与上传计划，不连接机器、不联网 | `DRY_RUN=1 bash deploy/deploy.sh` |
| `COLLECT_ARTIFACTS` | 0 = 产物留在打包机 `dist/`，不回收 | 默认 1 |
| `ARTIFACTS_DIR` | 产物回收目录 | 默认 `deploy/artifacts-<时间戳>` |
| `UPLOAD` / `UPLOAD_QINIU` | 1 = 回收校验通过后上传七牛（见第十节） | 默认 0 |
| `UPLOAD_REQUIRE_ALL` | 1 = TARGET=all 时任一平台失败则整批跳过上传 | 默认 1 |

也支持位置参数（键名大小写不敏感，顺序无关，裸 `win|mac|all` 等价 `target`）——`target mac REF main` 这类写法可直接用：

```bash
deploy/deploy.sh target mac REF main              # 只构建 mac 的 main
deploy/deploy.sh target mac REF main upload 1     # 构建后投放七牛
deploy/deploy.sh target all ref v1.2.4 dry        # 只演练
```

### 前置条件

1. **免密公钥（无人值守必需）**：2026-11-17 实测 BatchMode 下两台机器均 `Permission denied (publickey,…)`，需先装公钥：
   ```bash
   ssh-copy-id -p 23491 keke@106.52.168.174
   ssh-copy-id -p 23490 hulifeng@106.52.168.174
   ```
   注意：若 keke 属 Windows 管理员组，公钥须写入服务端 `C:\ProgramData\ssh\administrator_authorized_keys`（并收紧 ACL），而不是 `~/.ssh/authorized_keys`——Windows OpenSSH 免密最常见的坑。交互密码模式仅适合手动触发。
2. 调度节点需 Node.js ≥ 20（回收后本地跑 `release-manifest.js verify`）与 git。
3. 打包机首跑 clone 走 GitHub 全量（~58 MiB pack），国内慢链路可能超时——建议按第一节方案 A 用 bundle 自举首拉，此后每轮只拉增量。
4. win 打包机需 SimplySign 已登录且跑过一次 `node scripts/win-sign.js --warmup`（PIN 缓存约 3 小时）。

### Jenkins 接入（可选，与 label agent 模式二选一）

若让 Jenkins 走此模式：Pipeline from SCM 检出仓库后执行 `TARGET=${params.TARGET} bash deploy/deploy.sh`，归档 `deploy/artifacts-*/**`。调度节点（主控或轻量 agent）需满足上述前置条件；无需在两台打包机上装 Jenkins agent。回收产物结构为 `artifacts-<时间戳>/<platform>/<package|package-win>/`（安装包 + blockmap + 清单，已过 sha512 配对校验）。

## 十、七牛 Kodo 投放（deploy.sh 的第 3 阶段）

`deploy/deploy.sh ... upload 1` 会在两台机器都回收并通过 sha512 校验后，把产物目录整体投放到七牛，作为 electron-updater 的 generic 更新源。上传逻辑是零依赖的 `scripts/qiniu-upload.js`（Node 20+ 自带 fetch/HMAC，不需要 `qshell`）。

### 配置（凭据不入库）

优先级：环境变量 > `.release.config.json` 的 `qiniu` 段 > 默认值。

```jsonc
// .release.config.json（已 gitignore；模板见 .release.config.example.json）
"qiniu": {
  "accessKey": "…",
  "secretKey": "…",
  "bucket": "…",
  "prefix": "autoupdates/",          // 须与 build.publish.url 的路径一致
  "uploadHost": "https://upload.qiniup.com",
  "publicBase": ""                    // 桶的公开域名根，仅用于上传后公网 HEAD 校验
}
```

CI 场景用环境变量注入，效果等价且优先：`QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY` / `QINIU_BUCKET` / `QINIU_PREFIX` / `QINIU_PUBLIC_BASE`。密钥建议用只授予该 bucket 写权限的子账号。

### 用法

```bash
# 多机打包 + 投放（推荐）
deploy/deploy.sh target all REF main upload 1

# 只投放已回收的产物（不重新打包）
QINIU_ACCESS_KEY=… QINIU_SECRET_KEY=… QINIU_BUCKET=… \
  node scripts/qiniu-upload.js --dir deploy/artifacts-<ts>/mac/package

# 演练 / 只核对远端
node scripts/qiniu-upload.js --dir dist/package --dry-run
node scripts/qiniu-upload.js --dir dist/package --check
```

### 契约与校验

| 机制 | 行为 | 失败表现 |
|---|---|---|
| 上传顺序 | 安装包与 blockmap 先传，`latest*.yml` **最后**传 | 客户端不会先看到指向 404 的清单 |
| 覆盖写 | putPolicy `insertOnly=0`，同 key 覆盖 | 重复执行不产生 `-1` 之类残留副本 |
| 逐个 stat | 每次 upload 后调 `rs.qiniu.com/stat` 比对 `fsize` | 大小不一致立即失败，退出码 1 |
| 本地预校验 | 上传前用 `release-manifest.js verify` 再对一次 sha512 | 清单与产物不配对则不上传 |
| 整批门禁 | `UPLOAD_REQUIRE_ALL=1`：任一平台构建失败则整批跳过 | 不会出现「win 失败、mac 已发」的半套 feed |
| 公网校验 | 配了 `publicBase` 时 HEAD 公开 URL | 默认只告警（CDN 缓存/防盗链易误判），`--strict-public` 可改为硬失败 |

> 清单与安装包必须**成对**发布：同一版本重复打包 sha512 会变，旧包配新清单会被客户端拒绝更新。

### 排障

| 现象 | 处置 |
|---|---|
| `缺少七牛凭据：QINIU_ACCESS_KEY …` | 配 `.release.config.json` 的 `qiniu` 段，或注入环境变量；脚本退出码 2 |
| `bad token` / 401 / 403 | AK/SK 不属同一账号，或子账号没有该 bucket 写权限 |
| `no such bucket` / 631 | `QINIU_BUCKET` 拼写或区域不符；上传入口可用 `upload-z0/z1/z2.qiniup.com` |
| `file exists` / 614 | 策略被改成禁止覆盖；脚本默认 `insertOnly=0`，检查是否被外部配置覆盖 |
| 公网 HEAD 404/403 但 stat 正常 | 桶未绑定域名、CDN 未刷新或开了防盗链；对象已落盘，刷新 CDN 后复验即可 |
| 客户端仍拉到旧版本 | 清单有 CDN 缓存：对 `latest*.yml` 做刷新，或在该前缀配置不缓存 |

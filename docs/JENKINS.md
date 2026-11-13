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

## 八、发布到自动更新服务器（当前未接，人工执行）

Jenkins 目前只做**构建 + 归档 + 校验**；发布（GitHub Release + 推清单到 ideanote.7373.com.cn/autoupdates/）涉及远端写操作，仍由人工在 mac 上执行 `npm run release -- patch`（内置版本递增、tag 先行、清单原子上传、线上校验）。如需把发布接进流水线，另行评审凭据与放行门禁（技能铁律 5：远端写操作前必须人工确认）。

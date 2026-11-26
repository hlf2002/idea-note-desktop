# 灵感笔记

> 连接 Q助理 的极简卡片式记录工具。打开即写，Markdown 所见即所得，扫码登录后自动双向同步到手机，本地缓存离线可读。

[官网](https://ideanote.7373.com.cn) · [下载安装](https://ideanote.7373.com.cn/#download) · [Windows / macOS 桌面端](#下载与安装)

![灵感笔记界面](screenshot.png)

## 核心特性

| | 功能 | 说明 |
|---|---|---|
| ✍️ | 打开即写 | 顶部输入框常驻，`Enter` 保存、`Shift+Enter` 换行，不为记录增加任何仪式感 |
| 🅼 | Markdown 所见即所得 | `**加粗**`、`` `代码` ``、`> 引用`、`- 列表`、`- [ ]` 待办渲染后即所得；渲染前先转义 HTML 防 XSS |
| 🏷️ | #标签整理 | 输入 `#标签` 即被识别，侧边栏汇总并可一键筛选；输入时跟随光标的标签联想 |
| 🖼️ | 图片插图 | 工具栏插入本地图片，上传后本机保留副本，离线也能看 |
| 🔍 | 即时搜索 | 顶栏搜索框实时过滤（`⌘K` / `Ctrl+K`），命中关键词高亮 |
| 📅 | 打卡热力图 | 侧边栏 12 周热力图，颜色深浅反映当天记录密度，点格子直达那天的笔记 |
| 🎲 | 每日回顾 | 随机抽取一条历史笔记漫游，翻到被忘掉的想法 |
| 💬 | @提及通知 | 笔记里 @ 联系人，发布时通过 Q助理 给 ta 发一条私信，附带网站分享页链接 |
| ☁️ | 双向同步 | 与 Q助理「灵感笔记」双向同步；本地缓存离线可读，登录后自动补齐 |
| 🔐 | 扫码登录 | Q助理 App 扫码授权，登录态本地保存，token 自动续期 |
| 📥 | 旧数据导入 | 检测到旧版本（flomo 时代）的本地数据时提示一键导入 |
| 🔔 | 自动更新 | 打包版启动 10 秒后静默检查、之后每 4 小时一次，新版本后台下载、重启安装 |
| 🪟 | 无边框窗口 | macOS 保留原生交通灯；Windows 自绘右上角三按钮与八向边缘缩放，顶栏/侧栏可拖动 |
| ⌨️ | 全局唤起 | `Cmd/Ctrl + Shift + M` 随时唤起窗口并聚焦输入框 |
| 📌 | 托盘常驻 | 关闭窗口收进系统托盘，需要时再唤出 |

## 下载与安装

从[官网下载页](https://ideanote.7373.com.cn/#download)取最新安装包：

| 平台 | 安装包 |
|---|---|
| Windows 10 / 11（x64） | `灵感笔记-Setup-<版本>.exe`（NSIS，可改安装目录） |
| macOS Apple 芯片（arm64） | `灵感笔记-<版本>-arm64.dmg` |
| macOS Intel（x64） | `灵感笔记-<版本>-x64.dmg` |

macOS 版已签名并公证；Windows 版带 Authenticode 签名。手机端请在 Q助理 App 内使用「灵感笔记」，与桌面端扫码即连通。

应用内自动升级：发现新版本后默认后台下载，下载完成提示「重启并安装」。

## 快速开始（开发）

```bash
npm install       # 首次安装依赖（含 Electron）
npm start         # 启动应用
```

> 需要 Node.js ≥ 21（单元测试用 `node --test` 的 glob 展开）。

常用命令：

```bash
npm test                    # 单元测试（标签/Markdown/更新清单/签名/窗口缩放/包文件闸门等纯函数）
npx electron smoke-test.js  # 集成冒烟：真实 Electron 里跑 IPC 全链路 + 界面断言，通过时输出 SMOKE_PASS=true
npm run build:mac           # 裸打包 macOS（不打发票据、不收尾）
npm run build:win           # 裸打包 Windows
```

打包与发布（签名 / 公证 / 上传 / 清单）见 [`docs/DEPLOY.md`](docs/DEPLOY.md)，Jenkins 双端打包见 [`docs/JENKINS.md`](docs/JENKINS.md)。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Cmd/Ctrl + Shift + M` | 全局唤起窗口并聚焦输入框 |
| `Cmd/Ctrl + K` | 聚焦搜索框 |
| `Enter` / `Shift + Enter` | 保存 / 换行 |
| `Esc` | 清空输入框 / 关闭漫游 / 关闭联想下拉 |

## 项目结构

```
idea-note-desktop/
├── main.js              # 主进程：窗口与托盘、全局快捷键、无边框窗口、生命周期
├── app-core.js          # 应用装配：AuthStore / QzApi / IdeaSync + 全部 IPC
├── updater.js           # 自动升级：检查/下载/安装、事件推送、友好错误文案
├── preload.js           # contextBridge 安全桥
├── window-controls.js   # Windows 自绘三按钮 IPC + 边缘缩放注册
├── window-resize.js     # 缩放坐标纯函数（起始/当前光标 → 新 bounds）
├── qz/                  # Q助理接入
│   ├── openapi.js       #   开放平台授权、token 续期、业务接口代理
│   ├── open-sign.js     #   开放平台 HMAC-SHA256 签名规则（含单测基线）
│   ├── auth.js          #   扫码登录流程（轮询取结果）
│   ├── sync.js          #   灵感笔记双向同步、本地缓存
│   ├── content.js       #   内容序列化（content_json 字符串契约）
│   ├── media.js         #   图片上传 + 本地副本索引
│   ├── notes-page.js    #   分享页发布/下线
│   ├── cli.js           #   本机 qz CLI 封装：@联系人、提及私信通知
│   └── config.js        #   中转服务地址与 PIN
├── renderer/            # 渲染层（沙箱，无 Node 权限）
│   ├── app.js           #   登录/同步/列表/搜索/热力图/漫游
│   ├── editor.js        #   所见即所得 Markdown 编辑器
│   ├── tagsuggest.js    #   #标签联想下拉
│   ├── atsuggest.js     #   @联系人联想下拉
│   ├── md.js / tags.js  #   安全 Markdown 渲染 / 标签提取（纯函数，可单测）
│   └── store.js         #   渲染层状态
├── assets/              # 图标与托盘图
├── scripts/             # 打包发布链（签名、公证、七牛上传、清单、包文件闸门）
├── test/                # 单元测试（node --test）
├── smoke-test.js        # 集成冒烟测试
└── docs/                # 部署与 Jenkins 文档
```

## 自动更新与发布

更新分发采用「安装包上对象存储 + 更新清单上官网域名」的架构，客户端 `build.publish` 指向 `https://ideanote.7373.com.cn/autoupdates/`：

| 场景 | 命令 |
|---|---|
| 本地打 macOS 包（不做 git 操作、不上传） | `npm run package` |
| 打包并投放（Jenkins 主控下发双端） | `PLATFORM=all MODE=publish REF=main deploy/deploy.sh` |
| 只上传某个产物（截图/报告/QA 包） | `npm run upload:artifact -- <文件或目录> [--dated]` |
| 演练（不联网不写远端） | `DRY_RUN=1 deploy/deploy.sh` / `upload:qiniu -- --dry-run` |

三条硬约束：

1. **版本号严格递增**（semver），否则客户端收不到升级；tag 已存在时脚本直接退出。
2. **安装包与更新清单成对发布**：同版本重打包 sha512 会变，旧包配新清单会被客户端拒绝。
3. **发布凭据只放本地 `.release.config.json` 或环境变量**，绝不入库（模板见 `.release.config.example.json`）。

打包前必须过闸门：`node scripts/check-package-files.js`（校验 `build.files` 白名单覆盖入口依赖链，防止 asar 里缺模块导致安装版启动失败）。

## 数据与隐私

- 数据目录：系统用户数据目录下的 `idea-note-local/`（macOS 为 `~/Library/Application Support/idea-note-local/`），侧边栏「数据文件 · 打开目录」可直接打开。
  - `auth.json`：登录态（token 不完整回传渲染层）
  - `idea-cache.json`：服务端笔记的离线缓存（原子写入，损坏自动备份）
  - `media/`：图片本地副本与索引
- 笔记内容只在你自己的 Q助理 账号与本地之间流转；应用不内置任何第三方统计或埋点。
- Windows 卸载时会一并清除应用数据（NSIS `deleteAppDataOnUninstall`），需要保留请先备份数据目录。

## 安全设计

- 渲染进程 `contextIsolation + sandbox`，无 `nodeIntegration`；所有能力经 `preload.js` 白名单暴露。
- Markdown 渲染先转义再套格式；链接仅放行 `http/https/mailto`。
- 开放平台的签名密钥不下发客户端：客户端请求统一经服务端代签，仅持 `RELAY_CLIENT_PIN`。
- 登录态失效判定只看明确凭证错误；网络错误与 5xx 视为瞬时故障退避重试，不误踢登录。

## License

MIT

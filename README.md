# 灵感笔记桌面端（Q助理版）

一个用 Electron 构建的极简卡片式桌面端，**连接 Q助理服务端**：使用 Q助理 App 扫码登录，灵感笔记自动双向同步到手机，同时保留本地缓存（离线可用）。

## 快速开始

```bash
cd idea-note-desktop
npm install     # 首次需要（已含 electron 依赖）
npm start       # 启动应用
```

> 需要 Node.js 20+。

一键打包（mac 双架构，不碰 git、不上传）：

```bash
npm run package            # 产物在 dist/package/：安装包 + blockmap + latest-mac.yml，整目录可直投静态服务器
npm run package -- 1.2.3   # 打包前改版本号（只改 package.json，不提交）
```

发布新版本见「自动升级 · 发布新版本」。

## 核心功能

| 功能 | 说明 |
|---|---|
| 🔐 Q助理扫码登录 | 打开 Q助理 App 扫码确认，登录态本地保存 |
| 🔄 灵感笔记同步 | 与 Q助理「灵感笔记」双向同步；本地缓存离线可读，登录后自动刷新 |
| ✍️ 快速记录 | 顶部输入框，所见即所得 Markdown：`**加粗**`、`#标签`、`` `代码` ``、`> 引用`、`- 列表`、`- [ ]` 待办 |
| 格式工具条 | `#` 插入标签、无序/有序列表一键插入；`Enter` 发送、`Shift+Enter` 换行、`Esc` 清空 |
| 📅 打卡热力图 | 侧边栏 12 周热力图，颜色深浅反映当天记录密度 |
| #标签 | 侧边栏标签列表点击筛选，笔记内绿色标签高亮 |
| 🔍 搜索 | 顶栏搜索框实时过滤，`⌘K` 聚焦，命中关键词高亮 |
| 每日回顾 | 「每日回顾」随机抽取一条历史笔记漫游 |
| 编辑/删除 | 卡片 hover 显示 `…` 菜单，编辑/删除（删除需二次确认） |
| 🎨 无边框窗口 | 隐藏系统标题栏，保留 macOS 红黄绿交通灯，顶栏/侧栏可拖动 |
| 全局唤起 | `Cmd/Ctrl + Shift + M` 随时唤起窗口并聚焦输入框 |
| 托盘常驻 | 关闭窗口最小化到系统托盘，托盘菜单可退出 |

## 数据存储

- 登录态：`~/Library/Application Support/idea-note-local/auth.json`
- 本地缓存：`~/Library/Application Support/idea-note-local/idea-cache.json`（服务端数据的离线缓存）
- 应用内侧栏底部「数据文件 · 打开目录」可直接打开所在目录

## 常用快捷键

| 快捷键 | 作用 |
|---|---|
| `Cmd/Ctrl + Shift + M` | 全局唤起窗口并聚焦输入框 |
| `Enter` / `Shift+Enter` | 保存 / 换行 |
| `Esc` | 清空输入框 / 关闭漫游 |
| `⌘K` | 聚焦搜索框 |

## 项目结构

```
idea-note-desktop/
├── main.js            # 主进程：无边框窗口、托盘、全局快捷键、生命周期
├── app-core.js        # 应用装配：store + IPC 注册（main 与测试复用）
├── updater.js         # 自动化升级：检查/下载/安装 + 事件推送 + 运行时更新源配置
├── preload.js         # contextBridge 安全桥
├── qz/                # Q助理接入：API 网关、扫码登录、灵感笔记同步、签名
├── renderer/
│   ├── index.html     # 页面结构（极简卡片式界面）
│   ├── styles.css     # 界面样式
│   ├── app.js         # 渲染逻辑（登录/同步/列表/搜索/热力图/漫游）
│   ├── editor.js      # 所见即所得 Markdown 输入框
│   ├── tags.js        # 标签提取（可单测）
│   ├── md.js          # 安全 Markdown 渲染（可单测，防 XSS）
│   └── vendor/        # 本地化 Font Awesome 图标（离线可用）
├── smoke-test.js      # Electron 集成冒烟测试（含界面截图）
├── scripts/
│   ├── release.sh         # 打包 / 发布（--package 只本地打包，默认走完整发布链）
│   └── release-manifest.js # 更新清单改写与产物 sha512 校验（纯函数，可单测）
└── test/              # 单元测试
```

## 自动升级

应用基于 `electron-updater` 实现自动化升级：打包版启动 10 秒后静默检查更新，之后每 4 小时自动检查一次；发现新版本默认自动后台下载，下载完成后提示「重启并安装」（若用户未点安装就退出，退出时也会自动完成安装）。

### 发布新版本

更新分发采用「**安装包放 GitHub Release + 更新清单放阿里云服务器**」的架构：

- 大文件（dmg / zip / blockmap）→ GitHub Release（https://github.com/hlf2002/idea-note-desktop/releases）
- 更新清单 `latest-mac.yml` → 阿里云服务器 `https://ideanote.7373.com.cn/autoupdates/`（服务器路径 `/var/www/ideanote/autoupdates/`）

发布走脚本，**不要手工改 `latest-mac.yml`**（逐行替换会让 `sha512`/`size` 的缩进被并入 `url`，客户端解析失败）：

| 场景 | 命令 |
|---|---|
| 本地打包 mac，不碰 git、不上传 | `npm run package` |
| 单机完整发布（改版本 → 建 Release → 推清单到服务器 → 线上校验） | `npm run release -- patch` |
| 多机打包（mac + win）并投放七牛 | `deploy/deploy.sh target all REF main upload 1` |
| 只把已回收的产物投放七牛 | `npm run upload:qiniu -- --dir deploy/artifacts-<ts>/mac/package` |
| 演练（不联网、不写远端） | 上面命令加 `dry`（deploy.sh）或 `--dry-run`（upload:qiniu） |

三条硬约束：

1. **版本号必须严格递增**（semver），否则客户端不会触发升级；tag `v$VERSION` 已存在时脚本直接退出。
2. **清单与安装包必须成对发布**：同一版本重复打包 sha512 会变，旧包配新清单会被客户端拒绝更新。
3. **七牛凭据只放 `.release.config.json` 的 `qiniu` 段或 `QINIU_*` 环境变量**，不得写进 `package.json` 等入库文件。对象 key 前缀须与 `build.publish.url` 的路径一致（默认 `autoupdates/`）。

上传顺序（包在前、`latest*.yml` 在后）、逐个 `stat` 字节校验、按 key 覆盖写等契约，见 `docs/JENKINS.md` 第十节。

### 配置更新服务器地址

默认取 `package.json` 中 `build.publish.url`（打包时由 electron-builder 写入 `resources/app-update.yml`）。如需运行时切换（如内网/外网不同环境），在用户数据目录（侧边栏「数据文件 · 打开目录」）放一个 `update-config.json`：

```json
{ "provider": "generic", "url": "https://your-server.example.com/updates/", "autoDownload": false }
```

- `autoDownload: false` 时不自动下载，只提示新版本，由用户点击「下载更新」

### 说明

- 开发模式（`npm start`）下自动更新禁用，但侧边栏仍显示当前版本号，手动检查会提示不可用
- macOS 未签名（`identity: null`）构建可正常升级；首次运行时如被 Gatekeeper 拦截，需在「系统设置 → 隐私与安全性」中允许打开
- Windows 升级会静默运行 NSIS 安装器完成替换，安装方式需与首次安装一致（本应用为可改安装目录的 assisted 模式）

## 测试

```bash
npm test                     # 单元测试（tags/md/qz）
npx electron smoke-test.js   # 集成测试：验证 IPC 全链路 + 界面渲染
```

## 安全设计

- 渲染进程 `contextIsolation + sandbox` 隔离，无 `nodeIntegration`
- Markdown 渲染先转义 HTML 再套格式标签；链接仅放行 `http/https/mailto`
- token 不完整回传渲染层；本地缓存原子写入，损坏自动备份

# 灵感笔记桌面端（Q助理版）

一个用 Electron 构建的极简卡片式桌面端，**连接 Q助理服务端**：使用 Q助理 App 扫码登录，灵感笔记自动双向同步到手机，同时保留本地缓存（离线可用）。

## 快速开始

```bash
cd idea-note-desktop
npm install     # 首次需要（已含 electron 依赖）
npm start       # 启动应用
```

> 需要 Node.js 20+。

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
└── test/              # 单元测试
```

## 测试

```bash
npm test                     # 单元测试（tags/md/qz）
npx electron smoke-test.js   # 集成测试：验证 IPC 全链路 + 界面渲染
```

## 安全设计

- 渲染进程 `contextIsolation + sandbox` 隔离，无 `nodeIntegration`
- Markdown 渲染先转义 HTML 再套格式标签；链接仅放行 `http/https/mailto`
- token 不完整回传渲染层；本地缓存原子写入，损坏自动备份

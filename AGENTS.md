# AGENTS.md

## 自动化工作流（用户明确要求，务必遵守）

每次完成一项编码任务后，必须自动执行以下步骤，无需用户再次提醒：

1. **提交并推送**：`git add -A && git commit -m "..."` 然后 `git push origin main`
   - 提交信息遵循仓库风格（`feat:` / `fix:` 前缀 + 中文摘要，要点分行列出）
   - 工作区含历史遗留的未提交改动时，一并纳入提交并说明
2. **重启应用**：先停止正在运行的 Electron 实例（`npm start` 后台任务），再重新 `npm start`
   - 重启后确认进程已启动（`ps aux` 检查 idea-note-desktop 的 Electron Helper 进程）
   - 测试产物 `screenshot.png` 历来随提交走，正常纳入

## 常用命令

- 启动：`npm start`（Electron 后台运行）
- 单元测试：`npm test`（`node --test test/*.test.js`，Node 20 需 shell 展开 glob）
- 集成冒烟：`npx electron smoke-test.js`（通过时输出 SMOKE_PASS=true，覆盖项目根 screenshot.png）
- 构建：`npm run build` / `build:mac` / `build:win`

## 架构速览

- `main.js`：主进程（窗口/托盘/登录态迁移）
- `app-core.js`：AuthStore / QzApi / IdeaSync 装配 + 全部 IPC；鉴权类错误统一带 `[AUTH]` 前缀透传（Electron IPC 不传自定义错误属性）
- `qz/api.js`：令牌自愈（失效自动重换重试一次）、12h keep-alive、probeAuth
- `renderer/app.js`：登录/同步 UI；`data-tip` 自定义即时 tooltip（替代原生 title）
- 真实用户数据目录：`~/Library/Application Support/idea-note-local/`（另两个入口：`flomo-local`、`灵感笔记`，登录态互为镜像）

## 关键约束

- 生产网关 `https://client.qzhuli.com` 只能做只读探测，不得向生产服务端发送无效 token 探测错误契约（用户明确拒绝过）。

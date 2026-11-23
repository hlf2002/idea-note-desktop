# AGENTS.md

## 自动化工作流（用户明确要求，务必遵守）

每次完成一项编码任务后，必须自动执行以下步骤，无需用户再次提醒：

1. **只在本地提交，不推送**：`git add -A && git commit -m "..."`
   - 提交信息遵循仓库风格（`feat:` / `fix:` 前缀 + 中文摘要，要点分行列出）
   - 工作区含历史遗留的未提交改动时，一并纳入提交并说明
   - **禁止自动 `git push`**（2026-11-19 用户明确要求）：推送必须由用户显式指示。
     `npm run release` 自带的 push 属于该命令的显式语义，不算自动行为
2. **重启应用**：先停止正在运行的 Electron 实例（`npm start` 后台任务），再重新 `npm start`
   - 重启后确认进程已启动（`ps aux` 检查 idea-note-desktop 的 Electron Helper 进程）
   - 测试产物 `screenshot.png` 历来随提交走，正常纳入

## 常用命令

- 启动：`npm start`（Electron 后台运行）
- 单元测试：`npm test`（`node --test "test/**/*.test.js"`，glob 由测试运行器展开，跨平台一致；要求 Node ≥ 21）
- 集成冒烟：`npx electron smoke-test.js`（通过时输出 SMOKE_PASS=true，覆盖项目根 screenshot.png）
- 构建（裸，无收尾）：`npm run build` / `build:mac` / `build:win`
- 打包 mac：`npm run package`（测试 → electron-builder → **dmg 就地签名+公证+装订** → 命名收尾：dmg 留中文、zip/blockmap 转 ASCII → 清单 sha512 校验）
- 打包机 mac 入口：`npm run package:mac`（`scripts/package-mac.sh`：载入 `.env` → 解锁签名钥匙串 → 真签自测 → 打包（内含 dmg 装订）→ 票据复核；`SKIP_SIGNING=1` 出未签名包）
- 打包 win：`npm run package:win`（win-sign.js 解析签名来源：显式 > env > 配置 > 证书存储自动发现，SimplySign 登录即自动签名+PIN 预热；构建 → 收尾三断言校验；须 Windows 宿主；`--dry-run` 可预演决策）
- dmg 装订机制：`scripts/dmg-notarize.sh`（对目录内 dmg：签名 → **notarytool 提交 dmg 本体** → staple，幂等）。根治点是 `release.sh` 的 `notarize_dmgs` 在 **stage 之前** 就地处理 `dist/*.dmg`，因此 stage 复制进 `dist/package` 的就是最终字节、清单 sha512 一次算准 —— 命名由 `assetName()` 统一决定（dmg 保留中文名，其余转 `idea-note-*`），不需要事后重命名。
- dmg 补票入口（历史产物 / 事后改目录才用）：`npm run staple` = `npm run notarize:dmg`（`scripts/notarize-dmg.sh`：调 dmg-notarize.sh + 重生成 blockmap + 重算清单）
- 交付目录纪律：**投放只认 `dist/package/`**。dmg 保留中文名 `灵感笔记-*`（人工下载用），zip / blockmap 是 ASCII `idea-note-*`（自动更新链路）；`dist/` 根目录是同一份字节但缺清单，不要直接分发
- electron-builder 的 `mac.notarize` 只覆盖 `.app`（`@electron/notarize` 会顺带装订 app）；dmg 是之后 hdiutil 打出的新字节流，不单独提交就没有票，`stapler` 必报 Record not found / Error 65
- 多机打包 + 投放：`PLATFORM=mac MODE=publish REF=main deploy/deploy.sh`（与 q_assistant 的 deploy.sh 同一套 PLATFORM/MODE/REF；`PLATFORM=all` 为双机扩展；`DRY_RUN=1` 只演练）。`MODE` 三种：`local` 只构建、`publish` 投七牛（自动更新仓）、`publish-feishu` 上传 IPA + 飞书公告（与七牛互斥，各管一个发布面）
- 只投放七牛：`npm run upload:qiniu -- --dir dist/package`（凭据读 `.release.config.json` 的 `qiniu` 段或 `QINIU_*` 环境变量，`--dry-run` 可预演；传完会修清单 Content-Type 并提交 CDN 刷新，`--no-cdn` / `--strict-cdn` 控制）
- 产物单传：`npm run upload:artifact -- <文件|目录>… [--dated] [--subdir qa] [--dry-run]`（独立链路，不读 latest\*.yml、默认不刷 CDN；前缀 `artifacts/`，配置键 `qiniu.artifactPrefix`）
- IPA 发布（`ipa.qzhuli.cn` + 飞书公告）：`npm run publish:ipa -- --platform mac --dir dist/package --app-id <id>`（四步 API：policy→upload→complete→feishu，`X-IPA-TOKEN` 鉴权；凭据 `--token` / 环境变量 `IPA_TOKEN`（或 `PUBLISH_TOKEN`）/ `.release.config.json` 的 `ipa` 段；`--dry-run` 预演、`--uploaded-key <key>` 只补飞书公告）。可加 `--qzhuli-conversation-id <群ID> --qzhuli-token <t>` 把发布消息同步发到 q助理群聊（`open.qzhuli.com/open/webhook/message/push`，`Authorization: Bearer` 鉴权，独立于飞书、失败不阻断）

## 架构速览

- `main.js`：主进程（窗口/托盘/登录态迁移）
- `app-core.js`：AuthStore / QzApi / IdeaSync 装配 + 全部 IPC；鉴权类错误统一带 `[AUTH]` 前缀透传（Electron IPC 不传自定义错误属性）
- `qz/api.js`：令牌自愈（失效自动重换重试一次）、12h keep-alive、probeAuth
- `renderer/app.js`：登录/同步 UI；`data-tip` 自定义即时 tooltip（替代原生 title）
- 真实用户数据目录：`~/Library/Application Support/idea-note-local/`（另两个入口：`flomo-local`、`灵感笔记`，登录态互为镜像）

## 关键约束

- 生产网关 `https://client.qzhuli.com` 只能做只读探测，不得向生产服务端发送无效 token 探测错误契约（用户明确拒绝过）。

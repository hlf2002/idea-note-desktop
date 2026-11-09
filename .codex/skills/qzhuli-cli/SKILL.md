---
name: qzhuli-cli
description: Use when operating the QZhuli CLI (`qz`), including QZhuli auth, config, friends, relations, users, conversations, messages, QFlow auth/projects/requirements/tasks, cache management, JSON filtering, dry-run, command help, and interpreting environment-specific config files.
version: 0.1.8
---

# QZhuli CLI

Concise operating manual for the `qz` command.

## First Checks

1. Check whether the user is logged in:
   ```bash
   qz auth status
   ```
2. If the task touches QFlow, also check QFlow auth:
   ```bash
   qz qflow auth status
   ```
3. If QZhuli auth is missing or expired, run login and ask the user to scan when needed. A successful login
   clears any saved QFlow session and silently rebinds QFlow to the newly authenticated account. The automatic
   QFlow attempt has a three-second deadline and does not change the QZhuli login result when it fails:
   ```bash
   qz auth login
   ```
4. If automatic QFlow login fails, retry it explicitly:
   ```bash
   qz qflow auth login
   ```
5. For exact syntax, use command help:
   ```bash
   qz --help
   qz <command> --help
   ```

## Safety Rules

**These rules prevent data loss and unwanted side effects. Follow them strictly.**

### Ask Before Acting

When ANY of the following applies, STOP and ask the user first:

- **Multiple options from any query**: `user search`, `friend list`, `conversation search`, `friend profile`,
  `qflow project list`, `qflow requirement members`, or similar commands return multiple candidates. Show all
  options with clear identifiers and ask which one to use.
- **Ambiguous search results**: `status: "needs_resolution"` — show options and ask.
- **Friend operations**: Before `user add`, show the target profile and confirm.
- **Relation changes**: Before `relation set`, show the current value and the new value, then confirm.
- **Cache clearing**: Before `cache clear`, confirm scope (all tables vs single table).
- **Message without conversation**: Before `message send`, check if a conversation with the target user exists.
  If not, ask the user whether to create one first.
- **QFlow writes**: Before `qflow task create` or `qflow requirement create`, `update`, `transition`,
  `assign-user`, `share`, `comment`, or `urge`, show the target project/requirement and confirm.
- **Any write operation** (`user add`, `relation set`, `conversation create`, `cache clear`): confirm with
  user.

### Least-Surprise Principle

- Never change a friend's remark without showing both old and new.
- Never delete cache data without confirming scope.
- If the user says "send a message" but doesn't specify content, draft it and ask before sending.
- Never change a requirement's status, approver, or developer without showing the current state and target
  state/user.
- Never update a requirement's title or description without showing the current value and the target value.
- Never create a QFlow requirement without showing the target project.
- Never create a QFlow task without showing the target project, title, assignees, and deadline.
- Never use `--skip-similarity-check` silently; call out that it bypasses duplicate detection.

### Message Role Detection

When sending messages, determine the role based on the user's wording:

- If the user says something like **"以我的名义"** (in my name), **"帮我发给"** (help me send to),
  **"替我发送"** (send on my behalf), or similar phrasing indicating they want to send as themselves
  → use `--role 1` (User).
- Otherwise, send normally without `--role` (defaults to `0` = Assistant).

## ID Reference

The CLI uses 4 distinct ID types for the legacy QZhuli surface. **Using the wrong type will fail silently or
hit the wrong target.**

| ID Type         | Field Name       | Format                  | Example                      | Used By                                                                                    |
|-----------------|------------------|-------------------------|------------------------------|--------------------------------------------------------------------------------------------|
| Q助号             | `id`             | Number, short           | `10003`                      | `user add <q-number>`, `user search`, `conversation search` (with `--qnumber`)             |
| UID             | `uid`            | 32-char hex string      | `d5b6308e3abad6bc96573c58`   | `relation get/set`, `friend profile --uid`, `user search --uid`, `conversation create`     |
| Conversation ID | `conversationId` | Base64-like long string | `9boGaR7iii2Jdjhmb5LSo37...` | `message send`, `message history`, `conversation profile`, `conversation search` (default) |
| Agent ID        | `agent.id`       | Number                  | `5`                          | `conversation create --agent-id`                                                           |

**Common mistake**: Using UID for `message send` instead of conversationId. Always resolve via
`conversation search` or `conversation list` first.

## QFlow IDs

QFlow commands use a different ID family from the older QZhuli contact commands.

| ID Type        | Field Name       | Format  | Example                           | Used By                                                                 |
|----------------|------------------|---------|-----------------------------------|-------------------------------------------------------------------------|
| Project ID     | `project_id`     | `p-...` | `p-pd9oycutwygygaj9cjvl9rp6yrk199` | `qflow requirement create`, `qflow requirement list --project-id`       |
| Requirement ID | `requirement_id` | `r-...` | `r-jmanxwlesyrwtq48mmbrwq8fihussm` | `get`, `members`, `activities`, `comments`, `comment`, `transition`     |
| Task ID        | `task_id`        | `tsk-...` | `tsk-123`                           | task detail links and task API responses                               |
| QFlow User ID  | `user_id`        | `u-...` | `u-dq0zembq9nsmkuii6nvxdwzm5hp4bj`  | `assign-user`, `share`, `transition --target-user-id`                   |
| Team ID        | `team_id`        | `t-...` | `t-mb6plehth1cycsjtu7sz8x54nvyvrn` | read-only data in project/requirement detail                            |

**Common mistake**: QFlow `user_id` is not the same thing as the older 32-char `uid` used by QZhuli
contacts.

## Environment and Config Files

| Visible behavior                                               | Environment | Config directory                   |
|----------------------------------------------------------------|-------------|------------------------------------|
| Shows `DEVELOPMENT BUILD / Running in TEST environment` banner | test        | `./.qzhuli-cli/` (relative to CWD) |
| No test banner                                                 | production  | `~/.qzhuli-cli/`                   |

Treat `credentials.json` and `qflow-credentials.json` as secrets. Preferences live in `preferences.json`.

## Output and Global Options

Commands return JSON with `status`, `code`, `message`, and `data`.

| status               | Meaning                             | Exit code |
|----------------------|-------------------------------------|-----------|
| `"success"`          | Operation completed                 | 0         |
| `"needs_resolution"` | Ambiguous result (multiple matches) | 0         |
| `"error"`            | Failed operation                    | 1         |

**Always check `status`, not just exit code.**

Use `--jq` for simple dot-path filtering:

```bash
qz --jq ".data.uid" auth status
qz --jq ".data.links" friend list
qz --jq ".data" conversation list --limit 5
qz --jq ".data.requirement.requirement_id" qflow requirement get <requirement-id>
```

`--jq` is not full jq. Prefer simple paths: `.data`, `.data.uid`, `.data.links`.

## Command Map

| Goal                          | Command |
|-------------------------------|---------|
| Check login                   | `qz auth status` |
| QR login                      | `qz auth login [--method qr-code]` |
| Clear credentials             | `qz auth logout` |
| Show preferences              | `qz config` |
| Update preferences            | `qz config [--locale en\|zh] [--debug\|--no-debug]` |
| Search user (Q助号)             | `qz user search <q-number>` |
| Search user (Q助号, explicit)   | `qz user search <q-number> --qnumber` |
| Search user (UID)             | `qz user search <uid> --uid` |
| Add friend (Q助号)              | `qz user add <q-number>` |
| List friends                  | `qz friend list` |
| Resolve profile (nickname)    | `qz friend profile <nickname>` |
| Resolve profile (nickname, explicit) | `qz friend profile <nickname> --nickname` |
| Resolve profile (UID)         | `qz friend profile <uid> --uid` |
| Resolve profile (remark)      | `qz friend profile <remark> --remark` |
| Read relation                 | `qz relation get <uid>` |
| Update relation               | `qz relation set <uid> [-r, --remark <name>] [-t, --type <type>]` |
| List conversations            | `qz conversation list [--limit <n>] [--offset <n>]` |
| Get conversation profile      | `qz conversation profile <conversation-id> [--type <n>]` |
| Create conversation           | `qz conversation create <uid> --agent-id <id>` |
| Search conversations (ID)     | `qz conversation search <conversation-id>` |
| Search conversations (CID)    | `qz conversation search <cid> --cid` |
| Search conversations (name)   | `qz conversation search <name> --name` |
| Search conversations (Q助号)    | `qz conversation search <q-number> --qnumber` |
| Search conversations (UID)    | `qz conversation search <uid> --uid` |
| Send message                  | `qz message send <conversation-id> <content> [--role <n>]` |
| Read message history          | `qz message history <conversation-id> [--from <id>] [--direction newer\|older] [--limit <n>]` |
| List personal notes           | `qz note list [--page <n>] [--page-size <n>]` |
| Get personal note             | `qz note get <note-id>` |
| List personal time albums     | `qz album list [--page <n>] [--page-size <n>]` |
| Get personal time album       | `qz album get <album-id>` |
| Search private Wiki           | `qz wiki search <query>` |
| Get private Wiki page         | `qz wiki get <page-id>` |
| Check QFlow login             | `qz qflow auth status` |
| Login to QFlow                | `qz qflow auth login` |
| Logout from QFlow             | `qz qflow auth logout` |
| List QFlow projects           | `qz qflow project list` |
| Create QFlow task             | `qz qflow task create --project-id <id> --title <title> --assignee-user-id <user-id> (--content <text> \| --content-file <path>) [--assignee-user-id <user-id> ...] [--deadline-date YYYY-MM-DD] [--deadline-time HH:mm] [--idempotency-key <key>]` |
| List my requirements          | `qz qflow requirement mine` |
| List unclaimed requirements   | `qz qflow requirement unclaimed` |
| Filter requirements           | `qz qflow requirement list [--loaded-requirement-ids <ids>] [--page <n>] [--project-id <id>] [--requirement-user-filter <filter>] [--status <name>] [--progress-stage-sort <order>] [--priority-sort <order>] [--sort <field>]` |
| Get requirement detail        | `qz qflow requirement get <requirement-id>` |
| List available members        | `qz qflow requirement members <requirement-id> [--keyword <keyword>]` |
| Read requirement activities   | `qz qflow requirement activities <requirement-id>` |
| Read requirement comments     | `qz qflow requirement comments <requirement-id>` |
| Add requirement comment       | `qz qflow requirement comment <requirement-id> (--content <text> \| --content-file <path>)` |
| Create requirement            | `qz qflow requirement create --project-id <id> --title <title> --priority <priority> --category <category> (--content <text> \| --content-file <path>) [--ai-suggestion <text>] [--repository-name <name>] [--risk-level <level>] [--skip-similarity-check]` |
| Update requirement            | `qz qflow requirement update <requirement-id> [--title <title>] [--content <text> \| --content-file <path>] [--priority <priority>] [--category <category>] [--repository-name <name>]` |
| Change requirement status     | `qz qflow requirement transition <requirement-id> --to <stage> [--remark <text>] [--target-user-id <id>]` |
| Assign/replace role user      | `qz qflow requirement assign-user <requirement-id> --user-id <id> --role approver\|developer\|tester\|refiner [--remark <text>]` |
| Share requirement             | `qz qflow requirement share <requirement-id> --user-id <id> [--user-id <id> ...]` |
| Urge current owner            | `qz qflow requirement urge <requirement-id>` |
| Sync cache                    | `qz cache sync` |
| Cache status                  | `qz cache status` |
| Clear cache                   | `qz cache clear [--table <name>]` |

Relation type values are `0=stranger`, `1=family`, `2=friend`, `3=former colleague`, `4=classmate`, `5=current colleague`.
QFlow role values: `approver`, `developer`, `tester`, `refiner`.

QFlow status guidance:
- Documented target statuses for `qz qflow requirement transition --to <stage>`:
  `待完善`, `完善中`, `待审批`, `待领取`, `研发中`, `待验收`, `验收中`, `已完成`, `已取消`.
- New requirements start at `待审批`; the main flow is `待审批 -> 待领取 -> 研发中 -> 待验收 -> 验收中 -> 已完成`.
- The CLI does not execute `待审批 -> 待领取`; complete that step manually in QFlow, then continue from `待领取`.
- Return flow: `待审批 -> 待完善 -> 完善中 -> 待审批`; `研发中 -> 待完善 -> 完善中 -> 待审批`.
- `已取消` is a valid terminal status when the backend transition rules allow it.
## Common Workflows

### Find a Friend and Inspect Relation

1. `qz friend list` — list candidates
2. `qz friend profile "<nickname>"` — resolve ambiguous names
3. `qz relation get <uid>` — inspect relation with resolved uid

### Update a Friend Relation

1. Resolve the exact `uid` via `friend list` or `friend profile`.
2. Show current value, confirm the change.
3. Execute: `qz relation set <uid> --remark "New Name" --type 1`
4. Verify: `qz relation get <uid>`

**Do not run `relation set` without `--remark` or `--type`; the CLI returns `INVALID_ARGUMENT`.**

### Search and Add a Friend

1. Search: `qz user search 10000`
2. Show profile to user, confirm.
3. Add: `qz user add 10000` (internally: search → create conversation)

### Find All Conversations with a User

```bash
qz conversation search <conversation-id>           # default: by conversation ID
qz conversation search <cid> --cid                 # by user CID
qz conversation search <name> --name               # by conversation name
qz conversation search <q-number> --qnumber        # by user Q助号
qz conversation search <uid> --uid                 # by user UID
```

Response includes `id`, `uid`, and `conversations` with full profile data. Each entry contains
`conversationId`, `isGroup`, `users`, and `visitors`.

### Send a Message

1. Confirm auth: `qz auth status`
2. **Check existing conversation**: If you have a `conversationId`, use `conversation search <conversation-id>`
   directly. Otherwise, use `conversation search <q-number> --qnumber`, `conversation search <uid> --uid`, or
   `conversation search <name> --name` to find conversations with the target user.
3. **Decision**:
   - If conversations exist → pick the relevant `conversationId`.
   - If no conversation exists → **ask the user first** whether to create one, then
     `qz conversation create <uid> --agent-id <id>`.
4. Determine role: if the user says "以我的名义" / "帮我发给" / "替我发送" etc., add `--role 1`; otherwise omit
   (defaults to Assistant).
5. Send: `qz message send <conversation-id> "message text"`
6. Verify: `qz message history <conversation-id> --limit 5`

### Create a QFlow Task

1. Confirm auth and identify the exact project and assignee user IDs:
   ```bash
   qz auth status
   qz qflow auth status
   qz qflow project list
   ```
2. Show the project, title, assignees, and deadline, then confirm before creating.
3. Preview the request when possible:
   ```bash
   qz --dry-run qflow task create --project-id <id> --title "Title" --assignee-user-id <user-id> --content "Body"
   ```
4. Create the task. Repeat `--assignee-user-id` for multiple assignees:
   ```bash
   qz qflow task create --project-id <id> --title "Title" --assignee-user-id <user-id> (--content <text> | --content-file <path>) [--assignee-user-id <user-id> ...] [--deadline-date YYYY-MM-DD] [--deadline-time HH:mm] [--idempotency-key <key>]
   ```
5. Deadline time is optional, requires a deadline date, and must use a whole or half hour such as `09:00` or
   `09:30`. The CLI generates an idempotency key unless one is supplied for a safe retry.

### Create a QFlow Requirement

1. Confirm auth:
   ```bash
   qz auth status
   qz qflow auth status
   ```
2. List projects and choose the exact `project_id`:
   ```bash
   qz qflow project list
   ```
3. Preview the write when possible:
   ```bash
   qz --dry-run qflow requirement create --project-id <id> --title "Title" --priority 中 --category 新功能 --content "Body"
   ```
4. Create the requirement:
   ```bash
   qz qflow requirement create --project-id <id> --title "Title" --priority 中 --category 新功能 --content "Body"
   ```
5. Verify with:
   ```bash
   qz qflow requirement get <requirement-id>
   ```

### Update a QFlow Requirement

1. Read the current requirement:
   ```bash
   qz qflow requirement get <requirement-id>
   ```
2. Preview the update when possible:
   ```bash
   qz --dry-run qflow requirement update <requirement-id> --content-file <path>
   ```
3. Apply the update:
   ```bash
   qz qflow requirement update <requirement-id> [--title <title>] [--content <text> | --content-file <path>] [--priority <priority>] [--category <category>] [--repository-name <name>]
   ```
4. Verify with:
   ```bash
   qz qflow requirement get <requirement-id>
   qz qflow requirement activities <requirement-id>
   ```

### Change Requirement Status

1. Read the current requirement:
   ```bash
   qz qflow requirement get <requirement-id>
   ```
2. Supported target stages for current CLI usage:
   `待完善`, `完善中`, `待审批`, `待领取`, `研发中`, `待验收`, `验收中`, `已完成`, `已取消`
3. Follow the current product flow, but complete `待审批 -> 待领取` manually in QFlow. The CLI may continue from
   `待领取 -> 研发中 -> 待验收 -> 验收中 -> 已完成`.
4. Run the transition:
   ```bash
   qz qflow requirement transition <requirement-id> --to <stage> [--target-user-id <id>] [--remark "reason"]
   ```
5. Verify both detail and activity log:
   ```bash
   qz qflow requirement get <requirement-id>
   qz qflow requirement activities <requirement-id>
   ```

### Assign or Replace a QFlow Role User

1. Read the current requirement and candidate members:
   ```bash
   qz qflow requirement get <requirement-id>
   qz qflow requirement members <requirement-id>
   ```
2. Show the current role holder and target user, then confirm.
3. Execute:
   ```bash
   qz qflow requirement assign-user <requirement-id> --user-id <user-id> --role approver --remark "reason"
   ```
4. Verify with:
   ```bash
   qz qflow requirement get <requirement-id>
   qz qflow requirement activities <requirement-id>
   ```

### Page Through Message History

```bash
qz message history <conversation-id> --limit 20
qz message history <conversation-id> --from <message-id> --direction older --limit 20
qz message history <conversation-id> --from <message-id> --direction newer --limit 20
```

### Pre-Sync Cache for Offline Speed

Run `qz cache sync` before heavy read operations. Verify with `qz cache status`.

## Troubleshooting

| Symptom                         | Action |
|---------------------------------|--------|
| Command not found               | Confirm `qz` is on PATH. Install: `npm install -g @qzhuli/qzhuli-cli` |
| Auth failure                    | `qz auth status`; then `qz auth login` if needed |
| QFlow auth fails                | Run `qz qflow auth status`; then `qz qflow auth login` if needed |
| Unexpected language             | `qz config --locale en` or `--locale zh` |
| Too much JSON                   | Use `--jq ".data"` or another simple dot path |
| Need no-op preview              | Use `--dry-run` |
| Message send fails              | Re-check `auth status`, verify conversationId via `conversation list` |
| Requirement missing from `mine` | `mine` lists current owner's requirements, not every requirement you created |
| Target has no conversation      | Ask user to create one, then `conversation create <uid> --agent-id <id>` |
| Slow queries                    | Run `qz cache sync` first (incremental, fast), then retry |
| Cache corrupted                 | `qz cache clear` to reset, then retry (falls back to API) |
| Ambiguous search                | `status: "needs_resolution"` — refine query with `--uid` or `--remark` flag |
| `relation set` INVALID_ARGUMENT | Must include at least one of `--remark` or `--type` |

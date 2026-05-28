# OpenClaw 内置 Skills 与 Sub-agents 摘要

统计基于当前本地 checkout。这里把“内置”按 OpenClaw 产品运行时能随安装或随插件包提供的能力来算，不把本工作区 `.agents/skills/` 下的维护者/开发者辅助技能算进产品内置。

## 结论

| 项目 | 数量 | 口径 |
| --- | ---: | --- |
| 核心 bundled skills | 57 | `skills/*/SKILL.md`，由核心包随 `skills/` 发布 |
| 本地插件 bundled skills | 14 | 插件 manifest 声明 `skills`，且本 checkout 能解析到 `SKILL.md` 的插件技能 |
| 静态预置 subagent | 0 | OpenClaw 内置的是动态 sub-agent 机制，不是固定角色清单 |
| 默认动态 sub-agent 并发 | 8 | `agents.defaults.subagents.maxConcurrent` 未配置时的 subagent lane 上限 |

一句话：skills 是“教模型怎么做”的说明包；tools/plugins 是“模型能调用什么”的执行面；sub-agents 是“把一段工作拆出去跑”的动态后台会话。主 agent 看到合格 skill 的简表，需要时读取对应 `SKILL.md`；遇到慢任务或可并行任务时，主 agent 可用 `sessions_spawn` 拉起 sub-agent，等子任务完成后再综合结果对用户回复。

## Skills 数量

### 核心 bundled skills：57 个

这些文件位于 `skills/*/SKILL.md`。`package.json` 的 `files` 包含 `skills/`，`src/agents/skills/bundled-dir.ts` 会解析安装包或开发 checkout 里的 bundled skills 目录。

当前 57 个核心 bundled skills 是：

`1password`, `apple-notes`, `apple-reminders`, `bear-notes`, `blogwatcher`, `blucli`, `camsnap`, `canvas`, `clawhub`, `coding-agent`, `diagram-maker`, `discord`, `eightctl`, `gemini`, `gh-issues`, `gifgrep`, `github`, `gog`, `goplaces`, `healthcheck`, `himalaya`, `imsg`, `mcporter`, `meme-maker`, `model-usage`, `nano-pdf`, `node-connect`, `node-inspect-debugger`, `notion`, `obsidian`, `openai-whisper-api`, `openai-whisper`, `openhue`, `oracle`, `ordercli`, `peekaboo`, `python-debugpy`, `sag`, `session-logs`, `sherpa-onnx-tts`, `skill-creator`, `slack`, `songsee`, `sonoscli`, `spike`, `spotify-player`, `summarize`, `taskflow-inbox-triage`, `taskflow`, `things-mac`, `tmux`, `trello`, `video-frames`, `voice-call`, `wacli`, `weather`, `xurl`.

### 插件 bundled skills：本地可解析 14 个

插件通过 `openclaw.plugin.json` 的 `skills` 字段声明技能目录。运行时只在插件启用且通过插件/槽位条件后加载这些 skills；同名时它们处于 extra-dir 低优先级，不能覆盖核心 bundled、managed、personal、project 或 workspace skills。

| 插件 | skills |
| --- | --- |
| `acpx` | `acp-router` |
| `browser` | `browser-automation` |
| `diffs` | `diffs` |
| `feishu` | `feishu-doc`, `feishu-drive`, `feishu-perm`, `feishu-wiki` |
| `memory-wiki` | `obsidian-vault-maintainer`, `wiki-maintainer` |
| `open-prose` | `prose` |
| `qqbot` | `qqbot-channel`, `qqbot-media`, `qqbot-remind` |
| `tavily` | `tavily` |

另有 `extensions/tlon/openclaw.plugin.json` 声明了 `node_modules/@tloncorp/tlon-skill`，但当前 checkout 没有可直接读取的该依赖目录，因此没有计入“本地可解析”数量。`extensions/lobster/SKILL.md` 没有被该插件 manifest 声明为 `skills`，也不按运行时 plugin skill 计数。

## Skill 加载与可见性

OpenClaw 按名字合并 skills，同名时高优先级来源覆盖低优先级来源。实际优先级从高到低是：

1. `<workspace>/skills`
2. `<workspace>/.agents/skills`
3. `~/.agents/skills`
4. `~/.openclaw/skills`
5. bundled skills
6. `skills.load.extraDirs` 和启用插件发布到 `~/.openclaw/plugin-skills/` 的 skills

能否进入某个 agent 的 prompt 还受三层过滤影响：

1. skill 自身 metadata gate，比如需要某个 bin、env、config 或 OS。
2. 插件 skill 的 owning plugin 必须启用。
3. `agents.defaults.skills` / `agents.list[].skills` allowlist。默认不配置时不限；配置 `[]` 表示该 agent 看不到 skills。

Prompt 里不会直接塞完整 `SKILL.md`。OpenClaw 注入紧凑的 `<available_skills>` 列表，只含 name、description、location。模型判断需要某个 skill 时，再用 `read` 读取对应 `SKILL.md`。这样能保留技能发现能力，同时避免基础 prompt 被 57+ 个长文档撑大。

## Sub-agent 数量与默认形态

OpenClaw 没有“内置 N 个固定 subagent”。sub-agent 是运行时由 `sessions_spawn` 创建的后台 agent run：

- session key 形如 `agent:<agentId>:subagent:<uuid>`。
- 默认目标 agent id 是 `main`，也可以在 allowlist 允许时用 `agentId` 指向其他配置 agent。
- 默认 context 是 `isolated`；需要继承当前上下文时可显式用 `fork`，线程绑定的 sub-agent session 默认 fork。
- 默认不允许继续嵌套：`maxSpawnDepth` 是 `1`，所以 depth-1 sub-agent 是 leaf。
- 默认每个 session 同时最多 5 个 active children。
- 默认 subagent lane 并发是 8。
- 默认完成后 60 分钟自动归档。

如果配置 `maxSpawnDepth: 2`，depth-1 sub-agent 会变成 orchestrator，可以再 spawn depth-2 worker；depth-2 永远是 leaf，不能继续 spawn。

## 它们如何配合

### 1. 插件提供能力，skills 提供操作说明

工具和插件负责真正的能力，例如浏览器、Discord、Slack、Feishu、Tavily、Diffs。Skill 负责告诉模型何时使用这些能力、按什么步骤用、哪些坑要避开。

典型链路：

1. 插件启用并注册 tool。
2. 插件 manifest 声明相关 skill 目录。
3. Skill loader 把插件 skill 发布到 plugin skill 目录，并按低优先级合并。
4. Prompt 只展示可用 skill 摘要。
5. 模型需要详细流程时读取 `SKILL.md`，再调用对应 tool。

### 2. 主 agent 负责判断与综合，sub-agent 负责后台执行

主 agent 在正常 turn 中接收用户任务。如果任务慢、可并行、需要多路调查，且当前 tool policy 允许，它可以调用 `sessions_spawn`。

`sessions_spawn` 非阻塞返回 run id；子 agent 在独立 session 中执行任务。完成后，OpenClaw 把子结果作为内部 completion event 交回 requester session。主 agent 要验证并综合子结果，然后决定是否对用户回复。子 agent 本身默认没有 `message` tool，用户可见输出仍由主 agent 的正常投递策略负责。

需要等待必要子结果时，主 agent 用 `sessions_yield` 结束当前 turn，让 completion event 成为下一条模型可见消息。运行时还会在有 active children 时注入 `Active Subagents` prompt block，让主 agent 不用轮询也能看到活跃子任务状态。

### 3. Tool policy 控制 sub-agent 权限

Sub-agent 先继承目标 agent 的 tool profile / allow / deny，再叠加 sub-agent 限制层。默认会移除容易造成外部副作用或递归混乱的工具，尤其是 `message`、session tools、system tools。

默认 depth-1 leaf 没有 session orchestration tools。如果 `maxSpawnDepth >= 2`，depth-1 orchestrator 才会额外拿到 `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history` 来管理自己的 children。depth-2 worker 始终没有继续 spawn 的能力。

### 4. Skills 与 sub-agents 在目标 agent 上重新解析

Sub-agent 是某个 `agentId` 下的 session，不是独立的全局角色。因此它看到的 skills、workspace、auth、model、sandbox 和 tool policy 都按目标 agent 的配置解析。主 agent spawn 到另一个 `agentId` 时，本质上是在调用另一个配置 agent 的后台会话；spawn 回自己时，则是同一 agent 的隔离后台分支。

## 统计依据

- 核心 skills 目录：`skills/`
- 核心包发布面：`package.json`
- bundled skill 目录解析：`src/agents/skills/bundled-dir.ts`
- skill 合并优先级：`src/agents/skills/workspace.ts`
- 插件 skill 发布：`src/agents/skills/plugin-skills.ts`
- skills 文档：`docs/tools/skills.md`, `docs/concepts/system-prompt.md`
- sub-agent 文档：`docs/tools/subagents.md`, `docs/concepts/session-tool.md`
- sub-agent 默认值：`src/config/agent-limits.ts`
- sub-agent session key 默认 agent：`src/routing/session-key.ts`
- sub-agent depth/allow/children 检查：`src/agents/acp-spawn.ts`, `src/agents/subagent-capabilities.ts`

## 验证备注

- `pnpm docs:list` 因当前 shell 找不到 `pnpm` 未能直接运行。
- 已用等价底层脚本 `node scripts/docs-list.js` 读取文档索引。
- 计数用本地文件系统枚举 `skills/*/SKILL.md` 和插件 manifest 的 `skills` 声明交叉确认。

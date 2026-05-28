# OpenClaw hooks 总结

按当前仓库口径，OpenClaw 随仓库内置的 internal hooks 有 5 个：`session-memory`、`bootstrap-extra-files`、`command-logger`、`compaction-notifier`、`boot-md`。它们是文件式 `HOOK.md` hooks，会被 `openclaw hooks` 发现和管理，主要用于命令、会话、启动、消息等粗粒度事件自动化。

另外还有一套 typed plugin hooks：`src/plugins/hook-types.ts` 当前列出 37 个 Plugin SDK hook 名称。它们不是“内置 internal hook”，而是插件通过 `api.on(...)` 注册的进程内扩展点，用来改写 prompt、拦截工具、取消消息、控制安装、观察生命周期等。

## 数量口径

| 口径 | 数量 | 入口 | 说明 |
| --- | ---: | --- | --- |
| Bundled internal hooks | 5 | `src/hooks/bundled/*/HOOK.md` | OpenClaw 自带、可通过 `openclaw hooks enable <name>` 启用 |
| Typed plugin hooks | 37 | `src/plugins/hook-types.ts` | Plugin SDK 事件名，插件运行时注册，不是 `HOOK.md` 文件式 hook |
| Provider runtime hooks | 40+ | `docs/plugins/architecture-internals.md` | Provider 插件专用回调，服务模型目录、认证、流式传输、replay、usage 等 provider 行为 |

下面主要总结 5 个 bundled internal hooks，并补充它们和 typed plugin hooks 的配合边界。

## 内置 internal hooks

| Hook | 监听事件 | 作用 | 如何配合 |
| --- | --- | --- | --- |
| `session-memory` | `command:new`、`command:reset` | 在 `/new` 或 `/reset` 时把上一段会话的最近消息保存到 `<workspace>/memory/YYYY-MM-DD-HHMM.md`。默认取最近 15 条 user/assistant 消息，可用 `messages` 调整；`llmSlug: true` 时可让模型生成文件名 slug。 | 和 `command-logger` 会在同一次命令事件中一起触发。它监听更具体的 `command:new` / `command:reset`，并把写文件放到后台，避免阻塞 `/new` / `/reset` 的回复路径。 |
| `bootstrap-extra-files` | `agent:bootstrap` | 在 agent bootstrap 阶段按配置的 `paths` / `patterns` / `files` 从 workspace 读取额外启动文件，追加到 `Project Context`。只允许识别的 bootstrap basename，例如 `AGENTS.md`、`TOOLS.md`、`MEMORY.md` 等。 | 运行在 prompt/bootstrap 上下文进入 agent 前，适合 monorepo 多上下文根。它修改的是事件里的 `bootstrapFiles` 数组，后续 agent prompt 组装会看到追加后的文件。 |
| `command-logger` | `command` | 记录所有 slash command 到 `~/.openclaw/logs/commands.log`，每行 JSONL，包含时间、action、sessionKey、senderId、source。 | 监听通用 `command`，因此 `/new`、`/reset`、`/stop` 等都会进入日志。内部触发顺序是先通用事件 `command`，再具体事件如 `command:new`，所以它通常先于具体命令 hook 执行。 |
| `compaction-notifier` | `session:compact:before`、`session:compact:after` | 在会话压缩开始和结束时向当前会话注入简短可见提示，让聊天侧知道上下文正在 compact 并会继续执行。 | compaction 流程会先触发 internal `session:compact:*`，收集 hook 写入的 `event.messages` 并发送给会话；同一阶段还会调用 typed plugin hooks `before_compaction` / `after_compaction`，给插件做观察或补充处理。 |
| `boot-md` | `gateway:startup` | Gateway 启动后，为每个配置的 agent scope 查找对应 workspace 的 `BOOT.md`，并运行其中的启动任务。相同 workspace 会去重。 | Gateway 先加载 internal hooks，再启动 channels 和 plugin services；随后延迟触发 `gateway:startup`。`boot-md` 借这个事件在系统就绪后运行启动检查或主动任务。 |

## internal hooks 的事件模型

Internal hook 事件由 `createInternalHookEvent(type, action, sessionKey, context)` 创建，包含 `type`、`action`、`sessionKey`、`timestamp`、`context` 和可追加回复的 `messages`。`messages` 只有在调用方提供回复通道时才会被送回用户；例如 `command:*` 和 compaction 通知会处理它，纯生命周期事件通常只做副作用。事件 key 有两层：通用 `type`，例如 `command`；具体 `type:action`，例如 `command:new`。

触发时，OpenClaw 会按这个顺序执行：

1. 找 `type` 通用监听器。
2. 找 `type:action` 具体监听器。
3. 拼成一个列表，按注册顺序依次 `await`。
4. 单个 handler 抛错会被记录，不会阻止后续 handler。

这意味着 `command-logger` 这种通用 hook 可以记录所有命令，而 `session-memory` 这种具体 hook 只响应 `/new` 和 `/reset`。

## discovery、启用和覆盖

Internal hooks 不是无条件启动。Gateway 只有在配置了 internal hooks 时才加载：例如 `hooks.internal.enabled=true`、启用了某个 `hooks.internal.entries.<name>`、安装了 hook pack、配置了 extra dirs，或仍在使用 legacy handlers。

发现来源按优先级合并：

1. `openclaw-bundled`：仓库自带 hooks。
2. `openclaw-plugin`：已安装插件随包提供的 hooks。
3. `openclaw-managed`：用户级 hooks，比如 `~/.openclaw/hooks/` 和 `hooks.internal.load.extraDirs`。
4. `openclaw-workspace`：workspace 里的 `hooks/`，默认需要显式 opt in。

覆盖规则不是简单“后发现者覆盖前发现者”。源码策略里，managed hooks 可以覆盖 bundled / plugin / managed；plugin hooks 可以覆盖 bundled / plugin；workspace hooks 只能覆盖 workspace hooks，不能覆盖 bundled、managed 或 plugin hook 名称。这避免项目目录里的 hook 偷偷替换掉系统级或插件级 hook。

## 和 typed plugin hooks 如何配合

Internal hooks 和 typed plugin hooks 面向不同层级：

| 需求 | 用 internal hook | 用 typed plugin hook |
| --- | --- | --- |
| 保存 `/new` 前的会话摘要、记录命令日志、Gateway 启动后跑脚本 | 适合 | 不需要 |
| 修改 prompt、注入系统上下文、决定 provider/model | 不适合 | 适合：`before_model_resolve`、`agent_turn_prepare`、`before_prompt_build` |
| 阻止或改写工具调用、要求用户批准 | 不适合 | 适合：`before_tool_call` |
| 观察工具结果、改写持久化的工具结果消息 | 不适合 | 适合：`after_tool_call`、`tool_result_persist` |
| 取消或改写出站消息 | 不适合 | 适合：`message_sending`、`before_dispatch`、`reply_dispatch` |
| 粗粒度观察入站/出站消息并做副作用 | 适合：`message:received`、`message:sent` | 也可，但 typed hooks 更适合有顺序、取消、改写语义的场景 |
| 安装前扫描或阻止插件/skill 安装 | 不适合 | 适合：`before_install` |

Typed plugin hooks 的执行规则也不同：`api.on(name, handler, { priority })` 注册后，hook runner 按 priority 从高到低排序。同 priority 保持注册顺序。观察型 hook 可以并行运行；会返回决策或修改结果的 hook 会按优先级串行运行并合并结果。部分 hook 可以终止后续处理，例如 block、cancel、handled、requireApproval 等。

## 一次典型流程中的配合

### Gateway 启动

1. Gateway 读取配置，确认是否需要 internal hooks。
2. `loadInternalHooks` 发现 bundled/plugin/managed/workspace hooks，做配置过滤和 eligibility 检查。
3. channels 启动，plugin services 启动。
4. Gateway 延迟触发 `gateway:startup`。
5. `boot-md` 响应事件，为每个 agent workspace 运行 `BOOT.md`。

### `/new` 或 `/reset`

1. reset/new 路径先构造 `command:new` 或 `command:reset` internal event，带上 `sessionEntry`、`previousSessionEntry`、`commandSource`、`cfg`、`workspaceDir`。
2. `command-logger` 因为监听 `command`，记录命令 JSONL。
3. `session-memory` 因为监听具体事件，把旧 transcript 最近消息写入 workspace memory。
4. session cleanup/reset 继续执行。
5. typed plugin hook `before_reset` 用于插件侧观察 reset 生命周期；它和 internal hook 是并行概念，不替代 `session-memory` 这种文件式自动化。

### Agent bootstrap

1. OpenClaw 准备 workspace bootstrap files。
2. 触发 `agent:bootstrap`。
3. `bootstrap-extra-files` 按配置读取额外文件并更新 `event.context.bootstrapFiles`。
4. 后续 prompt 组装使用更新后的 bootstrap 文件集合。

### Session compaction

1. compaction 前触发 internal `session:compact:before`。
2. `compaction-notifier` 把“正在 compact”的提示加入 `event.messages`。
3. 同阶段再调用 typed plugin `before_compaction`，供插件观察压缩前指标。
4. OpenClaw 执行实际 compaction。
5. compaction 后触发 internal `session:compact:after`，再调用 typed plugin `after_compaction`。
6. `compaction-notifier` 输出完成提示和 token 变化。

### 消息收发

1. 入站消息可以先经过 typed plugin hooks，如 `inbound_claim`、`message_received`，前者可以 claim 并合成回复。
2. internal `message:received` 更适合做粗粒度副作用或兼容 hook pack；它不表达 claim、block、cancel 这类策略。
3. 出站前 typed plugin hooks 如 `message_sending`、`before_dispatch`、`reply_dispatch` 可以改写或取消。
4. 发送完成后 typed `message_sent` 和 internal `message:sent` 都可以观察投递结果；internal 侧更偏自动化副作用。

## 37 个 typed plugin hooks 分组

| 分组 | Hooks |
| --- | --- |
| Agent turn | `before_model_resolve`、`agent_turn_prepare`、`before_prompt_build`、`before_agent_start`、`before_agent_run`、`before_agent_reply`、`before_agent_finalize`、`agent_end`、`heartbeat_prompt_contribution` |
| Conversation observation | `model_call_started`、`model_call_ended`、`llm_input`、`llm_output` |
| Tools | `before_tool_call`、`after_tool_call`、`tool_result_persist`、`before_message_write` |
| Messages and delivery | `inbound_claim`、`message_received`、`message_sending`、`message_sent`、`before_dispatch`、`reply_dispatch` |
| Sessions and compaction | `session_start`、`session_end`、`before_compaction`、`after_compaction`、`before_reset` |
| Subagents | `subagent_spawning`、`subagent_delivery_target`、`subagent_spawned`、`subagent_ended` |
| Lifecycle and install | `gateway_start`、`gateway_stop`、`deactivate`、`cron_changed`、`before_install` |

## 记忆点

- “OpenClaw 内置了多少 hook”如果指 `openclaw hooks list` 里的 bundled internal hooks：答案是 5 个。
- internal hooks 是事件驱动脚本，适合 side effects 和 operator automation。
- typed plugin hooks 是插件中间件/策略层，适合控制 agent、prompt、tool、message、session、install 生命周期。
- provider runtime hooks 是 provider 插件内部能力层，不应和上面两个数量相加。
- internal hook 的协作方式是“通用事件 + 具体事件”顺序触发；typed plugin hook 的协作方式是 priority 排序、按 hook 类型并行观察或串行合并决策。

## 主要来源

- `docs/automation/hooks.md:9`：internal hooks 的加载条件和用途。
- `docs/automation/hooks.md:47`：internal hook 事件类型列表。
- `docs/automation/hooks.md:182`：internal hook discovery 来源和启用行为。
- `docs/automation/hooks.md:205`：5 个 bundled hooks 表。
- `src/hooks/bundled/*/HOOK.md`：5 个 bundled hooks 的元数据。
- `src/hooks/internal-hooks.ts:268`：internal hooks 同时匹配通用事件和具体事件。
- `src/hooks/internal-hooks.ts:286`：internal hooks 的触发顺序和错误隔离。
- `src/hooks/loader.ts:89`：加载和注册 internal hooks。
- `src/hooks/configured.ts:20`：internal hooks 只有配置后才加载。
- `src/plugins/hook-types.ts:68`：37 个 typed plugin hook 名称。
- `docs/plugins/hooks.md:52`：typed plugin hooks 的 priority 执行规则。
- `src/plugins/hooks.ts:557`：观察型 typed hooks 的并行执行。
- `src/plugins/hooks.ts:593`：修改/决策型 typed hooks 的串行执行和结果合并。

## 验证备注

尝试执行 `pnpm docs:list` 时当前环境返回 `pnpm: command not found`，所以没有跑文档索引脚本。本文基于当前仓库源码与已有文档交叉确认，并用 `find src/hooks/bundled -mindepth 1 -maxdepth 1 -type d` 确认 bundled internal hook 目录为 5 个。

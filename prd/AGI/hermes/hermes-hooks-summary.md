# Hermes Hook 总结

本文按当前仓库源码统计 Hermes 的 hook 体系，主要参考：

- `hermes_cli/plugins.py`：插件 hook 的 `VALID_HOOKS`、注册和分发。
- `agent/conversation_loop.py`：会话、LLM、API 请求相关 hook 的触发点。
- `model_tools.py`、`tools/terminal_tool.py`：工具调用和终端输出相关 hook。
- `agent/shell_hooks.py`：shell hook 如何桥接到插件 hook。
- `gateway/hooks.py`、`gateway/run.py`：gateway 专用事件 hook。
- `plugins/*/plugin.yaml` 和各插件 `__init__.py`：仓库内置插件实际注册了哪些 hook。

## 一句话结论

Hermes 里有三套容易混淆的 hook 机制：

| 机制 | 数量 | 注册方式 | 运行范围 | 说明 |
|---|---:|---|---|---|
| 插件 hook 事件 | 17 个内置事件名 | 插件里调用 `ctx.register_hook()` | CLI + Gateway | 核心生命周期扩展点，也是 shell hooks 复用的事件集合。 |
| Shell hooks | 复用同 17 个事件 | `~/.hermes/config.yaml` 的 `hooks:` 配置 | CLI + Gateway | 不是新事件体系，而是把脚本包装成插件 hook callback。 |
| Gateway event hooks | 8 类事件 | `~/.hermes/hooks/<name>/HOOK.yaml` + `handler.py` | Gateway only | 独立的 gateway 生命周期事件系统。当前 `gateway/builtin_hooks/` 没有内置 handler。 |

如果把“内置 hook”理解为随仓库内置的 hook 型插件，则当前有 4 个 opt-in 插件注册 hook：`disk-cleanup`、`security-guidance`、`observability/langfuse`、`google_meet`。它们合计注册 11 次 hook，覆盖 8 个唯一插件 hook 事件。

## 插件 Hook：17 个内置事件

这些事件定义在 `hermes_cli.plugins.VALID_HOOKS`。插件可以注册未知 hook 名，但会有 warning；稳定可依赖的内置集合是下面 17 个。

| Hook | 触发时机 | 返回值是否影响流程 | 主要用途 |
|---|---|---|---|
| `pre_tool_call` | 任意工具执行前 | 是。返回 `{"action": "block", "message": "..."}` 可阻止工具执行 | 安全策略、审计、限流、工具白名单。 |
| `post_tool_call` | 任意工具执行后 | 否 | 工具日志、指标、自动清理、observability。 |
| `transform_tool_result` | 工具返回后、结果写回对话上下文前 | 是。第一个字符串返回值会替换工具结果 | 通用工具结果改写、脱敏、追加提示。 |
| `transform_terminal_output` | `terminal` 工具拿到原始 stdout/stderr 后，截断、ANSI 清理、脱敏前 | 是。第一个字符串返回值会替换终端输出 | 终端输出预处理、压缩超长输出、去除噪声。 |
| `pre_llm_call` | 每个用户 turn 进入工具调用循环前 | 是。返回字符串或 `{"context": "..."}` 注入本轮用户消息 | 记忆召回、RAG、临时上下文、策略提示。 |
| `post_llm_call` | 成功产出最终回复后 | 否 | 外部记忆同步、质量统计、turn 级 telemetry。 |
| `pre_api_request` | 每次真实模型 API 请求前 | 通常不影响流程 | 每次 provider call 的 tracing、token/消息快照。 |
| `post_api_request` | 每次模型 API 响应后 | 通常不影响流程 | 记录 usage、finish_reason、响应模型、调用耗时。 |
| `transform_llm_output` | 最终回复交付给用户前 | 是。第一个非空字符串返回值替换最终回复 | 回复脱敏、风格化、追加固定页脚、输出规范化。 |
| `on_session_start` | 新 session 第一轮构建 system prompt 后 | 否 | 初始化 session 级状态、预热缓存。 |
| `on_session_end` | 每次 `run_conversation()` 收尾时，也会在 CLI 中断退出兜底触发 | 否 | flush、清理、turn/session 结束统计。注意它并不只代表真正销毁会话。 |
| `on_session_finalize` | CLI/Gateway 要销毁或换掉当前活跃 session 时 | 否 | 旧 session 最后一次落盘、关闭资源、最终 telemetry。 |
| `on_session_reset` | Gateway/CLI 换入新 session key 后 | 否 | 重置 session 缓存、记录 session rotation。 |
| `subagent_stop` | `delegate_task` 的每个子 agent 完成后 | 否 | 多 agent 编排审计、子任务耗时统计、成本归集。 |
| `pre_gateway_dispatch` | Gateway 收到用户消息后、鉴权/配对/agent dispatch 前 | 是。可 `skip`、`rewrite`、`allow` | 消息流策略、静默旁路、群聊只监听、人工接管。 |
| `pre_approval_request` | 危险命令需要用户审批、发送审批提示前 | 否 | 审批通知、审计日志、外部提醒。 |
| `post_approval_response` | 用户审批响应或超时后 | 否 | 记录审批结果、关闭通知、指标统计。 |

## Gateway Event Hooks：8 类事件

Gateway 事件 hook 是另一套独立系统，由 `gateway.hooks.HookRegistry` 管理。它扫描 `~/.hermes/hooks/` 下的 `HOOK.yaml` 和 `handler.py`，只在 gateway 进程里运行，不通过 `hermes_cli.plugins.invoke_hook()`。

| Event | 触发时机 | 常见用途 |
|---|---|---|
| `gateway:startup` | Gateway 进程启动 | 启动检查、外部服务通知。 |
| `session:start` | 新 messaging session 创建 | 记录用户/平台/session 关系。 |
| `session:end` | session reset 前旧会话结束 | 落盘、统计、通知。 |
| `session:reset` | 用户执行 `/new` 或 `/reset` 后 | 记录会话重置、初始化新状态。 |
| `agent:start` | agent 开始处理一条消息 | 运行审计、开始计时。 |
| `agent:step` | 工具调用循环每一步 | 长任务告警、进度监控。 |
| `agent:end` | agent 完成处理 | 记录最终响应、耗时统计。 |
| `command:*` | 任意 slash command 执行 | 命令审计，也可用 `emit_collect()` 对命令 `deny`、`handled`、`rewrite`。 |

`gateway/builtin_hooks/__init__.py` 当前只有说明字符串，没有实际注册任何 always-on handler。因此 gateway hook 系统有 8 类内置事件，但仓库当前内置 gateway hook handler 数量是 0。

## 三套 Hook 如何配合

### 1. 插件 hook 是主干

插件通过 `ctx.register_hook(name, callback)` 把 callback 追加到全局 `PluginManager._hooks[name]`。核心代码在不同生命周期点调用 `invoke_hook(name, **kwargs)`，并收集非 `None` 返回值。

错误处理是 fail-open：单个 callback 抛异常会被记录，但不会中断其他 callback，也不会让 agent 崩掉。

### 2. Shell hooks 复用插件 hook 分发器

Shell hooks 不是独立生命周期。启动时 `agent.shell_hooks.register_from_config()` 读取配置，把每个脚本包装成 callback，再挂到同一个 `PluginManager._hooks` 上。

运行时流程是：

1. 核心调用 `invoke_hook("pre_tool_call", ...)` 等插件 hook。
2. Python 插件 callback 先执行。
3. Shell hook wrapper 后执行，向脚本 stdin 写入 JSON payload。
4. 脚本 stdout 如果是可识别 JSON，会被解析成 Hermes hook 返回值。

因此 Python 插件和 shell hooks 天然串在同一条分发链上。当前设计里 Python 插件先注册，shell hooks 后注册；在 `pre_tool_call` 多个 block 冲突时，第一个有效 block 生效，所以 Python 插件优先。

### 3. Gateway hooks 独立于插件 hook

Gateway event hooks 由 `GatewayRunner.hooks` 管理，事件名类似 `agent:start`、`command:status`。它们适合 gateway 平台的外部集成、消息审计和 slash command 策略。

它和插件 hook 的配合关系是“并行存在”：

- `pre_gateway_dispatch` 是插件 hook，发生在 gateway 收到用户消息、正式鉴权和分发前。
- `command:<name>` 是 gateway event hook，发生在 gateway 识别 slash command 后、执行命令前。
- agent 真正开始跑之后，会进入通用插件 hook 流程，比如 `pre_llm_call`、`pre_api_request`、`pre_tool_call`。

## 一次正常消息的大致 Hook 顺序

下面是简化后的顺序，真实流程会因为中断、工具调用次数、gateway/CLI 差异而变化：

```text
Gateway 收到消息
  -> pre_gateway_dispatch       # 插件 hook，可 skip/rewrite/allow
  -> command:<name>             # gateway hook，仅 slash command
  -> agent:start                # gateway hook

Agent turn 开始
  -> on_session_start           # 新 session 第一轮才触发
  -> pre_llm_call               # 可注入本轮临时上下文

每一次模型 API 调用
  -> pre_api_request
  -> provider API request
  -> post_api_request

模型要求调用工具时
  -> pre_tool_call              # 可 block
  -> terminal: transform_terminal_output  # 仅 terminal 工具
  -> 工具 dispatch
  -> post_tool_call
  -> transform_tool_result      # 结果给模型看之前可改写

如果有 delegate_task 子 agent
  -> subagent_stop              # 每个子 agent 完成一次

最终回复
  -> transform_llm_output       # 给用户前可改写
  -> post_llm_call
  -> on_session_end             # 每个 run_conversation 收尾
  -> agent:end                  # gateway hook

真正 session 边界，例如 /new、/reset、空闲回收、CLI 退出
  -> on_session_finalize(old_id)
  -> 换 session key
  -> on_session_reset(new_id)
  -> 下一轮首条消息触发 on_session_start(new_id)
```

审批相关 hook 是旁路流程：危险命令进入审批系统时触发 `pre_approval_request`，用户选择或超时后触发 `post_approval_response`。这两个 hook 只能观察，不能代替用户审批；要提前拦截工具，应使用 `pre_tool_call`。

## 仓库内置 Hook 型插件

这些插件都在 `plugins/` 下，但默认是 opt-in，需要显式启用。

| 插件 | 注册的 hook | 作用 |
|---|---|---|
| `disk-cleanup` | `post_tool_call`、`on_session_end` | 跟踪会话中产生的临时/测试文件，并在结束时做安全清理。 |
| `security-guidance` | `pre_tool_call`、`transform_tool_result` | 扫描写文件/patch 内容里的危险模式；默认追加安全警告，也可开启 block 模式。 |
| `observability/langfuse` | `pre_api_request`、`post_api_request`、`pre_llm_call`、`post_llm_call`、`pre_tool_call`、`post_tool_call` | 把 turn、模型调用、工具调用串成 Langfuse trace。 |
| `google_meet` | `on_session_end` | 会话结束时清理/收尾 Google Meet 相关状态。 |

按注册次数算是 11 次；按唯一事件算覆盖 8 个插件 hook：`pre_tool_call`、`post_tool_call`、`transform_tool_result`、`on_session_end`、`pre_api_request`、`post_api_request`、`pre_llm_call`、`post_llm_call`。

## 注意事项

- `on_session_end` 名字容易误导：当前实际触发点是每次 `run_conversation()` 收尾；真正销毁/换出 session 更应该看 `on_session_finalize`。
- `pre_llm_call` 注入的是用户消息，不是 system prompt；这是为了保留 prompt cache。
- `transform_terminal_output` 比 `transform_tool_result` 更早，只覆盖 terminal 原始输出；`transform_tool_result` 覆盖所有工具返回值。
- `pre_api_request` / `post_api_request` 是每次 provider API call；`pre_llm_call` / `post_llm_call` 是每个用户 turn。
- Shell hook 脚本以当前用户权限运行，有独立 allowlist；它们的返回值只在 Hermes 识别的 JSON 形状下生效。
- Gateway event hooks 只在 gateway 进程中运行，CLI 不加载。

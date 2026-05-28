# Hermes 与 OpenClaw 的 Agent 内核对比

我读下来的核心判断是：**Hermes 是 agent-centric，OpenClaw 是 gateway/runtime-centric。**

Hermes 的中心是一个会学习、会用工具、会沉淀技能和记忆的 `AIAgent`。OpenClaw 的中心是一个本地优先、常驻、多通道的控制平面，agent runtime 只是其中可替换的一层。

## 本质区别

Hermes 的 agent 内核更像“一个强 agent 循环”。入口很多，CLI、gateway、ACP、batch、API server，最后都汇入 `AIAgent`，由它负责 prompt、provider/API mode、工具、重试、fallback、压缩、记忆、回调和持久化。Hermes 文档也直接把 `AIAgent` 描述为核心编排引擎，负责从 prompt assembly 到 tool dispatch 到 provider failover 的整条链路。

OpenClaw 的内核更像“runtime/harness 编排系统”。它明确区分 provider、model、agent runtime、channel 四层。agent runtime 是“拥有一个 prepared model loop 的组件”，可以是内置 `openclaw`，也可以是 `codex`、CLI backend、ACP 等。所以 OpenClaw 更关心“谁拥有这次循环”：OpenClaw 自己、Codex app-server，还是外部 harness。

Hermes 的工具系统是“核心注册表 + toolsets”。工具自注册，`AIAgent` 在 loop 里调用 `model_tools` / registry，部分 agent-level tools 如 `memory`、`todo`、`delegate_task` 被 agent 内核拦截。OpenClaw 则更强调工具策略、sender/group/sandbox policy、plugin harness 的边界；显式 plugin runtime 失败时不会偷偷退回 OpenClaw，这一点在 harness selection 里写得很硬。

## Agent Loop 形态

Hermes 的 loop 是经典同步工具循环：

```text
messages -> LLM call -> tool_calls? -> 执行工具 -> append tool result -> 下一轮 -> final text
```

它内部统一成 OpenAI-style message 格式，支持三种 API mode。多个 tool call 用线程池并发，结果按原顺序塞回历史。

OpenClaw 的底层 loop 更事件化。`packages/agent-core/src/agent-loop.ts` 用 `AgentMessage`，每轮发 `agent_start`、`turn_start`、`message_update`、`tool_execution_*`、`turn_end`、`agent_end`，并支持 steering / follow-up queue。LLM 边界才把 `AgentMessage[]` 转成 provider message。上层 `embedded-agent-runner` 再负责 workspace、sandbox、session lock、context engine、prompt build、runtime stream wrapper 等大量前后处理。

## 理念差异

Hermes 的产品哲学是“自我改进的个人 agent”。README 第一段就把 closed learning loop 放在中心：从经验创建 skill、使用中改进 skill、主动持久化知识、搜索过往会话、形成用户模型。所以 Hermes 的内核设计更偏“让同一个 agent 越用越懂你”。

OpenClaw 的产品哲学是“在你的设备、渠道和规则中做事的本地助手”。VISION 写的是运行在你的设备和渠道里，重点是安全默认值、平台、provider、channel、companion apps。它还明确说 core 要 lean，能力优先走 plugin，不能做就扩 plugin API。所以 OpenClaw 的设计更偏“一个安全、可路由、可扩展的个人 AI 操作系统控制面”。

## 相同点

两者都不是简单聊天壳，核心共同点很多：

- 都有多渠道 gateway，CLI 只是入口之一。
- 都有 tool-calling loop、streaming、interrupt、context compaction、provider fallback。
- 都有 workspace / instruction files，如 `AGENTS.md`、`SOUL.md`、`USER.md`。
- 都有 skills、memory、sessions、cron / automation、subagent / delegation。
- 都追求 prompt stability，避免每轮系统 prompt 随便变化破坏 cache。
- 都把安全和工具权限当成一等问题，不只是“给模型一个 shell”。

## 一句话取舍

如果你想研究“一个 agent 怎么形成持续人格、记忆、技能和自我改进循环”，Hermes 更直接。

如果你想研究“一个个人 AI 平台怎么把多渠道、设备、runtime、插件、沙箱和 session 统一起来”，OpenClaw 的架构更完整。

Hermes 的内核像强心脏，OpenClaw 的内核像一套神经系统加运行时调度层。


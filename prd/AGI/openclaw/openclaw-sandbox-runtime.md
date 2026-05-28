# OpenClaw 的沙箱与运行时架构

## 结论

OpenClaw 默认不是套 Claude Code 的内核。它有自己的内置 agent runtime，也可以通过插件或 ACP 接入 Codex、Claude Code 等外部 harness。

沙箱方面，OpenClaw 的沙箱主要是“工具执行层”的隔离：Gateway 进程仍在宿主机上，`exec`、`read`、`write`、`edit`、`apply_patch`、`process` 等工具在启用后进入 sandbox backend 执行。

## 沙箱如何实现

OpenClaw 沙箱默认关闭，由 `agents.defaults.sandbox` 或 `agents.list[].sandbox` 控制。文档说明：Gateway 不进沙箱，工具执行才进入隔离环境。

参考：`docs/gateway/sandboxing.md:9`、`docs/gateway/sandboxing.md:17`、`docs/gateway/sandboxing.md:32`

主要配置包括：

- `mode`: `off`、`non-main`、`all`
- `scope`: `agent`、`session`、`shared`
- `backend`: 默认 `docker`
- `workspaceAccess`: `none`、`ro`、`rw`

源码默认值在：`src/agents/sandbox/config.ts:246`

Docker backend 会创建或复用容器，并加上安全约束：

- `readOnlyRoot: true`
- `network: "none"`
- `capDrop: ["ALL"]`
- `--security-opt no-new-privileges`
- 可配置 seccomp、apparmor、pids、memory、cpu、gpu 等

参考：`src/agents/sandbox/config.ts:101`、`src/agents/sandbox/docker.ts:430`、`src/agents/sandbox/docker.ts:459`、`src/agents/sandbox/docker.ts:485`

## 命令如何进入沙箱

运行时会先解析当前 session 是否需要 sandbox：

- `src/agents/embedded-agent-runner/run/attempt.ts:1511`
- `src/agents/sandbox/context.ts:130`

然后把 sandbox context 传给工具构造器：

- `src/agents/embedded-agent-runner/run/attempt.ts:1814`
- `src/agents/agent-tools.ts:769`

`exec` 默认 `host=auto`：有 sandbox 时跑 sandbox，没有 sandbox 时跑 gateway。显式 `host=sandbox` 但没有 sandbox runtime 会 fail closed。

参考：`docs/tools/exec.md:44`、`docs/tools/exec.md:68`、`docs/tools/exec.md:86`、`src/agents/bash-tools.exec.ts:1410`

Docker 执行路径最终是：

```text
docker exec ... /bin/sh -lc <command>
```

参考：`src/agents/sandbox/docker-backend.ts:66`、`src/agents/bash-tools.exec-runtime.ts:786`

## OpenClaw 是否用了 Claude Code 类似内核

不是默认使用 Claude Code 内核。

OpenClaw 自己拥有内置 runtime：

- `src/agents/embedded-agent-runner/`: agent attempt loop、provider stream、compaction、model selection
- `packages/agent-core/`: reusable agent core、session/tool contracts
- `src/agents/agent-tools*.ts`: OpenClaw 自己的工具定义、策略和 hooks

参考：`docs/agent-runtime-architecture.md:6`、`docs/agent-runtime-architecture.md:10`、`docs/agent-runtime-architecture.md:43`

## Claude Code 如何接入

Claude Code 在 OpenClaw 中主要是外部 harness 路径，而不是默认内核。

### ACP 路径

Claude Code through ACP 的栈是：

1. OpenClaw ACP session control plane
2. `@openclaw/acpx` runtime plugin
3. Claude ACP adapter
4. Claude-side runtime/session machinery

参考：`docs/tools/acp-agents.md:236`

依赖也能看到：

- `@agentclientprotocol/claude-agent-acp`
- `acpx`

参考：`extensions/acpx/package.json:10`

重要边界：ACP sessions 当前不在 OpenClaw sandbox 内。

参考：`docs/tools/acp-agents.md:720`

### CLI backend 路径

Claude CLI backend 是更轻的 text-only fallback：OpenClaw 构造 prompt、调用 Claude CLI、解析输出。OpenClaw 工具默认不会直接注入。

参考：`docs/gateway/cli-backends.md:10`、`docs/gateway/cli-backends.md:147`

## 和 Claude Code 的主要区别

| 维度 | OpenClaw native runtime | Claude Code / ACP |
| --- | --- | --- |
| 模型循环 | OpenClaw 拥有 | Claude 侧 harness 拥有 |
| 工具调用 | OpenClaw 工具系统 | Claude native tools 或 ACP/MCP 桥 |
| 沙箱 | OpenClaw 工具层 sandbox | 不被 OpenClaw sandbox 自动包住 |
| 多渠道 | Telegram、Discord、Slack 等由 OpenClaw 管 | 通过 OpenClaw ACP/渠道桥接 |
| 插件 hooks | OpenClaw 原生支持 | 只能桥接或观察部分事件 |
| session 状态 | OpenClaw transcript | 外部 harness 自己的 session/thread |

## Codex 的特殊情况

Codex 不是 Claude Code，但 OpenClaw 有 bundled Codex plugin，依赖 `@openai/codex`。在 Codex runtime 下，Codex app-server 拥有更多 native model loop、thread、tool continuation，OpenClaw 负责渠道投递、动态工具桥接、hooks 适配和 transcript mirror。

参考：`extensions/codex/package.json:10`、`docs/plugins/codex-harness-runtime.md:16`

## 一句话总结

OpenClaw 自己做了 agent runtime 和工具沙箱；Claude Code/Codex 可以作为外部或插件 harness 接进来。区别的核心是：OpenClaw native 路径由 OpenClaw 控制模型循环、工具、沙箱和插件 hooks；Claude Code 路径由 Claude 侧 runtime 控制核心执行，OpenClaw 负责调度、渠道、会话绑定和部分策略桥接。

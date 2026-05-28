# Hermes 的沙箱与运行内核说明

本文基于当前仓库代码梳理 Hermes 如何实现沙箱、它是否使用 Claude Code 类似的内核，以及 Hermes 与 Claude Code 的主要区别。

## 结论

Hermes 默认没有嵌入 Claude Code 的内核。它的默认执行路径是自己实现的 Python agent loop、工具注册与工具调用系统，再接入不同模型提供商。

Hermes 可以读取 Claude Code 的 OAuth 凭据，并模拟 Claude Code 的部分 Anthropic 请求头，但这属于认证与协议兼容，不等于复用 Claude Code runtime。

Hermes 另有一个可选的 `codex app-server` 运行路径，可以把一轮对话交给 Codex 子进程处理；这是 OpenAI Codex 侧的 runtime，不是 Claude Code，而且只有在显式配置相关 runtime 时才启用。

Hermes 的沙箱不是单一机制，而是由工具面、终端后端、命令审批、文件安全策略和 `execute_code` 子进程隔离组合出来的分层模型。默认 `local` 终端后端不是强 OS 沙箱；强隔离主要依赖 Docker、Modal、Daytona、Singularity 等后端。

## Hermes 的默认运行内核

Hermes 的默认 agent loop 在 `agent/conversation_loop.py` 中实现。它负责构造消息、调用模型、解析工具调用、执行工具，并把工具结果继续喂回模型。

关键路径：

- `agent/conversation_loop.py:263`：`run_conversation()` 入口。
- `agent/conversation_loop.py:675`：默认 Hermes 工具循环。
- `agent/conversation_loop.py:1083`：构造模型调用参数。
- `agent/conversation_loop.py:3345`：处理模型返回的 tool call。
- `agent/conversation_loop.py:3577`：调用 `agent._execute_tool_calls(...)` 执行工具。
- `agent/chat_completion_helpers.py:151`：非流式模型调用封装。
- `agent/chat_completion_helpers.py:1530`：流式模型调用封装。
- `model_tools.py:757`：`handle_function_call()`，即工具分发入口。

也就是说，Hermes 默认是：

```text
用户输入
  -> Hermes Python agent loop
  -> 模型 provider / adapter
  -> tool call
  -> Hermes tool registry / handle_function_call
  -> 工具后端
  -> 工具结果回填到消息
  -> 下一轮模型调用
```

这套循环、工具系统和 provider 插件系统都是 Hermes 自己实现的。

## Hermes 的沙箱分层

### 1. 工具面控制

Hermes 先通过 toolset 决定模型能看到哪些工具。例如 `safe` toolset 不暴露 terminal；`terminal` toolset 才包含终端与进程相关工具。

关键路径：

- `toolsets.py:152`：`terminal` toolset 包含 `terminal` 和 `process`。
- `toolsets.py:328`：`safe` toolset 不包含 terminal access。
- `toolsets.py:411`：gateway 侧 toolset 说明 terminal 带安全检查。
- `model_tools.py:1`：工具注册与发现的总入口说明。

这是一层能力暴露控制：模型拿不到工具 schema，就不能直接调用对应工具。

### 2. 终端环境后端

真正执行 shell 命令的是 `tools/terminal_tool.py` 和 `tools/environments/*`。Hermes 通过 `TERMINAL_ENV` 选择后端，支持：

- `local`
- `docker`
- `singularity`
- `modal`
- `daytona`
- `ssh`

关键路径：

- `tools/terminal_tool.py:948`：读取终端环境配置。
- `tools/terminal_tool.py:1038`：根据环境类型创建 backend。
- `tools/terminal_tool.py:1576`：`terminal_tool()` 主入口。
- `tools/environments/base.py:81`：host 侧 sandbox 根目录。
- `tools/environments/base.py:288`：所有环境后端的基础接口。

#### local 后端

`local` 后端是在当前宿主机上以当前用户身份运行命令。它会做环境变量过滤、超时、进程组管理、输出截断和敏感信息脱敏，但它本身不是强 OS 沙箱。

关键路径：

- `tools/environments/local.py:83`：provider / messaging secret 环境变量 blocklist。
- `tools/environments/local.py:281`：构造运行环境并过滤 secrets。
- `tools/environments/local.py:413`：`LocalEnvironment` 说明。
- `tools/environments/local.py:521`：通过 `subprocess.Popen` 启动命令。
- `tools/environments/local.py:545`：终止进程 / 进程组。

所以默认本地模式更像“有护栏的本机执行”，不是容器级隔离。

#### Docker 后端

Docker 后端才更接近传统意义的沙箱。它把命令放到容器里执行，并配置 capability、no-new-privileges、PID 限制、资源限制、tmpfs、工作目录挂载等。

关键路径：

- `tools/environments/docker.py:1`：Docker sandbox backend 说明。
- `tools/environments/docker.py:146`：基础安全参数，例如 `cap-drop`、`no-new-privileges`、PID limit。
- `tools/environments/docker.py:277`：容器作为安全边界的说明。
- `tools/environments/docker.py:325`：CPU、内存、磁盘、网络等资源限制。
- `tools/environments/docker.py:374`：持久化 workspace / home。
- `tools/environments/docker.py:406`：凭据、skills、cache 等只读挂载。
- `tools/environments/docker.py:507`：`docker run` 启动容器。

如果希望 Hermes 有比较硬的沙箱边界，应优先使用 Docker 或云端隔离后端，而不是 `local`。

### 3. 命令审批与危险操作拦截

Hermes 对 terminal 命令还有一层审批与检测。`tools/approval.py` 是危险命令检测、审批、智能审批、allowlist 和硬性 blocklist 的集中实现。

关键路径：

- `tools/approval.py:1`：模块职责说明。
- `tools/approval.py:122`：敏感目标列表。
- `tools/approval.py:166`：hardline blocklist，某些命令即使在 yolo / unrestricted 下也不能由 agent 执行。
- `tools/approval.py:240`：`sudo` stdin 相关保护。
- `tools/approval.py:818`：审批配置与 smart approval。
- `tools/approval.py:1192`：gateway 下的阻塞式审批流程。

这层主要解决“模型想执行什么命令”的风险。它不是 OS 隔离，但可以在命令进入 backend 前阻断高风险行为。

### 4. `execute_code` 的子进程隔离

Hermes 还有一个 `execute_code` 工具，用于程序化工具调用。它不是普通 terminal 的简单别名，而是启动一个受控 Python 子进程，并通过 RPC 暴露有限工具集。

关键路径：

- `tools/code_execution_tool.py:3`：Programmatic Tool Calling 总说明。
- `tools/code_execution_tool.py:58`：允许在代码里调用的工具白名单。
- `tools/code_execution_tool.py:1026`：`execute_code` 主入口。
- `tools/code_execution_tool.py:1120`：RPC socket / loopback 权限设置。
- `tools/code_execution_tool.py:1149`：子进程环境变量清理，不传 secrets。
- `tools/code_execution_tool.py:1217`：启动子进程。
- `tools/code_execution_tool.py:1360`：输出脱敏。

这层适合让模型写一段小程序来批量调用工具，同时避免把所有中间工具结果都塞进上下文。但在 local backend 下，它仍然不是强 OS jail；如果底层 terminal backend 是 Docker / Modal 等，隔离强度才会跟着增强。

### 5. 文件工具的防御性保护

文件读写工具也有自己的路径检查、敏感文件保护和写入边界。

关键路径：

- `tools/file_tools.py:119`：根据当前 task 的 live terminal cwd 解析路径。
- `tools/file_tools.py:130`：阻止设备文件、`/proc` 等特殊路径。
- `tools/file_tools.py:168`：敏感路径写入检查。
- `tools/file_tools.py:533`：`read_file` 阻止二进制、内部、凭据路径。
- `tools/file_tools.py:884`：`write_file` 的跨 profile / 敏感路径保护。
- `tools/file_tools.py:953`：`patch` 的路径保护。
- `agent/file_safety.py:28`：默认写入拒绝列表，例如 `.ssh`、`.env`、`auth.json`、`/etc/passwd` 等。
- `agent/file_safety.py:85`：`HERMES_WRITE_SAFE_ROOT`。
- `agent/file_safety.py:165`：读保护说明。

需要注意：`agent/file_safety.py` 明确把这些保护称为 defense-in-depth，而不是不可绕过的安全边界。因为如果 terminal 工具可用，shell 命令理论上可以绕过文件工具的读写封装；这也是为什么 terminal 是否暴露、是否进入 Docker 后端很关键。

## Hermes 是否用了 Claude Code 类似内核

默认没有。

Hermes 与 Claude Code 的关系主要体现在 Anthropic OAuth 兼容层，而不是 runtime 复用。

关键路径：

- `agent/anthropic_adapter.py:1`：Anthropic Messages adapter 支持普通 API key、OAuth setup token、Claude Code credentials。
- `agent/anthropic_adapter.py:273`：OAuth-only beta headers。
- `agent/anthropic_adapter.py:742`：Bearer auth 与 Claude CLI 风格请求头。
- `agent/anthropic_adapter.py:855`：读取 Claude Code 凭据。
- `agent/anthropic_adapter.py:1120`：OAuth token 解析顺序。
- `plugins/model-providers/anthropic/__init__.py:42`：provider alias 包含 `claude`、`claude-oauth`、`claude-code`。

因此，`claude-code` 在 Hermes 里更准确地说是一个 Anthropic provider alias / credential path，而不是“调用 Claude Code 内核”。

## 可选的 Codex app-server 路径

Hermes 有一条可选路径可以把一轮对话交给 `codex app-server` 子进程。

关键路径：

- `agent/conversation_loop.py:661`：当 `agent.api_mode == "codex_app_server"` 时走 Codex app-server。
- `agent/transports/codex_app_server.py:1`：Codex app-server JSON-RPC over stdio transport 说明。
- `agent/transports/codex_app_server.py:82`：Kanban 场景下配置 Codex sandbox。
- `agent/transports/codex_app_server.py:113`：启动命令是 `codex app-server`。
- `agent/transports/codex_app_server_session.py:1`：每个 Hermes session 维护一个 Codex thread。
- `agent/transports/codex_app_server_session.py:51`：Hermes terminal security mode 到 Codex permission profile 的映射。

这条路径说明 Hermes 能接入另一个 agent runtime，但它是 Codex app-server，不是 Claude Code，而且是 opt-in。未启用时，Hermes 仍走自己的默认 Python loop。

## 与 Claude Code 的主要区别

### 1. 内核所有权不同

Claude Code 是 Anthropic 官方 CLI，核心 runtime、权限模型、工具执行链路与 Claude 深度绑定。

Hermes 默认是 provider-agnostic 的 Python agent 框架：agent loop、工具注册、provider 插件、终端后端、gateway、TUI、skills 都在仓库里实现或扩展。

### 2. 模型接入方式不同

Claude Code 主要围绕 Claude 体验设计。

Hermes 通过 model-provider plugins 接不同 provider，例如 Anthropic、OpenRouter、GMI、DeepSeek、NVIDIA 等。Anthropic 只是其中一个 provider。

### 3. 沙箱边界不同

Hermes 的沙箱强度取决于 backend：

- `local`：本机执行，加审批、环境变量过滤、文件工具保护、输出脱敏。
- `docker` / `modal` / `daytona` / `singularity`：更接近真正隔离环境。

Claude Code 的具体内部实现属于闭源细节，不能从 Hermes 仓库直接断言。但从 Hermes 代码看，Hermes 不是复用 Claude Code 的本地 sandbox runtime，而是在自己的 terminal backend 和 approval layer 上实现安全模型。

### 4. 产品面不同

Hermes 不只是一个代码 CLI。它还包含：

- CLI 与 Ink TUI。
- Dashboard 内嵌 TUI。
- Gateway，多平台消息机器人。
- Skills 系统。
- Plugin 系统。
- Memory provider plugins。
- Context engine plugins。
- Cron / scheduler。
- 多种 terminal backend。

Claude Code 更像围绕 Claude 的官方代码代理产品；Hermes 更像一个可插拔、多 provider、多入口的 agent 平台。

## 一句话总结

Hermes 的默认内核是自己写的 agent loop 和工具执行框架；它没有默认嵌入 Claude Code。Hermes 对 Claude Code 的使用主要是读取其 Anthropic OAuth 凭据与兼容请求头。沙箱方面，Hermes 是分层实现：toolset 限权、terminal backend 隔离、命令审批、文件保护与 `execute_code` 子进程隔离共同工作，其中真正强隔离主要来自 Docker / 云端 / 容器类 backend。

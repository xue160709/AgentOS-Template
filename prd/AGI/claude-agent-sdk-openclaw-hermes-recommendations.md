# Claude Agent SDK 路线下对 OpenClaw / Hermes 的借鉴建议

## 背景

本文基于 `prd/AGI/` 中关于 OpenClaw、Hermes 与三张 AGI 图的分析，结合当前 AgentOS / CodeX-UI-Template 的实际实现，整理哪些设计值得参考，哪些不建议照搬。

当前项目的核心路线应该保持清晰：

> 以 Claude Agent SDK 作为 agent loop 和工具执行核心，在外围补齐任务、记忆、角色、验证和过程控制台。

因此，OpenClaw 和 Hermes 不应该被当成要迁移的目标架构，而应该被拆成可吸收的工程思想。

## 核心判断

不要复制 OpenClaw 或 Hermes 的内核。

当前项目已经拥有以下基础：

- `ClaudeAgentRunner`：封装 Claude Agent SDK `query`，支持 session resume、权限闸门、事件流、文件 checkpoint 和 PostToolUse hook。
- `Agent Mode`：提供 `CLAUDE.md`、`AGENT.md`、`SOUL.md`、`MEMORY.md`、`memory/`、`TODO.md` 等项目长期上下文。
- `agent-context`：扫描 `.claude`、`.agent`、`.agents`、`.cursor` 下的 Skills、Commands、Subagents 和 instruction files，并转成 Claude SDK 可用上下文。
- `Task Home Plugin`：支持项目首页任务卡、Skills 编排、定时运行、运行态展示和停止任务。
- `Transcript` / Chat runtime：已经能展示 activity、tool、thinking、file diff、permission request 和 AskUserQuestion。

所以真正的缺口不是 agent loop，而是三张图所表达的产品层：

```text
目标系统
-> 项目知识
-> 角色 / Skills
-> 任务拆解
-> 执行
-> 验证
-> 反馈
-> 记忆沉淀
-> 用户可见的过程控制台
```

## 三张图的产品映射

| 三张图 | 当前应落地的产品能力 |
| --- | --- |
| `AGI.png` | 项目级控制台：目标、任务、角色、进度、Bug、用户中途干预 |
| `Model.png` | Claude SDK 外围的记忆、Guardrails、验证、回写层 |
| `Character.png` | 角色执行协议：Plan -> Retrieve -> Act -> Verify -> Reflect -> Persist |

这三张图最重要的价值，是把 agent 从“聊天模型”提升为“可审计的智能工作系统”。

## 最值得借鉴的方向

### 1. Project Knowledge Compiler

这是最贴合当前项目的方向。

`prd/AGI/project-document-compiler.md` 的核心观点是：项目文档不是大 Prompt，而是 AgentOS 的源码。文档应该被编译成：

```text
Project Memory
Skills
Subagents
Guardrails
Workflows
Task Graph
Open Questions
```

建议把它作为 Agent Mode 的升级版：

- 基于项目文档生成 `MEMORY.md` / `SOUL.md` / `GOAL.md` 草案。
- 基于流程和规范生成 `.agents/skills/*/SKILL.md`。
- 基于模块边界和职责生成 `.agents/agents/*.md`。
- 基于规则和风险生成 `GUARDRAILS.md` 或 Agent Mode 标记块。
- 所有生成结果必须先让用户审阅、编辑、启用或丢弃。

不要把所有文档无差别注入每次请求。应该先生成短而稳定的 Project Memory，再按任务需要加载相关 Skills、Agents 和引用文档。

### Token / Prompt Cache 策略

Token cache 也值得借鉴，但它不应该被理解成“在本地保存模型 KV cache”。

Hermes 的核心经验是：

```text
让上游 provider 更容易命中 prompt cache
= 稳定可复用前缀
+ 临时上下文不污染 system prompt
+ 同一 session 尽量复用同一份 system prompt snapshot
+ provider 支持时再使用 cache_control / prompt_cache_key
```

对当前项目来说，优先级应该是：

1. **先做 prompt 分层和稳定前缀。**
2. **暂不绕过 Claude Agent SDK 做 provider-specific cache marker。**
3. **等 SDK 或 Claude Code 暴露更明确的 cached token usage / cache control 能力后，再做可观测和开关。**

当前 `ClaudeAgentRunner` 每次运行都会通过 `buildRuntimeContext()` 重新拼装 `appendSystemPrompt`，再传给 Claude Agent SDK 的 `systemPrompt.append`。这条路径很方便，但随着 Project Knowledge、Memory、Skills、Heartbeat、TaskFlow 增多，如果每轮都把变化内容塞进 system prompt，就会破坏可复用前缀。

建议把上下文分成两类。

稳定前缀，适合进入 session 的 system prompt：

- 固定宿主规则。
- Claude Agent SDK / AgentOS 能力说明。
- 项目级短 Project Memory snapshot。
- 已启用 Skills / Agents 的紧凑索引。
- 长期 Guardrails 摘要。
- USER / IDENTITY 这类低频变化信息。

临时上下文，应该进入当前 user turn，而不是改 system prompt：

- slash command / Skill 的完整正文。
- 本轮检索到的相关文档片段。
- session search / old thread recall。
- Memory provider recall。
- Task Registry / TaskFlow 当前运行态。
- Heartbeat 当轮观察结果。
- handoffContext。
- 今日记忆中新写入、但不该立刻改变当前 session 前缀的内容。

推荐后续新增一个 `PromptAssembly` 层，不急着改底层模型调用，只先规范输入位置：

```ts
interface PromptAssemblyResult {
  systemPromptSnapshot: string
  userTurnPrefix?: string
  userPrompt: string
  configSignature: string
  promptSignature: string
}
```

关键规则：

- 新 thread / 新 SDK session 创建时生成 `systemPromptSnapshot`。
- 同一 thread resume 时优先复用旧 snapshot，而不是重新读取所有 Memory 和 Project Knowledge。
- Memory 或 Project Knowledge 更新后，默认下一个新 session 生效；当前 session 如需知道变化，用一次性 user-turn note 注入。
- Skills、Agents、instruction files 列表必须排序稳定，避免同样内容因为读取顺序不同造成 prefix 变化。
- 不要在 system prompt 里放会频繁变化的任务状态、时间戳、运行日志和检索结果。
- provider、模型、工具集、权限模式、核心 instruction 文件变化时，才更新 `configSignature` / `promptSignature` 并重建 session。

可以借鉴 Hermes 的观测方式，但不要一开始就实现完整 provider layer：

- 如果 SDK result 未来暴露 `cached_tokens` / `cache_read_input_tokens`，在 activity 或调试面板展示。
- 当前阶段先记录 `promptSignature`、`systemPromptSnapshot` 长度和 config signature，帮助判断为什么 session 被重建。
- Provider-specific `cache_control`、`prompt_cache_key`、会话绑定 header 暂时交给 Claude Agent SDK / Claude Code；只有当 SDK 提供稳定扩展点时再接。

这件事的产品意义很实际：Project Knowledge Compiler 会让项目上下文越来越丰富，如果没有 prompt cache 纪律，后面每一轮都会更贵、更慢，也更容易因为 system prompt 变化导致 session 行为不稳定。

### 2. 显式角色，而不是重造 Subagent Runtime

Hermes 的 subagent 思路值得参考，但不需要复制它的 `delegate_task` runtime。

当前 `electron/agent-context.ts` 已经能把项目内 agent markdown 转成 Claude SDK `AgentDefinition`。下一步应该做的是定义可编辑的 Expert Definition 模板：

```text
name
purpose
required_context
skills
allowed_tools
output_contract
verification
guardrails
failure_modes
```

这样 `Character.png` 里的“角色内部”就可以落成项目资产，而不是临时 prompt。

角色不要追求数量多。关键是每个角色都有明确输入范围和输出合同。

推荐的默认角色：

- Orchestrator：理解目标、拆任务、选择 Skills 和 Subagents。
- Product Agent：理解 PRD、用户场景和验收标准。
- Research Agent：查找相关文档、事实和背景。
- Frontend Agent：处理页面、组件、交互和设计规范。
- QA Agent：生成测试计划、边界场景和回归检查。
- Docs Agent：同步 PRD、架构文档和变更说明。
- Review Agent：发现风险、遗漏、规范冲突和质量问题。

### 3. Task Registry

OpenClaw 最值得借鉴的是 durable task registry。

当前 `Task Home Plugin` 已经能创建任务卡、写 `task.json` / `runtime.json`，并用 Electron timer 触发运行。这个设计适合 UI 和项目内配置，但不应该让 `runtime.json` 成为唯一事实来源。

建议新增独立任务账本：

```ts
type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'lost'

interface AgentTaskRunRecord {
  taskId: string
  runId: string
  projectId: string
  projectPath: string
  source: 'home-plugin-task' | 'skill-run' | 'manual' | 'heartbeat'
  slug?: string
  threadId?: string
  sessionId?: string
  requestId?: string
  status: AgentTaskStatus
  title: string
  summary?: string
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  lastEventAt?: number
  cleanupAfter?: number
  notifyPolicy: 'silent' | 'done_only' | 'state_changes'
}
```

它能带来几个直接收益：

- 应用重启后可以区分运行中任务是真的还活着，还是已经丢失。
- 任务卡可以展示最近运行历史和失败原因。
- 线程、任务卡、首页通知能通过同一个 `taskId/runId` 串起来。
- 以后接 CLI、外部触发、托盘通知时不需要重写运行状态模型。

### 4. TaskFlow

Task Registry 记录每次具体运行，TaskFlow 承载宽泛目标。

如果用户目标是“持续推进一个项目”“每天帮我更新报告”“研究并逐步完善方案”，单次任务记录不够，需要保存：

- 当前目标是什么。
- 当前做到哪一步。
- 是否在等待子任务、等待时间或等待用户。
- 哪些子任务属于这个目标。
- 是否有取消意图。
- 多个事件同时更新时谁是新状态。

建议数据结构：

```ts
type AgentTaskFlowStatus =
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

interface AgentTaskFlowRecord {
  flowId: string
  projectId: string
  ownerThreadId?: string
  title: string
  goal: string
  status: AgentTaskFlowStatus
  currentStep?: string
  stateJson: string
  waitJson?: string
  childTaskIds: string[]
  revision: number
  cancelRequestedAt?: number
  createdAt: number
  updatedAt: number
}
```

TaskFlow 适合放在第二阶段。先做 Task Registry，再做 Flow。

### 5. 验证任务作为一等公民

这是三张图里最有价值的点之一，尤其是 `Character.png`。

建议在任务流里显式增加 Verification Step 或 Quality Guardian：

```text
Execution Result
-> Verification Task
-> Failure Classification
-> Repair Plan
-> Re-run or Mark Done
```

验证不应该只是模型最后说“我检查过了”。它应该有可见结构：

- 验证目标。
- 执行了哪些检查。
- 哪些检查通过。
- 哪些检查失败。
- 失败原因分类。
- 是否需要修复任务。
- 是否需要用户确认。

当前项目已经有文件 diff、checkpoint、permission request 和 task events，很适合接入这个层。

### 6. 对话面板升级为 Agent Workflow Cockpit

`AGI.png` 里的对话面板不是普通聊天窗口，而是工作流控制台。

当前 Transcript 已经能展示 activity、tool、thinking、file diff，但还缺任务图和角色视角。

建议后续在项目首页或 Docs/Agent 面板展示：

- 当前目标。
- Task Records。
- Flow 状态。
- 使用的 Skills。
- 使用的 Subagents / Roles。
- 验证结果。
- Bug / Blocker。
- 用户待决策项。
- 候选记忆。

这样用户不是在等模型吐答案，而是在监督一个智能工作流。

## 跨 Session 记忆设计

跨 Session 记忆不要做成“把所有历史都总结进一个大 prompt”。

更稳的方式是拆成三层：

```text
稳定记忆层
+ 历史会话检索层
+ 当前回合临时召回层
```

### 1. 稳定记忆层

稳定记忆只保存少量、可审阅、长期有效的信息。

适合保存：

- 用户长期偏好。
- 项目稳定事实。
- 架构约束。
- 设计原则。
- 测试要求。
- 已确认的历史决策。
- 可复用工作流。
- 从失败中沉淀出的经验。

不适合保存：

- 一次性任务进度。
- 已完成某个临时任务的流水账。
- 短期 PR 号、commit hash、临时路径。
- 未确认的推测。
- 模型自我感觉良好的总结。
- 带强指令注入风险的句子。

建议引入结构化 `MemoryEntry`：

```ts
type MemoryKind =
  | 'user_profile'
  | 'project_fact'
  | 'project_rule'
  | 'decision'
  | 'workflow'
  | 'lesson'

type MemoryStatus = 'candidate' | 'approved' | 'archived'

interface MemoryEntry {
  id: string
  projectId: string
  kind: MemoryKind
  content: string
  sourceThreadId?: string
  sourceItemId?: string
  confidence?: number
  status: MemoryStatus
  createdAt: number
  updatedAt: number
}
```

运行规则：

- 默认只把 `approved` 且短小稳定的记忆注入新 session。
- 任务结束后，agent 可以提出 `candidate` 记忆。
- 用户确认、编辑或拒绝后，再写入长期记忆。
- `MEMORY.md` 可以继续作为人类可读镜像，但不要只依赖 Markdown 做机器状态。
- 当前 session 中新写入的记忆默认下个 session 生效；如当前回合确实需要，用一次性 user-turn note 注入。

### 2. 历史会话检索层

旧聊天记录不应该都进入长期记忆。它们更适合做可搜索证据库。

典型问题：

- “上次我们怎么定的模型设置？”
- “之前那个任务失败原因是什么？”
- “我上周让你改过的 PRD 在哪里？”
- “那次 UI 调整用了哪些文件？”

这些问题应该通过 session search 找原始消息片段，而不是让模型凭长期记忆猜。

建议在现有 workspace thread / transcript 持久化基础上增加：

```ts
interface SessionSearchHit {
  threadId: string
  itemId: string
  role: 'user' | 'assistant' | 'tool' | 'activity'
  title: string
  snippet: string
  createdAt: number
  score: number
}
```

搜索结果应支持：

- 按关键词找旧 thread / message。
- 展开命中消息上下文窗口。
- 一键把选中片段作为当前请求引用。
- 在回答中显示“使用了哪段旧会话”。

这层解决的是“可追溯回忆”，不是“永久人格”。

### 3. 当前回合临时召回层

本轮需要旧上下文时，把检索结果作为当前 user turn 的临时上下文注入。

不要把它写进 system prompt，也不要默认写入长期记忆。

推荐流程：

```text
用户发起请求
-> 读取当前 thread
-> 注入稳定 Memory snapshot
-> 判断是否需要旧会话检索
-> 检索片段作为临时上下文进入本轮 user prompt
-> Claude Agent SDK 执行
-> 完成后生成 Memory candidates
-> 用户确认后写入长期记忆
```

这样有三个好处：

- system prompt 前缀稳定，有利于 prompt cache。
- 长期记忆不被临时运行信息污染。
- 回答可以追溯到旧会话证据。

### 4. 最小实现路线

第一阶段先做：

- `MemoryEntry` 类型和 store。
- Memory candidates inbox。
- 用户 approve / edit / reject。
- 新 session 注入 approved memory snapshot。
- 当前 session 新增记忆默认下轮生效。

第二阶段再做：

- session / message 索引。
- session search API。
- 搜索结果引用插入当前 prompt。
- 回答中展示 recalled source。

第三阶段再考虑：

- 后台 Memory Curator。
- 外部 MemoryProvider。
- 自动候选记忆生成节奏。
- 跨项目或团队共享记忆。

## 任务拆分与长时间运行设计

长时间运行不要依赖一个 Claude SDK call 一直跑。

正确模型是：

```text
单次 Agent Run
-> Task Registry 记录每次运行
-> TaskFlow 承载宽泛目标
-> Scheduler / Heartbeat 负责再次唤醒
-> Delivery / UI 把结果推回用户
```

### 1. 当前回合内任务拆分

当前回合内的拆分可以继续依赖 Claude Agent SDK 的 agent loop、工具调用和 Task / Todo 事件。

当前项目已经能接收和展示：

- `task_create`
- `task_update`
- `task_list`
- `agent_activity`
- `tool_start`
- `tool_done`
- `ask_user_question`
- `permission_request`

这一层适合：

- 本轮对话可以完成的多步骤任务。
- 短期代码修改。
- 一次性调研。
- 小范围文档更新。
- 简单 Skills 编排。

UI 上应把这些事件整理为“执行计划 / 当前步骤 / 完成状态”，而不只是散落在聊天流里。

### 2. Task Registry：每次后台运行都有账本

凡是离开当前普通聊天、进入任务卡、定时运行、后台运行或 skill-run 的任务，都应该有 run record。

建议最小数据结构：

```ts
type AgentTaskRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost'

interface AgentTaskRunRecord {
  taskId: string
  runId: string
  projectId: string
  threadId?: string
  requestId?: string
  status: AgentTaskRunStatus
  title: string
  currentStep?: string
  summary?: string
  error?: string
  startedAt?: number
  completedAt?: number
  lastEventAt?: number
}
```

职责边界：

- `TaskHomePluginManager` 继续负责任务卡、任务配置和 schedule。
- `ClaudeAgentRunner` 继续负责实际 Claude SDK run。
- `Task Registry` 记录每次 run 的生命周期。
- UI 从 registry 读取最近运行历史和失败原因。

运行规则：

- 每次任务启动先创建 `queued` record。
- SDK `session_start` 后变成 `running`。
- `ask_user_question` / permission 等需要人介入时变成 `waiting`。
- `result` 后变成 `succeeded`。
- `error` 后变成 `failed`。
- 用户取消后变成 `cancelled`。
- 应用重启后发现未终结记录，标记为 `lost` 或 `cancelled`，并保留历史。

这层能让任务“可审计、可恢复、可展示”，而不是只靠当前内存状态。

### 3. TaskFlow：宽泛目标的运行态

Task Registry 解决单次 run，TaskFlow 解决跨多次 run 的目标。

适合 TaskFlow 的任务：

- “持续研究并更新一个报告。”
- “分阶段实现一个大功能。”
- “先调研，等我确认后再实现。”
- “每天检查项目状态，有变化再汇报。”
- “一个任务拆成多个子任务，最后合并结果。”

建议数据结构：

```ts
type AgentTaskFlowStatus =
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

interface AgentTaskFlowRecord {
  flowId: string
  projectId: string
  ownerThreadId?: string
  goal: string
  status: AgentTaskFlowStatus
  currentStep?: string
  childTaskIds: string[]
  stateJson: string
  revision: number
}
```

关键规则：

- Flow 保存目标、当前步骤、等待状态和子任务关系。
- Run 保存每次具体 Claude SDK 执行。
- Flow 更新必须带 `revision`，避免多个子任务同时完成时覆盖彼此。
- Flow 可以等待用户、等待时间、等待子任务完成。
- Flow 取消时，要级联取消未完成子 run。

### 4. 子任务完成后 push，不让 Orchestrator 轮询

长任务系统不要让父 agent 一直问“子任务完成了吗”。

更好的方式是：

```text
Orchestrator 创建子任务
-> Runtime 创建 AgentTaskRunRecord
-> 子任务运行
-> 子任务完成后 Task Registry 记录 terminal result
-> Flow runner 收到 terminal event
-> 推进父 Flow
-> UI / Thread 收到更新
```

这样节省 token，也更可靠。

### 5. Heartbeat：项目常驻检查

Heartbeat 不是 cron 的替代品。

- Cron：明确时间触发明确任务。
- Heartbeat：周期性醒来检查是否有值得推进的事项。

Agent Mode 可以新增 `HEARTBEAT.md`：

```md
# HEARTBEAT.md

## 关注事项

- 检查等待中的 TaskFlow 是否能继续。
- 检查 TODO.md 是否有阻塞项可以推进。
- 检查最近失败任务是否需要整理原因。
- 检查是否有记忆候选需要用户确认。
```

Heartbeat 规则：

- 没有实质变化时不打扰用户。
- 可以创建 task record，方便审计。
- 有 due flow / blocked task / failed run 时才真正启动 agent run。
- 项目忙、已有任务运行、用户正在交互时可以延后。

### 6. 推荐落地顺序

```text
Phase 1: MemoryEntry + 记忆候选确认
Phase 2: Session Search + 临时召回注入
Phase 3: Task Registry 接管任务运行历史
Phase 4: TaskFlow 支撑宽泛目标
Phase 5: Heartbeat 定期检查可推进事项
```

一句话：

```text
跨 Session 记忆 = 稳定记忆 + 历史检索 + 临时召回
长任务运行 = 单次 Agent Run + Task Registry + TaskFlow + Heartbeat
```

## 不建议照搬的部分

### 1. 不搬 Hermes 的完整 `AIAgent`

Claude Agent SDK 已经是当前项目的 agent loop。Hermes 的同步工具循环、skills index、memory manager、delegate_task、kanban 等可以拆开学习，但不应该替代 `ClaudeAgentRunner`。

### 2. 不搬 OpenClaw 的多 channel / gateway / harness 体系

当前项目定位是桌面项目工作台，不需要优先做 Telegram、webhook、ACP gateway、channel delivery 等完整控制面。

可以学习 OpenClaw 的 task registry、TaskFlow、Heartbeat、completion push，但不要一开始复制它的多入口运行时。

### 3. 不先搬 Hermes 的大规模 Skill Hub

Hermes 的 100+ skills 证明了技能体系的可行性，但当前项目更需要“从项目文档生成项目专属 Skills”，不是先维护一个庞大的通用 skill catalog。

### 4. 不优先做复杂 Provider / Prompt Cache 体系

Prompt cache、provider fallback、external memory provider 都有价值，但当前优先级低于任务、记忆、角色和验证。

这里说的是不优先做复杂 provider 适配层，不是忽略 cache。稳定 system prompt、system prompt snapshot、临时上下文注入 user turn，这些属于 P0 工程纪律。

只需要先保证：

- system prompt 尽量稳定。
- 临时 recall 放进当前 user turn。
- 长期记忆短而稳定。
- session resume 使用旧 session 上下文。

底层 provider 细节尽量交给 Claude Agent SDK 和现有模型配置。

## 推荐落地路线

### P0：Project Knowledge Compiler MVP

目标：把项目文档编译成用户可审阅的 AgentOS 草案。

产物：

- Project Knowledge Map。
- Project Memory 草案。
- Guardrails 草案。
- Candidate Skills。
- Candidate Agents。
- Open Questions。

验收：

- 用户可以查看、编辑、启用或丢弃生成结果。
- 生成的 Skills 和 Agents 能被现有 `agent-context` 扫描。
- 普通聊天和任务运行能读取生成后的上下文。

### P1：Task Registry

目标：把任务卡运行从 `runtime.json` 快照升级为可审计 run ledger。

产物：

- `AgentTaskRunRecord` 类型。
- task registry store。
- task run history IPC。
- 任务卡最近运行历史。
- 重启后将不确定运行标记为 `lost` 或 `cancelled`。

验收：

- 每次任务卡运行都有 `taskId` 和 `runId`。
- 任务失败原因可追溯。
- 同一任务卡不能重复启动同一轮运行。
- task thread、任务卡、运行记录能互相跳转。

### P1：Expert Definition + Quality Guardian

目标：让角色和验证成为标准协议。

产物：

- `.agents/agents/*.md` 模板。
- role metadata schema。
- verification result event。
- Review / QA 默认角色模板。

验收：

- 角色有职责、上下文、工具、输出合同和失败模式。
- 任务完成后能生成结构化验证结果。
- 验证失败可以生成修复任务或阻塞状态。

### P2：TaskFlow + Heartbeat

目标：支撑长期目标、等待、恢复和项目常驻检查。

产物：

- `AgentTaskFlowRecord`。
- Flow 创建、暂停、恢复、取消。
- `HEARTBEAT.md`。
- Agent Mode Heartbeat 设置。
- flow / heartbeat 对应 task record。

验收：

- 宽泛目标可以跨多次 agent run 推进。
- 子任务完成后由 runtime 推进父 flow，而不是让父 agent 轮询。
- Heartbeat 没有实质变化时不打扰用户，只更新内部状态。

## 与现有文件的关系

直接相关：

- `electron/claude-agent-runner.ts`
- `electron/agent-context.ts`
- `electron/task-home-plugin-manager.ts`
- `src/claude-chat-types.ts`
- `src/components/chat/Transcript.tsx`
- `src/components/chat/ProjectHomeSurface.tsx`
- `prd/agent-mode.md`
- `prd/chat-agent-runtime.md`
- `prd/task-home-plugin.md`
- `prd/workspace-session.md`

参考文档：

- `prd/AGI/advise.md`
- `prd/AGI/project-document-compiler.md`
- `prd/AGI/openclaw/openclaw-runtime-comparison.md`
- `prd/AGI/hermes/analysis/openclaw-hermes-agent-init-prd-architecture-comparison.md`
- `prd/AGI/hermes/analysis/openclaw-hermes-agent-kernel-comparison.md`
- `prd/AGI/hermes/analysis/hermes-task-planning-and-decomposition.md`
- `prd/openclaw-long-running-agent-runtime.md`

## 最短总结

OpenClaw 和 Hermes 都值得参考，但参考方式不同：

```text
Hermes 给我们看强 agent loop、skills、memory、subagent 和 kanban 的实现经验。
OpenClaw 给我们看长期任务、runtime、task registry、TaskFlow 和 completion push 的系统边界。
三张图给我们定义产品目标：目标、记忆、角色、验证、反馈、控制台。
```

当前项目的最佳路线是：

```text
Claude Agent SDK 做核心执行引擎
Project Knowledge Compiler 做项目智能体系统生成
Task Registry / TaskFlow 做长期运行状态
Expert Definition / Quality Guardian 做角色和验证协议
Workflow Cockpit 做用户可见的过程控制台
```

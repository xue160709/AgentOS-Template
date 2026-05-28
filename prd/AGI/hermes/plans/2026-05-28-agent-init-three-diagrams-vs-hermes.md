# agent-init 三张图与 Hermes 架构对比参考

本文对比 `/Volumes/macOS/Github/agent-init/prd` 中三张图与 Hermes Agent 的真实工程实现，重点回答：

- agent-init 的三张图在表达什么。
- Hermes 中哪些模块已经实现了类似能力。
- 两者的相同点和差异。
- agent-init 有哪些地方值得 Hermes 参考。
- Hermes 有哪些地方值得 agent-init 参考。

## 结论

agent-init 的三张图更像一套 **AgentOS / AGI 工作系统蓝图**，强调目标、任务、记忆、角色、反馈、Guardrails 和多角色协作。

Hermes 更像这套蓝图的 **工程化运行时实现**，已经落地了模型-工具循环、长任务执行、后台进程、cron、goal loop、kanban、多工具系统和运行时 Guardrails。

一句话：

> agent-init 是 Hermes 可以吸收的上层知识编译与角色治理系统；Hermes 是 agent-init 应该学习的真实 agent 运行时和长任务执行内核。

## 三张图分别表达什么

### AGI.png：管理角色与执行角色

`AGI.png` 描述的是一个宏观 AgentOS：

```text
用户输入目标
-> 管理角色拆分任务、测试任务和执行角色数量
-> 执行角色处理任务
-> 对话面板展示流程、进度、结果、Bug
-> 用户审视过程并中途修改
-> 输出结果
```

它的重点不是“模型怎么推理”，而是一个多角色智能工作系统如何组织目标、任务、执行者和人类监督。

### Model.png：记忆、规划、执行与 Guardrails

`Model.png` 描述的是模型内部的认知结构：

```text
任务/目标数据 + 短期记忆 + 长期记忆
-> 预测/规划能力
-> LLM Prompt 元认知：自我评估、反思调整
-> 执行
-> 输出结果
-> 结果回写记忆
```

底部的 Guardrails 贯穿预测、prompt 反思和执行阶段，表示系统行为需要被安全边界和伦理/规范约束。

### Character.png：角色内部任务闭环

`Character.png` 最接近今天的 agent loop。它把一个角色内部拆成：

- 任务模型。
- 任务优先级模型。
- 执行模型。
- 测试任务。
- 短时记忆。
- 长期记忆。
- 外部信息。
- 输出结果。
- 失败后回写任务和 Bug。

这张图的本质是：

```text
Plan -> Retrieve -> Act -> Verify -> Reflect -> Persist
```

## 总览映射表

| agent-init 三图概念 | Hermes 对应实现 | 当前差异 |
| --- | --- | --- |
| 用户输入目标 | `AIAgent.run_conversation()` | Hermes 已经是成熟工具循环，不只是目标输入 |
| 管理角色 | 主 agent、`delegate_task`、kanban dispatcher / orchestrator | Hermes 有调度能力，但“管理角色”不是显式产品对象 |
| 执行角色 | `delegate_task` 子 agent、kanban worker | Hermes 工程更完整，支持独立预算和隔离上下文 |
| 对话面板 | CLI / TUI / gateway / dashboard activity | Hermes 有过程展示，但未完全显式展示角色关系和任务图 |
| 短时记忆 | conversation history、todo、tool results、process output | 已落地 |
| 长时记忆 | memory tool、memory providers、session search、skills | 已落地，但文档世界模型不如 agent-init 清晰 |
| 任务模型 | `todo`、kanban task、cron job、goal | 有多个任务系统，但概念分散 |
| 任务优先级模型 | todo 顺序、kanban dependencies、模型判断 | 没有独立 priority model |
| 执行模型 | tool registry + tool executor | Hermes 很强 |
| 测试任务 | prompt discipline、运行测试、kanban review/block | 有实践，但还不是一等公民 |
| Guardrails | approval、tool guardrails、file safety、cron injection scanner | Hermes 工程实现强于 agent-init |
| 外部信息 | web、browser、MCP、files、terminal | 已成熟 |
| 反馈修正 | tool error recovery、goal continuation、kanban block/retry、memory sync | 已成熟，但知识提升流程不如 agent-init 清晰 |

## Hermes 对应源码阅读路线

### 1. 主 Agent 循环

建议看：

- `run_agent.py`
  - `AIAgent` 的整体状态和初始化参数。
- `agent/conversation_loop.py`
  - `run_conversation()`。
  - 核心模型-工具循环。
- `agent/iteration_budget.py`
  - iteration budget。
  - 防止长任务无限运行。

对应 agent-init：

- `Model.png` 里的任务/目标输入、执行、输出和回写。
- `Character.png` 里的任务模型、执行模型和结果反馈。

### 2. 工具系统与执行模型

建议看：

- `model_tools.py`
  - 工具注册、发现、分发。
- `toolsets.py`
  - 默认工具集。
- `agent/tool_executor.py`
  - 工具执行、并行执行、中断、结果写回。

对应 agent-init：

- `Model.png` 里的“执行”。
- `Character.png` 里的“执行模型”。

Hermes 的工具系统比 agent-init 图里的执行层更具体，已经处理了现实问题：工具 schema、异常、并行、安全、结果预算和 interrupt。

### 3. 任务模型与短期记忆

建议看：

- `tools/todo_tool.py`
  - agent 的任务列表。
  - `pending`、`in_progress`、`completed`、`cancelled`。
- `agent/conversation_compression.py`
  - 上下文压缩后重新注入 active todo。

对应 agent-init：

- `Character.png` 里的任务模型、短时记忆、任务结果保存。

差异：

- Hermes 有可运行的 todo。
- agent-init 的图里有更明确的任务优先级模型和测试任务模型。
- Hermes 可以进一步把 todo、goal、kanban、cron 整合成统一 Task Graph。

### 4. 长期记忆与 Skills

建议看：

- `tools/memory_tool.py`
- `agent/memory_manager.py`
- `agent/background_review.py`
- `agent/curator.py`
- `tools/skills_tool.py`
- `agent/prompt_builder.py`

对应 agent-init：

- `Model.png` 里的长期记忆。
- `Character.png` 里的长期记忆插件。
- `advise.md` 里的“文档是世界模型，Skills 是插件化长期记忆 + 操作规程”。

差异：

- Hermes 的 memory provider 和 skills 体系更成熟。
- agent-init 的 Project Knowledge 分层更清晰：
  - `Project Knowledge/INDEX.md`
  - `Project Knowledge/KNOWLEDGE.md`
  - `Project Knowledge/GUARDRAILS.md`
  - `Project Knowledge/expert-definitions/`

Hermes 可以参考 agent-init，把项目文档从“可读取上下文”升级成“可编译的世界模型”。

### 5. 子 Agent 与多角色协作

建议看：

- `tools/delegate_tool.py`
  - 短周期子 agent。
  - 子 agent 独立 iteration budget。
- `tools/kanban_tools.py`
  - worker 的 complete、block、heartbeat、create。
- `hermes_cli/kanban_db.py`
  - 任务 claim、reclaim、spawn、heartbeat。
- `agent/prompt_builder.py`
  - Kanban worker protocol。

对应 agent-init：

- `AGI.png` 里的管理角色和执行角色。
- `Character.png` 里的多个角色内部执行闭环。

差异：

- Hermes 已经具备真实可运行的多 agent 协作机制。
- agent-init 对角色职责、专家定义、输入输出合同和失败模式的描述更清楚。

Hermes 可以参考 agent-init，把 subagent 从“运行时能力”进一步产品化为：

```text
Character / Role
-> Expert Definition
-> Required Context
-> Skills
-> Output Contract
-> Guardrails
-> Failure Modes
```

### 6. 宽泛目标与持续推进

建议看：

- `hermes_cli/goals.py`
  - `/goal`。
  - judge 判断目标是否完成。
  - 未完成时生成 continuation prompt。
- `cli.py`
  - `_handle_goal_command()`。
  - `_maybe_continue_goal_after_turn()`。
- `gateway/run.py`
  - gateway 场景下的 goal continuation。

对应 agent-init：

- `AGI.png` 里的用户目标输入和过程监督。
- `Character.png` 里的任务未完成时生成新任务。

差异：

- Hermes 已经有可持续运行的 goal loop。
- agent-init 更强调目标先被文档化、结构化、拆成任务图。

融合方向：

```text
用户目标
-> GOAL.md / Task Graph
-> Hermes /goal loop 执行
-> judge + Quality Guardian 验证
-> 回写 Project Knowledge / Memory / Learnings
```

### 7. 后台进程与长期运行

建议看：

- `tools/terminal_tool.py`
  - `background=true`
  - `notify_on_complete`
  - `watch_patterns`
- `tools/process_registry.py`
  - `poll`
  - `log`
  - `wait`
  - `kill`
  - `write`
  - `submit`
- `cron/scheduler.py`
  - cron agent。
  - inactivity timeout。
- `tools/cronjob_tools.py`
  - cron job 管理工具。

对应 agent-init：

- `Character.png` 里的执行模型和测试任务。
- `AGI.png` 里的执行角色长期工作。

Hermes 这里明显更工程化。agent-init 图里有“执行”，但 Hermes 已经处理了真实世界的长进程问题：

- 长命令不能阻塞 agent。
- 需要追踪 stdout / stderr。
- 需要恢复或取消。
- 需要完成通知。
- 需要防止后台任务丢失。

## agent-init 值得 Hermes 参考的地方

### 1. Project Knowledge first

Hermes 有 context files、memory、skills、session search，但缺少 agent-init 这种明确的项目知识编译层。

agent-init 的结构值得参考：

```text
Project Knowledge/
  INDEX.md
  KNOWLEDGE.md
  GUARDRAILS.md
  expert-definitions/
```

价值：

- 知道哪些文档是权威来源。
- 区分长期知识、短期任务、规则边界和专家上下文。
- 避免把所有文档无差别塞给 agent。

### 2. Expert Definitions

Hermes 的 subagent 很强，但子 agent 的专家上下文可以更明确。

agent-init 的 expert definition 结构值得借鉴：

- 专家定位。
- 必读上下文。
- 专家判断模型。
- 输出合同。
- Guardrails。
- Skill / Subagent 关系。
- 失败模式。

这能让子 agent 不只是“另一个模型调用”，而是有稳定职责和判断边界的专业角色。

### 3. Guided Decisions

Hermes 遇到不确定点时，常见路径是直接问用户或用 clarify。

agent-init 的 Guided Decision 更适合复杂项目：

```text
问题
证据
系统推荐
默认处理
影响
是否阻塞
用户可选项
```

这比裸问题更可操作，也更适合异步长任务。

### 4. Learning lifecycle

Hermes 有 memory 和 background review，但 agent-init 的分层更明确：

- `logs/`：错误事实和复现线索。
- `.learnings/`：可复用改进信号。
- `memory/YYYY-MM-DD.md`：每日稳定进展。
- `MEMORY.md`：长期稳定摘要。
- `.learnings/archive/`：已提升或已解决记录。

Hermes 可以借这个降低长期记忆污染。

### 5. 测试任务作为一等公民

agent-init 的 `Character.png` 明确把“测试任务”放入角色内部循环。

Hermes 已经会运行测试，但测试更多是工具使用习惯，不是独立模型对象。

可以考虑把验证显式化为：

```text
Execution Result
-> Verification Task
-> Failure Classification
-> Repair Plan
-> Re-run
```

## Hermes 值得 agent-init 参考的地方

### 1. 真实模型-工具循环

agent-init 是蓝图，Hermes 已经有完整 agent loop。

agent-init 如果要落地，必须学习 Hermes 的：

- 消息格式。
- 工具调用。
- 工具结果回写。
- 重试。
- 上下文压缩。
- 预算耗尽总结。
- 中断恢复。

### 2. Iteration budget、interrupt、steer、queue

Hermes 的长任务不是无限跑，而是受运行时控制：

- iteration budget。
- interrupt。
- steer。
- queue。
- grace summary。

这些机制是 agent-init 从概念走向真实产品必须补的运行时边界。

### 3. 后台进程管理

Hermes 的 `terminal(background=true)` + `process` 是长任务基础设施。

agent-init 的执行模型需要参考：

- 如何创建后台进程。
- 如何读取日志。
- 如何等待完成。
- 如何 kill。
- 如何写 stdin。
- 如何把进程完成通知回 agent。

### 4. cron / goal / kanban 三层长任务机制

Hermes 把长任务拆成三层：

| 层 | 作用 |
| --- | --- |
| `/goal` | 跨回合持续推进一个目标 |
| `cron` | 按时间定期唤醒 agent |
| `kanban` | 跨 agent、跨运行的持久任务协作 |

agent-init 的 Task Graph 可以直接参考这三层。

### 5. Guardrails 的运行时实现

agent-init 的 Guardrails 是知识结构，Hermes 的 Guardrails 是运行时能力。

Hermes 已有：

- approval。
- file safety。
- tool guardrails。
- cron injection scanner。
- 权限与工具集限制。

agent-init 如果只保留 Markdown 规则，会停留在“提醒 agent 要守规矩”。要真正可靠，就需要像 Hermes 一样把部分规则做成运行时拦截。

## 最好的融合方向

二者可以这样融合：

```text
agent-init 提供：
Project Knowledge
Expert Definitions
Guided Decisions
Character / Skill 生成
Learning lifecycle

Hermes 提供：
Agent loop
Tool executor
Background process
Cron
Goal loop
Kanban
Runtime Guardrails

融合后：
项目文档先编译成 Project Knowledge
-> 生成 Characters / Skills / Guardrails / Task Graph
-> Hermes runtime 执行
-> 运行结果、失败、测试、用户纠正回写到 memory / learnings
-> 再改进 Project Knowledge 和 Skills
```

## 对 Hermes 的具体改进建议

### P0：增加 Project Knowledge 约定

先不做复杂 UI，只定义项目级文件协议：

```text
Project Knowledge/
  INDEX.md
  KNOWLEDGE.md
  GUARDRAILS.md
  expert-definitions/
```

让 Hermes 在读取项目上下文时知道：

- 哪些文档是权威。
- 哪些是知识库。
- 哪些是 Guardrails。
- 哪些是 subagent 专家上下文。

### P1：把 Subagent 角色显式化

在 `delegate_task` 或 kanban worker 之上增加角色规格：

```text
role:
  name
  purpose
  required_context
  tools
  output_contract
  verification
  failure_modes
```

这会让 Hermes 的子 agent 更接近 agent-init 的 Character。

### P1：引入 Guided Decision 输出格式

当任务需要用户决策时，不只问一句“你想怎么做”，而是生成：

```text
Decision:
Evidence:
Recommended default:
Alternatives:
Impact:
Blocking:
```

适合接入 `clarify`、kanban block 或 `/goal` 暂停。

### P2：统一 Task Graph

Hermes 现在有 todo、goal、cron、kanban。可以考虑抽象一层 Task Graph：

```text
Task Node:
  goal
  source
  status
  priority
  dependencies
  assigned_role
  required_skills
  acceptance_criteria
  verification
  history
```

这样更接近 `Character.png` 里的任务模型、优先级模型和测试任务闭环。

## 对 agent-init 的具体改进建议

### P0：补真实运行时

agent-init 不应只生成 Markdown。需要定义真实执行层接口：

```text
run_task()
run_skill()
spawn_subagent()
start_background_process()
poll_process()
interrupt()
resume()
verify()
persist_memory()
```

Hermes 是很好的参考。

### P1：补预算与中断

每个角色、每个任务、每个 flow 都需要：

- 最大轮数。
- 最大时间。
- 当前状态。
- interrupt。
- blocked。
- resume。
- summary on budget exhausted。

否则长任务很容易失控。

### P1：把 Guardrails 从文本变成 hook / runtime check

agent-init 已经有 hooks 雏形。下一步可以明确：

- 哪些 Guardrails 是提示词。
- 哪些 Guardrails 是静态检查。
- 哪些 Guardrails 是工具前拦截。
- 哪些 Guardrails 需要用户审批。

### P2：让 Task Graph 接上真实 worker

Task Graph 不只是任务列表，还要能被 worker claim、heartbeat、complete、block、reclaim。

这里可以直接学习 Hermes kanban。

## 最终判断

agent-init 三张图提出的问题非常准：

- 智能体需要目标系统。
- 需要短期和长期记忆。
- 需要任务模型。
- 需要执行和测试。
- 需要 Guardrails。
- 需要管理角色和执行角色。
- 需要反馈和修正。

Hermes 的价值在于它已经把这些问题中的大部分变成了真实可运行的工程模块。

二者最大的互补关系是：

```text
agent-init：让 Hermes 更懂项目、更懂角色、更懂知识治理。
Hermes：让 agent-init 真正跑起来、跑得久、可中断、可恢复、可验证。
```


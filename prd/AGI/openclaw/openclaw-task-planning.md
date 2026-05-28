# OpenClaw 任务规划与拆解机制说明

## 结论

OpenClaw 现在没有一个独立的、硬编码的“任务规划器”先把所有用户请求拆成固定 DAG 再执行。普通会话里的规划主要由三层组成：

1. **系统提示指导模型怎么规划和执行。**
   OpenClaw 自己构造 agent system prompt，告诉模型可用工具是 policy-filtered、长等待不要轮询、较大的任务优先考虑 `sessions_spawn`，并在需要等待子任务结果时用 `sessions_yield`。见 `src/agents/system-prompt.ts:1028`、`src/agents/system-prompt.ts:1040`、`src/agents/system-prompt.ts:1065`。

2. **可选的 `update_plan` 工具记录当前执行计划。**
   `update_plan` 是结构化“计划状态”工具，只保存短步骤和 `pending | in_progress | completed` 状态，并强制最多一个 `in_progress`。它用于跟踪非平凡多步骤工作，不负责自动执行步骤。见 `src/agents/tools/update-plan-tool.ts:9`、`src/agents/tools/update-plan-tool.ts:17`、`src/agents/tools/update-plan-tool.ts:69`。

3. **真正的任务拆分/并行执行由 session/subagent 工具完成。**
   当工具策略允许时，主 agent 可以调用 `sessions_spawn` 创建独立子会话，让子 agent 做研究、代码检查、长工具调用等工作；子任务完成后通过 push-based completion 回到请求者会话，而不是靠轮询。见 `docs/tools/subagents.md:63`、`docs/tools/subagents.md:70`、`docs/tools/subagents.md:126`。

所以，OpenClaw 的“规划”更像是 **LLM 按系统提示决定执行策略 + 工具层提供计划记录和可控拆分能力**，不是固定 planner engine。

## `update_plan` 如何启用

`update_plan` 不是所有情况下都固定出现。它会在以下情况进入工具面：

- `tools.experimental.planTool: true` 明确打开。
- 或者严格 agentic 执行契约生效时自动打开；文档写明默认是关闭，除非 OpenAI/OpenAI Codex GPT-5 family run 使用 `strict-agentic`。见 `docs/gateway/config-tools.md:404`、`docs/gateway/config-tools.md:415`。
- 代码里 `isUpdatePlanToolEnabledForOpenClawTools` 先看显式配置，再落到 `isStrictAgenticExecutionContractActive`。见 `src/agents/openclaw-tools.registration.ts:13`。

启用后，系统提示只把它定位为“非平凡多步骤工作”的进度跟踪工具；它不会替 agent 自动拆出子任务，也不会改变工具 policy。

## 是否用了 subagent

用了，但不是无条件自动用。

Subagent 的入口是 `sessions_spawn`。工具 schema 要求 `task`，可带 `taskName`、`agentId`、`model`、`thinking`、`thread`、`mode`、`sandbox`、`context` 等参数。见 `src/agents/tools/sessions-spawn-tool.ts:151`。

实际执行时，`spawnSubagentDirect` 会：

- 规范化 `taskName` / `agentId`，并拒绝非法 agent id。
- 按配置解析 timeout、`context`、session ownership。
- 检查最大嵌套深度和当前活跃 child 数量。
- 解析目标 agent、sandbox 约束、model/thinking override。
- 构造子会话 system prompt 和第一条可见的 `[Subagent Task]`。
- 通过 Gateway `agent` 方法在 `subagent` lane 启动子会话。
- 把 run 注册进 subagent registry，供完成通知、审计和清理使用。

证据点：`src/agents/subagent-spawn.ts:701`、`src/agents/subagent-spawn.ts:787`、`src/agents/subagent-spawn.ts:1048`、`src/agents/subagent-spawn.ts:1106`、`src/agents/subagent-spawn.ts:1171`、`src/agents/subagent-spawn.ts:1270`。

Subagent 默认是隔离的，只有显式 `context: "fork"` 或 thread-bound 场景才会分叉当前 transcript。文档把 `isolated` 定义为默认低 token 成本模式，把 `fork` 定义为需要当前对话上下文时才用。见 `docs/tools/subagents.md:118`。

Subagent 也有工具边界：leaf subagent 默认不能再用 `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history`；只有配置允许更深嵌套时，orchestrator subagent 才能继续拆分。见 `src/agents/agent-tools.policy.ts:42`、`src/agents/agent-tools.policy.ts:57`、`src/agents/agent-tools.policy.ts:68`。

## Subagent 如何影响规划

OpenClaw 对 subagent 的指导是 prompt-level 的：当 `agents.defaults.subagents.delegationMode` 为 `prefer` 时，系统提示会把主 agent 定位成 responsive coordinator，要求它把复杂工作交给 `sessions_spawn`，并在 spawn 前明确 child 的目标、输出、输入、写入范围、验证要求和是否阻塞最终答案。见 `src/agents/system-prompt.ts:93`、`src/agents/system-prompt.ts:96`、`src/agents/system-prompt.ts:98`。

子 agent 自己也会拿到专门的 subagent system prompt：它只负责第一条 `[Subagent Task]`，最终结果会自动回报给父 agent；如果允许再 spawn，它要协调并综合 child 结果。见 `src/agents/subagent-system-prompt.ts:41`、`src/agents/subagent-system-prompt.ts:71`。

这说明 OpenClaw 的拆解不是“平台自动分配所有任务”，而是“模型在提示和工具可见性约束下决定是否委派”。

## 是否用了 skills

用了，但 skills 不是 worker，也不是任务队列。Skills 是 **AgentSkills-compatible 的 `SKILL.md` 指令包**，作用是教 agent 在某类任务里怎么使用已有工具。文档明确说每个 skill 是含 `SKILL.md` 的目录，OpenClaw 会加载 bundled skills 和本地覆盖，并按环境、配置、bin 存在性过滤。见 `docs/tools/skills.md:11`。

OpenClaw 会给每个 run 构建或复用 skills snapshot。`agent-command.ts` 会根据 snapshot version 和 agent skill filter 判断是否刷新，然后调用 `buildWorkspaceSkillSnapshot`；最终 prompt 里只注入紧凑的 `<available_skills>` 列表。见 `src/agents/agent-command.ts:817`、`src/agents/agent-command.ts:842`、`src/agents/skills/workspace.ts:1198`。

系统提示对 skills 的使用也很克制：扫描 `<available_skills>`，如果某个 skill 明显适用，就用 `read` 精确读取对应 `SKILL.md` 并遵循；如果多个适用，选最具体的；如果没有明确匹配，就不读。一次最多 upfront 读一个 skill。见 `src/agents/system-prompt.ts:248`。

Skills 的优先级从高到低是 workspace、project `.agents/skills`、personal `.agents/skills`、managed/local、bundled、extra dirs。见 `docs/tools/skills.md:17`。插件也可以随包提供 skills，适合放工具专用操作指南；这些 skill 会在插件启用时加载。见 `docs/tools/skills.md:91`。

所以 skills 会影响“怎么做”以及“遇到某类任务时该读哪份操作流程”，但不会自己启动子任务；真正拆分执行还是要靠模型调用工具，比如 `sessions_spawn`、`exec`、`browser`、`cron`、插件工具等。

## Task Flow 和 background tasks 的位置

OpenClaw 还有任务/流程层，但它主要用于后台和持久化编排：

- Background Tasks 是 ledger，记录 ACP runs、subagent spawns、cron executions、CLI operations；不是 scheduler。见 `docs/automation/tasks.md:17`、`docs/automation/tasks.md:25`。
- Task Flow 位于 background tasks 之上，用于跨 Gateway 重启仍能追踪的多步骤/分支流程。它适合 A -> B -> C 这种 durable pipeline；单个后台任务仍用 plain task。见 `docs/automation/taskflow.md:10`、`docs/automation/taskflow.md:14`。

这和普通聊天里的 `update_plan` 不同：`update_plan` 是当前 run 的模型可见进度记录；Task Flow 是可持久化的后台流程状态。

## 一个典型执行路径

1. 用户发来请求。
2. OpenClaw 汇总上下文、工具列表、skills snapshot、workspace/bootstrap 文件，构造 system prompt。
3. 如果有明显匹配的 skill，模型先读取对应 `SKILL.md`。
4. 如果任务简单，模型直接答或直接调用工具完成。
5. 如果任务是非平凡多步骤，且 `update_plan` 可见，模型用它维护当前计划。
6. 如果任务适合并行、长耗时、隔离执行或外部 ACP harness，模型调用 `sessions_spawn` 创建子会话。
7. 子会话完成后，OpenClaw 通过 push-based completion 把结果送回父会话；父 agent 验证、综合，并决定是否给用户最终更新。
8. 如果这是后台/定时/持久流程，Task/Task Flow 记录对应状态，供 `openclaw tasks` / `openclaw tasks flow` 查询。

## 边界总结

| 机制 | 用途 | 是否自动拆任务 | 是否执行任务 |
| --- | --- | --- | --- |
| System prompt | 指导模型如何规划、何时委派、如何避免轮询 | 否，由模型判断 | 否 |
| `update_plan` | 当前 run 的计划/进度记录 | 否 | 否 |
| `sessions_spawn` | 创建隔离子 agent/ACP run | 由模型调用后实现拆分 | 是 |
| `sessions_yield` | 结束当前 turn 等子任务 completion event | 否 | 等待/交还控制 |
| `subagents` | 查看当前 requester 的 active/recent subagents | 否 | 否 |
| Skills | 按需加载专项工作流说明 | 否 | 否 |
| Background Tasks | 记录 detached work | 否 | 否 |
| Task Flow | 持久化多步骤流程编排 | 可用于管理式流程 | 间接驱动/跟踪子 tasks |
| Active Memory | 可选插件拥有的阻塞 memory sub-agent | 只用于记忆召回前置 | 是，限记忆召回 |

Active Memory 是一个例外型补充：它是可选插件提供的 blocking memory sub-agent，会在主回复前运行一次以注入相关记忆，但它不是通用任务规划器。见 `docs/concepts/active-memory.md:10`。


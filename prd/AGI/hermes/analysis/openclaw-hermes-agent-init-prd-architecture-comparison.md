# OpenClaw / Hermes 与 agent-init PRD 三张图的架构理念对比

## 核心结论

OpenClaw、Hermes 和 `agent-init` PRD 三张图不是同一层级的东西。

- **Hermes** 是一个强 agent 内核：重点是 `AIAgent` 如何把 prompt、模型、工具、记忆、技能、自我改进和多入口串成一次可执行循环。
- **OpenClaw** 是一个 agent runtime / control plane：重点是谁拥有 loop、如何跨 channel / session / runtime / sandbox / plugin 长期可靠地运行。
- **agent-init 三张图** 是一个闭环智能工作系统的概念蓝图：重点是一个项目如何从目标、知识、角色、技能、验证、记忆和反馈里长出自己的 AgentOS。

一句话：**agent-init 是蓝图和编译器，Hermes 是 agent 发动机，OpenClaw 是运行时和操作系统层。**

## 三张图分别表达什么

### 1. `AGI.png`：系统组织层

`AGI.png` 画的是系统级协作闭环：

```text
用户输入目标
  -> 管理角色拆分执行任务、测试任务和执行角色数量
  -> 执行角色领取任务
  -> 对话面板展示流程、进度、结果、Bug
  -> 执行结果回到管理角色 / 对话面板
  -> 用户审视并中途修改
  -> 进度 100% 后输出结果
```

它的架构理念不是“单个模型怎么思考”，而是“一个智能系统如何组织工作”。这里的关键抽象是管理角色、执行角色、过程可见、用户反馈和任务再分配。

与 Hermes / OpenClaw 对应：

- Hermes 有 delegation / subagent / tool loop，但核心仍是一个强 `AIAgent` 在主循环里调度。
- OpenClaw 更贴近这张图，因为它天然强调 channel、session、subagent、runtime、delivery 和过程事件。
- agent-init 则把这张图转成项目脚手架规则：先生成目标、Project Knowledge、Characters、Skills、Guardrails，再让 Orchestrator 调度。

### 2. `Model.png`：认知单元层

`Model.png` 画的是单个智能单元内部的认知闭环：

```text
任务/目标等数据 + 短时记忆/长时记忆
  -> RNN + Transformer 的预测能力
  -> LLM Prompt 元认知：自我评估、反思调整
  -> 执行
  -> 输出结果
  -> 回写记忆
```

底部还有 `Guardrails`，覆盖预测、prompt 元认知和执行，表示护栏不是最后一步检查，而是贯穿整个智能循环的约束。

这张图的理念是：智能不是一次 LLM call，而是“目标、记忆、预测、反思、执行、约束、回写”的闭环。放到今天工程实现里，`RNN + Transformer` 不一定要真的训练一个新模块，更现实的实现是 planner、retriever、evaluator、reflection、prompt policy 和 tool runtime 的组合。

与 Hermes / OpenClaw 对应：

- Hermes 最贴近这张图的 agent 内核部分：它把 messages、memory、skills、tools、compression、provider fallback 和 tool results 组织成强循环。
- OpenClaw 则把一部分“模型内部能力”外化到 runtime：session store、event stream、harness、sandbox、context engine、task state、delivery。
- agent-init 不是实现这条 loop，而是要求新项目生成能喂给 loop 的知识、规则、角色和 Skill。

### 3. `Character.png`：角色执行层

`Character.png` 画的是单个角色内部的工作循环：

```text
输入或修改目标 / 任务列表
  -> 任务模型记录目标和任务
  -> 查询长期记忆与外部信息
  -> 任务优先级模型排序
  -> 执行模型处理任务
  -> 生成测试任务
  -> 测试失败写入短期记忆并生成新任务
  -> 全部完成且测试通过后输出结果
```

它最接近今天成熟 agent loop 的工程语言：

```text
Plan -> Retrieve -> Act -> Verify -> Reflect -> Persist
```

这张图的关键不是“角色很多”，而是每个角色内部都有任务模型、优先级模型、执行模型、验证任务、短期记忆、长期记忆和外部信息接口。也就是说，角色不是 prompt 名字，而是有输入输出合同和自检回路的工作单元。

与 Hermes / OpenClaw 对应：

- Hermes 的 `AIAgent` 本身可以被看成一个强 Character：能读上下文、调用工具、处理记忆、复盘、生成最终回答。
- OpenClaw 的 subagent / plugin runtime / ACP runtime 更像可替换 Character 宿主：不同角色可以由不同 runtime 或 harness 承担。
- agent-init 用 `character-designer` 把这张图落成角色规格，再用 `skills-designer` 从角色职责反推 Skills。

## 最大差异

### 1. Hermes：智能长在 agent 内核里

Hermes 的核心问题是：

```text
一个 agent 如何在一次又一次会话中变强？
```

所以它把很多能力收进 `AIAgent` 和周边 agent 模块：prompt assembly、tool dispatch、memory、skills、compression、retry、fallback、session search、self-improvement。它的架构重心是“同一个 agent 的经验、技能和记忆如何持续积累”。

### 2. OpenClaw：智能跑在 runtime 控制面里

OpenClaw 的核心问题是：

```text
一个 agent 系统如何在多渠道、多模型、多 runtime、多 session 中可靠运行？
```

所以它把重点放在 Provider / Model / Agent Runtime / Channel 的分层、harness 选择、session、workspace、sandbox、plugin、事件流和消息投递。它不坚持所有智能都长在一个内核里，而是允许不同 runtime 拥有不同 loop。

### 3. agent-init 三图：智能来自项目系统的编译

agent-init 的核心问题是：

```text
一个已有项目如何生成自己的闭环 AI 工作系统？
```

所以它的默认顺序是：

```text
项目资料
  -> Project Knowledge
  -> Agents / Characters
  -> Skills
  -> Guardrails / Task Graph / Memory / Self-improvement
```

这里最重要的理念是“先知识，再角色，后工具”。它不先追求 runtime，也不先堆 Skills，而是先把项目文档编译成可审阅、可追溯、可运行的世界模型。

## 共同点

三者都把 agent 看成闭环系统，而不是聊天壳。

共同结构大致是：

```text
目标输入
  -> 上下文 / 记忆读取
  -> 任务拆解
  -> 工具或角色执行
  -> 验证 / 反思
  -> 结果输出
  -> 记忆或状态回写
```

它们也都承认三件事：

- 长期性不能只靠上下文窗口，必须有外部状态、文件、session、memory 或 Project Knowledge。
- 安全不能只靠模型自觉，必须有 Guardrails、sandbox、approval、权限或确认边界。
- 多角色协作必须有管理角色和输出合同，否则只是多开几个 prompt。

## 架构坐标系

| 维度 | Hermes | OpenClaw | agent-init 三图 |
| --- | --- | --- | --- |
| 抽象层级 | Agent 内核 | Runtime / control plane | 元架构 / 项目编译器 |
| 中心对象 | `AIAgent` | Agent runtime + channel + session | Project Knowledge + Character + Skill |
| 主要问题 | 如何让 agent 会工具、会记忆、会自我改进 | 如何让 agent 长期、安全、多渠道运行 | 如何从项目资料生成闭环工作系统 |
| Loop 形态 | 同步 tool-calling loop | 事件化 runtime loop / harness loop | 概念闭环和生成顺序 |
| 角色观 | 强主 agent，可委托 | runtime 可替换，subagent 可调度 | 角色是有任务模型和验证回路的工作单元 |
| 记忆观 | agent learning / skills / sessions / memory | session、workspace、task、runtime state | Project Knowledge、MEMORY、daily memory、learnings、logs |
| Guardrails | tool policy、agent-level handling、安全配置 | sandbox、approval、channel policy、runtime 边界 | 来源边界、确认边界、角色边界、质量边界 |
| 最强处 | 个人 agent 持续成长 | 多渠道长期运行与调度 | 把文档变成可运行 AgentOS |

## 最佳组合方式

三者如果放在一起，合理分工是：

```text
agent-init
  负责把项目资料编译成 Project Knowledge、Characters、Skills、Guardrails、Task Graph

Hermes
  负责提供强 agent loop、工具执行、记忆、技能、自我改进能力

OpenClaw
  负责让这些 agent / runtime 在本地、多渠道、长期任务、session 和 sandbox 中可靠运行
```

也可以理解为：

```text
agent-init 决定“这个项目的 agent 系统应该是什么”
Hermes 决定“一个强 agent 如何思考和行动”
OpenClaw 决定“这些 agent 如何被启动、隔离、调度、恢复和投递”
```

## 最短总结

`agent-init` 三张图是目标架构语言：它告诉你一个闭环智能系统应该有哪些层和回路。

Hermes 是强 agent 实现语言：它把这些回路集中在 `AIAgent` 和工具/记忆/技能系统里。

OpenClaw 是运行时实现语言：它把这些回路放进可替换 runtime、多渠道 gateway、session、sandbox 和事件流里。

所以三者的本质区别不是“谁更像 agent”，而是它们分别站在 **蓝图、内核、运行时** 三个位置上。


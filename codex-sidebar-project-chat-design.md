# Codex 侧边栏项目与对话交互拆解

> 基于本机 `/Applications/Codex.app` 打包资源与可见 UI 行为整理。能确认的资源包括 `sidebar-project-groups-*`、`sidebar-signals-*`、`sidebar-thread-keys-*`、`project-dropdown-options-*`、`add-project-menu-items-*`、`use-start-new-conversation-*` 等模块；本文不复刻内部实现，只整理可观察的产品结构和本项目采用的实现方案。

## 1. 信息结构

Codex 的侧边栏不是简单导航，而是「项目分组 + 项目内对话」：

1. 顶部固定操作：`New chat`，从当前上下文直接开新对话。
2. 项目区：每个项目是一组，项目行显示文件夹/工作区名称，内部列出该项目最近对话。
3. 对话行：显示标题、更新时间/状态，当前对话高亮。
4. 辅助导航：搜索、设置、插件/自动化等不会和项目会话混在同一层级。
5. Chatbot 底部上下文：composer 下方有项目选择器，可切换当前对话所属项目，也可新增项目。

## 2. 关键交互

- 点击侧边栏顶部「新对话」：在当前项目下创建一个空会话，并切回聊天页。
- 点击项目：切换当前项目；如果项目已有未归档对话，进入最近一个；如果没有，则创建一个空会话。
- 鼠标悬停项目行：右侧出现「+」图标，点击后在该项目下新建对话。
- 鼠标悬停对话行：右侧出现归档图标。
- 点击归档图标：不立即归档，而是把按钮切成红色/危险态的「确认」。
- 再次点击「确认」：归档该对话；如果归档的是当前对话，则自动切到同项目最近对话，没有则创建新对话。
- Chatbot 底部项目按钮：打开项目菜单，支持切换项目、从空白开始新增项目、使用已有文件夹新增项目。

## 3. 本项目实现方案

本项目新增一份本地 workspace state：

```ts
type WorkspaceProject = { id; name; path; createdAt; updatedAt }
type WorkspaceThread = { id; projectId; title; createdAt; updatedAt; archivedAt?; chatState }
type ChatWorkspaceState = { activeProjectId; activeThreadId; projects; threads }
```

实现要点：

- `AppShell` 统一持有项目、对话和当前选中状态，并持久化到 `localStorage`。
- `AppShellSidebar` 只负责展示和触发：新对话、项目切换、项目内新建对话、归档确认。
- `ChatPage` 使用当前 `activeThread.chatState` 渲染消息，并在发送后把首条用户消息同步为会话标题。
- Electron 侧的 Claude runner 按 `threadId` 分开保存 SDK `sessionId`，切换对话后继续发送不会把不同会话的上下文混到一起。
- 新增项目当前用浏览器 `prompt` 收集名称/路径；正式产品可替换为 Electron `dialog.showOpenDialog` 或自定义新建项目弹窗。

## 4. 视觉细节

- 侧边栏行高保持紧凑：项目行约 42px，对话行约 34px。
- 操作按钮默认隐藏，靠 hover/focus 显示，确认态保持显示。
- 当前项目用浅背景，当前对话额外加细边框，避免只靠文字颜色区分。
- 归档确认按钮使用危险色，但只在二次确认状态出现，减少误触。
- 底部项目菜单上弹，避免覆盖输入框内容。

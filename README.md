# AgentOS

面向 **类 Codex 桌面工作台** 体验的 **Electron + Vite + React + TypeScript** 模板：内置 **App Shell**（可 resize 侧栏、工作区顶栏、随系统的深浅色外观、基于 Hash 的视图切换），集成 **Claude Agent SDK**（主进程运行）、**多项目 / 多会话聊天工作区**、**本地项目文件树面板** 与持久化。在 **macOS** 上使用隐藏式标题栏、透明窗口与 `vibrancy: under-window`，侧栏区域可透出系统质感，工作区为不透明白底以便阅读与输入。

![界面预览 1](image1.png)

![界面预览 2](image2.png)

## 功能概览

| 领域 | 说明 |
| --- | --- |
| **桌面壳** | Electron 30 + Vite 5 + React 19；主进程 / 预加载 / 渲染进程由 `vite-plugin-electron` 串联开发与构建。 |
| **macOS 外观** | `titleBarStyle: hiddenInset`、交通灯可拖拽区域；透明窗口 + 侧栏 vibrancy；详见 `electron/main.ts`。 |
| **App Shell** | 侧栏导航（聊天、文档）、会话与项目相关的侧栏结构（由 `AppShell` / `AppShellSidebar` 管理）、工作区标题栏、可折叠/可拖拽调整宽度的侧栏（宽度键名 `CodeX-UI-Template-sidebar-width-px`）。 |
| **主题** | 深浅色主要 **跟随系统** `prefers-color-scheme`（见 `src/theme/tokens.css`）。「设置 · 外观」当前为占位，后续可接手动的主题/字体等。 |
| **路由** | 使用 `location.hash`：`#` / 空为聊天首页，`#docs` 文档，`#settings` 模型设置，`#settings/appearance` 外观设置（逻辑见 `src/components/app-shell-constants.ts`）。 |
| **对话** | `ChatPage` 通过 `preload` 暴露的 `window.claudeChat` 与主进程中的 **Claude Agent SDK** 交互；支持流式事件、取消、新线程、读取/保存 Agent 相关设置。 |
| **工作区** | 多项目、多线程（会话）状态；通过 `chat-workspace:get` / `chat-workspace:save` 持久化（见 `electron/chat-workspace-store` 与 `src/chat-workspace-persistence.ts`）。 |
| **文件树** | 选择本地项目目录、`listProjectFiles` 列举树形结构；工作区内 **文件树面板**（`AppFilePanel`）可开关浏览。 |
| **安全区** | `src/window-safe-area.ts` 将窗口控件安全区写入 CSS 变量，适配自定义标题栏。 |
| **内容渲染** | Markdown 等展示使用 `marked` + `dompurify`（见依赖与聊天消息渲染逻辑）。 |

## 具体功能

以下为当前代码中已接好或已占位的能力，便于区分「可用」与「待扩展」。

### 应用壳与导航

- **布局**：工具条（侧栏显隐、后退/前进）、可滚动侧栏、右侧主工作区；macOS 下配合隐藏标题栏与 `window-safe-area` 的 CSS 变量做控件区避让与拖拽。
- **侧栏宽度**：拖拽分隔条调节，持久化键 **`CodeX-UI-Template-sidebar-width-px`**（见 `app-shell-constants.ts`）。
- **Hash 路由**：`#` 或空 → 聊天；`#docs` → 文档；`#settings` → 模型设置；`#settings/appearance` → 外观占位页（见 `app-shell-constants.ts`）。
- **设置模式侧栏**：处于设置视图时，侧栏切换为设置分组导航样式，并可返回主界面。

### 聊天（Claude Agent）

- **主进程 Agent**：渲染层通过 `window.claudeChat.submit` 发送请求，`cancel` 取消，`newThread` 新建会话线程，`onEvent` 接收流式与状态更新。
- **消息展示**：用户/助手文本；助手侧 **Markdown**（`marked`）转 HTML 后经 **DOMPurify** 消毒；数据模型中还支持 **工具调用**、**thinking**、**活动/状态** 等时间线条目（见 `src/components/types.ts`）。
- **工作目录**：发送时会带上当前选中项目的 **`cwd`**（项目路径），供 Agent 在该目录上下文中运行。
- **输入增强**：输入框支持类 Codex 的 `/` slash command 菜单与 `@` mention 菜单；`/` 聚合内置命令、全局/项目 skills 与 commands，`@` 可搜索当前项目文件/文件夹并引用 subagent。
- **Skills / Agents 发现**：主进程扫描 `~/.claude`、项目 `.claude`，并兼容 `~/.agent`、`~/.agents`、项目 `.agent`、项目 `.agents`、`~/.cursor`、项目 `.cursor` 下的 `skills/`、`commands/`、`agents/`。
- **项目指令读取**：Claude 原生 `CLAUDE.md` 通过 SDK `settingSources: ['user', 'project', 'local']` 加载；模板额外把 `AGENT.md` / `AGENTS.md`、`.agent`、`.cursor/rules` 作为 host append prompt 注入。
- **模型选择**：聊天输入区旁的模型菜单与 Agent 设置里的「当前对话所用配置」一致并持久化；与设置页里「正在编辑哪一条厂商配置」相互独立（见 `ClaudeAgentSettingsPage`）。

### 工作区（多项目 / 多会话）

- **项目**：多个 `WorkspaceProject`；支持 **新建占位项目** 与 **选择本机文件夹** 作为项目根（系统对话框）。
- **会话线程**：归属项目；支持 **置顶**、**归档**（侧栏内需二次确认）。
- **列表排序**：同项目下置顶优先，其余按更新时间排序。
- **持久化**：优先 **`desktop.getChatWorkspace` / `saveChatWorkspace`**（主进程）；不可用时 **`localStorage`** 兜底，并含从旧版单会话数据的迁移（见 `chat-workspace-persistence.ts`）。

### 文件树面板

- 工作区标题栏可 **开关文件树**；按当前项目路径调用 **`desktop.listProjectFiles`**（主进程对深度、数量、忽略目录有限制）。
- 支持目录 **展开/收起**、`Escape` **关闭面板**。

### 设置与文档

- **模型 / Agent**：多条厂商配置、配置来源、`getSettings` / `saveSettings` 读写；界面展示环境与条目状态摘要。
- **外观**：**占位页**，文案说明后续接入主题、字体等。
- **文档**：**占位视图**（`DocsPage`），可后续接路由或 WebView。

### Electron 与其它平台

- **`window.desktop`**：选目录、列文件、聊天工作区读写等。
- **非 macOS**：窗口背景随系统明暗通过 `nativeTheme` 同步（见 `electron/main.ts`）。

## 环境要求

- **Node.js** 18+（建议当前 LTS）
- **npm** 或兼容的包管理器

## 快速开始

```bash
npm install
npm run dev
```

开发模式会拉起 Vite 开发服务器并打开 Electron 窗口。

## Claude Agent 与环境变量

Claude Agent SDK 在 **Electron 主进程** 中运行，环境变量写在项目根目录的 **`.env.local`**，不要使用 `VITE_*` 前缀（那些仅作用于渲染层构建）。可从示例文件复制：

```bash
cp .env.example .env.local
```

常用变量（完整列表以 `.env.example` 为准）：

| 变量 | 说明 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API Key |
| `ANTHROPIC_BASE_URL` | 兼容 Anthropic 的 API Base URL |
| `ANTHROPIC_MODEL` | 默认模型，会传给 Agent 的 `model` 配置 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 可选：Haiku 档位模型映射 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 可选：Sonnet 档位模型映射 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 可选：Opus 档位模型映射 |
| `ANTHROPIC_AUTH_TOKEN` | 可选：部分鉴权流程下替代 API Key |

**设置页与对话模型的关系**：在「设置 · 模型」中可维护多条厂商/端点配置（API Key、Base URL、模型与各档位映射）。**真正用于当前对话的模型条目**在聊天输入旁的模型菜单中选择并会持久化；设置页不直接「切换正在对话的模型」。默认策略为「设置优先」：若当前选中的配置里某字段有值，则覆盖同名环境变量；留空则回落到 `.env.local` 或系统环境变量。

## Codex 式 Skills / Agents 策略

这套模板把「发现、展示、提交」拆成三层：

- **发现层**：`electron/agent-context.ts` 读取全局与当前项目目录，支持 `.claude/skills/<name>/SKILL.md`、`.claude/commands/*.md`、`.claude/agents/*.md`，并用同样规则兼容 `.agent`、`.agents`、`.cursor`。
- **交互层**：`ChatPage` 在输入 `/` 时打开命令菜单，在输入 `@` 时打开文件/文件夹/agent 菜单；选择项只替换当前 token，不直接提交，用户可以继续补充上下文。
- **运行层**：`claude-agent-runner` 交给 Claude Agent SDK 原生加载 `.claude` 的 skills、commands、agents、CLAUDE.md；对 `.agent/.agents/.cursor` 的 slash command 做 host-side 展开，对 agents 转成 SDK `agents` 配置。

兼容目录约定：

```text
~/.claude/skills/<name>/SKILL.md
~/.claude/commands/<name>.md
~/.claude/agents/<name>.md
<project>/.claude/skills/<name>/SKILL.md
<project>/.claude/commands/<name>.md
<project>/.claude/agents/<name>.md
<project>/.agent/skills/<name>/SKILL.md
<project>/.agent/agents/<name>.md
<project>/.agents/skills/<name>/SKILL.md
<project>/.agents/agents/<name>.md
<project>/.cursor/skills/<name>/SKILL.md
<project>/.cursor/agents/<name>.md
<project>/AGENT.md
<project>/AGENTS.md
```

`.claude` 是 Claude SDK 原生路径；`.agent` / `.agents` / `.cursor` 是模板兼容层。兼容层支持 frontmatter 的 `name`、`description`、`argument-hint`、`model`、`tools`、`allowed-tools`、`skills` 等常见字段。

## 预加载与 IPC

渲染进程通过 `contextBridge` 暴露三类常用入口（定义见 `electron/preload.ts`）：

- **`window.desktop`**：`platform`、`windowEffects`（macOS vibrancy 标记）、`pickProjectDirectory`、`listProjectFiles`、`searchProjectFiles`、`listAgentContext`、`getChatWorkspace`、`saveChatWorkspace`。
- **`window.claudeChat`**：`submit`、`cancel`、`newThread`、`getSettings`、`saveSettings`、`setActiveChatPick`、`onEvent`（主进程推送的聊天/Agent 事件）。
- **`window.ipcRenderer`**：通用 `on` / `off` / `send` / `invoke`（按需使用，注意最小暴露面与安全）。

类型与载荷见 `src/claude-chat-types.ts` 与相关主进程模块（如 `electron/claude-agent-runner.ts`、`electron/claude-agent-settings.ts`）。

## 脚本说明

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite + Electron 开发环境 |
| `npm run build` | 执行 `tsc`、Vite 生产构建，并调用 **electron-builder** 打安装包 |
| `npm run preview` | 仅预览 Vite 构建后的静态资源（**不**启动 Electron） |

构建产物：

- **`dist`**：渲染进程静态资源与 `index.html`
- **`dist-electron`**：主进程与预加载脚本

安装包输出目录见 `electron-builder.json5` 中的 `directories.output`（默认 `release/${version}`）。

## 项目结构

```text
├── electron/                      # 主进程与预加载
│   ├── main.ts                    # 窗口、IPC、与 Agent 运行器衔接
│   ├── preload.ts                 # contextBridge API
│   ├── env-loader.ts              # 加载 .env.local 等主进程环境变量
│   ├── claude-agent-runner.ts     # Claude Agent SDK 运行逻辑
│   ├── claude-agent-settings.ts   # Agent 设置读写
│   ├── agent-context.ts           # skills / commands / agents / AGENT.md 发现与兼容层
│   └── chat-workspace-store.ts    # 聊天工作区持久化
├── src/
│   ├── main.tsx                   # React 挂载入口
│   ├── components/                # AppShell、聊天、文档、设置、文件面板等
│   ├── theme/tokens.css           # 设计令牌（建议在此演进）
│   ├── style.css                  # 全局与应用壳样式
│   ├── window-safe-area.ts       # 窗口控件安全区 → CSS 变量
│   ├── chat-workspace-persistence.ts
│   ├── claude-chat-types.ts       # 前后端共享的类型
│   ├── icons.ts / icon-inline.tsx
│   └── vite-env.d.ts
├── public/
├── index.html
├── vite.config.ts                 # React 插件 + vite-plugin-electron/simple
├── electron-builder.json5
├── tsconfig.json
├── .env.example
├── codex-ui-framework-notes.md    # Codex 类桌面 UI 分层笔记（参考）
├── codex-css-tokens.md / .json    # 从参考应用抽取的 CSS 令牌说明与清单
└── AGENT.md                       # 克隆/开发界面时的代理说明（含本地 Codex 参照路径）
```

## 打包与发布

1. 在 `electron-builder.json5` 中修改 **`appId`**、**`productName`** 等与品牌一致的字段。
2. 按需调整各平台 `mac` / `win` / `linux` 的 `target` 与签名、公证等（详见 [electron-builder 文档](https://www.electron.build/)）。
3. 本地打包：`npm run build:local`；推 tag `v*` 后由 GitHub Actions 发布到 [Releases](https://github.com/xue160709/AgentOS/releases)。

发布与应用内更新见 **[docs/RELEASE.md](docs/RELEASE.md)**。

主进程依赖里将 `@anthropic-ai/claude-agent-sdk` 标为 **external**（见 `vite.config.ts`），以便在 Electron 运行时从 `node_modules` 加载；发布前请确认打包配置包含该依赖。

## 技术栈

- [Electron](https://www.electronjs.org/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react)
- [vite-plugin-electron](https://github.com/electron-vite/vite-plugin-electron)
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [electron-builder](https://www.electron.build/)
- [marked](https://marked.js.org/) · [DOMPurify](https://github.com/cure53/DOMPurify)
- TypeScript

## 许可证

[MIT](LICENSE)。使用前可按需在 `LICENSE` 第二行将版权归属改为你的名字或组织。

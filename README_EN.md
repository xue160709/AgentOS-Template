# AgentOS

**中文版本 / Chinese version: [README.md](./README.md)**

AgentOS is a desktop Agent workspace for local projects and long-running tasks. It is not just another chat wrapper around a model. AgentOS turns a project folder into an Agent runtime where chat, skills, visual cards, task orchestration, project memory, and local file context live together.

The backend runtime is powered by **Claude Agent SDK** inside the Electron main process, handling streaming chat, session resume, permission requests, tool calls, and task execution. The frontend focuses on presentation and interaction.

The vision is simple: every project should be able to grow its own Agent operating system. You choose a local folder, and AgentOS helps the Agent understand that folder, remember project context, run Skills, render interactive dashboards, and collaborate with you over time.

## Preview

![Preview 1](image1.png)
![Preview 2](image2.png)
![Preview 3](image3.png)
![Preview 4](image4.png)
![Preview 5](image5.png)

## Vision

Useful Agents should not live only inside one-off chat sessions.

A useful Agent needs to know which project it is serving. It needs to remember conventions, understand local files, show results as readable and interactive interfaces, and run multiple skills on demand or on a schedule. AgentOS therefore puts the Agent boundary in the place users already understand: the folder.

A folder in AgentOS can gradually accumulate instructions, memory, skills, task cards, data cards, and conversation history. You can use it as a personal Agent workspace, or as a framework for building your own Agent product.

## Branches

This project has three branches with different goals:

| Branch | Purpose | Best for |
| --- | --- | --- |
| `main` | Product branch. More user-friendly product features will land here, and stable builds are published through GitHub Releases. | Users who want to install and use AgentOS directly. |
| `AgentOS-Framework` | Framework branch. This branch keeps the framework structure clearer for developers who want to build their own Agent products on top of AgentOS. | Developers and product builders. |
| `AgentOS-Experimental` | Experimental branch. This branch explores more possibilities around human-agent collaboration, memory, visual interaction, and automation. | People who want to follow early experiments and co-create. |

If you only want to use the app, start with Releases from `main`.  
If you want to build your own product, start from `AgentOS-Framework`.  
If you want to follow unstable explorations, watch `AgentOS-Experimental`.

## What Makes AgentOS Different

### Folder as Agent

The core object in AgentOS is not a bot profile. It is a project folder. Files such as `AGENT.md`, `SOUL.md`, `MEMORY.md`, `memory/`, `.agents/skills/`, and `.agents/home-plugins/` define the Agent identity, long-term memory, skills, and visual workspace for that folder.

The Agent is therefore connected to your project files, project rules, history, and task plans.

### Agent = Chat + Data Visualization + Interactive Content + Memory

In AgentOS, an Agent is more than text replies:

- **Chat**: understand requests, run tasks, and explain process.
- **Data visualization**: render project state, data outputs, task progress, and custom panels through Home Plugins and A2UI cards.
- **Interactive content**: cards can include actions such as refresh, open file, run task, and stop task.
- **Memory**: project instructions, memory files, and daily memory help the Agent understand the project over time.

This is the main difference between AgentOS and a normal chat app: AgentOS is designed around Agents living inside projects for the long run.

## Current Features

### Multi-Agent, Multi-Project, Multi-Session

- Add multiple local project folders as independent Agent workspaces.
- Create multiple conversation threads under each project.
- Pin, archive, sort, and persist threads.
- Resume Claude Agent SDK sessions with persisted `sessionId`.
- Organize conversations and project Skills in the sidebar.

### Scheduled and Repeated Skill Orchestration

- Discover project Skills from `.agents/skills/`, `.claude/skills/`, and compatible folders.
- Run project Skills directly from the sidebar.
- Create task cards that run either the current `AGENT.md` or an ordered set of Skills.
- Repeat a task up to 100 times.
- Schedule tasks by time and interval: 1h, 2h, 3h, 6h, 12h, or 1d.
- Mirror task runs into dedicated conversation threads, with stop support.

Current scheduling requires the Electron process to stay alive. It is not a system-level background daemon yet.

### Visual and Interactive Content

- Project home supports a Home Plugin card system.
- Supports data cards and task cards.
- Cards render A2UI v0.9 output.
- Supports small, medium, and large card sizes.
- Supports card sorting, resizing, refresh, and single-card editing.
- Card actions can open files, refresh content, run tasks, or stop tasks.

### Agent Mode Scaffolding

- Generate or repair `AGENT.md`, `SOUL.md`, `MEMORY.md`, and `memory/`.
- Enable TODO mode and manage `TODO.md`.
- Edit project-level USER and IDENTITY content in settings.
- Inject Agent Mode context into the Agent runtime.

### Local File Context

- Pick a local project directory.
- Browse, expand, refresh, and preview the project file tree.
- Preview Markdown, JSON, text, and images.
- Use `@` in the composer to search and mention project files, folders, or sub-agents.
- Attach text and image files to chat. Image availability depends on the selected model configuration.

### Slash Commands, Skills, and Sub-Agents

- Use `/` to open built-in commands, project Skills, and project Commands.
- Supports global and project-level context from `.claude`, `.agent`, `.agents`, and `.cursor`.
- Reads `AGENT.md` and `AGENTS.md` as project instructions.
- Discovers sub-agent definitions and exposes them through `@` mention.

### Visible Agent Runtime

- The transcript shows model responses, tool calls, thinking, activity status, and elapsed time.
- Permission modes include Plan, Auto, Default, Accept Edits, and Bypass Permissions.
- Interactive prompts appear when the Agent needs user confirmation or additional input.
- File diffs can be reviewed and reverted.

### Model Settings and Desktop Experience

- Supports multiple model provider configurations.
- Configure API Key, Base URL, model, and model-tier mappings in settings.
- Switch the active chat model from the composer.
- Chinese and English UI, with Chinese as the default.
- macOS hidden titlebar, sidebar vibrancy, tray menu, close-to-tray, and open-at-login preferences.
- In-app update checks, downloads, and installation through GitHub Releases.

## Download and Install

### For Users

1. Open [AgentOS Releases](https://github.com/xue160709/AgentOS/releases).
2. Download the installer for your platform:
   - macOS: `AgentOS-Mac-x.y.z-Installer.dmg`
   - Windows: `AgentOS-Windows-x.y.z-Setup.exe`
   - Linux: `AgentOS-Linux-x.y.z.AppImage`, if provided by the current Release
3. Install and launch AgentOS.
4. Configure your model provider in Settings, or use environment-based configuration.
5. Pick a local project folder and start chatting, running Skills, or creating Agent cards.

### For Developers

For framework development, start from `AgentOS-Framework`:

```bash
git clone https://github.com/xue160709/AgentOS.git
cd AgentOS
git checkout AgentOS-Framework
npm install
npm run dev
```

For the product branch:

```bash
git checkout main
npm install
npm run dev
```

For the experimental branch:

```bash
git checkout AgentOS-Experimental
npm install
npm run dev
```

## Development

### Requirements

- Node.js 18+
- npm

### Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite + Electron development mode |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run test:electron` | Run Electron tests |
| `npm run test:home-plugin` | Validate Home Plugin structure |
| `npm run build:local` | Build local installers without publishing |
| `npm run build` | Build and package with electron-builder |
| `npm run release` | Build and publish to GitHub Releases |

### Model Environment Variables

For development, copy `.env.example`:

```bash
cp .env.example .env.local
```

Common variables:

| Variable | Description |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key |
| `ANTHROPIC_BASE_URL` | Anthropic-compatible API base URL |
| `ANTHROPIC_MODEL` | Default model |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku-tier model |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet-tier model |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Opus-tier model |
| `ANTHROPIC_AUTH_TOKEN` | Optional auth token |

Installed app users can also manage model providers directly from Settings.

## Project Convention

AgentOS reads and generates project context around the selected folder. A typical project may look like this:

```text
your-project/
├── AGENT.md                  # Project Agent instructions
├── SOUL.md                   # Project vision, values, and long-term identity
├── MEMORY.md                 # Project-level memory
├── TODO.md                   # TODO mode task file
├── memory/                   # Daily memory
├── .agents/
│   ├── skills/               # Project Skills
│   ├── agents/               # Project sub-agents
│   └── home-plugins/         # Project home cards
├── .claude/                  # Optional Claude-native context
└── .cursor/                  # Optional Cursor rules or compatible context
```

`.agents/home-plugins/` powers the project home card system. Each card can read project files, generate A2UI output, and render as a data card or task card in AgentOS.

## Tech Stack

- Electron
- React
- TypeScript
- Vite
- Claude Agent SDK
- A2UI
- electron-builder
- marked + DOMPurify

## Contact

For discussion, feedback, or co-creation, add WeChat:

**xuezhirong233**

## License

[MIT](LICENSE)

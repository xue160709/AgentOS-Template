---
name: a2ui-project-home-panel
description: 定制 Agent 面板 / project-home Home Plugin 时使用。适用于用户要求设计、生成、修改或测试基于 A2UI v0.9 的项目首页面板、卡片式 dashboard、日报/论文/数据库/代码项目概览、数据可视化卡片和二层交互。该 Skill 以 PM、Programmer、Tester 三角色闭环工作：先确认用户真正想看什么，再实现 .agents/home-plugins/project-home/，最后在当前环境验证并循环修复。
argument-hint: "[用户对面板的需求或当前项目数据说明]"
---

# A2UI Project Home Panel

This Skill turns the current project's Agent panel into a useful A2UI project-home dashboard.

## Required Role Loop

Use the three role agents in this Skill whenever the host supports sub-agents:

- `a2ui-home-panel-pm`: decide what the user needs to see, which project data matters, and what actions should exist.
- `a2ui-home-panel-programmer`: implement or update `.agents/home-plugins/project-home/manifest.json` and `extractor.js`.
- `a2ui-home-panel-tester`: run the validator and available build/type checks, then return failures to the programmer.

If sub-agent execution is unavailable, perform the same PM -> Programmer -> Tester -> PM loop yourself and label the phases in your working notes.

## Load References

Read only what is needed:

- Always read `references/a2ui-v0_9-home-surface.md`.
- Read `references/dashboard-information-architecture.md` before deciding cards.
- Read `references/data-visualization-patterns.md` whenever counts, time series, rankings, status, distributions, or trends are present.
- Read `references/project-data-sources.md` when choosing extractors for Markdown, JSON, CSV, SQLite, README/TODO, or recent files.
- Read `references/examples.md` when you need a concrete A2UI component/message pattern.

## Workflow

1. PM pass:
   - Inspect the current project structure using file listing/search tools.
   - Identify candidate data sources, their freshness, and their user value.
   - Decide the minimum useful dashboard: top metrics, latest activity, unresolved work, trends/distributions, and source-backed actions.
   - Ask the user only when the intended audience or priority is genuinely ambiguous.

2. Programmer pass:
   - Store the Home Plugin under `.agents/home-plugins/project-home/`.
   - Create/update `manifest.json` and `extractor.js`.
   - `extractor.js` must define `async function run(host)` and use only the host API: `host.listFiles`, `host.readText`, `host.readJson`, `host.exists`, `host.stat`, `host.querySqlite`.
   - Do not use `import`, `require`, `process`, `fetch`, shell commands, network calls, or direct filesystem APIs inside `extractor.js`.
   - Return `{ version: 1, messages, diagnostics }`.
   - Use A2UI v0.9 messages with surfaceId `project-home` and catalogId `https://a2ui.org/specification/v0_9/basic_catalog.json`.
   - Prefer compact cards, metric rows, latest-item lists, bar-list style text visualization, timelines, status summaries, and source-backed buttons.
   - Never dump an entire file, report, README, database table, or JSON blob into one Text component.

3. Interaction rules:
   - Any card based on a file should include an `open_file` action with `context.filePath` set to the relative project path.
   - If a dashboard shows a latest report, daily note, paper, task file, or data source, make the path or an adjacent button open it.
   - Use `refresh_home` for refresh controls and `customize_home` only for editing the panel itself.

4. Tester pass:
   - Run `node .agents/skills/a2ui-project-home-panel/scripts/validate_home_plugin.js <project-root>` when this script is available.
   - In this repository, also run `npm run typecheck` after TypeScript/Electron/renderer changes.
   - Run `npm run build` only when packaging-sensitive changes need full validation or before final delivery if time allows.
   - If validation fails, give the exact failure back to the programmer phase and fix before finalizing.

5. PM confirmation:
   - Re-check whether the result answers the user question: "What should I look at now, why does it matter, and what can I open next?"
   - Summarize changed plugin files, data sources used, visualizations included, and any remaining tradeoffs.

## Dashboard Quality Bar

- A user should understand the project state in under 10 seconds.
- Counts without interpretation are not enough; pair them with latest activity, missing/unfinished items, or trend context.
- Data visualization is mandatory when there are comparable buckets, dates, statuses, or repeated records.
- Every second-level interaction should preserve source traceability: show where data came from and make source files reachable.

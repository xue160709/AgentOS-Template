# AgentOS Search TODO

## Goal

Build AgentOS search as a project context entry point, not only a chat title finder. Search should help users return to files, chats, memories, tasks, skills, and concrete transcript moments inside a project.

## Principles

- Keep search scoped and predictable: current project first, cross-project search later.
- Separate lightweight navigation search from heavier full-text history search.
- Reuse the existing `@` project file search path before adding a new index system.
- Every result should be actionable: open file, open chat, jump to message, mention in composer, run skill, or open task.
- Preserve local-first privacy: indexes stay on device and can be rebuilt.

## P0 - Basic Search Surface

- [ ] Define search result types in shared frontend/Electron types.
  - Include `kind`, `projectId`, `title`, `subtitle`, `path`, `threadId`, `score`, `updatedAt`, and optional highlight ranges.
- [ ] Add a command/search modal.
  - Suggested shortcuts: `Cmd/Ctrl+K` for global command menu, `Cmd/Ctrl+P` for project files, `Cmd/Ctrl+G` for chats.
  - Support keyboard navigation, Enter to open, Escape to close, and grouped result sections.
- [ ] Implement project file search section.
  - Reuse `desktop:search-project-files`.
  - Improve scoring beyond simple `includes`: exact match, prefix match, path match, recent project weighting.
  - Keep ignored directories and search caps from `electron/agent-context.ts`.
- [ ] Implement chat/thread search section.
  - Search current project's `WorkspaceThread` list.
  - Match title, first user message, thread purpose, skill/task metadata, and project path.
  - Sort pinned threads and recent threads higher.
- [ ] Add result actions.
  - File result: open preview or insert mention.
  - Chat result: open thread.
  - Skill result: run or open skill.
  - Task result: open task thread/card when available.
- [ ] Add empty/loading/error states.
  - Empty state should explain the scope, for example "No files or chats found in this project."

## P1 - Full-Text History Search

- [ ] Design a local search index.
  - Use SQLite FTS when available.
  - Fall back to JSON search if SQLite is unavailable.
- [ ] Create a normalized search document table.
  - Suggested fields: `id`, `kind`, `project_id`, `thread_id`, `path`, `title`, `subtitle`, `body`, `metadata_json`, `updated_at`.
- [ ] Index transcript content.
  - User messages.
  - Assistant summaries or message text.
  - Important tool outputs and errors, with truncation rules.
  - Thread title and first prompt.
- [ ] Keep the index updated from persistence.
  - Hook into workspace save / Electron mirror save.
  - Read rollout JSONL records for long-term transcript indexing.
  - Rebuild stale indexes on startup or on demand.
- [ ] Add message-level result rendering.
  - Show chat title, matched snippet, author/type, and relative timestamp.
  - Jump to the matching thread and scroll to the matching message.
- [ ] Add archive handling.
  - Current project active threads by default.
  - Toggle archived threads on demand.
  - Archived results should rank lower.

## P2 - AgentOS Knowledge Search

- [ ] Index Agent Mode files.
  - `AGENT.md`, `SOUL.md`, `MEMORY.md`, `TODO.md`, and files under `memory/`.
- [ ] Index skills, commands, and sub-agents.
  - Search name, description, frontmatter, file path, and scope.
- [ ] Index Home Plugin and task records.
  - Search card title, task title, status, latest output summary, and related thread.
- [ ] Add contextual actions.
  - "Add to composer context."
  - "Ask Agent about this."
  - "Open memory file."
  - "Run this skill."
  - "Continue from this thread."
- [ ] Add filters.
  - Current project / all projects.
  - Files / chats / messages / memory / skills / tasks.
  - Active / archived.
  - Recent time ranges.

## Technical Notes

- Existing file search entry points:
  - `electron/agent-context.ts` exports `searchProjectFiles`.
  - `electron/main.ts` exposes `desktop:search-project-files`.
  - `src/components/chat/ChatPage.tsx` uses it for `@` mention autocomplete.
- Existing persistence references:
  - `prd/persistence.md` describes `chat-workspace.json`, `chat-workspace.sqlite*`, and rollout JSONL files.
  - `prd/workspace-session.md` describes `WorkspaceProject` and `WorkspaceThread`.
- Keep filesystem traversal bounded:
  - Do not scan ignored directories such as `.git`, `node_modules`, `dist`, `build`, and release output.
  - Keep max depth and entry caps configurable before increasing them.

## Acceptance Criteria

- [ ] Users can find a file in the current project by partial name or path.
- [ ] Users can find a chat by title, first prompt, or project path.
- [ ] Search results are grouped, keyboard navigable, and actionable.
- [ ] Full-text history search can find a phrase from a previous user/assistant message.
- [ ] Search stays responsive on large projects.
- [ ] Local search data can be rebuilt and cleared without deleting user project files.


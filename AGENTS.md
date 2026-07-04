# OpenBoard Agent Instructions

## Product

OpenBoard is a local multi-agent command center for OpenCode. A task card is a work spec; running it dispatches an OpenCode session through the Hono adapter, and the board tracks the task through To Do, In Progress, Review, and Done.

V1 ships the TUI + named-instance CLI workflow. Treat `openboard` / `src/tui` as the release and tester surface. The Electron app is not a V1 ship target and must not be used as a readiness, packaging, or release gate unless a task explicitly asks for Electron work.

## Source Map

- `src/cli/` contains the named-instance `openboard` CLI.
- `src/tui/` contains the V1 OpenTUI surface and launcher.
- `src/server/` contains the Hono adapter, OpenCode process/client wiring, dispatcher, task routes, SSE, and worktree integration.
- `src/db/` contains the SQLite-backed task and board stores.
- `src/shared/` contains route, task, model, event, column, and error contracts shared by server, web, MCP, and TUI surfaces.
- `src/web/` contains the non-V1 React/Vite board UI.
- `electron/main.cjs` contains the non-V1 Electron shell.
- `src/mcp/` contains the OpenBoard MCP server.
- `test/` contains unit, DOM, integration, MCP, server, client, TUI, and shared-contract tests.

## Required Context

Before changing dispatch, task lifecycle, model/agent assignment, or worktree behavior, read:

- `README.md`
- `src/shared/task.ts`
- `src/server/dispatcher.ts`
- `src/server/worktree.ts`
- `src/server/routes/tasks.ts`

Before changing the web UI, read:

- `src/web/App.tsx`
- `src/web/taskStore.ts`
- `src/web/components/TaskCard.tsx`
- `src/web/components/NewTaskForm.tsx`

Before changing the TUI, read:

- `src/tui/index.ts`
- `src/tui/model.ts`
- `src/tui/launcher.ts`

## Verification

Use the narrowest relevant command first, then broaden before handoff.

- `npm run typecheck`
- `npm test`
- `npm run test:integration`
- `npm run build:tui`
- `npm run build:cli`
- `npm run build:app` only when validating bundled non-TUI artifacts too.

`npm run test:coverage` is a CI gate, but its current status may be under discussion. Do not claim a full CI-equivalent pass unless this command passes too.

## Rules

- Preserve worktree isolation semantics. Concurrent repo work should run with `isolation: "worktree"` unless a task explicitly needs shared-tree behavior.
- For V1 readiness, focus on the TUI, named-instance CLI, server/task lifecycle, and integration tests. Do not raise Electron packaging/signing/app-shell work as a V1 requirement.
- Do not treat Review as Done. Review means the OpenCode session went idle; humans or an orchestrator still need to verify the diff.
- Keep route and task contract changes synchronized across `src/shared/`, server routes, web clients, MCP tools, and TUI code.
- Do not add provider-specific model assumptions. Available models come from OpenCode config and `/api/agents`.
- Do not commit generated build output from `dist/`.
- Do not read or expose secrets. Avoid `.env` files unless a task explicitly requires them; prefer documented examples and config source.

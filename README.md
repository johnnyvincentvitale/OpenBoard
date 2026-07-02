# opencode-board

A local, Devin/Hermes-style **multi-agent command center for [OpenCode](https://opencode.ai)**,
delivered as an Electron desktop app. Post a task, assign it an OpenCode agent, hit **Run** —
the board dispatches a real session that **autonomously does the work**, and the card
**auto-advances To Do → In Progress → Review → Done** as the agent runs. It's the named-agent,
multi-agent workflow OpenCode doesn't ship, and a free alternative to Devin Desktop's Kanban.

## What it does
- **Tasks, not just sessions.** A card in To Do is a spec: title, description, working
  directory, and an assigned **agent** + **model**.
- **Agents = OpenCode's own agents** — `build`, `plan`, `general`, `explore`, plus any you
  define. The roster comes live from OpenCode; assign a card to one.
- **Run → it executes.** The dispatcher creates a session bound to that agent/model with an
  allow-all permission (so it runs unattended), prompts it with the task, and the agent
  autonomously reads/writes/runs to completion.
- **Cards move themselves.** The dispatcher watches OpenCode's `/event` stream and advances
  the card to Review when the session finishes; the UI updates live over SSE.
- **Per-card actions:** Run, Retry (re-prompt), Stop (abort), Delete.

## How it works
```
Electron (electron/main.cjs)
  └─ spawns the adapter → opens a native window on the served board
        src/server (Hono adapter)
          ├─ TaskDispatcher  Run → client.v2.session.create({agent,model,permission})
          │                       → client.v2.session.prompt({text}) → /event → auto-advance
          ├─ SqliteTaskStore  tasks + columns (better-sqlite3)
          ├─ routes  /api/tasks · /api/agents · /api/tasks/events (SSE)
          └─ spawns `opencode serve`  (the agents' backend)
        src/web (React + Vite + dnd-kit)  task board · new-task form · agent-assigned cards
```
Uses the OpenCode **v2 durable session API** (`client.v2.session.*`). Verified capability
notes live in the vault: `~/Brain-Pro/projects/opencode-board/opencode-capabilities.md`.

## Run it
```sh
npm install            # first time only
npm run electron       # builds the UI + opens the native desktop window
```
The app spawns `opencode` and the adapter itself — no other terminals. Dispatched agents
work in the **workspace** (default: your home dir); point it at a repo with:
```sh
BOARD_WORKSPACE=/path/to/your/repo npm run electron
```

Browser fallback (two terminals):
```sh
npm run dev:server     # spawns opencode + the API on :4097
npm run dev            # Vite UI at http://localhost:5173
```

## Develop
```sh
npm test                  # unit + DOM (fast, no opencode) — runs on pre-commit + CI
npm run test:integration  # integration vs a real ephemeral opencode (local)
npm run typecheck
npm run build:web         # build the frontend → dist/web
```
Branches: `main` (trusted) / `dev` (work). Husky runs the unit+DOM suite before every commit.

### Structure
```
src/shared/    frozen contracts (Task, Column, ModelRef, RosterAgent, routes, events)
src/server/    Hono adapter — opencode client, dispatcher, task store wiring, routes, SSE, serve
src/db/        better-sqlite3 task store + session-column sidecar
src/web/       React UI — task store, TaskBoard (dnd), TaskCard, NewTaskForm
electron/      Electron main process (main.cjs)
test/          unit + DOM + integration
```

## Known constraints (verified)
- `session.wait` is a stub in this OpenCode version → completion comes from the `/event` stream.
- v2 `session.create` runs the session in the **server's working directory** (the workspace).
- Concurrent agents in one repo have **no file locking** — assign non-overlapping work, or use
  a git worktree per agent.
- Available models depend on your OpenCode auth/config (here: OpenCode Zen free + OpenAI GPT-5.x).

## Roadmap
- Packaged/signed `.app` (electron-builder config is in place; native-module bundling is a follow-up).
- Worktree-per-agent isolation for safe parallelism.
- Multi-CLI: back an agent with Codex or Claude instead of OpenCode (a provider seam / ACP host).

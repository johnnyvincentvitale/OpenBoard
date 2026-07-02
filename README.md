# opencode-board

A local, Devin/Hermes-style **multi-agent command center for [OpenCode](https://opencode.ai)**,
delivered as an Electron desktop app. Post a task, assign it an OpenCode agent, hit **Run** —
the board dispatches a real session that **autonomously does the work**, and the card
**auto-advances To Do → In Progress → Review** as the agent runs. Moving to Done is manual
until OpenCode exposes a stronger task-complete signal. It's the named-agent,
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
  the card to Review when the session goes idle; the UI updates live over SSE.
- **Per-card actions:** Run, Retry (re-prompt), Stop (abort), Delete.

## How it works
```
Electron (electron/main.cjs)
  └─ spawns the adapter → opens a native window on the served board
        src/server (Hono adapter)
          ├─ TaskDispatcher  Run → client.v2.session.create({agent,model,location,permission})
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
work in each task's requested directory. The adapter/OpenCode default workspace is your home
dir unless you point it at a repo with:
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

### Package the desktop app
```sh
npm run electron:pack     # → dist/mac-arm64/opencode-board.app (unsigned)
```
This bundles the adapter to a single ESM file (`dist/server/serve.mjs`, via esbuild — the
packaged app has no `tsx`) and emits an unsigned `.app`. When packaged, `main.cjs` runs the
bundled server with the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE`); in dev it
still runs the TS source via `tsx`.

The `better-sqlite3` native module is ABI-sensitive, so the pack script is deliberate:
`electron-rebuild -f` builds it for Electron's ABI, `electron-builder --config.npmRebuild=false`
packs that exact binary (an independent copy in `app.asar.unpacked`), then `npm rebuild
better-sqlite3` restores the Node ABI so `npm test` keeps working — the app's copy is
untouched. Code signing needs an Apple Developer ID cert (`mac.identity` is `null` = unsigned).

### Structure
```
src/shared/    frozen contracts (Task, Column, ModelRef, RosterAgent, routes, events)
src/server/    Hono adapter — opencode client, dispatcher, task store wiring, routes, SSE, serve
src/db/        better-sqlite3 task store + session-column sidecar
src/web/       React UI — task store, TaskBoard (dnd), TaskCard, NewTaskForm
electron/      Electron main process (main.cjs)
test/          unit + DOM + integration
```

## Worktree isolation
Concurrent agents in one repo share a working tree and can clobber each other. Turn on
**worktree isolation** and each run gets its own `git worktree`:

- **Default + override.** A board-level *worktree default* toggle (header checkbox) sets the
  default; each task can override it (worktree / in-place) in the new-task form.
- **Isolated run.** A worktree run cuts `board/<taskId>` from the task's directory and dispatches
  the session into that worktree — never the main working tree.
- **Non-git dir.** Can't be isolated, so the run is blocked and the card offers **Make repo & run**
  (`git init` + commit, then run). Decline = no run.
- **Reclaim.** The worktree + branch persist after the run. **Sync** merges the upstream base
  branch *into* the worktree (resolve drift there); **Integrate** merges the worktree branch *into*
  the base branch, removes the worktree, and **keeps the branch**. Conflicts are reported, not
  forced.

## Known constraints (verified)
- `session.wait` is a stub in this OpenCode version → completion comes from the `/event` stream.
- Push tasks pass `location.directory` to v2 `session.create`; `BOARD_WORKSPACE` is the
  adapter/OpenCode default workspace, not the per-task execution directory.
- Without worktree isolation, concurrent agents in one repo have **no file locking** — assign
  non-overlapping work, or enable worktree isolation (above).
- Available models depend on your OpenCode auth/config (here: OpenCode Zen free + OpenAI GPT-5.x).

## Roadmap
- Packaged `.app` — **done** (`npm run electron:pack`, unsigned). Signing awaits an Apple
  Developer ID cert.
- Worktree-per-agent isolation — **done** (board default + per-task override, sync/integrate).
- Multi-CLI: back an agent with Codex or Claude instead of OpenCode (a provider seam / ACP host).

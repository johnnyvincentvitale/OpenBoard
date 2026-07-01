# opencode-board

A local, Devin-style **Kanban command center for [OpenCode](https://opencode.ai)**.
Cards are your OpenCode **sessions**, pulled live from `opencode serve`, arranged across
**To Do / In Progress / Review / Done**, updating in real time. A free, self-hosted
alternative to Devin Desktop's Kanban.

<!-- screenshot: four-column board with live session cards -->

## What it does

- **Every OpenCode session is a card** — title, working directory, agent/model, cost,
  diff stats (`+adds −dels (files)`), and a live-state pill (running / idle / retrying /
  error). Running sessions pulse.
- **Drag cards across columns** — the column layout is yours (OpenCode has no column
  concept); it's stored in a local SQLite sidecar.
- **Act on a card** — send a prompt, stop (abort) a running session, or view its diff.
- **Real-time** — a Server-Sent-Events stream from the adapter pushes session
  create/update/delete and live-state changes with no polling.

## How it works

```
opencode serve :4096  ──┐  REST (sessions, status, diff)
   /event SSE (flat)  ──┼──▶  src/server (Hono adapter)  ──▶  src/web (React + Vite + dnd-kit)
                        │     · board-service: merge sessions + status + columns → Card DTO
                        │     · SqliteColumnStore: the column/order sidecar
                        │     · EventBridge: /event → snapshot + patch frames over SSE
                        └──▶  GET /api/board · POST …/move · …/prompt · …/interrupt · …/diff
                             GET /api/board/events (SSE) · GET /api/health
```

- **Cards = sessions** via `@opencode-ai/sdk` (`client.session.*`). Column state is the
  only thing this app owns, in `better-sqlite3` (dense-integer positions, reindexed on move).
- **Frontend** talks to the adapter same-origin through the Vite dev proxy — no CORS.

## Quick start

Two processes: the board server (which spawns/owns an `opencode serve`) and the Vite UI.

```sh
npm install
npm run dev:server      # spawns opencode + serves the adapter on http://127.0.0.1:4097
npm run dev             # Vite UI on http://localhost:5173  (proxies /api → :4097)
```

Open http://localhost:5173. Already running `opencode serve` yourself? Point the adapter at
it instead of spawning a new one:

```sh
OPENCODE_BASE_URL=http://127.0.0.1:4096 npm run dev:server
```

### Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_BASE_URL` | — | Connect to an existing opencode server (skips spawning). |
| `OPENCODE_MANAGE_PROCESS` | `true` when spawning | Whether the adapter owns the opencode process. |
| `OPENCODE_HOSTNAME` / `OPENCODE_PORT` | `127.0.0.1` / `4096` | Where to spawn/reach opencode. |
| `BOARD_PORT` | `4097` | The adapter's own port. |
| `BOARD_DB_PATH` | `board.sqlite` | Column sidecar location. |

## Develop

```sh
npm test               # unit + DOM tests (fast, no opencode needed) — runs on pre-commit + CI
npm run test:integration  # integration tests against a REAL ephemeral opencode (local)
npm run test:coverage  # coverage report
npm run typecheck      # tsc --noEmit
```

Branches: `main` (trusted, green) / `dev` (work). Husky runs the unit+DOM suite before every
commit; CI re-runs it plus a best-effort integration job on every push.

### Project structure

```
src/shared/    frozen contracts imported everywhere (Card, Column, events, ColumnStore, routes)
src/server/    Hono adapter — opencode client, board-service, routes, event-bridge, app, serve
src/db/        better-sqlite3 column/order sidecar
src/web/       React UI — store (useSyncExternalStore), dnd-kit board, session card
test/          unit + DOM + integration (test/integration/*.int.test.ts)
```

## Parallel dev with worktrunk (optional)

This board is about running many agents at once — and [worktrunk](https://github.com/max-sixty/worktrunk)
(`wt`) is a great companion for developing it that way. It makes git worktrees "as easy as
branches," so you can run several OpenCode (or other) agents in parallel on isolated
checkouts of this repo without them stepping on each other.

```sh
brew install worktrunk
wt config shell install     # shell integration
wt switch feature/my-change # create + enter a worktree by branch name
wt list                     # see worktrees + status
wt merge                    # merge back and clean up
```

It's a convenience for your own workflow — the board itself doesn't depend on it.

## Roadmap

v1 is **OpenCode-only**. Multi-CLI (Codex, Claude Code) is a future direction: a
`SessionProvider` seam or an ACP-host rebuild (the Devin Desktop model). Only OpenCode
currently exposes a full query+drive server, so it's the natural first (and only) provider.

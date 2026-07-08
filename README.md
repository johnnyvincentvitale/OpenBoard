# OpenBoard

A local **multi-agent command center for [OpenCode](https://opencode.ai)**.
OpenBoard ships the **TUI + named-instance CLI** workflow. Post a task, assign it an OpenCode agent,
hit **Run** — the board dispatches a real session that **autonomously does the work**, and
the card **auto-advances To Do → In Progress → Review** as the agent runs. Moving to Done is
manual until OpenCode exposes a stronger task-complete signal. It's the named-agent,
multi-agent workflow OpenCode doesn't ship.

New here? Start with the **[User Guide](GUIDE.md)** — a walkthrough from a fresh
clone to orchestrated multi-agent runs. This README is the reference.

## Scope

The public repo is TUI/CLI/server-first:

- Ship/test surface: `openboard` named-instance CLI and OpenTUI board.
- Primary launch path: `openboard attach <instance>` or `npm run tui`.
- Primary validation: TUI build, CLI/instance flow, server/task lifecycle, integration tests, and source tests.

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
- **Review diffs in place.** On Review cards, press `v` to open the full-screen diff view
  before syncing, integrating, or accepting the work.
- **Fix it without leaving the diff.** Press `e` on a DiffView selection to open that file —
  at the selected hunk's line — in `$VISUAL`/`$EDITOR` (or an `OPENBOARD_EDITOR` template).
  Terminal editors take over the terminal until you quit; GUI editors open detached. The diff
  refreshes on return so the fix rides straight into the same Integrate. Requires a local
  board and a configured editor — no fallback guessing.
- **Per-card actions:** Run, Retry (re-prompt), Stop (abort), Delete.

## How it works
```
openboard CLI / TUI (src/cli + src/tui)
  └─ attaches to a named board instance, or starts one when needed
        src/server (Hono adapter)
          ├─ TaskDispatcher  Run → client.v2.session.create({agent,model,location,permission})
          │                       → client.v2.session.prompt({text}) → /event → auto-advance
          ├─ SqliteTaskStore  tasks + columns (better-sqlite3)
          ├─ routes  /api/tasks · /api/agents · /api/tasks/events (SSE)
          └─ spawns `opencode serve`  (the agents' backend)
        src/tui (OpenTUI)  task board · selected-card detail · instance switcher
```
Uses the OpenCode **v2 durable session API** (`client.v2.session.*`), verified against
the OpenCode server capabilities used by this adapter.

## Harnesses

A card's **harness** is the agent runtime that executes it. OpenCode is the default;
the other harnesses are driven over the **Agent Client Protocol (ACP)**.

- **OpenCode** — binds one of your OpenCode agents (`build`, `plan`, `general`,
  `explore`, …) and a model synced live from the providers OpenCode is authenticated
  for.
- **Claude Code** — dispatches a background Claude Code ACP session. This is the
  exercised ACP path; it reports completion through the same structured contract, so its
  cards join Review, handoffs, and dependencies like any other.
- **Codex, Gemini, Hermes, Pi Coding Agent, Cursor** — additional ACP harnesses.
  **Experimental:** the runner and live discovery are wired, but these have not yet been
  run end-to-end. Each appears in the new-task wizard only when its adapter is actually
  installed and launchable.

**Live discovery.** `GET /api/acp-config` probes each ACP adapter (`initialize` +
`session/new`) and reports `available`, `modes`, `models`, and extra config options per
harness (30s cache; `GET /api/acp-models` is the models-only projection). The wizard
sources its model/mode/option controls from this and hides adapters that don't launch, so
you never see a harness you can't run. Model IDs can also be entered freeform per harness.

**Adapter resolution** (per harness, in order): an explicit
`OPENBOARD_<HARNESS>_ACP_COMMAND` override → a bundled `@agentclientprotocol/*` adapter
package if installed (Claude, Codex, Gemini) → the adapter binary on `PATH`
(`claude-agent-acp`, `codex-acp`, `gemini-agent-acp`, `hermes-agent-acp`,
`pi-coding-agent-acp`, `cursor-agent-acp`). All ACP harnesses share Claude Code's
write-fence permission model and `permissionMode` set.

## Install

```sh
git clone https://github.com/<owner>/openboard.git openboard
cd openboard
npm install
npm run build:app
npm link                   # exposes the `openboard` CLI on your PATH
```

The bundled plugin's MCP config starts `openboard mcp`, so copy and symlink
installs use the same path. No machine-local MCP bundle path or
`OPENCODE_BOARD_MCP_SERVER` export is required for normal installs. See
`plugins/openboard/README.md` for plugin-specific install options.

## Auth / token setup

After the security hardening, mutating and sensitive board routes require a
per-instance board API token. The `/api/health` endpoint remains unauthenticated;
all other `/api/*` routes require the token.

Local launches (`npm run tui`, `openboard start`, and
`openboard mcp --instance <name>`) inject the token automatically. Plugin MCP
launches start unbound with `openboard mcp`; use `select_instance` to bind the
running MCP process to a named instance before board tool calls. External clients
and custom scripts that bypass the named-instance CLI must provide the token via
the `OPENBOARD_API_TOKEN` environment variable:

```sh
OPENBOARD_API_TOKEN=<token> OPENCODE_BOARD_URL=http://127.0.0.1:4097 your-client
```

Named instances persist their `boardToken` in
`~/.config/openboard/instances.json` so `openboard start`, `openboard attach`,
and the TUI can reconnect without manual token copy/paste. Direct/dev server
launches resolve the token from `OPENBOARD_API_TOKEN`; if it is unset, the
server generates a random token for that process and prints it to stdout. Set
`OPENBOARD_API_TOKEN` only when you intentionally want a deterministic token
(CI, pre-shared setups, or multiple boards sharing one token). See
`SECURITY.md` for rotation details.

See `SECURITY.md` for the full threat model, workspace scoping, and data
retention details.

## Localhost threat model

OpenBoard is designed to bind to `127.0.0.1` (loopback) only. **Never expose
the board adapter port or the spawned OpenCode port on a network interface.**
Doing so would give anyone on the network remote shell access to your machine.

Treat board access as equivalent to local shell access: a dispatched agent
runs under your user account and can read files, write files, and execute
arbitrary commands in the configured workspace. The board API token protects
against unauthorized same-machine access, but loopback binding alone is not a
security boundary — anyone who can reach `127.0.0.1:4097` on your machine can
create and run tasks if they have the token.

## Run it
```sh
npm install            # first time only
npm run build:app      # builds server, TUI, CLI, MCP, and web bundles
npm run tui            # starts a single self-owned TUI board
```

For named-instance testing:

```sh
openboard add my-repo --workspace /path/to/your/repo   # register only (does not start)
openboard start my-repo                                # start the daemon
openboard attach my-repo                               # open the TUI
```

`openboard add` only registers the instance and `openboard attach` does not start a stopped
one, so `start` goes between them — or use the one-step shortcut `openboard my-repo`, which
starts the instance if needed and then attaches.

The board spawns `opencode` and the adapter itself. Dispatched agents work in each task's
requested directory. There is no home-directory default: named instances always set their
workspace explicitly (`--workspace` is required), and the raw-env server refuses to start
unless `BOARD_WORKSPACE` points at an existing directory.

## Running multiple instances

OpenBoard supports two ways to run more than one independent board on a single
machine. Pick the named-instance CLI for V1/day-to-day work; keep the raw-env path
for scripts or when you want to manage processes yourself.

### Named-instance CLI (recommended)

The `openboard` binary keeps a registry of named instances, each with its own
adapter port, workspace, and database, and runs each as a background daemon.

```sh
openboard add my-repo --workspace /path/to/repo-1      # auto-assigns a port
openboard add side-project --workspace /path/to/repo-2 --port 4197
openboard start my-repo
openboard start side-project
openboard list                                          # status + identity of every instance
openboard status my-repo                                # read-only registry/live diagnostics
openboard default set my-repo                           # default for attach with no name
openboard default show / clear
openboard attach my-repo                                # open the TUI for one
openboard stop my-repo
openboard remove side-project
```

Files and directories:

| Item | Location |
|------|----------|
| Instance registry | `${HOME}/.config/openboard/instances.json` |
| Per-instance data dir | `${HOME}/.local/share/openboard/<name>/` |
| Daemon PID file | `${HOME}/.local/share/openboard/<name>/openboard.pid` |
| Daemon log file | `${HOME}/.local/share/openboard/<name>/openboard.log` |
| Default instance DB | `${HOME}/.local/share/openboard/<name>/board.sqlite` (column DB is the `-board` sibling) |

Rules of the registry:

- Names must be lowercase kebab-case (`my-repo`), up to 40 characters, and may
  not shadow a subcommand.
- Ports must be unique across all registered instances; omit `--port` and the
  CLI picks the next free one starting from `4097`.
- `openboard add` only registers the instance; `openboard start` spawns the
  daemon process.
- `openboard list` reports `running`, `stopped`, `stale-pid`, or `unhealthy`,
  plus board URL, workspace, and DB path so similar instances can be
  distinguished. A stale pidfile is cleaned up the next time it is inspected.
- `openboard status <name>` is read-only diagnostics: registry identity,
  runtime state, board and OpenCode endpoints when available, workspace, task DB
  path, board-token presence (never the token), adapter build/version/commit,
  and OpenCode health/version when the daemon is reachable.
- `openboard <name>` (the bare shorthand) starts the instance if needed and then
  opens the TUI with that instance's board URL.
- `openboard attach <name>` opens the TUI for an already-running instance; it does
  not start a stopped one — run `openboard start <name>` first, or use the bare
  `openboard <name>` shorthand above.
- When no name is given to `attach`, the default instance is used: the instance
  explicitly marked with `openboard default set <name>`, or the only registered
  instance. Use `openboard default show` to see whether the default is explicit,
  inferred, or unset, and `openboard default clear` to remove the explicit
  default.

### `npm run tui` — single self-owned instance

`npm run tui` keeps working exactly as before: it boots a single adapter
process that the launcher owns, requires no registry, and is not part of the
named-instance world. Use it for quick one-off sessions; use the `openboard`
binary when you want multiple persistent daemons.

### Raw environment path (advanced / manual)

You can still start independent instances directly by environment variables.
Use this with `npm run dev:server` or custom scripts.
The instance-resolution env vars are resolved in `src/server/config.ts`:

| Env var                    | Controls                                      | Default when unset                  |
|-----------------------------|-----------------------------------------------|--------------------------------------|
| `OPENBOARD_PORT`            | This instance's adapter (board) port          | `4097` (legacy fallback: `BOARD_PORT`) |
| `OPENBOARD_DB`              | This instance's SQLite path (board + task DB derive from it) | `board.sqlite` / `board-tasks.sqlite` |
| `BOARD_WORKSPACE`           | This instance's default workspace (dispatched agents' cwd) | **Required** — the server refuses to start if unset, empty, or not an existing directory (no home-directory default) |
| `OPENBOARD_OPENCODE_PORT`   | Port for this instance's spawned `opencode serve` | auto-selected free port (never hardcoded 4096) |
| `OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES` | Allow task and terminal directories outside `BOARD_WORKSPACE` (unsafe for shared instances) | `false` |

Task and terminal directories are canonicalized (`realpath`) and rejected if they escape the instance workspace unless this opt-in is set to `true`.

Two-instance example — run each in its own terminal:

```sh
# Instance A — repo-1, default-ish ports, its own DB
OPENBOARD_PORT=4097 \
OPENBOARD_DB=/tmp/openboard-a/board.sqlite \
BOARD_WORKSPACE=/path/to/repo-1 \
npm run dev:server

# Instance B — repo-2, a second adapter port + OpenCode port + DB
OPENBOARD_PORT=4197 \
OPENBOARD_OPENCODE_PORT=4196 \
OPENBOARD_DB=/tmp/openboard-b/board.sqlite \
BOARD_WORKSPACE=/path/to/repo-2 \
npm run dev:server
```

The named-instance CLI and TUI show the selected instance/port for cheap disambiguation.
Starting a second instance on a port that's already taken fails fast with a clear startup
error — it never produces a half-started, silently-duplicate instance. If you omit
`OPENBOARD_OPENCODE_PORT`, the adapter asks the OS for a free port itself, so two instances
started with no OpenCode port configured never fight over the same spawned backend.

Plugin MCP clients start unbound through the installed CLI:

```sh
openboard mcp
```

Then call `select_instance` from the MCP client to bind that process to a
running named instance. To start an MCP process already bound to a specific named
instance, use the instance-aware wrapper:

```sh
openboard mcp --instance my-repo
```

The wrapper reads the registry and starts the MCP server with `OPENCODE_BOARD_URL`,
`OPENBOARD_API_TOKEN`, and `OPENBOARD_INSTANCE_NAME` already set. The instance must already be
running; stopped instances fail with a message to run `openboard start <name>`. MCP never silently
controls the legacy `4097` fallback when no board is selected. Advanced/manual clients may still set
`OPENCODE_BOARD_URL` directly.

The MCP server's tools are an orchestrator control surface for the existing task API:
`openboard_status`, `current_instance`, `list_instances`, `select_instance`, `create_task`,
`add_tasks`, `list_tasks`, `list_agents`,
`link_tasks`, `unlink_tasks`, `run_task`, `retry_task`, `abort_task`, `move_task`,
`complete_task`, `block_task`, `sync_task`, `integrate_task`, `comment_task`, `add_note`, and
`task_events`. `move_task` requires `completedBy` when moving to Done, and `integrate_task`
requires `confirmReviewed: true`.

Review cards expose `GET /api/tasks/:id/diff`, which the TUI uses for the `v`
full-screen diff view. Non-Review cards return 409, unknown tasks return 404,
and missing git evidence returns a readable no-git response instead of crashing.

## BoardV3 task lifecycle
Beyond Run/Retry/Stop, a Task carries an explicit completion contract, optional
parent/child dependencies, and an archive flag — all exposed on `/api/tasks`.

**Completion contract.** Every dispatched prompt gets an appended footer telling the
agent exactly how to end its turn: `POST /api/tasks/:id/complete` (or `/block`) with a
JSON body `{ summary, changedFiles, verification: [{ command, result }], residualRisk }`.
The JSON shape stays the same for every card, but the footer includes task-type
handoff guidance: `research` reports factual evidence and source gaps,
`synthesis` evaluates parent findings for agreement/conflict/evidence strength/gaps,
`build` reports implementation output, `audit` reports findings, and `fix`
reports resolved findings plus regression checks. Build, synthesis, audit, and
fix cards also receive task-mode context before parent handoffs.
The server stamps `outcome` (`complete`/`blocked`) and `reportedAt`, stores it as the
task's `completion`, sets `completionSource: "reported"`, and — if the task was still in
`todo`/`in_progress` — moves it to `review` (`complete` leaves `runState: "idle"`; `blocked`
sets `runState: "error"` with `error` set to the reported `residualRisk`). Both routes
404 on an unknown task and 409 if the task isn't currently `running` (except a late report can upgrade an `idle-fallback` Review card). If the agent never
calls either endpoint but OpenCode's `/event` stream reports the session went idle anyway,
the dispatcher still advances the card to `review` — but stamps `completionSource:
"idle-fallback"` and leaves `completion: null`, so the UI (and any dependent task) can tell
a real report from a bare idle signal.

**Dependency links + gated dispatch.** `POST /api/tasks/:id/links` (body `{ parentId }`)
and `DELETE /api/tasks/:id/links/:parentId` manage a task's `parentIds`; the server rejects
self-links and cycles with 409. Calling `run` or `retry` on a task with unmet parents never
creates a session — it returns 409 with `error.unmetParents: [{ id, title, why }]` naming
each unsatisfied parent (e.g. "parent is in todo", "parent is still running", "parent
reported blocked"). A parent counts as satisfied once it's `done`, *or* it has a `complete`
completion report with `completionSource: "reported"` — column aside. Once every parent is
satisfied, the dispatcher injects a `PARENT CONTEXT` section into the child's prompt (before
the completion-contract footer) with read-only parent worktree instructions and numbered
parent sections (`PARENT-000`, `PARENT-001`, ...): worktree, task id, branch, summary,
changed files, verification results, and residual risk — or a "manually marked Done" note
for parents with no structured report.

**Archive + filters.** `POST /api/tasks/:id/archive` / `/unarchive` toggle a task's
`archived` flag; only `review`/`done` tasks can be archived (409 otherwise). `GET
/api/tasks` excludes archived tasks by default; pass `?archived=true` to see only archived
tasks, or `?archived=all` to see both (any other value is a 400).

## Develop
```sh
npm run verify              # typecheck + unit tests + integration tests + app build
npm test                  # unit + DOM (fast, no opencode) — runs on pre-commit + CI
npm run test:integration  # integration vs a real ephemeral opencode (local)
npm run typecheck
npm run build:app         # build server, MCP, TUI, and CLI
```
Branches: `main` (trusted) / `dev` (work). Husky runs the unit suite before every commit.

For tester handoff, run `npm run verify` from a clean checkout before sharing
the repo or asking someone to retry a bug. Integration tests self-skip only
when the local `opencode` binary cannot be started; call that out in reports.

**Never commit generated or runtime files:** `dist/`, `*.sqlite*` (DB + WAL/SHM),
`*.log`, `.env*` (env files), `node_modules/`, or ephemeral worktree artifacts.
These contain local state and may include sensitive prompts, paths, or session
IDs.

### Structure
```
src/shared/    frozen contracts (Task, Column, ModelRef, RosterAgent, routes)
src/server/    Hono adapter — opencode client, dispatcher, task store wiring, routes, SSE, serve
src/db/        better-sqlite3 task store + global archive
src/tui/       V1 OpenTUI board, selected-card details, instance switcher, launcher
src/cli/       named-instance CLI (`openboard`)
test/          unit + integration
```

## Worktree isolation
Concurrent agents in one repo share a working tree and can clobber each other. Choose
**worktree isolation** on a task and that run gets its own `git worktree`:

- **Per-task choice.** Pick `worktree` or `in-place` in the new-task form.
- **Isolated run.** A worktree run cuts `board/<taskId>` from the task's directory and dispatches
  the session into that worktree — never the main working tree.
- **Non-git dir.** Can't be isolated, so the run is blocked and the card offers **Make repo & run**
  (`git init` + commit, then run). Decline = no run.
- **Reclaim.** The worktree + branch persist after the run. **Sync** merges the upstream base
  branch *into* the worktree (resolve drift there); **Integrate** merges the worktree branch *into*
  the base branch, removes the worktree, and **keeps the branch**. Conflicts are reported, not
  forced.

## Open in editor

From a Review card's DiffView (`v`), press **`e`** to open the currently selected file — at the
selected hunk's line — in your own editor. This is the in-app fix-then-integrate path: no
in-app editor, just a suspend/resume handoff to the terminal (or a detached launch for GUI
editors).

- **Resolution order:** `OPENBOARD_EDITOR` (a command template) → `$VISUAL` → `$EDITOR` → a
  clear "no editor configured" status message. Nothing ever falls back to a platform default
  opener — if none of these are set, `e` fails loud instead of guessing.
- **`OPENBOARD_EDITOR` template.** Supports `{file}`/`{line}` placeholders, e.g.
  `OPENBOARD_EDITOR="hx {file}:{line}"`. If the template has no `{file}` placeholder, the file
  path is appended as the last argument.
- **Editors with line-jump support:** `vim`/`nvim`/`vi`/`gvim`, `emacs`/`emacsclient`, `nano`,
  `micro`, `kak`, `hx`, `subl`, `zed`, `code`/`code-insiders`, `cursor`, `windsurf`. Any other
  `$EDITOR`/`$VISUAL` still opens the file, just without a line jump.
- **Terminal vs. GUI.** `vim`/`nvim`/`vi`/`emacs`/`emacsclient`/`nano`/`micro`/`kak`/`hx` and
  unrecognized editors suspend the TUI renderer and take over the terminal until you quit;
  `code`/`code-insiders`/`cursor`/`windsurf`/`zed`/`subl`/`gvim` are spawned detached, and the
  TUI keeps running underneath.
- **Target tree.** The edit lands in whichever tree the diff was actually computed against —
  the task's worktree, or the in-place task directory for dirty in-place diffs — never the base
  repo copy.
- **Diff refreshes on return.** As soon as the editor exits (terminal) or launches (GUI), the
  DiffView re-fetches and reapplies the diff, so the edit is immediately visible and rides into
  the same Integrate.
- **Requires a local board and a configured editor.** `e` is blocked with a status message on a
  remote board (`isLocalBoardUrl` check) — same reasoning as the localhost threat model above.

## Known constraints (verified)
- `session.wait` is a stub in this OpenCode version → completion comes from the `/event` stream.
- Push tasks pass `location.directory` to v2 `session.create`; `BOARD_WORKSPACE` is the
  adapter/OpenCode default workspace, not the per-task execution directory.
- Without worktree isolation, concurrent agents in one repo have **no file locking** — assign
  non-overlapping work, or enable worktree isolation (above).
- Available models depend on your local OpenCode auth/config and enabled providers.
- ACP harnesses beyond Claude Code (Codex, Gemini, Hermes, Pi, Cursor) are wired and
  discovered live but **not yet verified end-to-end**; persisted `permissionMode`
  validation is still shaped around the Claude mode set, so a non-Claude adapter reporting
  a mode outside that set may be rejected.

## Roadmap
- V1 TUI + named-instance CLI — **ship target**.
- Worktree-per-agent isolation — **done** (per-task isolation, sync/integrate).
- Multi-CLI ACP host — **in progress**: Claude Code is the exercised path; Codex, Gemini,
  Hermes, Pi Coding Agent, and Cursor harnesses are wired and discovered live
  (experimental, adapter-gated, not yet verified end-to-end).

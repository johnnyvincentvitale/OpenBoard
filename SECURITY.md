# Security Policy

## Supported Versions

OpenBoard is pre-release local tooling. Security fixes are handled on the active `main` and `dev` branches unless a release branch is explicitly created later.

## Reporting A Vulnerability

Do not open a public issue for a vulnerability.

Report security concerns privately through GitHub's private vulnerability reporting for the OpenBoard repository if it is enabled. If private reporting is not available, contact the repository maintainers directly before sharing exploit details.

Include:

- affected commit or version
- reproduction steps
- expected and actual impact
- whether the issue exposes local files, tokens, credentials, OpenCode sessions, or shell access

## Local Security Model

OpenBoard is a local command center that dispatches autonomous OpenCode agents.
Every dispatched agent runs under your user account with the ability to read
files, write files, and execute arbitrary commands in the configured workspace.

**Board access equals local terminal access.** Anyone who can reach the board
API can create and run tasks, which will execute in the configured workspace
with your privileges. Protect board access the same way you protect your shell.

### Network Binding

OpenBoard is designed to bind to `127.0.0.1` (loopback) only. Never expose the
board adapter port or the spawned OpenCode server port on a network interface.
Doing so would give anyone on the network remote shell access to your machine.

- Do not bind `OPENBOARD_PORT` or `OPENCODE_PORT` to `0.0.0.0` or any external
  IP address.
- Do not run OpenBoard on a shared host where untrusted local users can reach
  `127.0.0.1`.
- Do not configure a reverse proxy or port forward that exposes loopback-bound
  ports to the network.

## Authentication

The board enforces a per-instance API token on all mutating and sensitive
routes. The `/api/health` endpoint is deliberately unauthenticated; all other
`/api/*` routes require the token.

### Where the token lives

The board API token is generated fresh every time the server starts. There is
**no token file on disk** — the token is purely in-memory for the lifetime of
the process.

By default, the server generates a random 64-character hex token on startup and
prints it to stdout:

```
board API token: a1b2c3d4...e9f0
```

You can override the random token with a fixed value by setting the
`OPENBOARD_API_TOKEN` environment variable before starting the server. This is
useful in CI environments or when you need a deterministic token for external
scripts.

### How clients provide the token

Clients send the token in one of two ways:

- `Authorization: Bearer <token>` header (preferred for HTTP clients)
- `?board_token=<token>` query parameter (for SSE/EventSource/WebSocket clients
  that cannot set custom headers)

Local clients launched by OpenBoard itself — the TUI and the `openboard` CLI —
receive the token automatically through the environment. The web UI receives it
via an injected `<script>` tag in the HTML. No manual copying is needed for
these same-origin clients.

Dispatched OpenCode sessions also receive the token inside the appended
completion-contract prompt so they can report `/complete` or `/block` back to
the board. That prompt may be retained anywhere OpenCode stores session history,
transcripts, logs, or debugging output. Treat OpenCode session history and logs
as sensitive for the lifetime of the token, and rotate the token by restarting
the board if those records are exposed.

External clients, including the MCP server when used from an agent harness,
must provide the token via the `OPENBOARD_API_TOKEN` environment variable:

```
OPENBOARD_API_TOKEN=<token> OPENCODE_BOARD_URL=http://127.0.0.1:4097 your-mcp-client
```

### Rotating or resetting the token

Since the token is not persisted to disk, rotation is simple:

- **Default (random) token:** Stop the server and restart it. A new random
  token is generated automatically. Any clients that relied on the old token
  (external scripts, MCP harnesses) must be updated with the new one. The local
  UI and TUI are unaffected because they receive the new token directly from
  the restarted server.
- **Fixed token (`OPENBOARD_API_TOKEN`):** Change the value of the environment
  variable and restart. There is no token file to delete or manage.

## Workspace Scoping

Every task's working directory and every terminal session's current working
directory is canonicalized (symlinks are resolved via `realpath`) and checked
against the board instance's configured workspace. By default, paths that
resolve outside the workspace boundary are rejected.

### Configuring the workspace

Set `BOARD_WORKSPACE` to a directory path. This is the root that all task and
terminal directories must fall under:

```
BOARD_WORKSPACE=/path/to/your/repo npm run dev:server
```

If `BOARD_WORKSPACE` is unset, the server falls back to your home directory. An
explicitly set but missing, empty, or non-directory value is rejected at
startup with a validation error — the server will not start with a broken
workspace configuration.

### Explicit unsafe override

If you need to dispatch agents into directories outside the configured
workspace, set `OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES=true`. This disables the
workspace boundary check entirely for all tasks and terminals on the instance.

```
OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES=true BOARD_WORKSPACE=/path/to/repo npm run dev:server
```

**This is unsafe.** When enabled, an agent can be dispatched into any directory
on your filesystem your user account can access, including your home directory,
`/etc`, or any mounted volume. Only enable it when you intentionally want to
run agents on external directories and accept the risk.

## Sensitive Data Retention

### SQLite databases

The task store uses SQLite databases that persist the full board state on disk,
including:

- Task titles and descriptions (the prompts sent to agents)
- Working directory paths for every task
- Session IDs linking tasks to OpenCode sessions
- Completion reports, including verification command output and agent summaries
- Changed-file lists from completed tasks

These files live in the per-instance data directory (or wherever `OPENBOARD_DB`
is pointed), not in the source repository. The column-store DB and task-store
DB are separate sidecar files derived from the same `OPENBOARD_DB` base path.

### Archiving is hiding, not deleting

The `/api/tasks/:id/archive` endpoint toggles a task's `archived` flag. An
archived task is excluded from the default task list but remains in the
database with all its data intact. Archiving does not scrub the task's title,
description, directory path, or completion reports. Archived tasks can be
unarchived and seen again at any time.

Additionally, archiving a task mirrors a full copy of the record into a
global cross-instance archive. By default this lives at
`${HOME}/.local/share/openboard/archive.sqlite` — outside any single instance's
data directory. The path can be overridden with `OPENBOARD_ARCHIVE_DB`. The
mirror persists independently: unarchiving a task does not remove the mirror
row, and mirroring is idempotent per `(source_db_path, task_id)` — re-archiving
the same task replaces the existing row.

`DELETE /api/tasks/:id` removes the task from its instance task store but does
**not** reach into the global archive. There is no API endpoint to remove a
global archive mirror; records in the archive persist until the database file
is deleted directly.

### Gitignore hygiene

Never commit to version control:

- SQLite databases and `-wal`/`-shm` sidecar files (`*.sqlite`, `*.sqlite-*`)
- Runtime log files (`*.log`)
- `.env` or other environment/secret files
- Generated `dist/` build output or worktree artifacts

These files contain local state and may include sensitive prompts, paths, or
session IDs. OpenBoard's `.gitignore` excludes these patterns by default, but
verify if you change the DB path or log location.

### Disposal and backups

When disposing of a machine or sharing a backup, treat the instance data
directory as sensitive. Delete the entire instance data directory
(`~/.local/share/openboard/<name>/` for named instances, or wherever your
`OPENBOARD_DB` path points) to remove per-instance task data.

The global cross-instance archive lives at a separate path
(`${HOME}/.local/share/openboard/archive.sqlite` by default, or
`OPENBOARD_ARCHIVE_DB` if set). Delete this file to remove all globally-mirrored
archive records across all instances.

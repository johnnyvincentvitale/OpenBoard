# OpenBoard Project Instructions

These instructions are the canonical agent-facing guide for this repository.
Read this file before making claims about the repo or editing code. Keep
`AGENTS.md` as the Codex adapter, but treat this file as the source of truth
for shared project behavior.

## Product Scope

OpenBoard is a local multi-agent command center for OpenCode sessions. The
public repo ships the TUI, named-instance CLI, server, MCP surface, and bundled
OpenBoard plugin.

V1 scope is TUI + named-instance CLI:

- Primary launch path: `openboard attach <instance>` or `npm run tui`.
- Ship/test surface: named-instance CLI, OpenTUI board, server/task lifecycle,
  MCP tools, and integration/source tests.
- Electron packaging is not a V1 gate unless the user explicitly asks about it.

## Required Context

Before substantive work, read:

1. `README.md`
2. `GUIDE.md`
3. `package.json`
4. The files directly involved in the requested change

For plugin work, also read `plugins/openboard/README.md` and the relevant
`plugins/openboard/skills/*/SKILL.md` files.

## Source Map

- `src/shared/` - shared task, route, provider, terminal, health, and instance
  contracts.
- `src/server/` - Hono adapter, OpenCode/ACP dispatch, routes, worktree
  lifecycle, auth, terminal, diff, and event handling.
- `src/db/` - SQLite task store, schema metadata, and global archive.
- `src/tui/` - V1 OpenTUI board, launcher, runtime, lifecycle display,
  confirmations, diff view, and model helpers.
- `src/cli/` - named-instance CLI and provider wiring.
- `src/mcp/` - OpenBoard MCP server and tool definitions.
- `test/` - unit, server, TUI, MCP, plugin, and integration tests.
- `plugins/openboard/` - bundled OpenBoard plugin and shared skills.

## Validation

Use the narrowest meaningful command first, then broaden before handoff.

Core commands:

```sh
npm run typecheck
npm test
npm run test:integration
npm run build:app
```

Script meanings:

- `npm test` runs unit tests, excluding `test/integration/**`.
- `npm run test:integration` runs integration tests against a real ephemeral
  OpenCode server when available.
- `npm run typecheck` runs TypeScript with `--noEmit`.
- `npm run build:app` builds server, MCP, TUI, and CLI bundles.

Husky runs `npm test` before commit. Do not describe work as verified unless
you ran the relevant command or clearly state what was not run.

## Runtime And Environment

OpenBoard targets Node 22 or newer. OpenCode must be installed and
authenticated for real dispatch. Git is required for worktree isolation.

Named instances persist config under:

- `~/.config/openboard/instances.json`
- `~/.local/share/openboard/<name>/`

Important env vars for raw/manual server paths:

- `OPENBOARD_PORT`
- `OPENBOARD_DB`
- `BOARD_WORKSPACE`
- `OPENBOARD_OPENCODE_PORT`
- `OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES`
- `OPENBOARD_API_TOKEN`

Named-instance launches inject board URL and token automatically. Direct/dev
server launches may generate a process-local token if `OPENBOARD_API_TOKEN` is
unset.

## Worktree And Dispatch Rules

Use worktree isolation for concurrent agent work in the same repo. In-place
runs can clobber each other because there is no file locking.

OpenBoard-managed task worktrees live under `.opencode-board-worktrees/`.
Do not delete dirty task worktrees or `board/task_*` branches unless the user
explicitly approves that cleanup. If cleanup is approved, constrain it to
OpenBoard-managed paths and verify with `git worktree list`, `git branch
--list 'board/task_*'`, and `git status --short --branch`.

Review is a checkpoint, not acceptance. Moving a task to Done requires a named
acceptor. Integrating worktree output requires review confirmation.

## Safety And Data Hygiene

Treat board access as local shell access. Do not expose board or OpenCode ports
outside loopback.

Never commit generated or sensitive runtime files:

- `dist/`
- `node_modules/`
- `.env*`
- `*.sqlite*`
- `*.log`
- `.opencode-board-worktrees/`
- `.claude/worktrees/`
- `.DS_Store`

Do not expose tokens, private keys, local registry tokens, SQLite data, or
session logs containing sensitive prompts.

## Documentation Discipline

Keep README/GUIDE aligned with behavior when user-facing commands, launch
paths, lifecycle semantics, or safety rules change.

Do not turn readiness gaps into OpenBoard cards unless the user explicitly
approves that planning step. The agent-readiness skill is report-only.

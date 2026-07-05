# OpenBoard

Skills that turn a coding-agent session into an **OpenBoard orchestrator cockpit**: assess
whether a repo is ready for autonomous work, plan a multi-agent run, dispatch OpenCode agents
onto an OpenBoard board, and verify the results — with the human in the pilot seat.

Multi-platform: the same `skills/` tree is used by **Claude Code** (`.claude-plugin`),
**Codex** (`.codex-plugin`), and **OpenCode** native skills.

## Install

The canonical plugin package is this directory inside the OpenBoard repo. It is
shipped as source, so the MCP server must be built before the plugin can connect:

```sh
cd /path/to/openboard
npm install
npm run build:mcp          # produces dist/mcp/server.mjs
```

Then install it into your agent harness:

- **Claude Code** — symlink or copy `plugins/openboard` into your Claude Code
  plugins directory (e.g. `~/.claude/plugins/openboard`). Symlinking keeps this
  copy authoritative and lets `mcp-server.mjs` resolve the bundle through the
  symlink.
- **Codex** — follow Codex CLI plugin conventions for the `.codex-plugin`
  directory.
- **OpenCode native** — copy or symlink `plugins/openboard/skills/` into your
  OpenCode skills directory.

If you copy the plugin elsewhere, the bootstrap script can no longer find
`dist/mcp/server.mjs` automatically. Set the absolute path explicitly:

```sh
export OPENCODE_BOARD_MCP_SERVER=/absolute/path/to/openboard/dist/mcp/server.mjs
```

The `.mcp.json` entry will use that path instead of the relative resolution.

## Source Of Truth

This repo copy is the canonical OpenBoard plugin package. Personal installs such as
`~/plugins/openboard` and Codex's installed cache should be synced from this directory after any
plugin edit.

Keep shared content identical across harnesses:

- `skills/`
- `README.md`
- `.mcp.json`

Keep harness-specific wrappers specific to their harness:

- `.codex-plugin/plugin.json` for Codex metadata/default prompts.
- `.claude-plugin/plugin.json` plus `hooks/` for SessionStart-capable harnesses
  such as Claude Code and observed Codex CLI plugin sessions.
- OpenCode uses direct skill discovery from its configured skills directory;
  its plugin should stay a thin startup hook, not a copy of the full skill bodies.

## Skills

- `startup` — connect to or start OpenBoard, verify the visible TUI/API/MCP surface, and hand off
  board facts (URL, roster, task state). Run this first.
- `agent-readiness` — score a repository's readiness for autonomous agent work and report the
  gaps (report-only; never creates cards).
- `board-plan` — design the run before dispatch: workflow shape, file-disjoint decomposition,
  agent profiles + model/provider selection, cards-as-contracts, and the failure policy.
- `create-profile` — create or repair OpenCode agent profiles with staged validation, safe
  install, restart discipline, and roster proof before cards use them.
- `openboard-orchestrator` — dispatch scoped cards, monitor runs, review worktrees, integrate
  safely, run role loops, clean up ephemeral profiles, and report verified status.

## Flow

```
startup → agent-readiness → board-plan → create-profile → openboard-orchestrator
```

Establish the board, optionally assess repo readiness, plan the run, validate any custom
profiles, then dispatch and verify.

## Components

- **Bundled MCP server** (`.mcp.json`) — a local `openboard` server that auto-connects to the
  board and exposes guarded orchestrator tools for task create/list, dependencies, run/retry/
  abort/move, structured complete/block reports, sync/integrate, comments, and task events.
  Reads `OPENCODE_BOARD_URL`; in multi-instance workflows, select an instance first and set
  that URL explicitly. It does not assume a default board port. `integrate_task` requires
  `confirmReviewed: true`; Done moves require explicit `completedBy`.
- **SessionStart hook** (`hooks/`) — frames a fresh session as the orchestrator
  cockpit and injects the flow in SessionStart-capable harnesses. Claude Code uses
  this path, and Codex CLI plugin sessions have been observed to follow it too.
  The `startup` skill remains the required first-skill contract and repeats the
  same framing in its "Session Role" section.
- **OpenCode startup hook** (`~/.config/opencode/plugins/openboard.js` globally) — injects only the
  short cockpit/session-start contract. The full instructions live in native
  OpenCode skills installed at `.opencode/skills/<name>/SKILL.md` or
  `~/.config/opencode/skills/<name>/SKILL.md`.
  OpenCode docs say global skills should load from `~/.config/opencode/skills`,
  but OpenCode 1.17.13 on this machine returns zero skills when launched from
  `~`, `~/code`, or `/tmp`. Work around that by starting from the target
  repository or passing the project path, e.g. `opencode /path/to/repo`.

## Usage

Start OpenBoard, open a coding-agent session in the target repo, and let the flow run —
`startup` establishes the board, then the session can assess readiness, plan the run with you,
and orchestrate it. Nothing dispatches or integrates without your approval.

### Auth token

If the selected OpenBoard instance requires authentication (the default after the
security hardening), the MCP server process must receive the per-instance
board token. The easiest way is to set the token in the process environment
before launching the agent harness:

```sh
export OPENBOARD_API_TOKEN=<instance-token>
export OPENCODE_BOARD_URL=http://127.0.0.1:4097
```

The bundled MCP server reads `OPENBOARD_API_TOKEN` and sends it as a bearer
token on board API requests. Local OpenBoard clients (TUI and CLI) inject the
token automatically.

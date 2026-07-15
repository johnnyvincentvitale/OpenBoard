# OpenBoard

Skills that turn a coding-agent session into an **OpenBoard orchestrator cockpit**: assess
whether a repo is ready for autonomous work, plan a multi-agent run, dispatch OpenCode agents
onto an OpenBoard board, and verify the results — with the human in the pilot seat.

Multi-platform: the same `skills/` tree is used by **Claude Code** (`.claude-plugin`),
**Codex** (`.codex-plugin`), and **OpenCode** native skills.

## Install

The canonical plugin package is this directory inside the OpenBoard repo. It is
shipped as source and uses the installed `openboard` CLI for MCP:

```sh
cd /path/to/openboard
npm install
npm run build:app
npm link                   # exposes the `openboard` CLI on your PATH
```

Then install it into your agent harness:

- **Claude Code** — symlink or copy `plugins/openboard` into your Claude Code
  plugins directory (e.g. `~/.claude/plugins/openboard`).
- **Codex** — follow Codex CLI plugin conventions for the `.codex-plugin`
  directory.
- **OpenCode native** — copy or symlink `plugins/openboard/skills/` into your
  OpenCode skills directory.

The `.mcp.json` entry runs `openboard mcp`, so copied and symlinked plugin
installs behave the same way. It starts unbound; use `select_instance` from the
MCP client. Start a bound worker process with `openboard mcp --instance <name>
--worker` when the instance is already known; add `--task-id <task-id>` only
when that MCP process belongs to one task.

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
- `.claude-plugin/plugin.json` for Claude plugin metadata.
- OpenCode uses direct skill discovery from its configured skills directory;
  no OpenBoard startup plugin is required.

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

- **Bundled MCP server** (`.mcp.json`) — a local `openboard` server that binds to the
  selected board and exposes guarded orchestrator tools for task create/list, dependencies, run/retry/
  abort/move, structured complete/block reports, sync/integrate, comments, and task events.
  Normal plugin launches run `openboard mcp` unbound and then bind with
  `select_instance`; worker/generated configs can use `openboard mcp --instance
  <name> --worker` so the CLI injects the selected board URL and token. The
  worker profile advertises only `task_diff`, `task_context`, `task_compare`,
  `complete_task`, and `block_task`; task-specific ACP launches also bind the
  assigned task ID, completion reports require the current `runStartedAt`, and
  dispatched OpenCode sessions deny every other `openboard_*` tool. This is an
  MCP interface boundary, not an OS sandbox. It does not assume a default board
  port. `openboard_status` proves the controlled instance. `integrate_task`
  requires `confirmReviewed: true`; Done moves
  require explicit `completedBy`.
- **Skills** (`skills/`) — expose the OpenBoard workflow without automatically
  forcing unrelated sessions into orchestration mode. Agents should invoke
  `startup` only when the user is actually doing OpenBoard work.
- **OpenCode native skills** — the full instructions live in native OpenCode
  skills installed at `.opencode/skills/<name>/SKILL.md` or
  `~/.config/opencode/skills/<name>/SKILL.md`; no global OpenBoard startup hook
  is required.
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
security hardening), plugin MCP starts unbound through the installed CLI:

```sh
openboard mcp
```

Then call `select_instance` from the MCP client to bind to the running board.
For manual orchestrator use, the named-instance wrapper retains the full
cockpit while injecting the board URL, instance name, and per-instance token:

```sh
openboard mcp --instance <name>
```

Generated worker configs use the restricted profile:

```sh
openboard mcp --instance <name> --worker
```

Add `--task-id <task-id>` only for a task-specific worker process.

Manual `OPENBOARD_API_TOKEN` + `OPENCODE_BOARD_URL` remains available for custom
scripts, but normal plugin use should not require env export. The MCP
server sends the token as a bearer token on board API requests and never exposes
the token through status tools.

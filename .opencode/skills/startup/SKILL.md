---
name: startup
description: >
  Mandatory first OpenBoard skill. Use whenever the OpenBoard plugin is loaded
  for an orchestration session, when the user asks to "connect to OpenBoard",
  "start OpenBoard", "use /startup", "check the OpenBoard app", or before
  creating, running, judging, or inspecting cards. Use when a named OpenBoard
  instance must be selected, when OPENCODE_BOARD_URL may be unset, or when
  MCP/API/TUI alignment matters.
---

# Startup

Establish the selected OpenBoard control surface before any orchestration
skill creates or judges cards. The V1 surface is the named-instance TUI plus
the `openboard` CLI; there is no browser board. Do not assume a running
server, a default port, or that a previous session points at the board the
user is viewing — prove the selected instance, endpoint, task store, and agent
roster in the current turn.

## First-Skill Contract

1. Treat the session as the orchestrator cockpit: the user drives; workers are
   sessions the board dispatches.
2. Prove board state (Connect, below) and bind MCP (MCP Readiness, below)
   before dispatching or judging anything.
3. Probe ACP harness availability with `GET /api/acp-config` (server-cached
   ~30s; `/api/acp-models` is the models-only projection). For each of the six
   ACP harnesses — `claude-code`, `codex`, `gemini-acp`, `hermes`,
   `pi-coding-agent`, `cursor-acp` — record whether `available` is true and
   the reported `modes`/`models`. A harness with `available: false` (or an
   `error` field) has no launchable adapter and must not be assigned work.
   This probe is the source of truth for `board-plan` harness selection and
   `create-profile`. If the endpoint is unreachable, say ACP availability is
   unverified and treat all ACP harnesses as unproven.
4. Offer: "Would you like me to assess your repository's readiness for agentic
   development?" If yes, run `agent-readiness` and return the report — do not
   create cards from its gaps.
5. Then `board-plan` (run design) → `create-profile` (any custom OpenCode
   profiles) → `openboard-orchestrator` (execution), keeping the user in
   control and reporting only verified board/work state.

## Step Completion Gate

Close every OpenBoard phase explicitly before starting the next:

```text
STEP COMPLETE: <startup | readiness | planning | profile creation | dispatch/review>
VERIFIED: <one-line evidence>
NEXT STEP: <the next skill or action>
Ready to move on to <next step>?
```

Do not silently stop after a phase or silently begin the next one. Wait for
confirmation unless the user already approved a multi-step run this turn.

## Connect

1. Select the instance before resolving a URL: use the instance the user names
   or the visible TUI shows; otherwise inspect `openboard list` and ask when
   more than one running or registered instance could match. Use an explicit
   `OPENCODE_BOARD_URL` only when the user or environment clearly chose a
   non-registry board.
2. Resolve the URL: the registry port from `openboard list` or
   `~/.config/openboard/instances.json`; `http://127.0.0.1:4097` only as a
   legacy single-board fallback after confirming there is no named-instance
   selection to make. If nothing can be selected safely, stop and ask instead
   of probing a default port.
3. Probe the selected adapter: `GET /api/agents` and `GET /api/tasks`.
4. Confirm the TUI and API match: the task list includes the cards the user
   can see, or tell the user the endpoint is a different board/store.
5. Startup side effect: bringing up a named instance runs a best-effort
   orphan-worktree sweep — clean orphans in remembered repos are pruned, dirty
   ones kept. A worktree that vanished after you started the instance may have
   been a clean orphan, not a bug.

## MCP Readiness

The plugin bundles a local `openboard` MCP server (`.mcp.json` runs
`openboard mcp`, unbound). Bind it with `select_instance` after proving the
intended running instance, or launch pre-bound with `openboard mcp --instance
<name>` so the CLI injects `OPENCODE_BOARD_URL`, `OPENBOARD_API_TOKEN`, and
`OPENBOARD_INSTANCE_NAME`. Manual `OPENCODE_BOARD_URL` is an advanced escape
hatch; MCP must never probe or silently fall back to `4097`. The MCP server
requires a running board and the `openboard` CLI.

Tools (a guarded control surface over the task API):

- `openboard_status` — selected instance/URL, workspace, DB identity, API reachability, cheap counts.
- `current_instance`, `list_instances`, `select_instance` — inspect/switch named-instance targets.
- `list_agents` / `list_tasks` — must match `GET /api/agents` / `GET /api/tasks`.
- `create_task` / `add_tasks` — create cards visible in the TUI.
- `link_tasks` / `unlink_tasks` — dependency edges.
- `run_task`, `retry_task`, `abort_task`, `move_task` — execution and placement.
  Moving to Done requires explicit `completedBy`; never silently default it.
- `complete_task` / `block_task` — structured worker completion reports.
- `sync_task` / `integrate_task` — worktree merges; integrate requires `confirmReviewed: true`.
- `comment_task` / `add_note`, `task_events` — scoped comments and durable task events.
- `task_diff` — structured Review-card diff without shelling into worktrees.

Verify the MCP client points at the board the user is viewing: `list_tasks`
must match the visible cards and the selected instance's `GET /api/tasks`. If
MCP reports no selected instance, use `list_instances` or `openboard list`,
then `select_instance({ name })` for an already-running instance. If MCP is
unavailable, use the adapter API directly and say MCP was not the control path.

## Handoff

Hand the next skill these facts:

- Selected instance name, or "explicit URL" / "legacy single-board fallback".
- Board URL, surface type (named-instance TUI or API-only dev server), and
  whether the TUI is visible.
- Agent roster summary.
- ACP harness availability from `GET /api/acp-config`: per-harness `available`
  plus reported modes/models. Downstream skills must not assign a harness that
  reported `available: false` or was not probed.
- Existing relevant card IDs and columns.
- Any mismatch between visible TUI, API, and MCP.
- Profile/roster restart target: the exact instance name to stop/start when
  profile changes must load; for explicit `OPENCODE_BASE_URL` boards, OpenBoard
  does not own the OpenCode process — the operator restarts it.

Then ask whether to move to repository readiness. Do not proceed without the
user's confirmation unless they already requested the full sequence.

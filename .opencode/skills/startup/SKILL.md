---
name: startup
description: >
  Mandatory first OpenBoard skill. Use whenever the OpenBoard plugin is loaded
  for an orchestration session, when the user asks to "connect to OpenBoard",
  "start OpenBoard", "use /startup", "check the OpenBoard app", or before
  creating, running, judging, or inspecting cards. Use when a named OpenBoard
  instance must be selected, when OPENCODE_BOARD_URL may be unset, when
  MCP/API/TUI alignment matters, or when browser fallback needs to be labeled.
---

# Startup

Establish the selected OpenBoard control surface before any orchestration skill creates or judges cards. Prefer the named-instance TUI when the task is about the primary user experience, board persistence, or what the user sees. Use browser fallback only when the user explicitly accepts a dev-server surface.

Do not assume a running server, default port, old browser tab, or previous session points at the same board the user is viewing. Prove the selected instance, endpoint, GUI/TUI surface, task store, and agent roster in the current turn.

## Session Role

When the user explicitly invokes OpenBoard work, treat the session as the
orchestrator cockpit. The user drives from here; the worker agents are OpenCode
sessions the board dispatches. This `startup` skill is the first-skill contract:
verify the selected instance before acting and do not rely on automatic session
hooks to enter OpenBoard mode.

## First-Skill Contract

Follow this sequence before any OpenBoard work:

1. Treat this session as an OpenBoard cockpit, not a normal coding/chat session.
2. Prove board state first with `startup`: identify the selected named instance
   or explicit board URL, start plugin MCP with `openboard mcp` and bind it with
   `select_instance` unless the caller already provided `--instance`, verify
   API/MCP/GUI/TUI alignment, and confirm this session is looking at the same
   board and task store the user sees.
3. Do not dispatch work or judge cards until the board surface is established.
4. After board proof, ask: "Would you like me to assess your repository's
   readiness for agentic development?"
5. If yes, run `agent-readiness` and return the report.
6. Then use `board-plan` to design the workflow, agents/profiles/models, and
   card shape.
7. Use `create-profile` for any custom OpenCode agent profiles before cards
   depend on them.
8. Then use `openboard-orchestrator` to drive execution, keeping the user in
   control and reporting only verified board/work state.

## Step Completion Gate

At the end of every OpenBoard phase, explicitly close the step before doing the
next one. Use this pattern:

```text
STEP COMPLETE: <startup | readiness | planning | profile creation | dispatch/review>
VERIFIED: <one-line evidence>
NEXT STEP: <the next skill or action>
Ready to move on to <next step>?
```

Do not silently stop after a phase, and do not silently begin the next phase.
Wait for the user's confirmation unless the user already gave explicit approval
for a multi-step run in the current turn. If the user says yes, continue with
the next skill immediately.

## Connect

1. Determine the intended surface:
   - Named-instance TUI for normal OpenBoard testing.
   - Browser fallback only for frontend/dev-server checks.
   - Existing app process when the user says it is already running.
2. Select the board instance before resolving a URL:
   - If the user names an instance, use that instance.
   - If the visible TUI/GUI shows an instance, use that instance.
   - Otherwise inspect the named-instance registry with `openboard list` and
     ask the user which instance to use when more than one running or registered
     instance could match the request.
   - Use an explicit `OPENCODE_BOARD_URL` only when the user or environment has
     clearly chosen a non-registry board.
3. Resolve the board URL for the selected instance:
   - For named instances, use the registry port shown by `openboard list` or
     `${HOME}/.config/openboard/instances.json`.
   - For explicit URLs, use `OPENCODE_BOARD_URL`.
   - Use `http://127.0.0.1:4097` only as a legacy single-board fallback after
     confirming there is no named-instance selection to make.
   - If no instance/URL can be selected safely, stop and ask for the intended
     instance instead of probing a default port.
4. Probe the selected adapter before acting:
   - `GET /api/agents`
   - `GET /api/tasks`
5. Confirm the TUI and API match:
   - The task list includes the cards the user can see, or
   - The user has been told that the selected endpoint is a different board/store.
6. Note the startup side effect: bringing up a named instance runs a
   best-effort orphan-worktree sweep — clean orphan worktrees in remembered
   repos are pruned; dirty ones are kept. If you started the instance this turn,
   a worktree that vanished may have been a clean orphan, not a bug.

## Browser Fallback

Use browser fallback only when the task is explicitly about development UI checks or the user accepts the distinction:

```sh
npm run dev:server
npm run dev
```

Label all evidence from this surface as browser/dev-server evidence.

## MCP Readiness

The plugin bundles a local `openboard` MCP server (`.mcp.json`). Normal plugin
launches run `openboard mcp` without a selected board; bind the process with
`select_instance` after proving the intended running instance. Generated worker
configs or manual terminal sessions may start MCP through `openboard mcp
--instance <name>` so the CLI injects `OPENCODE_BOARD_URL`,
`OPENBOARD_API_TOKEN`, and `OPENBOARD_INSTANCE_NAME` for the selected running
instance. Manual `OPENCODE_BOARD_URL` remains an advanced escape hatch, but MCP
must never probe or silently fall back to `4097`. It exposes guarded
orchestrator tools for board control:

- `openboard_status` — proves selected instance/URL, workspace, DB identity, API reachability, and cheap counts.
- `current_instance`, `list_instances`, `select_instance` — inspect/switch explicit named-instance targets.
- `list_agents` — should match `GET /api/agents` (the assignable roster).
- `list_tasks` — should match `GET /api/tasks` (avoid duplicate cards).
- `create_task` / `add_tasks` — create manual or agent cards visible in the GUI.
- `link_tasks` / `unlink_tasks` — manage task dependencies.
- `run_task`, `retry_task`, `abort_task`, `move_task` — control task execution and placement.
- `complete_task` / `block_task` — submit structured worker reports.
- `sync_task` / `integrate_task` — worktree merge controls; integrate requires `confirmReviewed: true`.
- `comment_task` / `add_note`, `task_events` — scoped comments and durable task events.

Verify the MCP client points at the same selected board the user is viewing:
`list_tasks` over MCP must match the visible cards and the selected instance's
`GET /api/tasks`. If MCP reports no selected instance, use `list_instances` or
`openboard list`, then call `select_instance({ name })` for an already-running
instance. If you control the launch command, `openboard mcp --instance <name>`
is also valid. The MCP server requires the board to be running and the built
`dist/mcp/server.mjs` bundle. MCP Done moves require explicit `completedBy`; the
tool layer must not silently default completion attribution.

If MCP is unavailable, use the adapter API directly and state that MCP was not the control path.

## Offer Readiness

Once the board surface is proven, offer the user a repository readiness
assessment before planning a run: "Would you like me to assess your repository's
readiness for agentic development?" If they accept, run the `agent-readiness`
skill and return its report. Do not create cards from the readiness gaps — the
report is for the user to act on.

## Handoff

When startup is complete, hand the orchestrator these facts:

- Selected instance name, or "explicit URL" / "legacy single-board fallback".
- Board URL.
- Surface type: named-instance TUI, browser fallback, or API-only.
- Whether the TUI is visible.
- Agent roster summary.
- Existing relevant card IDs and columns.
- Any mismatch between visible GUI, API, and MCP.
- Profile/roster restart target: for named instances, the exact instance name
  to stop/start when profile changes must be loaded; for explicit
  `OPENCODE_BASE_URL` boards, state that OpenBoard does not own the OpenCode
  process and the external server must be restarted by the operator.

Then ask whether to move to repository readiness. Do not proceed without the
user's confirmation unless they already explicitly requested the full sequence.

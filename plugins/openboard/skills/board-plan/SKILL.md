---
name: board-plan
description: >
  This skill should be used when the user asks to "plan the board", "how should
  I run agents in this repo", "set up a multi-agent workflow", "/board-plan",
  "choose models for my agents", "which OpenCode agents should I use", or wants
  to design a multi-agent run before dispatching. Use after startup and any
  requested readiness report, before the orchestrator dispatches cards, to lock
  the run shape, the card contracts, the worker harnesses, the agent profiles,
  and the model/provider setup.
---

# Board Plan

Design the multi-agent run before anything dispatches. The output is a run
plan the user approves: workflow shape, waves, card contracts, harness
choices, agent profiles, model assignments, and a verified-green baseline.

Native vs procedural: OpenBoard natively provides dependency links
(`link_tasks` / `unlink_tasks`; run/retry return 409 on unmet parents) and
completion contracts (`/complete`, `/block`). Auto-promotion of ready
children, per-card retry caps, and role-loop round-trip caps are NOT native —
the orchestrator session enforces them procedurally, and this plan is where
they get defined.

Plan, do not implement: work that needs doing goes on a card. Assume `startup`
established the board surface and probed `GET /api/acp-config`. Use the
`agent-readiness` report if one exists — its verified build/test command is
the verification currency for the whole run. If there is no runnable
build/test command, stop: an unattended run cannot verify itself.

## Decide What Deserves A Card

Make a card when the work crosses agent boundaries, should survive restarts,
may need human input, or should be discoverable afterward. Keep quick lookups
and trivial edits in the orchestrator session. Namespace the run's cards with
a shared title prefix (e.g. `[Payments]`) so the run is judged independently
of existing board state.

## Pick The Workflow Shape

Offer the user named shapes rather than a blank page:

- **Solo pipeline** — one agent, sequential cards. No isolation needed.
- **Fan-out** — N agents of one role on file-disjoint areas, one integration
  pass. The default for feature work.
- **Waves** — fan-out with dependencies: wave N+1 dispatches only after wave N
  is integrated and green.
- **Role loop** — two or more roles (e.g. coder + auditor) exchanging cards
  until an acceptance condition passes. Use when quality gating matters more
  than throughput.
- **Arena / quorum** — N agents attempt the same problem in separate
  worktrees; the orchestrator or user judges and keeps the winner.
- **Typed evidence graph** — map task kinds (below) onto any shape above when
  the run needs explicit evidence, interpretation, implementation, review, or
  repair stages.

Serial at the edges, parallel in the middle: setup and integration are always
serial; only execution parallelizes. Decompose along the file tree (feature
directories, packages, modules) so agents are file-disjoint by construction.
When parallel work shares interfaces, freeze the shared contracts serially
before fan-out, and give every shared file (root wiring, package manifest)
exactly one owner — usually the integration pass. Install dependencies once,
before fan-out, never per-agent.

## What `isolation: "worktree"` Enforces

On the OpenCode lane, a worktree-isolated card gets a dedicated git worktree
plus:

- **Write-fence.** File-tool writes outside the worktree are denied at the
  permission layer (reads outside are allowed); the fence is fail-closed.
- **Escape detector.** The base checkout's git status is snapshotted at
  dispatch and re-checked before Review and before Integrate; a detected
  escape blocks the card with `pending: "base-checkout-escape"`.
- **Bash is NOT syscall-fenced.** OpenBoard does not sandbox shell commands;
  rely on worktree cwd discipline plus the escape detector, and prefer read
  tools for parent/sibling inspection.

ACP harness cards (`claude-code`, `codex`, `gemini-acp`, `hermes`,
`pi-coding-agent`, `cursor-acp`) can run in a task worktree and still get the
base-checkout escape detector, but they do NOT get OpenCode's file-tool
fence — the worker process is unfenced. Label them "worktree cwd, unfenced
tools" instead of implying OpenCode-level protection.

File-disjoint decomposition remains the primary boundary — it keeps merges
clean and Review legible. The fence/detector stack is the structural backstop
underneath it.

## Design Worker Harnesses And Agent Profiles

Count roles, not workers, and choose the harness before the profiles:

- `harness: "opencode"` — dispatches through OpenCode's agent roster. Each
  assignable agent must appear in `GET /api/agents` with a concrete model;
  OpenBoard materializes that roster model onto `task.model` when the card is
  created (explicit model override only when the approved plan calls for it).
  Planned OpenCode runs normally use custom profiles so role behavior,
  provider, and model are explicit and roster-verifiable before dispatch.
- `harness: "claude-code"` — dispatches Claude Code over ACP, with a Claude
  Code model and a `permissionMode` such as `bypassPermissions`. Do not create
  an OpenCode profile pretending to be Anthropic when the intended executor is
  Claude Code.
- Other ACP harnesses (`codex`, `gemini-acp`, `hermes`, `pi-coding-agent`,
  `cursor-acp`) — the same ACP path backed by a different agent. Experimental
  and adapter-gated: usable only when `/api/acp-config` reports the adapter
  `available` (models, modes, and options are discovered live per harness, and
  freeform model IDs are allowed). Default real runs to `opencode` or
  `claude-code`. Same permission-mode set and unfenced posture as the Claude
  Code lane.

**One OpenCode role, N lanes** (fan-out/waves): generate N named profiles from
a single prompt template so the prompts cannot drift — profiles differ only in
`name`, `color`, and `model`. The boundary lives in the card and the worktree,
not the agent prompt; say so in the plan. Per-lane models are the point:
cheap/free models on light lanes, stronger models on hard ones, all verified
in the live roster before any cards are created.

**Multiple OpenCode roles** (role loop): one profile per role, each with its
own system prompt (the coder implements and hands off evidence; the auditor
reviews adversarially and never fixes). A custom prompt may REPLACE OpenCode's
default agent prompt rather than extend it, so each role prompt must carry its
own agentic-coding instructions; verify a role profile against one real
dispatch before building a run on it. The loop is orchestrator-mediated —
you author every hop; workers must not create or move cards. Spawned OpenCode
workers do receive the injected `openboard` MCP server, but dispatch guidance
limits its use to `task_diff` inspection and `complete_task`/`block_task`
reports. Define the loop's exit condition (e.g. the audit card completes with
no findings) and a round-trip cap in the plan; the runtime procedure lives in
`openboard-orchestrator`.

Cross-provider defaults and mid-run recovery:

- **Default to cross-provider review** in role loops: coder, auditor, and
  fixer on different providers. Same-provider review rubber-stamps;
  cross-provider audit catches defects the fix wave itself introduced.
- **Per-card model override is the mid-run escape hatch.** When a profile or
  provider breaks mid-run, re-lane via `agent=<working-profile> +
  model=<working-model>` instead of editing profiles (profile edits need a
  restart, which kills board state). Reserve profile edits for run boundaries.
- **WIP salvage**: when a worker dies with uncommitted work, commit it on the
  `board/*` branch and have the takeover card merge it, stating "treat merged
  WIP as unreviewed input" in the takeover prompt.

OpenCode profile hygiene:

- Give every profile a distinct `color` so agent badges are scannable during
  concurrent runs.
- Define profiles in `~/.config/opencode/agents/<name>.md` (frontmatter + body
  = the system prompt) with `mode: primary` so they appear in the assignable
  roster — `subagent`-mode profiles serve OpenCode's internal task tool
  instead. Docs use `agents/` (plural); verify the path your installed version
  honors by checking the roster.
- Assign models only from authenticated, enabled providers; name a fallback
  model per profile in case a provider preflight fails at run time.
- Back up existing agent files with the same names; stop and ask before
  overwriting shared global config.
- Record each profile's lifecycle in the plan: **ephemeral** (removed by the
  orchestrator at run end, backups restored) or **durable** (a standing role,
  kept deliberately). Default to ephemeral so the global roster does not
  accumulate orphans.

Write a **Profile Manifest** whenever custom profiles are needed — the
contract `create-profile` and `openboard-orchestrator` verify mechanically:

```text
PROFILE MANIFEST
- id: <profile filename/id>
  role: <coder | auditor | fixer | planner | ...>
  harness: opencode
  provider: <openai | openrouter | ...>
  model: <provider/model-id as written in profile frontmatter>
  expectedMode: primary
  expectedRosterModel: <model id exactly as /api/agents should report it>
  lifecycle: ephemeral | durable
  restartRequired: true
  overwrite: none | backup-required | approved-durable-update
```

For Claude Code cards, write a **Harness Manifest** row instead:

```text
HARNESS MANIFEST
- id: <lane/card role id>
  role: <coder | auditor | fixer | ...>
  harness: claude-code
  model: <claude-code model id supported by the product, such as claude-code/sonnet>
  claudePermissionMode: <acceptEdits | auto | bypassPermissions | manual | dontAsk | plan>
  expectedStoredHarness: claude-code
  expectedStoredModel: <model id exactly as task.model should report>
  expectedStoredPermissionMode: <permission mode exactly as task should report>
  lifecycle: card-scoped
  restartRequired: false
```

Do not let later phases infer profile or harness intent from prose; the
manifests drive profile installation, roster proof, task-model
materialization, dispatch eligibility, and cleanup.

OpenCode config is not hot-reloaded: after profile edits, the selected
OpenBoard instance or external OpenCode server must be restarted, and
`GET /api/agents` (or MCP `list_agents`) must show every planned profile with
the expected `mode` and `model` before any card is created. The Claude Code
gate is different: no OpenCode profile or roster proof — the selected build
must support Claude Code cards, and the created task record must store
`harness: "claude-code"`, the intended model, and the intended
`claudePermissionMode`.

## Establish The Green Baseline

Every worktree branches from a verified-green commit:

1. Dependencies installed; build and test commands pass; committed, so
   worktrees have a clean base.
2. **Worktree bootstrap check:** untracked files (`node_modules`, `.env`) do
   not follow into fresh worktrees, and relative paths that escape the repo
   may break. Prove a fresh worktree can install and build before fan-out, or
   make setup step 1 of every card. Known traps:
   - Vitest/Vite temp paths: set `VITEST_TMPDIR` and Vite `cacheDir` to a
     worktree-local location, or tests hit EPERM writing through base-repo
     `node_modules`.
   - Python: `.venv` is not in the worktree — commit it, bootstrap it per
     card, or use absolute venv tools from the base repo.
   - Runner binaries (e.g. `tsx` ENOENT in fresh worktrees): add a bootstrap
     hook or a scoped test command.
3. For audit/synthesis cards that need parent evidence, rely on the injected
   `task_diff`-first parent inspection guidance; prefer read/grep/list tools
   over shell commands for anything beyond parent diffs.

## Choose Task Kinds And Dependencies

Every planned card declares its `taskKind` — the kind shapes the dispatched
context and handoff guidance without changing the prompt or the completion
shape. Do not leave meaningful workflow roles as `none`:

- `none` — generic; only when no role fits.
- `research` — gather factual findings, evidence, repo observations; usually
  changes no product files.
- `synthesis` — read parent context first and evaluate findings for agreement,
  conflict, evidence strength, gaps, implications. The prompt's requested
  output shape is authoritative — do not pre-bias toward "combining".
- `build` — create or modify the requested implementation in cwd, inspecting
  relevant cwd files before editing.
- `audit` — inspect only; report findings with severity/confidence and
  residual risk. Do not fix.
- `fix` — resolve specific parent findings, tying each change back to its
  finding and calling out unfixed ones.

Use dependency links for information flow, not prose duplication. A linked
child will not run until parents are satisfied; at dispatch OpenBoard injects
one `PARENT CONTEXT` section that directs workers to inspect parent code with
the `task_diff` MCP tool first (read-only parent worktree reads are the
fallback), marks parent worktrees read-only, states that the child cwd starts
from base (un-integrated parent changes must be reapplied), and lists each
parent as `PARENT-000`, `PARENT-001`, ... with worktree, task id, branch,
summary, changed files (worktree-relative when possible), verification, and
residual risk.

Useful kind mappings onto any shape: research fan-out → one `synthesis` child;
research → `build` directly when the direction is already clear; a `synthesis`
card proposing the next build/audit graph for the orchestrator/user to decide
on; `build` parents → one `audit` child; `audit` + the relevant build/synthesis
parent → `fix`; `fix` → `audit` when quality gates matter.

## Write Cards As Contracts

The card body is the only channel OpenBoard gives a worker — it carries the
whole contract:

- Title with the run's namespace prefix.
- Absolute working directory (`directory` field); `isolation: "worktree"` for
  anything concurrent.
- `taskKind` and parent links (`link_tasks` / `parentIds`).
- Worker harness. OpenCode cards: the assigned agent (roster model
  materialized onto `task.model`; overrides recorded in the plan and verified
  after creation). Claude Code cards: no OpenCode profile — store the Claude
  Code model and `claudePermissionMode` explicitly on the task.
- The boundary, restated: which files/directories this card may touch.
- Acceptance criteria concrete enough to judge Review against — the board's
  first idle means "end of turn", not "done".
- The verification command(s) that must pass in the worktree before Integrate.
- A required handoff: end with a summary of what changed, what was run, and
  what passed, so the next wave or opposing role inherits evidence.

**Absolute paths:** the `directory` field is the only absolute path anywhere
on the card. Absolute paths in the prose body can steer a worker to edit the
main checkout directly — the worker treats the body as authoritative — even
though the injected worktree preamble, write-fence, and escape detector exist
as backstops. Keep every body path repo-relative and rely on the injected
preamble for cwd guidance. Do not paste parent handoffs into child prompts;
link the parents.

Create cards through MCP `create_task` / `add_tasks`; check `list_tasks` first
to avoid duplicates.

## Set The Failure Policy

Decide before dispatch, not mid-thrash:

- Retry a failed card at most twice; then stop and surface it with the error.
- A stalled In-Progress card gets its session inspected, not re-dispatched.
  Distinguish board-state bugs from hung sessions.
- Integrate is rebase-first: it rebases the task branch onto the target inside
  the worktree, then fast-forwards the base. A conflict never dirties the
  base — the card blocks with `pending: "rebase-conflict"` +
  `rebaseConflictPaths`, and resolution is retrying the same still-live
  session, which inherits the mid-rebase worktree. Declare who resolves
  conflicts and the retry budget.
- Declare fan-out integration order; Sync a worktree only when a later card
  genuinely needs the updated base.
- Plan non-Integrate endings: audit/QA/error-replaced cards leave worktrees.
  Discard (Review cards only) and delete clean them up — REST/TUI actions, not
  MCP tools — and a dirty worktree blocks removal unless forced or kept.
  Decide up front whether dirty abandoned work is salvaged (a manual git
  commit inside the worktree) or force-removed.
- Role loops get a round-trip cap in addition to the per-card retry cap.
- End every fan-out with one serial seam card: fix integration seams, run the
  full verification, add minimal smoke tests if needed.

## Hand Off To The Orchestrator

The approved plan hands `openboard-orchestrator`: the shape, the waves and
their promotion conditions, the card contracts, the manifests and agent/model
assignments, the baseline commit, the integration order, and the failure
policy. End with a step gate instead of dispatching automatically:

```text
STEP COMPLETE: planning
NEXT STEP: create-profile if custom profiles are needed; otherwise openboard-orchestrator
Ready to create/verify the profiles and then dispatch the planned cards?
```

Do not create profiles or cards until the user confirms. If the user already
approved a full end-to-end run this turn, state that approval before
continuing.

## Failure Modes

- Planning a run in a repo with no self-verifiable build/test command.
- Creating cards before the roster shows every planned profile with a concrete
  model, or failing to confirm the created task stored the intended
  harness/model/permission fields.
- Omitting `taskKind` on cards with clear roles; pasting parent handoffs into
  child prompts instead of linking parents.
- Creating OpenCode profiles for work meant to run on the Claude Code harness.
- N same-role profiles with hand-written (driftable) prompts instead of one
  template; role prompts that assume they extend the default prompt.
- Boundaries that exist only in card text, with no structural disjointness.
- Custom profiles without a Profile Manifest (expected mode/model/lifecycle).
- Fan-out from a dirty or unverified baseline; worktree cards that assume
  deps/env exist in a fresh worktree.
- Acceptance criteria too vague to judge Review against.
- Role loops with no exit condition or round-trip cap; unbounded retries.
- The orchestrator session implementing feature work itself instead of
  carding it.
- Finishing the plan and then silently stopping or silently dispatching.

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

Design the multi-agent run before anything dispatches. The output of this skill
is a run plan the user approves: workflow shape, waves, card contracts, worker
harness choices, agent profiles, model assignments, and a verified-green
baseline. OpenBoard provides native task dependency links (`link_tasks` /
`unlink_tasks`, with run/retry returning 409 on unmet parents) and native
completion contracts (`/complete`, `/block`); declare these in the plan.
Auto-promotion of ready children when a parent completes, per-card retry caps,
and role-loop round-trip caps are not native — the orchestrator session enforces
them procedurally, and this plan is where they get defined.

OpenBoard also stores a `taskKind` on each card: `none`, `research`,
`synthesis`, `build`, `audit`, or `fix`. The task kind changes the dispatch
context and handoff guidance without changing the user's prompt or the JSON
completion shape. Plan the kind deliberately; do not leave meaningful workflow
roles as `none`.

Plan, do not implement. The orchestrator session decomposes, dispatches,
reviews, and integrates; it does not write feature code itself. Work that needs
doing goes on a card.

Assume `startup` has established the board surface. Use the `agent-readiness`
report if one exists — its verified build/test command becomes the verification
currency for the whole run. If there is no runnable build/test command, stop:
an unattended run cannot verify itself, and planning one anyway is theater.

## Decide What Deserves A Card

Not all work belongs on the board. Make a card when the work crosses agent
boundaries, should survive restarts, may need human input, or should be
discoverable afterward. Keep quick lookups and trivial edits in the
orchestrator session. Namespace related cards with a shared title prefix
(e.g. `[ClipQueue]`) so the run is judged independently of existing board state.

## Pick The Workflow Shape

Offer the user named shapes rather than a blank page:

- **Solo pipeline** — one agent, sequential cards. No isolation needed.
- **Fan-out** — N agents of one role on file-disjoint areas, one integration
  pass. The default for feature work.
- **Waves** — fan-out with dependencies: wave N+1 dispatches only after wave N
  is integrated and green. Use when later work builds on earlier work.
- **Role loop** — two or more roles (e.g. a coder and an auditor) exchanging
  cards until an acceptance condition passes. Use when quality gating matters
  more than throughput.
- **Arena / quorum** — N agents attempt the same problem in separate worktrees;
  the orchestrator (or the user) judges and keeps the winner.
- **Typed evidence graph** — map `research`, `synthesis`, `build`, `audit`, and
  `fix` cards onto any of the shapes above. The types describe each card's role;
  they do not prescribe one fixed methodology. Use this when the run needs
  explicit evidence gathering, interpretation, implementation, review, or repair
  stages inside a solo pipeline, fan-out, waves, role loop, or arena/quorum.

Serial at the edges, parallel in the middle: setup and integration are always
serial; only execution parallelizes.

## What `isolation: "worktree"` Enforces

On the OpenCode lane, a worktree-isolated card always gets a dedicated git
worktree plus OpenBoard's file-tool fence and base-checkout escape detector.
Plan around these guarantees:

- **Write-fence.** File-tool writes outside the worktree are denied at the
  permission layer (reads outside are allowed); the fence is fail-closed.
- **Escape detector.** The base checkout's git status is snapshotted at
  dispatch and re-checked before Review and before Integrate; a detected escape
  blocks the card with `pending: "base-checkout-escape"` instead of advancing.
- **Bash sandbox (spawn mode, optional).** If the instance's desired bash
  sandbox setting is on and the macOS Seatbelt wrapper is available, bash tool
  calls run under that wrapper. If desired is on but unavailable, OpenCode
  worktree cards fail closed at dispatch (`runState: "error"`) before any
  session starts. If the user turns desired off, worktree cards still keep the
  file-tool fence and escape detector, but bash commands are not syscall-fenced.

File-disjoint decomposition remains a core part of the plan: it keeps merges
clean and Review legible, and it is how concurrent lanes stay independent. The
fence/detector stack is the structural backstop underneath that boundary, so a
single OpenCode file-tool mistake cannot reach the base checkout.

The Claude Code lane — and every other ACP harness (`codex`, `gemini-acp`,
`hermes`, `pi-coding-agent`, `cursor-acp`) — can still run in a task worktree,
but it does not get OpenCode's file-tool permission fence or bash sandbox.
OpenBoard still snapshots the base checkout for worktree ACP runs and blocks on
detected base-checkout escape, but the worker process itself is UNFENCED. Label
ACP worktree cards as "worktree cwd, unfenced tools" instead of implying the
same protection as OpenCode worktree cards.

## Decompose Along The File Tree

Parallel safety must be structural, not aspirational. Split work by the repo's
actual structure (feature directories, packages, modules) so agents are
file-disjoint by construction. When parallel work shares interfaces, freeze the
shared contracts serially before fan-out, and give every shared file (root
wiring, package manifest) exactly one owner — usually the integration pass.
Install dependencies once, before fan-out, never per-agent.

## Design Worker Harnesses And Agent Profiles

Count roles, not workers, but choose the worker harness before choosing profiles.
OpenBoard has more than one execution path:

- `harness: "opencode"` — dispatches through OpenCode's agent roster. Use this
  when the worker should be an OpenCode agent profile with a roster-visible
  provider/model.
- `harness: "claude-code"` — dispatches Claude Code over ACP. Use this when the
  worker should be Claude Code itself, with a Claude Code model selection and a
  `permissionMode` such as `bypassPermissions`. Do **not** create an OpenCode
  profile pretending to be Anthropic when the intended executor is Claude Code.
- Other ACP harnesses (`codex`, `gemini-acp`, `hermes`, `pi-coding-agent`,
  `cursor-acp`) — the same ACP path backed by a different agent. Treat these as
  **experimental and adapter-gated**: a harness is usable only when its adapter is
  installed and launchable, which the board reports through `/api/acp-config`
  (models, modes, and options are discovered live per harness, and freeform model
  IDs are allowed). Default real runs to `opencode` or `claude-code`; reach for
  these only after confirming the adapter is available. They carry the same
  `permissionMode` set and unfenced-by-default posture as the Claude Code lane.

Create one profile per distinct OpenCode behavior; parallel lanes are cards,
not identities. The live OpenCode roster is the board's model/provider source
of truth only for `harness: "opencode"` cards: each assignable OpenCode agent
must appear in `/api/agents` with a concrete model, and OpenBoard materializes
that roster model onto `task.model` when the card is created. Planned OpenCode
runs normally use custom profiles so role behavior, provider, and model are
explicit and roster-verifiable before dispatch.

Claude Code harness cards do not use OpenCode agent profiles. They must declare
their harness, Claude Code model, and permission mode in the card/task plan, and
the created task must be inspected before dispatch to prove those fields were
stored.

**One OpenCode role, N lanes** (fan-out/waves — e.g. eight coders on disjoint features):

- Generate N named profiles from a single prompt template so the prompts
  cannot drift. The profiles differ only in `name`, `color`, and `model`.
- One shared system prompt written for agentic coding; the boundary lives in
  the card and the worktree, not the agent prompt. Say so in the plan.
- Per-lane models are the point: assign cheap/free models to light lanes and
  stronger models to hard ones, then verify those models appear in the live
  roster before any cards are created.

**Multiple OpenCode roles** (role loop — e.g. coder + auditor):

- One profile per role, each with its own system prompt encoding its behavior:
  the coder implements and hands off evidence; the auditor reviews
  adversarially and never fixes — it reports findings and sends work back.
- A custom prompt may replace OpenCode's default agent prompt rather than
  extend it, so each role prompt must carry its own agentic-coding
  instructions. Verify a role profile against one real dispatch before
  building a run on it.
- The loop is orchestrator-mediated — workers never create cards and need no
  board access; the orchestrator authors every hop. The runtime procedure lives
  in the `openboard-orchestrator` skill; this plan only declares the loop.
- Define the loop's exit condition in the plan (e.g. the audit card completes
  with no findings), and cap the loop (e.g. three round trips) so two agents
  cannot volley forever.


### Cross-Provider Audit And Mid-Run Re-Lane

- **Default to cross-provider review.** When planning a role loop, use a coding
  lane, an auditor on a different provider, and a fixer on a third. Same-
  provider review rubber-stamps; cross-provider audit catches defects the fix
  wave itself introduced (a round-2 audit has caught a stale-lock bug that the
  first fix introduced).
- **Per-card model override is the mid-run escape hatch.** When a profile
  breaks mid-run or a provider 502s, re-lane via `agent=<working-profile> +
  model=<working-model>` instead of editing profiles (which needs a restart and
  kills board state). Reserve profile edits for run boundaries.
- **WIP salvage**: when a worker dies mid-stream with uncommitted work, commit
  it on the `board/*` branch and have the takeover card merge it as unreviewed
  input. State "treat merged WIP as unreviewed input" in the takeover card
  prompt.

OpenCode profile hygiene, regardless of case:

- Give every profile a distinct `color` in its config so the board's agent
  badges are scannable at a glance during concurrent runs.
- Define profiles in `~/.config/opencode/agents/<name>.md` (frontmatter + body
  = the agent's system prompt) with `mode: primary` so they appear in the
  board's assignable roster — `subagent`-mode profiles serve OpenCode's
  internal task tool instead. Docs use `agents/` (plural); verify the path
  your installed version honors by checking the roster.
- Assign models only from authenticated, enabled providers; name a fallback
  model per profile in case a provider preflight fails at run time.
- Back up existing agent files with the same names; stop and ask before
  overwriting shared global config.
- Decide each profile's lifecycle up front and record it in the plan:
  **ephemeral** (created only for this run — the orchestrator removes it at
  completion and restores any backed-up original) or **durable** (a reusable
  role such as a standing coder/auditor — kept intentionally). Default to
  ephemeral for one-off runs so the global OpenCode roster does not accumulate
  orphaned profiles. The orchestrator enforces this at completion.

Write a **Profile Manifest** in the plan whenever custom profiles are needed.
This manifest is the contract that `create-profile` and
`openboard-orchestrator` must mechanically verify:

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

For Claude Code cards, write a separate **Harness Manifest** row instead of a
Profile Manifest row:

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

If multiple OpenCode lanes share one behavior, use one prompt template and one
Profile Manifest row per profile id/model/color. Do not let later phases infer
profile or harness intent from prose; the manifests are the source of truth for
profile installation, roster proof, task model materialization, task harness
proof, dispatch eligibility, and cleanup.

OpenCode config is not hot-reloaded. After OpenCode profile edits, the selected OpenBoard
instance or external OpenCode server must be restarted, then `GET /api/agents`
(or MCP `list_agents`) must show every planned profile with the expected
`mode` and `model` before creating any card. Verify the roster from the
manifest; do not assume it. During card creation, the assigned agent's roster
model is copied onto the task as `task.model`; if a card intentionally uses an
explicit model override, record that override in the plan and verify the stored
task model after creation.

Claude Code harness setup is different: profile creation and OpenCode roster
proof are not the gate. The gate is that the selected OpenBoard build supports
Claude Code cards and the created task record stores `harness: "claude-code"`,
the intended Claude Code model, and the intended `claudePermissionMode`.

## Establish The Green Baseline

Every worktree branches from a verified-green commit:

1. Dependencies installed; build and test commands pass.
2. Committed, so worktrees have a clean base.
3. **Worktree bootstrap check:** untracked files do not follow into fresh
   worktrees — no `node_modules`, no `.env`. Prove a fresh worktree can
   install and build before fan-out, or make setup step 1 of every card.
   Relative paths that escape the repo may also break inside a worktree.


### Worktree Test-Environment Bootstrap

The worktree bootstrap check above covers untracked files (node_modules, .env).
It does NOT cover writable temp/dependency paths inside worktrees — and this
has blocked real cards whose tests write temp files through base-repo
`node_modules` and hit EPERM.

- **Vitest/Vite temp paths**: set `VITEST_TMPDIR` and Vite `cacheDir` to a
  worktree-local location, or agents hit EPERM writing through base-repo
  `node_modules`.
- **Python worktrees**: `.venv` is not in the worktree. Either commit it,
  bootstrap it as step 1 of every card, or use absolute venv tools from the
  base repo.
- **Integration test bootstrap**: `tsx ENOENT` in fresh worktrees — add a
  worktree bootstrap hook or a scoped test command.

4. **Bash sandbox desired/effective state (OpenCode worktree + spawn mode).**
   Confirm the selected instance's diagnostics before planning a macOS OpenCode
   worktree fan-out:
   - desired on + effective on: bash wrapper is active.
   - desired on + effective unavailable/off: worktree dispatch fails closed or
     requires a restart.
   - desired off: file-tool fence and escape detector remain, but bash commands
     are intentionally not sandboxed.

## Choose Task Types And Dependencies

Every planned card should declare its `taskKind` and dependency links:

- `none` — generic current behavior. Use only when the card does not fit a
  workflow role.
- `research` — gather factual findings, source evidence, repo observations, or
  raw notes. It usually changes no product files.
- `synthesis` — read parent context first and evaluate parent findings for
  agreement, conflict, evidence strength, gaps, and implications. Preserve the
  user's/card prompt as the authority for output shape; do not pre-bias the
  output toward "combining" findings unless the user asked for that.
- `build` — create or modify the requested implementation/artifact in cwd. It
  may be from scratch or a modification of existing work.
- `audit` — inspect only unless explicitly told otherwise; report findings with
  severity/confidence and residual risk. Do not fix.
- `fix` — resolve specific findings from parent audit/build/synthesis context
  and tie each change back to the finding it addresses.

Use dependency links for information flow, not prose duplication. A child card
with parent links will not run until parents are satisfied. At dispatch,
OpenBoard injects one `PARENT CONTEXT` section that marks parent worktrees
read-only and lists each parent as `PARENT-000`, `PARENT-001`, ... with worktree,
task id, branch, summary, changed files, verification, and residual risk. The
changed-file paths are worktree-relative when possible. The child is told to
inspect parent copies only for intent and then edit/test the cwd copy.

Map task types onto the selected workflow shape explicitly. Useful mappings
include:

- Research fan-out inside any shape: multiple `research` parents -> one
  `synthesis` child when interpretation is useful.
- Direct research-to-build: one or more `research` parents -> one or more
  `build` children when the prompt already makes the implementation direction
  clear.
- Synthesis-to-dispatch: a `synthesis` card proposes or evaluates a build/audit
  graph, and the orchestrator/user decides what to dispatch next.
- Build review: one or more `build` parents -> one `audit` child.
- Audit repair: `audit` parent plus the relevant `build`/`synthesis` parent ->
  one `fix` child.
- Fix verification: `fix` parent -> `audit` child when quality gates matter.

## Write Cards As Contracts

The card body is the only channel OpenBoard gives a worker — make it carry the
whole contract:

- Title with the run's namespace prefix.
- Absolute working directory; `isolation: "worktree"` for anything concurrent.
- Task type: `research`, `synthesis`, `build`, `audit`, `fix`, or `none`.
- Parent dependencies: use `link_tasks` / `parentIds` so OpenBoard injects
  parent context and gates dispatch until parents are satisfied.
- Worker harness: `opencode` for OpenCode profile workers, or `claude-code` for
  Claude Code workers.
- For OpenCode cards: assigned agent, whose verified roster model is
  materialized onto `task.model` at creation time. Use an explicit model
  override only when the run plan calls for it, and make that override visible
  in the card record.
- For Claude Code cards: no OpenCode agent profile; store the Claude Code model
  and `claudePermissionMode` explicitly on the task.
- The boundary, restated: which files/directories this card may touch.
- Acceptance criteria concrete enough for the orchestrator to judge Review
  against them — the board's first idle means "end of turn," not "done."
- The verification command(s) that must pass in the worktree before Integrate.
- A required handoff: instruct the worker to end with a summary of what
  changed, what was run, and what passed, so the orchestrator, the next wave,
  or the opposing role inherits evidence instead of re-deriving it.

Do not restate parent worktree absolute paths in the prompt unless the card is
explicitly about read-only parent inspection. Link the parents instead. The
dispatcher will inject the parent worktree context in a consistent, numbered
format.

Create cards through MCP `create_task`/`add_tasks`; check `list_tasks` first to
avoid duplicates. Use guarded MCP control tools only from the orchestrator flow.

### Absolute Paths In Card Body

The card's `directory` field is absolute — that is correct. But absolute paths
**in the prose body** of the card can defeat worktree isolation: the dispatcher
injects a worktree-isolation preamble stating the agent's cwd and marking the
base repo read-only, and a permission fence plus the `base-checkout-escape`
detector catch absolute-path writes as a backstop. Despite that, absolute paths
in the card body can still steer a worker to edit the main checkout directly,
because the worker treats the body as authoritative.

Rule: everything in the card body must be repo-relative. The `directory` field
is the only absolute path that should appear. Every worktree card should rely on
the injected preamble for cwd guidance rather than restating absolute paths in
the body.

## Set The Failure Policy

Decide before dispatch, not mid-thrash:

- Retry a failed card at most twice; then stop and surface it to the user with
  the error. Do not re-run to see if it goes away.
- A stalled In-Progress card gets its session inspected, not re-dispatched.
  Distinguish board-state bugs from hung OpenCode sessions.
- Integration is rebase-first: Integrate rebases the task branch onto the
  target branch inside the worktree, then fast-forwards. A conflict does not
  dirty the base — the card blocks with `pending: "rebase-conflict"` +
  `rebaseConflictPaths`, and the resolution is to retry the same still-live
  session (which inherits a mid-rebase worktree — conflict markers present, not
  a clean tree). Declare who resolves a rebase conflict and the retry budget
  for it.
- Integration order for fan-out is declared in the plan; Sync a worktree only
  when a later card genuinely needs the updated base.
- Plan the non-Integrate endings too. Audit/QA/error-replaced cards leave
  worktrees. Discard (Review cards) and delete clean them up, but a dirty
  worktree blocks removal unless forced or kept. Decide up front whether a dirty
  abandoned worktree is salvaged (a manual git commit inside it — standalone
  commit is not a product action) or force-removed. Discard/delete are REST/TUI
  actions, not MCP tools.
- Role loops get a round-trip cap in addition to the per-card retry cap.
- End every fan-out with one serial seam card: fix integration seams, run the
  full verification, add minimal smoke tests if needed.

## Hand Off To The Orchestrator

The approved plan hands the `openboard-orchestrator` skill: the shape, the
waves and their promotion conditions, the card contracts, the profile manifest
and agent/model assignments, the baseline commit, the integration order, and
the failure policy.

End with a step gate instead of dispatching automatically:

```text
STEP COMPLETE: planning
NEXT STEP: create-profile if custom profiles are needed; otherwise openboard-orchestrator
Ready to create/verify the profiles and then dispatch the planned cards?
```

Do not create profiles, create cards, or dispatch work until the user confirms
the next step. If the user already approved a full end-to-end run in the current
turn, state that approval before continuing.

## Failure Modes

- Planning a run in a repo with no self-verifiable build/test command.
- Creating cards before the selected agent roster has been verified with a
  concrete model for OpenCode harness cards, or failing to confirm the created
  task stores the intended harness/model/permission fields.
- Omitting `taskKind` on cards that are clearly research, synthesis, build,
  audit, or fix roles.
- Copy-pasting parent handoffs into child prompts instead of linking parents and
  letting OpenBoard inject `PARENT CONTEXT`.
- Creating OpenCode profiles for work that was supposed to run through the
  Claude Code harness.
- N same-role profiles with hand-written (driftable) prompts instead of one
  template.
- Role prompts that assume they extend the default prompt when they may
  replace it.
- Boundaries that exist only in the card text, with no structural disjointness.
- Creating cards before the roster reflects the new agent config.
- Creating cards from a plan that used custom profiles but omitted a profile
  manifest with expected mode/model/lifecycle.
- Fan-out from a dirty or unverified baseline.
- Worktree cards that assume deps/env exist in a fresh worktree.
- Acceptance criteria too vague to judge Review against.
- Role loops with no exit condition or round-trip cap.
- Unbounded retries instead of a declared failure policy.
- The orchestrator session implementing feature work itself instead of carding it.
- Finishing the plan and then silently stopping or silently dispatching without
  asking whether to move to the next step.

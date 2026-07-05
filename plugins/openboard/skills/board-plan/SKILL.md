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
harness choices, agent profiles, model assignments, and a verified-green baseline. OpenBoard has no
dependency links, completion contracts, or failure caps natively — the
orchestrator session enforces all of them procedurally, and this plan is where
they get defined.

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

Serial at the edges, parallel in the middle: setup and integration are always
serial; only execution parallelizes.

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
- `harness: "claude-code"` — dispatches through Claude Code. Use this when the
  worker should be Claude Code itself, with a Claude Code model selection and
  `claudePermissionMode` such as `bypassPermissions`. Do **not** create an
  OpenCode profile pretending to be Anthropic when the intended executor is
  Claude Code.

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

## Write Cards As Contracts

The card body is the only channel OpenBoard gives a worker — make it carry the
whole contract:

- Title with the run's namespace prefix.
- Absolute working directory; `isolation: "worktree"` for anything concurrent.
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

Create cards through MCP `create_task`/`add_tasks`; check `list_tasks` first to
avoid duplicates. Use guarded MCP control tools only from the orchestrator flow.

## Set The Failure Policy

Decide before dispatch, not mid-thrash:

- Retry a failed card at most twice; then stop and surface it to the user with
  the error. Do not re-run to see if it goes away.
- A stalled In-Progress card gets its session inspected, not re-dispatched.
  Distinguish board-state bugs from hung OpenCode sessions.
- Integration order for fan-out is declared in the plan; Sync a worktree only
  when a later card genuinely needs the updated base.
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

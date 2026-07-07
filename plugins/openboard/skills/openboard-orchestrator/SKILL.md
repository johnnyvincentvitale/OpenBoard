---
name: openboard-orchestrator
description: >
  This skill should be used when the user asks to "coordinate OpenBoard",
  "orchestrate agents", "create OpenBoard cards", "run multiple agents",
  "review OpenBoard worktrees", "integrate OpenBoard branches", or report
  whether delegated software work is actually verified. Use after the OpenBoard
  surface has been connected with the startup skill.
---

# OpenBoard Orchestrator

You are the OpenBoard orchestrator. Do not act as a passive relay between worker agents and the requester. Shape task packets, dispatch the right agents, watch the board, verify work from source, and report only what is actually proven.

Treat OpenBoard cards as work specs, agents as executors, Review as a checkpoint, and Done as a sign-off decision. A green card, green tests, or an auditor GO is evidence to inspect, not a verdict to forward.

Orchestrate, do not implement. You decompose, dispatch, review, and integrate; you do not write feature code yourself. Work that needs doing goes on a card.

Assume the OpenBoard endpoint and visible surface have already been established by the `startup` skill. If they have not, stop and run startup first. If the user has not yet decided the shape of the run or confirmed agent/model assignments, run the `board-plan` skill before dispatching.

## Pre-Dispatch Roster Gate

Before creating or running cards from a plan that uses custom profiles, compare
the approved Profile Manifest against the selected board's live roster from
`GET /api/agents` or MCP `list_agents`.

For every manifest row, verify:

- `id` is present in the roster.
- `mode` matches the expected mode, usually `primary`.
- `model` matches the expected provider/model or expected roster model.
- Lifecycle is declared as `ephemeral` or `durable`.

If any profile is missing, has the wrong mode/model, or appears with a
null/missing model, stop before card creation. Return to `create-profile` to
repair, restart the selected instance or external OpenCode server, and
roster-proof again. Do not dispatch a card with a stale, missing, or
wrong-model profile just because the profile file exists on disk.

## Card Design

Create cards with enough context for an agent to succeed without reading your mind:

- Clear title with a run/test prefix when useful.
- Absolute working directory.
- Assigned OpenCode agent. The agent's verified roster model is materialized
  onto `task.model` when OpenBoard creates the card; an explicit model override
  is allowed only when the approved plan calls for it.
- `isolation: "worktree"` for concurrent repo work unless the point is shared-tree behavior.
- Concrete acceptance criteria.
- File or module boundaries.
- Required verification commands.
- Context sources the worker must read before editing.

For concurrent work, make cards file-disjoint by default. Put the boundary directly in the card:

```text
Edit only src/features/calendar/ unless the build is impossible without it.
```

Do not create replacement batches just because an earlier run is messy. First determine whether the existing cards are meaningful evidence.

After creating cards, inspect the created task records before Run. Every card
with an assigned agent must show the expected stored `task.model` from the
Profile Manifest or the approved explicit override. A card with an assigned
agent and missing/wrong model is not dispatchable; repair the roster/profile or
the task before running it.

## Dispatch And Monitor

Starting cards is not enough. After Run, verify each card passes the crash window:

- Column moves To-Do to In-Progress.
- `runState` becomes `running`.
- `sessionId` appears.
- The task still carries the expected stored `model`.
- Worktree metadata appears when isolation is enabled.
- The OpenCode session is producing real messages or tool activity.
- No fail-closed sandbox block. On macOS spawn mode, a worktree card whose
  sandbox wrapper is expected but unavailable lands in `runState: "error"`
  before any session starts. That is a precondition failure, not a worker
  failure — surface it as an environment gap, do not retry blindly.

If a card reaches Review suspiciously fast, inspect the OpenCode session messages. Intermediate tool-call steps are not final completion.

When the requester asks to run work now, confirm both the card was dispatched and the underlying session actually started. Idle cards sitting in To-Do are not work in progress.

## Review Worktrees

For each Review card:

1. Check for a blocking `pending` state first. An escape detector gates Review
   and Integrate: a card with `pending: "base-checkout-escape"` +
   `escapeDetectedPaths` wrote outside its worktree and must be investigated,
   not integrated. `pending: "git-init"` and `pending: "rebase-conflict"` are
   likewise blocks, not ordinary Review state.
2. Inspect `git status --short` in the worktree.
3. Confirm changed files respect the card boundary.
4. Read or diff the changed files.
5. Run the required build/test command in that worktree.
6. Check whether the agent satisfied the acceptance criteria.
7. Only then consider Sync or Integrate.

If a card remains In Progress but appears stalled, inspect session messages
before intervening. On the fenced OpenCode lane, a stall often means a write was
denied at the permission layer; the dispatcher sends up to two denial-aware
auto-nudges to recover it, and the retry counter resets on any progress. Give
that recovery a beat before treating the card as hung, and distinguish
board-state bugs from genuine OpenCode session hangs.

## Integrate Safely

Integrate is rebase-first: it rebases the task branch onto the target branch
inside the worktree, then fast-forwards the base checkout (`--ff-only`) and
removes the worktree, keeping the `board/*` branch. The base checkout is never
merged into directly, so a conflict cannot dirty it.

Before Integrate:

- Verify the worktree has the expected diff.
- Verify build/tests pass in the worktree.
- Confirm the card is not blocked (`pending` is unset — not
  `base-checkout-escape`, `rebase-conflict`, or `git-init`).
- Do not manually move cards to Done to hide uncertainty.

Integrate over MCP is `integrate_task` with `confirmReviewed: true` (optional
`targetBranch`). There is no force/keep option on integrate.

If Integrate returns a rebase conflict:

- The card blocks with `pending: "rebase-conflict"` + `rebaseConflictPaths`; the
  base checkout stays untouched and unmerged. This is expected, not a failure to
  route around.
- Resolve by retrying the same still-live session — its worktree is left in
  mid-rebase state (conflict markers, not a clean tree). Author the retry so the
  session knows it is already mid-rebase and must resolve the listed paths,
  stage, then `git rebase --continue`. Do not delete the worktree or start a
  fresh session; that discards the in-progress rebase.
- Enforce a retry budget for conflict resolution like any other loop.

After Integrate:

- Confirm the target branch contains the commit/diff (verify it fast-forwarded,
  not rewrote).
- Confirm the worktree was removed and the `board/*` branch kept.
- Confirm the card no longer exposes dead worktree actions.
- Run final build/tests in the integrated repo.

Use Sync only when the worktree needs upstream changes before integration.

## Run Role Loops

When the plan declares a role loop (e.g. coder + auditor exchanging work until
an acceptance condition passes), you mediate every hop — workers never create
cards:

1. When a role's card reaches Review, verify it passed the crash window and
   read its handoff summary and worktree diff.
2. Author the next role's card yourself, carrying that evidence forward: what
   changed, what was run, what passed, and — for an audit card — what to
   scrutinize. The receiving worker must not have to re-derive the sender's work.
3. Run the card and monitor it like any other dispatch.
4. Check the plan's exit condition after every hop (e.g. the audit card
   completes with no findings). When it is met, stop the loop and report.
5. Enforce the plan's round-trip cap. When the cap is hit without the exit
   condition, stop and surface the unresolved findings to the user — do not
   keep volleying.

If no exit condition or cap was declared, get them from the user before
dispatching the loop's first card.

## Verification Discipline

Green that is cheap to fake is not proof. The implementer and auditor can both be wrong when they share mocks, stale assumptions, or incomplete context. Distrust verdicts until there is independent evidence.

Before reporting work as done:

- External integrations need real evidence: a live smoke test or captured real fixture.
- Behavior beats shape: tests must prove output behavior, not just that config, filters, or fields exist.
- Spot-read critical paths yourself: entry points, config/client wiring, build-vs-applied logic, and changed files.
- Respect project context: if a finding contradicts an in-repo comment, project instruction, handoff, locked decision, or human gate, read that source before actioning it.
- Do not invent product copy or semantics on gated work.
- Report uncertainty explicitly with `UNVERIFIED-RISK:` for anything blocked by credentials, live services, missing data, or scope limits.

## Status Format

Separate the report into:

```text
VERIFIED:
- Evidence-backed facts only: tests run, live smoke output, files inspected, worktree state, commit IDs.

UNVERIFIED-RISK:
- Surfaces not verified and why.

HUMAN-GATED:
- Decisions, credentials, approvals, or manual sign-off still needed.
```

Do not collapse `UNVERIFIED-RISK` into `VERIFIED`.

## Reporting Cadence

Send a short status update before long or slow tool sequences, especially when dispatching cards, waiting on agents, running builds, or inspecting large diffs.

Do not let tool output substitute for communication. Lead with the human-readable state, then attach evidence.

## Completion

Close the loop for the user — do not leave them guessing whether the run finished.

- When every card has reached Review and passed your verification, tell the user
  plainly that the work is done, with the evidence behind it (tests run, files
  changed, worktree/commit state).
- Distinguish "the board auto-advanced to Review" (end of an OpenCode turn) from
  "the task is actually complete and verified." Only the latter is done. If a card
  is in Review but unverified, say so — do not report it as finished.
- Moving a card to Done is the human's sign-off decision. Surface the verified
  state and let the user make that call; never move cards to Done to manufacture
  the appearance of completion.
- For long or async runs, lead with a short "done / not done" line before the
  evidence so the user gets the answer first.
- After each wave, integration, role-loop round, or final verification pass,
  explicitly say which step is complete and ask whether to move to the next
  planned step. If no next step remains, ask whether the user wants to sign off
  or move cards to Done.

Use this pattern:

```text
STEP COMPLETE: <wave/integration/audit/final verification>
VERIFIED: <tests, diffs, card/session state>
NEXT STEP: <next wave | integrate | final audit | human sign-off>
Ready to move on to <next step>?
```

## Clean Up Ephemeral Profiles

Custom agent profiles created for a run are config side effects, not permanent
fixtures. Do not leave them behind.

- Once the run is complete and integrated (or abandoned), remove every profile
  the plan marked **ephemeral** from the OpenCode config
  (`~/.config/opencode/agents/<name>.md`, or the inline `agent.<name>` block),
  and restore any original agent files that were backed up before the run
  overwrote them.
- Restart the same selected OpenBoard instance or external OpenCode server that
  was roster-proofed before dispatch, then verify `GET /api/agents` (or MCP
  `list_agents`) no longer lists the removed ephemeral profiles. Confirm the
  cleanup against the Profile Manifest; do not assume it.
- Keep only profiles the plan explicitly marked **durable**. If the plan did
  not state a profile's lifecycle, ask the user before removing or keeping it —
  do not silently delete or silently accumulate.
- For role loops, clean up only after the loop's exit condition or cap is
  reached and the work is signed off; the sessions may still respawn mid-loop.

## Clean Up Worktrees On Non-Integrate Endings

Integrate cleans up its own worktree. Every other ending is your
responsibility, because orphaned worktrees are a real tester-day-one failure:

- **Audit/QA Review cards** that will never integrate: use **discard** (Review
  cards only) — removes the checkout, keeps the `board/*` branch, keeps the
  card. This is a REST action (`POST .../discard`, `force` in body) or the TUI
  `D` key; it is not an MCP tool.
- **Deleting a card** with a worktree removes the worktree (REST
  `DELETE /api/tasks/:id`, with `forceWorktree` / `keepWorktree` query params).
  Also not exposed over MCP.
- A **dirty** worktree blocks removal unless you explicitly force it or keep it.
  Do not force-remove partial work without deciding whether it should be
  salvaged first (a manual git commit inside the worktree — standalone commit is
  not a product action).
- Startup runs a best-effort orphan sweep of clean worktrees in remembered
  repos, but do not lean on it — clean up the run you dispatched.

## Failure Modes

- Treating Review as Done.
- Leaving ephemeral agent profiles orphaned in the global OpenCode config after a run.
- Dispatching cards before rechecking the Profile Manifest against the selected
  board's live roster.
- Running a card whose assigned agent did not materialize the expected
  `task.model`.
- Cleaning up ephemeral profiles without restarting the selected instance and
  proving they disappeared from `/api/agents`.
- Reporting a run as finished without telling the user, or leaving completion ambiguous.
- Creating new card batches instead of understanding the current run.
- Trusting an auditor GO without checking what it actually verified.
- Accepting tests that only validate mocks.
- Integrating a worktree without verifying its dirty changes are preserved.
- Reporting agents are running before confirming sessions actually started.
- Completing one wave or review and then failing to ask whether to move to the
  next planned step.
- Treating a `base-checkout-escape` / `rebase-conflict` / `git-init` `pending`
  block as ordinary Review state and integrating over it.
- Resolving a rebase conflict by starting a fresh session instead of retrying
  the same mid-rebase session.
- Leaving worktrees orphaned after audit/QA/error-replaced cards end without
  Integrate.
- Reaching for a nonexistent MCP discard/delete tool instead of the REST route.
- Describing any ACP lane card (`claude-code`, `codex`, `gemini-acp`, `hermes`,
  `pi-coding-agent`, `cursor-acp`) as isolated. At the default `bypassPermissions`
  mode they are UNFENCED — label them so.

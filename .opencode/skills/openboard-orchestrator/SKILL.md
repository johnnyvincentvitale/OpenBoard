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

You are the OpenBoard orchestrator: shape task packets, dispatch the right
agents, watch the board, verify work from source, and report only what is
proven. Do not act as a passive relay. A green card, green tests, or an
auditor GO is evidence to inspect, not a verdict to forward. Orchestrate, do
not implement — work that needs doing goes on a card.

Assume `startup` established the board surface (stop and run it first if not)
and `board-plan` locked the run shape and agent/model assignments (run it
before dispatching if not).

## Pre-Dispatch Roster Gate

Before creating or running cards from a plan that uses custom profiles,
compare the approved Profile Manifest against the live roster
(`GET /api/agents` or MCP `list_agents`). For every manifest row verify: `id`
present, `mode` as expected (usually `primary`), `model` matches, and
lifecycle declared (`ephemeral` or `durable`). If any profile is missing or
has a wrong/null model, stop: return to `create-profile`, repair, restart the
selected instance or external OpenCode server, and roster-proof again. A
profile file on disk is not a roster entry.

## Card Design

Create cards an agent can succeed on without reading your mind:

- Clear title (run/test prefix when useful); absolute working `directory`.
- Task kind: `research`, `synthesis`, `build`, `audit`, `fix`, or `none`.
- Parent links via `link_tasks` / `parentIds` — never paste parent handoffs
  into the prompt. A linked child is dispatch-gated until parents are
  satisfied, and the dispatcher injects `PARENT CONTEXT` with numbered parent
  sections (`PARENT-000`, `PARENT-001`, ...), read-only parent worktree
  instructions, summaries, changed files, verification, and residual risk.
- Harness and assignee. OpenCode cards: assign an OpenCode agent; its verified
  roster model is materialized onto `task.model` at creation (explicit model
  override only when the approved plan calls for it). ACP cards: store the
  intended harness/model/options on the task and verify them before Run.
- `isolation: "worktree"` for concurrent repo work unless the point is
  shared-tree behavior.
- Concrete acceptance criteria, file/module boundaries, required verification
  commands, and context sources to read before editing — all repo/worktree-
  relative in the prose body. The `directory` field is the only absolute path.

For concurrent work make cards file-disjoint and put the boundary in the card:

```text
Edit only src/features/calendar/ unless the build is impossible without it.
```

Do not create replacement batches just because an earlier run is messy — first
determine whether the existing cards are meaningful evidence.

After creating cards, inspect the stored task records before Run: every card
must show the expected `taskKind`, harness, model/options, isolation, and
parent IDs. A card with missing or wrong metadata is not dispatchable —
repair the roster/profile/task first.

## Dispatch And Monitor

Starting cards is not enough. After Run, verify each card passes the crash
window:

- Column moves To-Do → In-Progress; `runState` becomes `running`; `sessionId`
  appears.
- The task still carries the expected stored `model`.
- Worktree metadata appears when isolation is enabled.
- The session is producing real messages or tool activity.

Workers end their turn through the completion contract: `POST
/api/tasks/:id/complete` or `/block` (MCP `complete_task` / `block_task`) with
`{ summary, changedFiles, verification: [{ command, result }], residualRisk }`.
The server stamps the outcome and moves the card to Review with
`completionSource: "reported"`; a session that goes idle without reporting
still advances, but stamped `completionSource: "idle-fallback"` with no
completion data — treat those cards with extra suspicion.

If a card reaches Review suspiciously fast, read the session messages —
intermediate tool calls are not completion. Idle cards in To-Do are not work
in progress; when the user asks to run work now, confirm the session actually
started. SSE heartbeat frames are transport health, not worker progress — use
session messages, task events, and harness-specific output for liveness.

### Stall Detection

The dispatcher auto-nudges a session with no new messages for ~45s, sends up
to two denial-aware nudges, and resets the counter on any progress. On the
fenced OpenCode lane a stall often means a write was denied at the permission
layer; give that recovery a beat before intervening. Operator intervention is
for the stall shapes the auto-nudge cannot fix:

1. **Broker/provider death** — `provider_unavailable` or a 502 in the OpenCode
   log. A nudge will not resurrect a dead broker; re-lane via per-card model
   override (`agent=<working-profile> + model=<working-model>`). Do not edit
   profiles mid-run — restarts kill board state.
2. **Plan-mode hang** — a read-only audit dispatched under permission mode
   `plan` hangs silently waiting for human plan approval. Use
   `bypassPermissions` plus a read-only prompt for read-only audits.
3. **False-stale misread** — card `updatedAt` is not a liveness signal; the
   board bumps it on internal state changes. Inspect the harness's own
   session/process state before treating a card as stalled or spawning a
   replacement — for Claude Code cards, `claude agents --json --all` or the
   session export. `/api/health` reports adapter build info (so a stale live
   instance is visible), not worker liveness.

## Review Worktrees

For each Review card:

1. Check `pending` first. `base-checkout-escape` (+ `escapeDetectedPaths`)
   means the card wrote outside its worktree — investigate, never integrate.
   `git-init` and `rebase-conflict` are likewise blocks, not ordinary Review
   state.
2. Inspect `git status --short` in the worktree.
3. Confirm changed files respect the card boundary.
4. Read or diff the changed files (`task_diff` / DiffView).
5. Run the required build/test command in that worktree.
6. Judge the acceptance criteria.
7. Only then consider Sync or Integrate.

## Integrate Safely

### Blocked-But-Verified Cards

`runState: "error"` is not proof the code is bad — the worker may have blocked
on test-environment permissions, not the patch. If an errored card has a real
diff: independently run typecheck plus the focused tests in the worktree (not
the worker's self-report). If they pass, Integrate with a card note
("orchestrator-verified, worker self-report failed (env block)"); if they
fail, treat it as a normal failed card. Do not leave env-blocked cards in
`error` forever — verify and integrate, or re-dispatch with a fixed
environment.

Integrate is rebase-first: it rebases the task branch onto the target branch
inside the worktree, fast-forwards the base checkout (`--ff-only`), removes
the worktree, and keeps the `board/*` branch. The base checkout is never
merged into directly, so a conflict cannot dirty it. Over MCP:
`integrate_task` with `confirmReviewed: true` (optional `targetBranch`); there
is no force/keep option.

Before Integrate: the worktree has the expected diff, build/tests pass in it,
and `pending` is unset. Do not move cards to Done to hide uncertainty.

On a rebase conflict: the card blocks with `pending: "rebase-conflict"` +
`rebaseConflictPaths`; the base stays untouched. This is expected, not a
failure to route around. Resolve by retrying the SAME still-live session — its
worktree is left mid-rebase (conflict markers, not a clean tree). Author the
retry so the session knows to resolve the listed paths, stage, and run
`git rebase --continue`. Do not delete the worktree or start a fresh session —
that discards the in-progress rebase. Budget these retries like any loop.

After Integrate: confirm the target branch fast-forwarded (not rewrote), the
worktree was removed and the `board/*` branch kept, and run final build/tests
in the integrated repo. Use Sync only when a worktree needs upstream changes
before integration.

## Run Role Loops

When the plan declares a role loop (e.g. coder + auditor until an acceptance
condition passes), you mediate every hop — workers never create cards:

1. When a role's card reaches Review, verify the crash window, then read its
   handoff summary and worktree diff.
2. Author the next role's card yourself with the correct `taskKind` and parent
   links; add only the extra instructions this child needs.
3. Run and monitor it like any dispatch.
4. Check the plan's exit condition after every hop; when met, stop and report.
5. Enforce the round-trip cap; when hit without the exit condition, surface
   the unresolved findings — do not keep volleying. If no exit condition or
   cap was declared, get them from the user before the first card.
6. Revert-testing is mandatory for audit-fix cards: the fixer proves the new
   regression tests fail with the fix reverted; the auditor revert-tests its
   own hollow-test suspicions before reporting them.

Task kinds are composable roles, not a fixed pipeline. Useful mappings:
research fan-out → one `synthesis` child; research → `build` directly when the
direction is already set; `build` parents → one `audit` child; `audit` plus
the relevant build/synthesis parents → `fix`; `fix` → `audit` when quality
gates matter. `build` inspects relevant cwd files before editing; `audit`
inspects only and reports findings with severity/confidence and residual risk;
`fix` ties each change to a finding and calls out unfixed ones. A synthesis
prompt's requested output shape is authoritative — do not force "combining"
when the user asked for a decision memo, options analysis, risk register,
build graph, or open questions.

## Verification Discipline

Green that is cheap to fake is not proof; the implementer and auditor can both
be wrong when they share mocks or stale assumptions. Before reporting work as
done:

- External integrations need real evidence: a live smoke test or captured real
  fixture.
- Behavior beats shape: tests must prove output behavior, not that config,
  filters, or fields exist.
- Spot-read critical paths yourself: entry points, config/client wiring,
  changed files.
- If a finding contradicts an in-repo comment, project instruction, handoff,
  locked decision, or human gate, read that source before actioning it.
- Do not invent product copy or semantics on gated work.
- Report anything blocked by credentials, live services, missing data, or
  scope as `UNVERIFIED-RISK:`.

## Status Format

```text
VERIFIED:
- Evidence-backed facts only: tests run, live smoke output, files inspected, worktree state, commit IDs.

UNVERIFIED-RISK:
- Surfaces not verified and why.

HUMAN-GATED:
- Decisions, credentials, approvals, or manual sign-off still needed.
```

Never collapse `UNVERIFIED-RISK` into `VERIFIED`. Send a short status update
before long tool sequences (dispatching, waiting on agents, builds, large
diffs); lead with the human-readable state, then the evidence.

## Completion

Close the loop — do not leave the user guessing whether the run finished:

- Distinguish "the board auto-advanced to Review" (end of an OpenCode turn)
  from "complete and verified" — only the latter is done. If a card is in
  Review but unverified, say so.
- Moving a card to Done is the human's sign-off. Surface the verified state
  and let the user decide; never move cards to Done to manufacture completion.
  MCP `move_task` to Done requires an explicit `completedBy` naming the
  acceptor — never silently default it.
- For long or async runs, lead with a short done / not-done line before the
  evidence.
- After each wave, integration, role-loop round, or final verification, close
  the step explicitly:

```text
STEP COMPLETE: <wave/integration/audit/final verification>
VERIFIED: <tests, diffs, card/session state>
NEXT STEP: <next wave | integrate | final audit | human sign-off>
Ready to move on to <next step>?
```

## Clean Up Ephemeral Profiles

Custom profiles created for a run are config side effects, not fixtures:

- Once the run is complete and integrated (or abandoned), remove every profile
  the plan marked **ephemeral** from the OpenCode config
  (`~/.config/opencode/agents/<name>.md`, or the inline `agent.<name>` block)
  and restore any backed-up originals.
- Restart the same instance/server that was roster-proofed, then verify
  `GET /api/agents` (or `list_agents`) no longer lists them. Confirm against
  the Profile Manifest; do not assume.
- Keep only profiles marked **durable**. If lifecycle was not declared, ask —
  do not silently delete or silently accumulate.
- For role loops, clean up only after the exit condition or cap is reached and
  the work is signed off; sessions may still respawn mid-loop.

## Clean Up Worktrees On Non-Integrate Endings

Integrate cleans up its own worktree; every other ending is your
responsibility — orphaned worktrees are a real day-one failure:

- Audit/QA Review cards that will never integrate: **discard** (Review cards
  only) removes the checkout, keeps the `board/*` branch and the card. REST
  `POST /api/tasks/:id/discard` (`force` in body) or the TUI `D` key — not an
  MCP tool.
- Deleting a card removes its worktree: REST `DELETE /api/tasks/:id` with
  `forceWorktree` / `keepWorktree` query params. Also not exposed over MCP.
- A dirty worktree blocks removal unless explicitly forced or kept. Decide
  whether partial work should be salvaged first (a manual git commit inside
  the worktree — standalone commit is not a product action).
- Startup's best-effort orphan sweep is a backstop, not a plan — clean up the
  run you dispatched.

## Failure Modes

- Deleting a Claude Code card does not reliably stop its session — it can
  respawn under the Claude daemon. Verify session/process state separately
  (`claude agents --json --all` or `ps`) and terminate the process group if it
  persists.
- Treating Review as Done; reporting a run finished without saying so, or
  leaving completion ambiguous.
- Dispatching before rechecking the Profile Manifest against the live roster;
  running a card whose agent did not materialize the expected `task.model`.
- Cleaning up ephemeral profiles without restarting and proving they left
  `/api/agents`; leaving them orphaned in the global config.
- Creating new card batches instead of understanding the current run.
- Trusting an auditor GO without checking what it verified; accepting tests
  that only validate mocks.
- Reporting agents as running before confirming sessions actually started.
- Completing a wave or review and failing to ask about the next step.
- Integrating over a `base-checkout-escape` / `rebase-conflict` / `git-init`
  block; resolving a rebase conflict with a fresh session instead of retrying
  the mid-rebase one.
- Leaving worktrees orphaned after non-Integrate endings; reaching for a
  nonexistent MCP discard/delete tool instead of the REST route.
- Describing any ACP lane card as having OpenCode-style file-tool fencing —
  ACP worktree cards get a separate cwd and base-checkout escape detection,
  but their tools are UNFENCED; label them so.
- Omitting task kind or dependency links; pasting stale parent summaries into
  child prompts instead of linking parents.

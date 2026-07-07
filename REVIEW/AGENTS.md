# AGENTS.md

## Agent Context

- `../CLAUDE.md` — canonical repo instructions and current architecture
- `../AGENTS.md` — Codex adapter instructions
- `../README.md` — public feature and API reference
- `../GUIDE.md` — fresh-clone walkthrough and orchestrated-run flow

Use this folder for operator reviews of real OpenBoard usage. These reviews are not
implementation handoffs. They should make it easy to compare runs, identify recurring
orchestration failures, and decide what OpenBoard should protect, fix, or defer next.

Review files should read like post-run process audits, not chat recaps. Capture the current
truth from disk, board state, and verified commands before writing conclusions. Separate what
OpenBoard coordinated from what the repo, runtime, harnesses, models, and operator actually
proved.

## Before Writing

Read the relevant project instructions and evidence before drafting a review:

- `../CLAUDE.md`
- `../AGENTS.md`
- the relevant issue, plan, task prompt, completion report, handoff, changelog entry, or session log for the run
- the live repo state for the checkout that was actually touched
- the board state for the instance that ran the cards, when still available

When the run touched OpenBoard itself, treat the current repo checkout as the source checkout
and verify it directly. Do not infer current repo or runtime state from a card, handoff, prior
review, or old conversation.

Before stating the result, check the relevant truth surfaces:

- `git status`, recent `git log`, and `git worktree list`
- board instance name, port, workspace, and whether API/MCP/TUI were bound to the same board
- task/card states, including Review vs Done, `runState`, completion source, archived cards,
  blocked cards, discarded worktrees, and any manually edited board state
- dirty files, unpushed commits, leftover worktrees/branches, stale background sessions, and
  whether the visible app/runtime was restarted after code changed
- verification commands, live visual checks, API checks, or filesystem proofs that support
  the conclusion

## Review Format

```md
# <Run / Scenario> OpenBoard Review

## Agent Context

- `../CLAUDE.md` — repo instructions
- `../AGENTS.md` — Codex adapter instructions
- `../README.md` — related product/API reference

## Metadata

| Field | Value |
| --- | --- |
| Date | YYYY-MM-DD |
| Reviewed by | Model/provider or person |
| Scenario | What OpenBoard was used for |
| Repos / workspaces | Paths or repo names |
| Board surface | TUI/API/MCP/GUI surface, instance name, port, and binding notes |
| Agents / models | Profiles and model providers used |
| Outcome | Shipped / partially shipped / failed / observational |

## Outcome Snapshot

- **Result:** one-line outcome.
- **Verification:** commands, visual checks, or API checks that prove the outcome.
- **Residual state:** dirty files, cards left in Review, unpushed commits, open worktrees, or manual follow-up.

## What Worked

- Repeatable behaviors that should be preserved.
- Include orchestration patterns, model-role pairings, prompt structures, worktree behavior,
  audit loops, verification practices, or recovery paths that are worth using again.

## What Did Not Work

| Severity | Layer | Issue | Evidence | Product impact | Follow-up |
| --- | --- | --- | --- | --- | --- |
| P0/P1/P2/P3 | prompt/spec, agent/model, harness/session, board API/MCP, worktree/repo, verification, or operator | Short name | What proved it | Why it matters | Link/open-loop/action |

## Blocked / Degraded Cards

Use this section when any cards stalled, errored, returned through `idle-fallback`, stayed busy,
were superseded, required manual recovery, or produced useful code without a clean completion
report.

| Card | Model / harness | Blocked or degraded behavior | Outcome |
| --- | --- | --- | --- |
| Title and task id | Model/provider and runtime | Symptom and evidence | Integrated, superseded, blocked, discarded, manually completed, or unused |

Omit this section only when every card completed cleanly and the board state accurately matches
the review result.

## Model Performance

Use this section for orchestration runs with multiple agents, providers, or harnesses.

| Role / Card | Model | Outcome | Notes |
| --- | --- | --- | --- |
| Builder, auditor, fixer, acceptance, orchestration, etc. | Model/provider | Good, useful, failed, blocked, unused | What the model did well or poorly, whether the output was used, and the operator lesson |

Judge models from this run's evidence only. Distinguish model quality from provider outages,
harness failures, stale runtime code, prompt mistakes, missing dependencies, or operator error.

## Operator Notes

- Prompting, sequencing, profile, model, harness, worktree, verification, or review-process
  lessons.
- Name orchestration mistakes directly when they affected the run: wrong board binding, stale
  liveness assumptions, duplicate dispatch, wrong permission mode, over-broad or over-parallel
  verification, direct database/API fallback, bad card prompts, or premature Done movement.
- Keep Review and Done distinct. If the run leaves cards in Review for human acceptance, say so.

## Product Signals

- **Keep:** behaviors to protect.
- **Fix next:** highest-leverage product changes. Mark whether each is already tracked, fixed
  during the run, newly needs an open-loop item, or intentionally left for later.
- **Defer:** observations that are real but not currently worth building.

## Evidence

- Links to handoffs, commits, commands, screenshots, API responses, or session log entries.
```

## Review Writing Rules

- Write the review as a current-state audit, not a chronological transcript.
- Do not treat board state as repo truth. Verify with git and filesystem evidence.
- Do not treat a green worker report as final proof. Verify the reported diff, tests, and
  residual state independently when the run affected code.
- Separate local migration or operator cleanup from public product defects.
- Separate stale running-build issues from source-code issues.
- Separate useful code from clean card completion; a blocked card can still contain valid work,
  and a Review card can still be unverified.
- Prefer concise evidence over broad recap. Include task IDs, commit hashes, instance names,
  ports, commands, and exact residual state when they matter.

## Severity Guide

- **P0:** corrupts or loses work, secrets, repo state, or blocks safe use.
- **P1:** causes failed/unsafe dispatch, wrong integration, or misleading completion state.
- **P2:** slows operation, requires manual recovery, or makes review harder.
- **P3:** polish, clarity, or nice-to-have workflow improvement.

---
name: agent-readiness
description: >
  This skill should be used when the user asks to "check agent readiness",
  "is this repo ready for agents", "score this repo before dispatching",
  "assess a directory before running OpenBoard cards", or asks why an
  autonomous agent keeps failing, guessing, or thrashing inside a repo. Use
  before dispatching unattended OpenBoard work into an unfamiliar directory,
  and to report where a repo falls short.
---

# Agent Readiness

Assess whether a target repository can support an autonomous agent run before
OpenBoard dispatches one into it. Uneven agent results are usually the repo's
fault, not the model's: missing local feedback loops force the agent to guess,
fail, wait on CI, and guess again. This skill scores the repo's feedback
environment and reports the highest-leverage fixes first.

Assess from source. Read the actual files in the target directory — manifests,
scripts, docs, hooks, CI config. Do not infer readiness from the repo name, a
prior session, or assumptions. An unread signal is an unknown signal.

This skill is derived from Factory's Agent Readiness Model (five maturity
levels across technical pillars). It is deliberately weighted toward the
Level 1–3 signals that decide whether an *unattended* run succeeds — fast local
validation and self-verifiable build/test — and de-weights the Level 4–5
signals (analytics, experimentation, issue-template task discovery) that matter
little to an OpenBoard dispatch.

## When To Run

- Before dispatching an OpenBoard card into an unfamiliar directory.
- When an agent run failed, stalled, or produced unverifiable work and the
  cause may be the environment rather than the model.
- When the user wants a repo scored or wants a readiness report.

This skill reports. It does not create, run, or move board cards. Its output is
a readiness report handed back to the user.

## What To Check

Read the target directory and evaluate these tiers. Each check is pass/fail
with cited evidence (the file/line that proves it), never a guess.

### Tier 1 — Blocks unattended runs (must-have)

- **Self-verifiable build/install.** A documented, deterministic command to
  install and build (package manifest scripts, README, lockfile present). The
  agent must be able to build without tribal knowledge.
- **Self-verifiable test or typecheck.** A runnable command that gives the
  agent a trustworthy pass/fail on its own work. This is the single strongest
  readiness signal — without it, the agent cannot verify itself.
- **Fast local validation.** Pre-commit hooks, a lint command, or a format
  command so feedback is seconds, not a ten-minute CI wait.
- **Documented environment.** Required env vars documented (e.g. `.env.example`),
  setup steps present, no undocumented secrets the agent will guess at.
- **Agent-facing context.** An `AGENTS.md`, `CLAUDE.md`, or README section
  stating how to run, test, build, and what conventions to follow.

### Tier 2 — Reduces failure and integration risk

- **Observability.** A documented way to see logs/errors when a run fails.
- **Security guardrails.** Branch protection, secret scanning, `CODEOWNERS` —
  relevant before integrating agent work back to a base branch.
- **Modularity / boundaries.** Clear module structure so file-disjoint cards
  are possible for concurrent agents.

### Tier 3 — Low priority for OpenBoard (note, do not weight)

- Analytics/experimentation infra, issue templates and labeling for autonomous
  task discovery. Record if absent, but do not gate a dispatch on them.

## Scoring

Estimate a maturity level from the tiers, mirroring Factory's gated model
(unlock a level only after passing ~80% of the level below):

- **L1 Functional** — runs, but manual setup, no automated validation.
- **L2 Documented** — setup/build/test written down; some automation.
- **L3 Standardized** — processes documented *and enforced* (hooks/CI). Target
  for safe unattended OpenBoard work.
- **L4 Optimized / L5 Autonomous** — fast measured feedback / self-improving.
  Above OpenBoard's dispatch bar; report but don't require.

Report the level as an estimate with the evidence behind it, not a precise
score. Missing Tier 1 items cap the repo below L3 regardless of Tier 2/3.

## Dispatch Guidance

Translate the score into advice for the user — advice, not board actions:

- **L3+ →** safe to dispatch. Suggest `isolation: "worktree"` for concurrent
  work — on the OpenCode lane it provides enforced containment (write-fence +
  escape detector, plus a macOS sandbox), a genuine safety net for a repo that
  is otherwise thin on guardrails.
- **L1–L2 with Tier 1 gaps →** advise against dispatching feature work
  unattended into the shared tree. Recommend worktree isolation at minimum, and
  report the readiness fixes to close first.
- **No self-verifiable test/build →** advise blocking the dispatch and say why.
  The agent cannot check its own work; a green card would be meaningless.

## Report Format

The deliverable is a readiness report to the user. Separate proven facts from
gaps, gaps ranked fix-first:

```text
READINESS: L<n> (<Functional|Documented|Standardized|Optimized|Autonomous>)

VERIFIED:
- Passing checks with the file/evidence that proves each.

GAPS (fix-first order):
- Failing checks, highest-leverage first, each with the concrete fix.
  Order by leverage: test/build self-verification → fast local validation →
  documented environment → agent context → Tier 2.

DISPATCH VERDICT:
- Safe to dispatch / worktree-only / blocked, with the reason.
```

Hand this report back to the user. Do not turn gaps into board cards; the user
decides what to do with the findings.

End with a step gate:

```text
STEP COMPLETE: readiness
NEXT STEP: board-plan
Ready to move on to planning the OpenBoard run?
```

If the readiness verdict is blocked, ask whether the user wants to stop or plan
only the readiness fixes. Do not create cards from readiness gaps unless the
user explicitly confirms that next step.

## Failure Modes

- Scoring from the repo name or memory instead of reading the files.
- Passing a repo that has no way for the agent to verify its own work.
- Weighting analytics/experimentation as if they gate a dispatch.
- Creating board cards for gaps instead of reporting them to the user.
- Reporting a level without the evidence behind it.
- Ending the report without asking whether to move to planning.

# OpenBoard User Guide

This is the operating manual for OpenBoard's V1 surface: the terminal UI,
named-instance CLI, local server, MCP (Model Context Protocol) orchestration
tools, and bundled plugin. It starts with a short tour, then documents the
decisions an operator has to make while cards are running, blocked, under
review, being integrated, or being recovered. The [README](README.md) remains
the compact product and technical reference; this guide is organized around
real workflows.

This guide documents OpenBoard as of July 2026 on `dev`. Its behavior claims
are deliberately specific; when a newer build disagrees with a detail here,
trust the build and report the doc drift.

## Contents

**Getting started**

1. [What OpenBoard is](#1-what-openboard-is)
2. [Before you start](#2-before-you-start)
3. [Install](#3-install)
4. [Your first task in five minutes](#4-your-first-task-in-five-minutes)

**Concepts**

5. [Core concepts](#5-core-concepts)
6. [Orchestration and multi-agent workflows](#6-orchestration-and-multi-agent-workflows)
7. [The OpenBoard plugin and its skills](#7-the-openboard-plugin-and-its-skills)

**Operating the board**

8. [TUI anatomy and control model](#8-tui-anatomy-and-control-model)
9. [Creating and editing cards](#9-creating-and-editing-cards)
10. [Card lifecycle and operator decisions](#10-card-lifecycle-and-operator-decisions)
11. [Running sessions: chat, permissions, blocked answers, and watchdog](#11-running-sessions-chat-permissions-blocked-answers-and-watchdog)
12. [Reviewing handoffs, files, comments, and evidence](#12-reviewing-handoffs-files-comments-and-evidence)
13. [Worktree isolation, integration, discard, and cleanup](#13-worktree-isolation-integration-discard-and-cleanup)

**Instances and CLI**

14. [Named instances and CLI operations](#14-named-instances-and-cli-operations)
15. [Settings, filtering, and the global archive](#15-settings-filtering-and-the-global-archive)

**Harnesses and orchestration**

16. [Harnesses: OpenCode, Claude Code, and other ACP agents](#16-harnesses-opencode-claude-code-and-other-acp-agents)
17. [MCP operator guide](#17-mcp-operator-guide)

**Safety and reference**

18. [Safety, persistence, and data retention](#18-safety-persistence-and-data-retention)
19. [Known issues and current boundaries](#19-known-issues-and-current-boundaries)
20. [What to test and how to report](#20-what-to-test-and-how-to-report)
21. [Troubleshooting by symptom](#21-troubleshooting-by-symptom)
22. [Contextual key reference](#22-contextual-key-reference)
23. [Environment variables and paths](#23-environment-variables-and-paths)
24. [Glossary](#24-glossary)

### Quick index: I want to…

| Goal | Section |
|---|---|
| Run my very first card | [§4](#4-your-first-task-in-five-minutes) |
| Kill a runaway or stuck session | [§11](#11-running-sessions-chat-permissions-blocked-answers-and-watchdog) |
| Answer a card that is asking a question | [§11](#11-running-sessions-chat-permissions-blocked-answers-and-watchdog) |
| Merge an agent's worktree into my branch | [§13](#13-worktree-isolation-integration-discard-and-cleanup) |
| Throw away a result without merging | [§13](#13-worktree-isolation-integration-discard-and-cleanup) |
| Run two agents in one repo safely | [§13](#13-worktree-isolation-integration-discard-and-cleanup) |
| Wire an orchestrator to the board | [§17](#17-mcp-operator-guide) |
| Prove MCP is pointed at the right board | [§17](#17-mcp-operator-guide) |
| Figure out why a card won't run | [§21](#21-troubleshooting-by-symptom) |
| Look up a key | [§22](#22-contextual-key-reference) |
| Look up an env var or path | [§23](#23-environment-variables-and-paths) |

---

## 1. What OpenBoard is

OpenBoard is a local command center for coding agents. You post tasks to a
Kanban board, assign each one an agent and a model, and hit Run. The board
dispatches a real agent session that autonomously reads, writes, and runs
commands to complete the task — and the card advances
**To Do → In Progress → Review** on its own as the session runs.

The mental model, in three sentences:

- **A card is a spec, not a session.** It holds a title, a prompt, a working
  directory, and an assigned agent + model. Nothing runs until you run it.
- **Run dispatches a real session.** The agent works unattended in the card's
  directory until it finishes or blocks.
- **Review is the automatic endpoint; Done is a decision.** The board never
  marks work accepted on its own.

What OpenBoard is *not*: it is not a general-purpose hosted chat client. Session
Chat is an operator surface for an agent session already attached to a card;
the board control plane, code checkout, task database, and stored chat/activity
history stay on your machine. The selected model provider still receives the
prompts and context required to run its model under that provider's own terms.

## 2. Before you start

You need:

- **Node 22** or newer (`node --version`).
- **[OpenCode](https://opencode.ai)** installed and authenticated with at least
  one model provider. This is the big one: OpenBoard dispatches work *through*
  OpenCode, so the models you can assign to cards are exactly the models your
  OpenCode install can use.
- **git** — required for worktree isolation, recommended everywhere.
- Optional: **Claude Code** installed and authenticated, if you want to back
  cards with Claude instead of OpenCode.
- Optional (experimental): other ACP agents — **Codex**, **Gemini**, **Hermes**,
  **Pi Coding Agent**, **Cursor**. Each shows up as a harness only when its ACP
  adapter is installed and launchable; none are verified end-to-end yet (see
  [§16](#16-harnesses-opencode-claude-code-and-other-acp-agents)).

**Verify OpenCode works by itself first.** Before touching OpenBoard, open a
terminal, run `opencode` in some repo, and ask it to do something trivial. If
that doesn't work, OpenBoard can't fix it — get OpenCode happy first
(`opencode auth login` for providers). Most first-run problems trace back to
this step.

## 3. Install

```sh
git clone https://github.com/johnnyvincentvitale/OpenBoard.git openboard
cd openboard
npm install
npm run build:app
```

Optional sanity check before testing:

```sh
npm run verify
```

That runs typecheck, unit tests, integration tests, and the app build. If the
integration tests self-skip because `opencode` is not available, mention that
when reporting results.

`build:app` builds everything into `dist/`, including the `openboard` CLI
binary (`dist/cli/openboard.mjs`). To get `openboard` on your PATH:

```sh
npm link      # or symlink dist/cli/openboard.mjs into your PATH
```

## 4. Your first task in five minutes

Choose or create a disposable Git repository, then launch the installed
OpenBoard checkout with that repository as its explicit workspace:

```sh
BOARD_WORKSPACE="/absolute/path/to/scratch-repo" npm run tui
```

This boots the board and its OpenCode backend and opens the TUI in your
terminal. Plain `npm run tui` (no variable) opens the launcher instead — the
instance selector when instances exist, or a workspace-setup screen on a fresh
machine that asks for the same absolute path. Pressing **`n`** opens a
six-screen agent-card wizard. `enter` moves forward, `Tab` moves between
fields, and **`esc`** cancels the whole wizard; `b` steps back from selector
fields (in text fields it just types `b` — see
[§22](#22-contextual-key-reference)). Nothing is created until Confirm.

1. **Identity.** 
- Leave **`CARD TYPE`** on `agent`. 
- Set **`TITLE`**, 
- Write the agent's work order in **`PROMPT`**,  
- Point **`DIR`** at that scratch Git repo—or one of its descendant directories. 
  - *Note: Paths outside the configured workspace are rejected.*
2. **Harness & Model.** 
- Leave **`TASK TYPE`** on `none`
- Leave **`HARNESS`** on OpenCode for this first run. 
- `Use Agent Profile Default` lets the next screen's profile choose the model. 
- Choosing a provider unlocks a type-to-filter **`MODEL`** field. 
  - **`FALLBACK`** is optional and is used only by watchdog recovery.
3. **Agent.** 
- Pick `build`, or another general-purpose OpenCode profile from the live roster.
4. **Isolation.** 
- Keep the default **`worktree`** setting. It gives this run a dedicated `board/<taskId>` branch and worktree. 
- **`AUTO-RUN`** should remain off for a standalone first task.
5. **Dependencies.** 
- Do not select parents.
  - *Existing cards can be toggled as parent with `space` when you build a dependency graph later.*
6. **Confirm.** 
- Check the read-only summary and press **`enter`**. This creates the card; it does not dispatch it.

Once the card exists, press **`r`** once to read the run confirmation and
**`r`** again to dispatch it. Destructive or acceptance-bearing TUI actions use
this same double-press model: the first press explains the consequence and the
second matching press executes it.

A good starter task: *"Create a file called HELLO.md containing a haiku about
kanban boards, then verify it exists."* Small, harmless, observable.

Watch the card move to In Progress, then Review. Select it and press **`enter`**
to read Prompt, Handoff, Output, Files, Attempts, and Comments. Press **`v`**
to inspect the full-screen diff. Because the default worktree now contains
changes, accepting it directly with `x` is intentionally rejected: press
**`i`** to run integration preflight. If files remain uncommitted, inspect the
lists and press **`i`** again to commit them and continue. If everything is
already committed, integration proceeds on the first press. Success integrates
the branch, removes the worktree, and moves the card to Done. If the result
needs more work, use Session Chat for a same-session clarification or create a
linked Fix card. Use the contextual key tables in
[§22](#22-contextual-key-reference) when a key's meaning is unclear.

## 5. Core concepts

**Task vs. session.** A task is the durable spec on the board; a session is the
live agent run it dispatches. Session Chat continues a resumable session in the
same working tree. Retry is the task-work control: it may resume an eligible
blocked session or create a fresh session while preserving the task baseline.

**Agents come from your harnesses, not from OpenBoard.** OpenCode cards bind
one of your OpenCode agents (`build`, `plan`, `general`, `explore`, plus any
you define in your OpenCode config). Claude Code cards dispatch a Claude Code
session instead. OpenBoard adds the board, the dispatch, and the lifecycle —
it doesn't invent its own agent system.

**Four lanes, plus run state.** To Do · In Progress · Review · Done are the
board lanes. The board moves cards through the first three automatically;
errors and blocks are distinct task states surfaced on their current card.

**Reported vs. unconfirmed completion.** Every dispatched prompt tells the
agent how to end its turn: report back with a structured completion — summary,
changed files, verification commands and results, residual risk. A card that
reaches Review with a report is solid ground. If the agent just went quiet
instead, the card still reaches Review but is labeled **unconfirmed** — the
work may be fine, but nothing vouches for it, so inspect before accepting.
Task type changes what the handoff asks for without changing the stored shape;
the full completion contract is in
[§10](#10-card-lifecycle-and-operator-decisions).

**Done is yours — unless you delegate it.** A human can accept an eligible
Review card with `x`; changed worktree cards normally reach Done through
Integrate instead. If you run an orchestrator (next section), you can prompt it
to review and accept work on your behalf. Every Done move names the acceptor,
so the audit trail survives either way.

## 6. Orchestration and multi-agent workflows

Running one card at a time is the tutorial. The board is built for the next
step: a **cockpit session** — a coding agent (Claude Code, Codex, or OpenCode)
that drives the board for you while you supervise. You describe the goal; the
cockpit plans the run, creates the cards, dispatches workers, watches them,
and verifies results.

**MCP control surface.** Point any MCP-capable agent at a running board:

```sh
openboard mcp --instance <name>
```

This injects the board URL and auth token automatically and exposes the guarded
orchestration surface as tools: create/list/link tasks, run/retry/abort/move,
structured complete/block reports, worktree sync/integrate, comments, and
event streams. Guardrails are built in — Done moves, integrations, and blocked
acceptance all require explicit attribution or confirmation — so a cockpit
can't silently accept or merge anything. The exact fields and preconditions
are in [§17](#17-mcp-operator-guide).

**Diagnostic and inspection tools.** The same MCP surface exposes read-only
diagnostics — bounded session tails, resolved task lineage, cross-task Git
comparison, and durable task events — plus guarded intervention tools for
permission asks, blocked answers, and operator messages into live sessions.
The full tool reference and recipes are in [§17](#17-mcp-operator-guide).

**Chat with a running card.** Select a card with a session and press `w` to
open Session Chat — an operator conversation that continues the same session
and working tree, with tool activity and permission asks visible inline and
fenced code blocks rendered for copying. A Review card with a still-resumable
session can be chatted with without leaving Review or replacing its completion
evidence; use Retry when you intend to resume task execution. The complete
Session Chat reference is in
[§11](#11-running-sessions-chat-permissions-blocked-answers-and-watchdog).

**Dependencies and handoffs.** Cards can declare parent tasks. A child with
unmet parents refuses to run, and once its parents complete, their summaries,
changed files, and verification results are injected into the child's prompt
as `PARENT CONTEXT` with numbered parent sections and read-only parent worktree
instructions. This is how multi-card runs stay coherent: downstream agents
start from upstream context instead of rediscovering it.

**Auto-run chains.** Link a build → audit → fix chain, turn on `AUTO-RUN` for
the audit and fix cards on the new-task wizard's Isolation screen (the toggle
appears for worktree cards, and for `in_place` OpenCode cards once EDIT and
BASH are both set to `deny` — the write-fenced read-only shape for
research/synthesis chains), and confirming Run with **`r`** twice on the build
card runs the whole chain: audit dispatches itself
the moment build reports complete, and fix dispatches itself the moment audit
does, with no further Run presses. Turning the toggle on shows a warning in
the wizard for a reason — auto-run dispatches a card the instant its parents
report complete, before any human reviews a diff, and because a downstream
worktree branches from base before its parent is integrated, later diffs can
duplicate parent changes, blurring which card made which edit. Read each
Review card in the chain yourself before integrating; a `task_auto_dispatched`
chain that ran fast is not the same as one that's verified.

**The bundled plugin.** This whole workflow — connect, assess, plan, validate
profiles, dispatch, verify — is packaged as the OpenBoard plugin's skills for
Claude Code, Codex, and OpenCode. The next section breaks down what each skill
does; see [The OpenBoard plugin and its skills](#7-the-openboard-plugin-and-its-skills).

## 7. The OpenBoard plugin and its skills

The workflow in the previous section can be driven manually through MCP; the
**OpenBoard plugin** packages it as a repeatable orchestrator discipline. It is
a bundle of skills (plus an MCP launcher) that turns a coding-agent session into
an OpenBoard cockpit. It lives in the repo at `plugins/openboard/`,
which is the canonical copy; personal installs are synced from there. The same
`skills/` tree is shared across **Claude Code**, **Codex**, and **OpenCode**
native skills, so the workflow is identical whichever harness you drive from.
Install steps are in
[plugins/openboard/README.md](plugins/openboard/README.md) — in short: build and
`npm link` the `openboard` CLI, then symlink or copy `plugins/openboard` into your
harness's plugins directory.

Two pieces ship in the plugin:

- **Skills** (`skills/`) — the workflow as invokable steps. In Claude Code they
  are slash commands (`/startup`, `/board-plan`, …). They're *opt-in*: a session
  only enters orchestration mode when you invoke one, so unrelated work is never
  forced onto the board.
- **An MCP launcher config** (`.mcp.json`) — starts the local `openboard mcp`
  process that binds to the selected board and exposes the guarded orchestration
  surface. It starts unbound (`openboard mcp`) and is bound with
  `select_instance`; the surface's guardrails and preconditions are described
  in [§17](#17-mcp-operator-guide).

### The skill files

Each skill is a `skills/<name>/SKILL.md` file. They're built to run in order, but
you invoke whichever you need:

1. **`startup`** — *run this first.* Connects to (or starts) the intended named
   instance, proves the TUI / API / MCP are all pointed at the same board, and
   hands the session the board facts (URL, agent roster, existing cards). Nothing
   should dispatch or judge cards until startup has established the surface.
2. **`agent-readiness`** — scores a repository's readiness for unattended agent
   work and reports the gaps (a runnable build/test command, docs, structure).
   Report-only — it never creates cards. Optional, but worth running before
   pointing agents at an unfamiliar repo.
3. **`board-plan`** — designs the run *before* anything dispatches: the workflow
   shape (solo pipeline / fan-out / waves / role loop / arena), file-disjoint
   decomposition, the agent profiles and their model/provider assignments,
   cards-as-contracts, and the failure policy. Produces a plan you approve.
4. **`create-profile`** — creates or repairs the custom OpenCode agent profiles a
   plan calls for, with staged validation (real YAML + OpenCode parse checks away
   from live config), safe install, an instance restart, and a live-roster proof
   before any card uses them — so a malformed profile can't quietly break the
   board.
5. **`openboard-orchestrator`** — the execution driver: dispatches the planned
   cards, watches each run past its crash window, reviews worktrees, integrates
   safely, runs role loops, cleans up ephemeral profiles, and reports only
   verified state (Review is a checkpoint; Done is your decision).

```
startup → agent-readiness → board-plan → create-profile → openboard-orchestrator
```

You stay in the pilot seat throughout: the skills plan, dispatch, and verify, but
nothing is dispatched, integrated, or accepted without your approval.

## 8. TUI anatomy and control model

The board view has four lanes, a selected-card panel, and a two-line command
strip. The card panel is the source of truth for what the selected card can do
*right now* among its primary lifecycle actions: shortcuts change with the
card's type, lane, run state, pending decision, completion outcome, and worktree
state. Global controls such as Session Chat, permission answers, refresh, and
Settings remain in the command strip and [§22](#22-contextual-key-reference).

Use `↑`/`↓` to move between cards and `←`/`→` to move between lanes. If a lane
has more cards than fit on screen, OpenBoard windows the lane around the current
selection and shows overflow counts. A board-wide filter may hide cards in
other lanes, so always read the selected card's title and state before acting.
The Review lane also surfaces how many blocked cards currently need an answer.

Two gate screens can replace the board entirely. If the terminal is smaller
than the minimum supported size, OpenBoard shows a "needs more room" prompt
with the current and required dimensions until the window grows (`q` quits
from there). And a self-owned launch that finds no instances and no workspace
shows a workspace-setup screen: type the repository path, `enter` to set up,
`Ctrl+U` to clear, `esc` to quit.

### Context matters

Keys are intentionally reused. For example:

- `e` edits a To Do card from the board, opens a file from View Diff, and expands
  archive detail.
- `r` runs a To Do card, replies to a comment, or refreshes View Diff depending
  on the active surface. Uppercase `R` is Retry from the board.
- `c` adds a comment, commits a file, or copies a Session Chat code block.
- `s` starts/stops an instance in selectors. There is currently no board-level
  `s` binding for task worktree sync; use MCP/API `sync_task`.
- `q` quits from most views, but returns to the board from Session Chat.

The command strip gives the shortest current hints. Press `?` for the in-app
overlay, and use the complete contextual tables in
[§22](#22-contextual-key-reference) when the overlay omits a less-common
action.

### Opening card detail

Press `enter` on a card to open its detail panel. The panel has six tabs:
Prompt, Handoff, Output, Files, Attempts, and Comments. Use `←`/`→` or `Tab` to
switch tabs and `↑`/`↓` to scroll. `esc` closes detail from any tab. `enter`
closes ordinary text tabs, opens a selected Files patch, and submits an active
comment draft; Comments browsing closes with `esc`. Tab-specific controls are
described in [§12](#12-reviewing-handoffs-files-comments-and-evidence).

### Confirmation model

Run, ordinary Retry, Abort, Done, Archive, Delete, Discard, and Git
initialization require confirmation. The first keypress shows exactly what will
happen. Press the same key again to execute, select another card to cancel, or
press `esc` to cancel explicitly. Integration first performs a preflight: it
continues immediately when all changed files are committed, but requires a
second `i` before committing remaining files. This protects mutations and makes
acceptance visible without forcing a modal dialog over the board.

### Action availability

OpenBoard refuses actions that do not match the selected card's state and writes
the reason into the command strip. The common rules are:

- Run and Edit are available on To Do agent cards; manual cards can be edited
  but not run.
- Abort is available while a card is In Progress.
- Retry is available for error cards, blocked cards, and Review cards stopped
  by a rebase conflict.
- Diff is available for Review or Done agent cards.
- Integrate and Done are Review decisions. A worktree with unresolved changes
  must be integrated or deliberately resolved before Done.
- Discard is available on Review cards with worktrees.
- Archive is a Done-card TUI action.
- Delete is available on To Do, Error, Review, and Done cards, subject to its
  worktree cleanup confirmation.

## 9. Creating and editing cards

OpenBoard has two card types. An **agent card** dispatches a harness session. A
**manual card** tracks human or project-management work, has an assignee, and
never dispatches until converted to an agent card.

### Agent-card wizard

The `n` wizard has six screens for agent cards:

1. **Identity** — `CARD TYPE`, `TITLE`, `PROMPT`, and `DIR`.
2. **Harness & Model** — task kind, harness, provider/model where applicable,
   and optional OpenCode watchdog fallback.
3. **Agent** — OpenCode agent profile, or live ACP permission mode and
   adapter-specific options.
4. **Isolation** — worktree/in-place choice, applicable permissions, and
   eligible Auto-run control.
5. **Dependencies** — zero or more parent cards.
6. **Confirm** — the complete read-only card configuration.

The fields mean:

| Field | Purpose | Important behavior |
|---|---|---|
| Card type | Agent or manual | Manual cards skip harness/model/isolation screens and cannot run. |
| Task type | `none`, research, synthesis, build, audit, or fix | Changes the task-mode context and handoff guidance; it is not a fixed pipeline. |
| Harness | OpenCode or a discovered ACP adapter | Only live, launchable ACP harnesses appear. |
| Provider / Model | Runtime model selection | `Use Agent Profile Default` delegates model choice to the OpenCode profile. Explicit providers unlock type-to-filter model selection. Nested model IDs such as `openrouter/anthropic/...` are supported. |
| Fallback | Watchdog retry model | OpenCode only. It must be on another provider to be useful for cross-provider retry. |
| Agent profile | OpenCode roster entry | Roster is read live from the selected instance and may need an instance restart after profile changes. |
| Permission mode / options | ACP adapter controls | Values come from live adapter discovery and vary by harness. |
| Directory | Session working directory | Must exist and normally remain inside the named instance workspace. |
| Isolation | `worktree` or `in-place` | Worktree is the default and the safe choice for concurrent or auto-run work. |
| Permission overrides | OpenCode `edit`, `bash`, `webfetch` | Editable only for in-place OpenCode cards. Worktree protection is automatic and locked. |
| Auto-run | Dispatch when all parents satisfy their gates | Allowed for worktree cards, or in-place OpenCode cards with both edit and bash denied. It does not imply review. |
| Parents | Dependency IDs | Parents must satisfy the dispatch gate before the child can run. |

### Model selection

With OpenCode, leaving Provider on `Use Agent Profile Default` locks Model and
uses the selected agent profile's configured model. Choosing a provider unlocks
Model; type text to filter, use `↑`/`↓` to select, and clear the query when you
want the full list. Fallback uses the same search interaction but excludes the
primary provider.

ACP harnesses obtain model aliases, permission modes, and additional option
fields from live discovery. A freeform model ID can be entered when the adapter
supports it. A configured adapter name is not enough: availability is proven by
successful ACP initialization and session creation.

### Isolation and permission choice

Choose worktree isolation whenever cards can overlap in one repository. It
creates a dedicated `board/<taskId>` branch and checkout and applies the
base-checkout escape detector. OpenCode worktree cards additionally receive the
external-directory ask fence. ACP cards rely on worktree cwd, escape detection,
and the selected adapter permission mode; bypass-style modes can auto-allow
provider asks. Worktree cards expose Auto-run without allowing per-card
OpenCode fence overrides.

In-place OpenCode cards run directly in `DIR`. Their `EDIT`, `BASH`, and
`WEBFETCH` overrides default to allow and may be changed to ask or deny. An
in-place card becomes eligible for Auto-run only when both edit and bash are
denied, producing a read-only research/audit shape. Other ACP cards use the
adapter permission mode rather than these OpenCode overrides.

### Dependencies

On Dependencies, use `↑`/`↓` to select an existing card and `space` to toggle
it as a parent. OpenBoard rejects self-links and cycles. A child cannot dispatch
until every parent is Done or has an agent-reported complete outcome. Blocked
and idle-fallback parents do not satisfy the gate.

### Manual cards

Switch `CARD TYPE` to manual to create a three-screen card:
Identity → Dependencies → Confirm. It stores Title, Notes, optional Assigned To,
Directory, and parents. Manual cards move between lanes with `m`; `r` explains
that they are not runnable. Edit the To Do card and convert it to agent when the
work should be dispatched.

### Editing existing cards

Press `e` on a To Do card to reopen the same wizard with its current values.
You can change card type, task kind, prompt/notes, assignee, harness, model,
fallback, profile, isolation, permissions, Auto-run, or parents. State-changing
edits are server-validated: for example, weakening a qualifying in-place
read-only shape automatically clears stale Auto-run. Once the card has left To
Do, treat its recorded configuration and run evidence as immutable; create a
new card or use Retry for further agent work.

## 10. Card lifecycle and operator decisions

The lane is only one part of task state. Read these fields together:

- **Column** says where the card sits: To Do, In Progress, Review, or Done.
- **Run state** says whether the session is queued, running, idle, or errored.
- **Pending** records a decision such as Git initialization, base-checkout
  escape, or rebase conflict.
- **Completion** is the structured complete/blocked report, when one exists.
- **Completion source** distinguishes agent report, idle fallback, and watchdog.
- **Pending permissions** are live, expiring requests and are not persisted.
- **Completed by** records who accepted Done; it is attribution, not proof.

When states overlap, the visible precedence is: permission input, blocked
Review, accepted-blocked Done, running, error, pending Git decision, ordinary
Review, Done, idle, then queued.

### Lifecycle matrix

| Visible state | Meaning | Normal operator decisions |
|---|---|---|
| To Do agent | Configured, not dispatched | Edit, Run, move, or delete. |
| To Do manual | Human-tracked work | Edit, assign, move, or delete; cannot Run. |
| In Progress | A session is active | Open Session Chat, answer permissions, inspect detail, or Abort. |
| Needs User Input | A permission ask is inside its grace window | Inspect the ask and allow once or deny. |
| Error | Dispatch/session failed outside the blocked-report flow | Read Error/Output/events, then Retry or delete. |
| Pending Git init | Worktree isolation targeted a non-repository directory | Press `g` twice only if the directory should become a Git repository. |
| Pending base-checkout escape | The base checkout changed outside the task worktree | Stop, inspect the named paths, and resolve deliberately before acceptance. |
| Pending rebase conflict | Integrate recorded a rebase conflict and named paths | Resolve in the worktree, then use the card's `R` recovery path. |
| Review · Complete | Structured report received | Read Handoff, Diff, Files, and verification; then Integrate or accept if no unresolved worktree changes remain. |
| Review · Unconfirmed | The session went idle without a structured report | Treat the work as unverified; inspect Output and Diff before deciding. |
| Review · Blocked | Agent or watchdog reported unresolved work | Answer or Retry; inspect/salvage and resolve/discard any changed worktree. Only then can incomplete Done acceptance succeed. The TUI will not Integrate this state. |
| Done | Work was accepted or successfully integrated | Read historical evidence, comment, move, archive, or delete. |
| Done · Accepted blocked | Incomplete blocked work was deliberately accepted | Preserve the accepted-by and block evidence; do not describe it as successful completion. |

### Completion contract

Every dispatched prompt asks the worker to report a summary, changed files,
verification commands/results, and residual risk. Task type changes what the
handoff asks for without changing the JSON fields: research is evidence-first,
synthesis evaluates parent findings for agreement, conflict, evidence
strength, gaps, and implications, build reports implementation, audit reports
findings, and fix ties changes back to the finding it resolves. Build,
synthesis, audit, and fix cards also receive task-mode context before any
parent handoffs. Standalone cards get context that references the card prompt
and cwd only; linked cards get parent-oriented context plus `PARENT CONTEXT`.

An agent-reported complete outcome is the strongest normal Review state. An
`idle-fallback` Review means the provider went idle without filing that report;
OpenBoard advances the card so it does not remain stuck, but labels it
Unconfirmed. A late structured report can still upgrade that card: when the
completion arrives after the idle-fallback advance, the Review card gains the
report in place and stops being Unconfirmed. A watchdog block is
system-authored after the automatic retry budget is exhausted and remains
incomplete until a human resolves or accepts it.

### Review is not Done

Review is an evidence and acceptance checkpoint. The original task turn has
normally ended, but Session Chat can start another conversational turn while
the card remains in Review and retains its completion evidence. Done requires
an acceptor. For ordinary in-place/manual work, `x` twice records `User`. For changed
worktree cards, direct Done is rejected until the worktree has been integrated,
discarded, or otherwise has no committed or uncommitted task changes. Successful
Integrate moves the card to Done and records integration attribution.

Blocked Done is deliberately harder: the acceptance must match the current
blocked report timestamp, explicitly say that incomplete work is accepted, and
name the acceptor. That acceptance does not bypass worktree safety: a changed
worktree must first be salvaged and integrated through an allowed surface,
cleaned, discarded, or otherwise resolved. The TUI supplies the acceptance
guard only after showing the blocked question, verification, residual risk,
source, and timestamp.

## 11. Running sessions: chat, permissions, blocked answers, and watchdog

### Session Chat

Select a card with a recorded session and press `w` to open its activity and
history. Assistant messages read as conversation, tool activity stays visible
but secondary, and permission asks surface inline. Internal completion-report
calls are hidden from the transcript, and exact same-turn provider echoes
render once. Sending continues that card's existing working tree only when the
provider session is still resumable; admission reports an error otherwise.
Session Chat is not a new task and does not replace the card's completion
evidence.

- Press `i` to compose.
- `Enter` sends now or queues behind the active turn.
- `Shift+Enter` inserts a newline.
- `Ctrl+Enter` interrupts the current prompt turn, then sends the replacement.
- `Ctrl+U` clears the entire draft.
- `↑`/`↓` scroll manually; `f` returns to the live tail.
- `Tab`/`Shift+Tab` select fenced code blocks; `c` copies the complete original
  block even if the terminal display is truncated.
- `y`/`N` answer a visible permission ask for the open chat card.
- `u` refreshes task/board state; stream reconnection itself is automatic.
  `b`, `esc`, or `q` returns to the board.

The transport label matters:

- **LIVE** means the activity stream is connected.
- **RECONNECTING** means the connection dropped and the TUI is retrying with its
  last event cursor.
- **STATIC** means the view is not currently live: the run may have reached a
  normal terminal event, or only static history may be available.
- **GAP** means the stream cannot prove that every event is present. Do not send
  a duplicate message merely to force activity; refresh board identity and logs.

Session Chat and Retry serve different intents. Chat is conversation in the
same session. Retry is task-work control and may clear an error, answer a block,
or create a fresh attempt. Review cards may still be chatted with when their
session is resumable, without leaving Review.

### Interactive permissions

Worktree-isolated OpenCode sessions allow normal work inside the task checkout
and set `external_directory` to ask. Known read-class requests such as native
read/glob/grep/list operations are answered automatically with allow-once.
Potentially mutating or unclassified requests appear on the card and in Session
Chat.

The default operator grace window is 60 seconds
(`OPENBOARD_PERMISSION_GRACE_MS`). Use:

- `y` — allow this one request. The next matching request asks again.
- `N` — deny this one request. The underlying policy remains ask.

Each ask has its own ID and deadline. A timeout may win while you are typing;
an unanswered ask is automatically denied at that deadline. On a
stale/conflict response, refresh instead of pressing the answer again.
Pending asks are runtime-only and disappear if the responsible ACP process or
board restarts. The watchdog suppresses intervention while a permission ask is
still within its grace period.

### Answering a blocked card

A blocked report is not the same as a permission ask or generic error. When a
Review card says `BLOCKED · NEEDS ANSWER`:

1. Select it and press uppercase `R`.
2. Read the exact question and block timestamp.
3. Type the answer and press `Enter`.
4. OpenBoard checks that the block is still current and only one answer is in
   flight.
5. If the old session is provably resumable, it receives the answer with its
   partial work. Otherwise a fresh session starts in the same task directory or
   worktree with the blocked context injected.

An empty composer followed by Enter falls back to ordinary Retry confirmation.
If the blocked question changes while you are composing, OpenBoard refreshes
the card and preserves the draft rather than submitting against stale evidence.
Archived cards cannot be answered. The TUI does not integrate blocked cards;
either resolve them or salvage/resolve/discard their worktree. Explicit
incomplete Done acceptance works only after worktree changes have been resolved;
`x` does not bypass that guard. MCP/API integration has a separate explicit
incomplete-acceptance guard described in [§17](#17-mcp-operator-guide).

### Watchdog and fallback recovery

The automatic retry watchdog currently applies to **OpenCode runs only**. ACP
harnesses use their runner/poller lifecycle and do not receive this two-retry
flow. `OPENBOARD_WATCHDOG_MS` controls the OpenCode inactivity threshold. The
default is ten minutes; `0` disables it. After the threshold, OpenBoard uses a
30-second diagnostic window before deciding whether intervention is safe, and
allows at most two automatic retries after the initial run.

Watchdog retries:

- preserve the original baseline, task branch, worktree, and partial files;
- start a fresh session rather than pretending the crashed one is healthy;
- avoid intervention while permission/reconnect uncertainty is unresolved;
- use the card's fallback model on the second retry when it is configured on a
  different provider;
- rely on provider REST status rather than event-stream silence alone.

Open the card's **Attempts** detail tab to see attempt number, outcome, model,
previous/new session IDs, and recovery reason. After the budget is exhausted,
OpenBoard creates a watchdog-sourced blocked report and moves the card to Review
for human triage. It never silently marks that work successful.

## 12. Reviewing handoffs, files, comments, and evidence

### Card detail tabs

| Tab | What it contains | How to use it |
|---|---|---|
| Prompt | Original card instruction | Confirm the worker solved the requested problem rather than a nearby one. |
| Handoff | Structured summary, changed files, verification, and residual risk | Treat missing or vague verification as a review finding. |
| Output | Final captured session output | Use when the handoff is absent, unconfirmed, or inconsistent. Not every ACP harness supplies final output. |
| Files | Diff file list and inline patches | Enter opens a patch; `esc` returns to the file list; `c` commits the selected Review worktree file. |
| Attempts | Watchdog retry history | Correlate models, sessions, and failure reasons. |
| Comments | Durable Review/Done discussion | `c` adds a comment; `r` replies to the selected comment. |

Comments, chat, and events are different records. Comments are durable review
discussion and remain visible in the global archive snapshot. Session Chat is
operator input to a worker session. Task events are the durable lifecycle ledger;
they are not a full transcript or a replacement for attempt/session output.
Comment threading is intentionally one level deep: replies are grouped beneath
their root comment, and replying to a reply attaches to that root.
While composing a comment, `Enter` submits, `Ctrl+U` clears the draft, and
`esc` cancels.

### View Diff

Press `v` on a Review or Done agent card. The full-screen view supports:

- `↑`/`↓` — choose a file; after locking, scroll the patch one row.
- `enter` — toggle between file selection and patch-scroll lock.
- `←`/`→` — previous/next hunk.
- `m` — mark the selected file reviewed locally in the view.
- `t` — switch split and inline presentation.
- `c` — commit the selected file on a Review worktree.
- `e` — open the selected file at the selected hunk line.
- `r` — refresh the diff after an external edit.
- `a` — cycle current-card and code-ancestor evidence when lineage is
  available; without lineage it reports a status message instead of switching.
- `?` — open help; `b`/`esc` returns; `q` quits.

### How Done-card diffs stay available after integration

Done-card diffs are historical and read-only. They omit commit/editor actions,
and `e` explains that the historical file cannot be edited.

They keep working after the worktree is gone because of two records made
around the run. At dispatch, OpenBoard stores the base branch and commit the
task started from. At integration, it commits any remaining task files, merges
the task branch into base, removes the worktree — and deliberately keeps the
frozen `board/<taskId>` branch. Pressing `v` on the Done card (or calling MCP
`task_diff`; both use the same board endpoint) diffs the recorded dispatch
baseline against that frozen branch. It deliberately does not diff against the
current base branch, which may have accumulated unrelated later integrations:
the historical diff shows what this card changed, not what the repository has
become. This is also why `board/*` branches are retained after integration,
discard, and delete — remove a card's branch and its historical evidence
honestly degrades to a no-git reason instead of a diff.

While the card is still in Review, the same `v` behaves differently: it diffs
the live worktree — including uncommitted and untracked files — against the
recorded baseline, so pre-integration inspection never hides work the agent
has not committed yet.

### Opening a file in your editor

Editor resolution is `OPENBOARD_EDITOR` → `$VISUAL` → `$EDITOR`. The explicit
template supports `{file}` and `{line}`, for example:

```sh
OPENBOARD_EDITOR="hx {file}:{line}"
```

Terminal editors suspend the TUI until they exit; known GUI editors launch
detached. The target is the tree that produced the diff—normally the task
worktree, not the base checkout—and View Diff refreshes when control returns.
This feature requires a local board and a configured editor; OpenBoard does not
guess a platform opener.

### Evidence and lineage

Use evidence tools for different questions:

- `task_diff` / `v` — what did this one card change relative to its baseline?
- `task_context` — what direct-parent handoffs, inherited ancestors, and
  code-evidence candidates reached this card?
- `task_compare` — what did a target code card change relative to a base code
  card, typically Build → Fix?
- `a` in View Diff — cycle the selected card's diff and usable ancestor evidence.

An Audit card's findings are evidence but not automatically a Git base. For a
Build → Audit → Fix chain, inspect Build with `task_diff`, read the Audit
handoff, then compare Build to Fix. If task comparison returns a no-git reason
because references are missing, dirty, unrelated, or diverged, inspect the
individual diffs instead; OpenBoard does not invent ordered evidence.

### Review decisions

After inspection, choose deliberately:

- **Integrate** reviewed worktree changes with `i`; press it a second time only
  when preflight reports remaining uncommitted files.
- **Retry** from the TUI for eligible Error, Blocked, or rebase-conflict states;
  MCP/API callers can use explicit retry for broader task-work continuation.
- **Session Chat** when you need an explanation without reopening task work.
- **Discard** with `D` twice when the Review worktree should not merge. The TUI
  uses safe cleanup and refuses a dirty checkout rather than forcing deletion.
- **Done** with `x` twice only when acceptance is allowed and no unresolved
  worktree changes remain.
- **Comment** when the decision or finding should remain on the card.

## 13. Worktree isolation, integration, discard, and cleanup

Concurrent agents in one checkout have no file locking. Worktree isolation is
therefore the default for new agent cards and the normal choice whenever more
than one card can touch the same repository.

### What isolation records

At dispatch, OpenBoard records the base branch and commit, whether the checkout
was dirty, and a base-checkout status snapshot. It creates a `board/<taskId>`
branch and worktree and runs the agent there. Diff evidence is computed against
the recorded baseline, not whatever the base branch happens to contain later.

The escape detector compares the base checkout before and after the run. If an
isolated agent changed files outside its worktree, OpenBoard surfaces the exact
paths and blocks ordinary acceptance until the operator resolves the situation.

### Non-Git directories

A worktree card cannot start from a non-Git directory. The card enters a
`git init required` pending state. Press `g` once to read the consequence and
again only when the directory truly should become a repository; OpenBoard runs
`git init`, creates an initial commit, and dispatches the card. Otherwise cancel
and switch the card to in-place or point it at an existing repository. The
current `g` handler is not state-gated, so never press it on a card that is not
visibly pending Git initialization.

### Review → Integrate → Done

1. Open Handoff, Output, Files, Attempts, and Comments.
2. Press `v` and review every relevant diff/hunk.
3. Run the required verification in the task worktree.
4. If upstream must be incorporated first, use MCP/API `sync_task`; there is no
   current board-level task-sync key.
5. Press `i`. If every changed file is already committed, integration proceeds.
   If uncommitted files remain, OpenBoard shows committed/uncommitted lists and
   explains that a second press will commit the remaining files.
6. When prompted, press `i` again. Existing task commits are preserved;
   remaining files are committed, the task branch is integrated into base, the
   worktree is removed, the branch is kept, and the card moves to Done.
7. Re-run final verification in the integrated base repository.

Conflicts stop the operation and are reported rather than forced. The two paths
are distinct:

- `sync_task` performs a merge. A merge conflict is returned by that operation
  without setting the card's pending rebase state. Resolve and commit it inside
  the worktree, then retry Sync or proceed to Integration when appropriate.
- Integrate may record `pending: rebase-conflict` plus conflict paths. Resolve
  those paths inside the worktree, then use the card's `R` recovery path.

Never resolve either case by blindly deleting the worktree: it may contain the
only copy of partial work.

### Outcome matrix

| Action | Merges work? | Removes worktree? | Keeps branch? | Keeps card? | Normal use |
|---|---:|---:|---:|---:|---|
| Integrate | Yes | Yes | Yes | Yes; moves Done | Accept reviewed implementation. |
| Discard (`D`) | No | Yes when safe cleanup succeeds; dirty checkout is refused | Yes | Yes; stays Review | Keep evidence/card but do not merge this checkout. |
| Delete (`d`) | No | Removes a clean task worktree; dirty cleanup can reject deletion | Yes | No after success | Permanently remove the card; not a substitute for archive. |
| Done (`x`) | No | No | Yes | Yes | Accept manual/in-place or already-resolved work; rejected while a worktree still has task changes. |
| Archive (`a`) | No | No | Yes | Yes; hidden from active board | Preserve a Done snapshot in global history. |

The TUI does not Integrate blocked cards. Discard is useful for read-only
audit/review worktrees that should never merge. Successful delete/discard
cleanup keeps the branch so an operator can salvage it later. Dirty cleanup is
not forced by these TUI actions; inspect/commit or use an explicitly authorized
API cleanup path. MCP/API callers can cross the blocked boundary only with
explicit incomplete acceptance ([§17](#17-mcp-operator-guide)).

### Orphan cleanup

On startup OpenBoard scans known repositories for board-owned worktrees no live
task references. Clean orphans are removed automatically. Dirty orphans are
kept and reported in Settings so data is not destroyed silently.

Press `p`, then `D`, to inspect dirty orphan worktrees. `d` requires a second
press before force-removing the selected orphan and keeps its branch for
salvage. The CLI `openboard worktrees <name>` is read-only: it reports active,
archived, missing, and dirty worktree state but does not clean anything.

Branches are deliberately retained after integration, discard, delete, and
orphan cleanup, so `board/*` branches can accumulate even when worktrees do not.
Those retained branches are also what keep Done-card historical diffs available
([§12](#12-reviewing-handoffs-files-comments-and-evidence)).

## 14. Named instances and CLI operations

`BOARD_WORKSPACE="/absolute/path/to/repo" npm run tui` starts a self-owned board
for that workspace. Without an explicit workspace or attach target, the launcher opens
its selector/setup surface. The daily-driver surface is the named-instance CLI:
one daemon, port pair, workspace, token, database, pidfile, and log per instance.

### Register and attach

```sh
openboard add my-repo --workspace /path/to/repo
openboard start my-repo
openboard attach my-repo
```

`add` registers only. `start` creates the daemon and runtime files. `attach`
connects the TUI and is intended for an already running instance. The shortcut
`openboard my-repo` starts a stopped instance and then attaches. Bare
`openboard` opens the selector, where instances can be registered, started,
stopped, renamed, removed, and attached.

The workspace is an admission boundary: task directories must normally be the
workspace or one of its descendants. Register the repository—or an intentional
parent containing several repositories—that agents are allowed to use.
Instance names must be lowercase kebab-case, begin with a letter, contain at
most 40 characters, and not shadow a CLI command.

### CLI reference

| Command | Board/task mutation? | Purpose and important options |
|---|---:|---|
| `openboard list [--json]` | No | Registered instances plus runtime/identity state. |
| `openboard add <name> -w <dir> [-p N] [--opencode-port N]` | Registry | Register without starting. Long forms: `--workspace`, `--port`. Ports must be unique. |
| `openboard start <name>` | Process/runtime | Start the daemon and wait for health. |
| `openboard stop <name>` | Process/runtime | Stop the daemon. |
| `openboard restart <name>` | Process/runtime | Stop/start, wait for health, then verify post-start task diagnostics and unsafe-running state. |
| `openboard attach [name]` | TUI process only | Attach to a running explicit/default/single inferred instance. |
| `openboard <name>` | Process/runtime | Start if stopped, then attach. |
| `openboard rename <old> <new>` | Registry/data/process | Stop a healthy-running instance, rename registry/data/DB identity, then restart when previously running. Explicitly stop an unhealthy live process first. |
| `openboard remove <name> [--force]` | Registry/process | Unregister only; `--force` stops a healthy-running instance first. Explicitly stop an unhealthy live process first. Data remains. |
| `openboard default show` | No | Explain explicit, inferred, or missing default state. |
| `openboard default set <name>` / `clear` | Registry | Set or clear the explicit attach default. |
| `openboard status <name> [--json]` | No | Cheap registry/runtime/live identity and health diagnostics. |
| `openboard doctor <name> [--json]` | No | Deeper operator checks; exits nonzero only when a check fails. |
| `openboard logs <name> [-n N] [-f]` | No | Last 80 lines by default; `--tail`/`-n` changes count, `--follow`/`-f` streams. Secrets are scrubbed. |
| `openboard harnesses <name>` | No | Live ACP availability, modes, models, and options summary. |
| `openboard agents <name>` | No | Live OpenCode agent roster. |
| `openboard providers <name>` | No | Live provider/model state. |
| `openboard tasks <name> [--review] [--running] [--json]` | No | Task summary; filters can be combined. JSON includes full task objects and auto-dispatch causality or an explicit unavailable marker. |
| `openboard worktrees <name>` | No | Managed active/archived worktree existence and dirty/missing state. |
| `openboard mcp [--instance <name>]` | MCP process | Start unbound, or pre-bind to a running named instance. |

Only `list`, `status`, `doctor`, and `tasks` currently support `--json`.
`tasks --running` includes cards whose run state is running or whose lane is In
Progress. Removing an instance never deletes its data directory or the global
archive. “No” in this table means no board/task/configuration mutation; runtime
inspection may still remove a stale pidfile after proving its process is dead.

### Defaults and identity

`openboard attach` without a name uses the explicit default, or infers the only
registered instance. With multiple instances and no explicit default, pass a
name or set one. An instance name alone is not sufficient identity: status and
MCP status expose the registry and live board name, workspace, database, build,
URL, and token presence. Compare those fields yourself before mutation.
`doctor` checks important live port/workspace mismatches, while pre-bound MCP
startup proves registry runtime and token presence; neither substitutes for the
full operator identity proof in [§17](#17-mcp-operator-guide).

### Status, doctor, and recovery

Use the diagnostic commands in increasing depth:

1. `openboard list` — is the registry/runtime state running, stopped,
   stale-pid, or unhealthy?
2. `openboard status <name>` — do registry identity, live health, OpenCode, and
   task diagnostics agree?
3. `openboard doctor <name>` — check registry, daemon, token, health, workspace,
   Git, identity, OpenCode, roster, providers, ACP discovery, tasks, worktrees,
   and startup-log evidence.
4. `openboard logs <name> -n 200` — inspect startup or runtime errors.
5. `openboard restart <name>` — restart, then verify whether startup recovery
   left task state safe.

An **unsafe RUNNING** card has `runState=running` while outside In Progress or
without a linked session. Do not trust the label or integrate its work. Restart
does not itself repair that card: it verifies post-start health and task
diagnostics and exits nonzero when either is unavailable or an unsafe RUNNING
card remains. Inspect the card's events/worktree and then Retry or Abort
deliberately.

`stale-pid` means the recorded process is gone; inspection cleans up the stale
pidfile. `unhealthy` means a process answers but fails health checks. Read logs
before repeatedly restarting. Agent/profile changes normally require restart
because OpenCode reads that configuration at boot.

### Runtime states

| Runtime | Meaning | Normal response |
|---|---|---|
| Running | Pid is alive and board health responds | Attach or inspect normally. |
| Stopped | No usable pidfile | Start explicitly or use `openboard <name>`. |
| Stale pid | Pidfile points to a dead process | Inspection removes it; inspect again, then start. |
| Unhealthy | Process is alive but board health fails | Read Doctor and Logs before restart. |

### JSON and exit behavior

JSON is available only from:

```sh
openboard list --json
openboard status <name> --json
openboard doctor <name> --json
openboard tasks <name> --json
```

Task JSON can include prompts, paths, model information, completions, and
session identities; treat it as sensitive. `status` is an inspection command
and returns success after producing its report even when the report contains
unhealthy evidence. `doctor` returns nonzero when any check is `fail`; warnings
alone remain exit zero. `restart` returns nonzero when post-start health or task
diagnostics are unavailable or an unsafe RUNNING card survives. Attached TUI
and MCP processes propagate their child exit code; signal exits use the normal
`128 + signal` convention.

A failed auto-dispatch causality read does not fail `tasks`. Human and JSON
output still return task data and mark causality unavailable instead of
silently claiming there was no cause.

### Logs, task, and worktree inspection

`openboard logs` reads the retained log even while an instance is stopped. It
defaults to 80 lines, accepts `--tail 0` for the full file, and follows until
interrupted with `--follow`. Common token patterns are redacted, but prompts,
paths, provider errors, or command output may still be sensitive.

Use `openboard tasks` for a quick lane/run-state audit. Archived tasks are
excluded. Use `openboard worktrees` for active and archived task records:
recorded branch/path, whether the path exists, dirty true/false/unknown, and
missing-path orphan candidates. It is strictly read-only. Treat dirty or
missing worktrees as evidence requiring review, not cleanup authorization.

## 15. Settings, filtering, and the global archive

### Settings

Press `p` from the board. Settings reports the selected instance identity,
workspace, database, board/OpenCode endpoints and health, OpenCode version,
token presence, editor configuration, and the most recent orphan-worktree sweep.
It never prints the token itself. Press `u` to refresh, `D` for dirty orphans,
and `b`/`esc` to return.

### Board filtering

Press `f` to choose a filter category and value. Current categories are:

- **Worktree** — branch, falling back to worktree path.
- **Manual** — manual-card assignee, including `unassigned`.
- **Agent** — OpenCode profile or ACP harness, including `unassigned`.

The filter applies across the board. Press `f` again to clear it. Selection is
reconciled to a visible card so an action cannot silently target a hidden one.

### Global archive

The TUI archives Done cards with `a` twice. The authenticated API also permits
archiving Review cards, but the TUI intentionally keeps Archive as a Done-card
action. Archiving hides the active card and writes/upserts a snapshot into the
cross-instance global archive; it is not deletion and does not clean a
worktree or branch.

Press uppercase `A` from the board or launcher to browse global history. The
archive supports:

- `↑`/`↓` record navigation;
- `enter` to focus/unfocus detail;
- `e` to expand/collapse detail;
- `←`/`→` or `Tab` across Prompt, Handoff, Output, Files, and Comments;
- `/` text search;
- `i` to cycle instance filter;
- `l` to cycle original-lane filter;
- `u` refresh; `b` returns; `q` quits.

Archive rows are snapshots keyed by source database and task. Removing an
instance leaves both its per-instance data directory and existing global
archive rows on disk. There is no TUI unarchive action today; unarchive remains
an authenticated API operation on the source board.

## 16. Harnesses: OpenCode, Claude Code, and other ACP agents

Every card has a `HARNESS` field, chosen on the wizard's Harness screen. OpenCode
is the default; the others are driven over the **Agent Client Protocol (ACP)**.

| Card/harness | Discovery and assignment | Safety posture | Recovery notes |
|---|---|---|---|
| Manual | No harness or model | Never dispatchable | Track human/PM work only. |
| OpenCode | Agent must exist in the selected board's live roster; an explicit provider/model is optional when the profile supplies one | Worktree cards use the external-directory ask fence plus escape detection; in-place cards may use edit/bash/webfetch overrides | Only OpenCode cards expose `fallbackModel`; watchdog retries preserve the task tree. |
| Claude Code | ACP discovery must report available; models, modes, and options come from the adapter | Worktree cwd and escape detection; not OpenCode's native file-tool fence | Same-session continuation depends on the live ACP session. |
| Codex, Gemini, Hermes, Pi Coding Agent, Cursor | Assign only when live ACP discovery reports available | ACP worktree-cwd posture and adapter permission mode | Experimental: prove a real end-to-end card before depending on the harness in a larger run. |

**OpenCode** (default). The card binds one of your OpenCode agents (`AGENT
PROFILE`, its own wizard screen) and a model. `PROVIDER`/`MODEL` are synced
live from `GET /api/providers` — the AI providers your OpenCode install is
currently connected to and authenticated for — not just whatever models
happen to already be attached to an agent. Leave `PROVIDER` at **`Use Agent
Profile Default`** to let the agent profile you pick on the next screen
supply its own model (`MODEL` locks to that same label until you pick a real
provider); pick a specific provider to unlock `MODEL` and type-to-filter its
models directly. Agent profiles themselves are defined in your OpenCode
config (`~/.config/opencode/agent/<name>.md` or `opencode.jsonc`). One catch:
OpenCode reads agent config at boot only, so after adding or editing an agent,
restart the board instance to see it in the roster.

**Claude Code.** The card dispatches a background Claude Code session instead.
This is unchanged from before the wizard — just relocated into its screens.
Full Claude "agent profile" support (matching what OpenCode gets above) is a
separate, later workflow. What changes today:

- `MODEL` (Harness screen) comes from live ACP discovery, includes Provider
  Default, and accepts freeform input. There is no `PROVIDER` screen for Claude
  Code — that concept is OpenCode-only.
- The Agent screen shows `PERMS` instead of `AGENT PROFILE` — the permission
  mode for the run. It defaults to the first mode returned by live discovery,
  falling back to `bypassPermissions` only when discovery reports none.
- The isolation screen's `PERMISSIONS` section doesn't apply to Claude Code —
  it's an OpenCode-only concept (see below) — so neither the locked note nor
  the editable control appears there for a Claude Code card.
- Claude reports completion through the same structured contract, so its cards
  participate in Review, handoffs, and dependencies like any other.
- **Commit before dispatching Claude into a repo.** If the target has
  uncommitted changes, the card gets a warning and Claude may isolate its edits
  into its own worktree instead of editing in place. The card's `RUN DIR` /
  `RUN BRANCH` / `RUN COMMIT` / `RESULT` rows show where the work actually
  landed, and harness-created worktrees feed the normal sync/integrate flow.

**Other ACP harnesses (experimental).** Beyond Claude Code, OpenBoard has a
generalized ACP runner for **Codex**, **Gemini**, **Hermes**, **Pi Coding
Agent**, and **Cursor**. These are wired but **not yet exercised end-to-end** —
treat them as experimental.

- **They only appear if their adapter is installed.** The wizard's `HARNESS`
  list is populated from live discovery (`GET /api/acp-config`, which runs each
  adapter's `initialize` + `session/new`). A harness whose adapter isn't
  installed or won't launch is hidden — so if you don't see one, that's why, and
  it's expected.
- **Model, modes, and options come from the adapter, not a hardcoded list.** The
  Harness screen's `MODEL` and permission-mode controls are sourced from what the
  live adapter reports; you can also type a model ID freeform per harness.
- **Adapter resolution.** OpenBoard looks for, in order: the harness's explicit
  command override (the exact variable names are listed in
  [§23](#23-environment-variables-and-paths)) → a bundled
  `@agentclientprotocol/*` adapter package if installed (Claude, Codex, Gemini) →
  the adapter binary on your `PATH` (`codex-acp`, `gemini-agent-acp`,
  `hermes-agent-acp`, `pi-coding-agent-acp`, `cursor-agent-acp`).
- **ACP safety depends on mode.** ACP harnesses run in the selected worktree cwd
  with base-checkout escape detection. In bypass-style modes provider asks may
  be auto-allowed; stricter modes use brokered permission handling. One known
  rough edge is that persisted mode validation is still shaped around Claude's
  modes, so a non-Claude adapter reporting a mode outside it may be rejected.

**OpenCode permissions, and why worktree isolation locks them.** The wizard's
isolation screen shows a `PERMISSIONS` section for OpenCode cards only.
Worktree-isolated runs already carry a layered safety stack — write-fenced
edit permissions, the base-checkout escape detector, worktree-cwd prompt
hygiene, and Review/Integrate checks.
The worktree screen does not expose per-card permission overrides; it shows the
automatic worktree protection state. Select isolation **`in_place`** instead to
get an editable `EDIT`/`BASH`/`WEBFETCH` control (each `allow`/`ask`/`deny`),
which defaults to `allow` everywhere — i.e., today's behavior — until you
actively tighten one.
"Container" isolation is a disabled placeholder in this same segmented
control; it isn't implemented yet and has no permissions story of its own.

## 17. MCP operator guide

OpenBoard's MCP server is a guarded orchestration control surface over one
running board. It does not assume that `127.0.0.1:4097` is the intended board,
and it does not start a stopped instance. Prove identity before creating,
running, reviewing, integrating, or accepting cards.

### Connect and prove the board

The bundled plugin starts MCP unbound:

```sh
openboard mcp
```

Use this protocol:

1. Call `current_instance`.
2. If unselected, call `list_instances`, start the intended instance from the
   CLI if necessary, then call `select_instance` with its name.
3. Call `openboard_status`. Verify the instance name, board URL, workspace,
   database identity, API reachability, and token-presence flag.
4. Call `list_tasks` and `list_agents`; the cards and roster must match the TUI
   the operator is looking at.
5. If any identity differs, stop and select the right instance before mutation.

When the target is known before launch, pre-bind instead:

```sh
openboard mcp --instance <name>
```

The named instance must already be running and have a board token. Selection
changes only the current MCP process's future calls; it does not restart a
daemon or affect another MCP client. Instance tools expose token presence, never
the token value.

### Tool reference

| Category | Tools | Mutation and important preconditions |
|---|---|---|
| Identity | `current_instance`, `list_instances`, `openboard_status` | Read-only. Status reports an unreachable board rather than silently selecting a fallback. |
| Target selection | `select_instance` | Changes this MCP process only. Named instance must exist, run, and have a token. |
| Board inspection | `list_tasks`, `list_agents` | Read-only. Use immediately after selection to prove board alignment. |
| Card creation | `create_task`, `add_tasks` | Writes To Do cards; never dispatches. Directory must be admitted by the board. |
| Dependencies | `link_tasks`, `unlink_tasks` | Writes graph metadata. Both tasks must exist; self-links and cycles are rejected. |
| Execution | `run_task`, `retry_task`, `abort_task` | Changes session/task state and may create a worktree. Agent/archived/parent gates apply. `retry_task` accepts optional `feedback` text forwarded into the retried session. |
| Placement and reports | `move_task`, `complete_task`, `block_task` | Writes lifecycle evidence. Done requires `completedBy`; blocked Done also needs current incomplete acceptance. Reports should identify the active run. |
| Operator intervention | `respond_permission`, `answer_blocked_task`, `send_session_message` | Mutates a live/resumable session and requires exact current ask, block, and session identities. `respond_permission` needs `taskId` plus `askId`; `send_session_message` uses `sentBy` and `mode` (`queue`/`interrupt`), with text capped at 12,000 characters. |
| Session diagnostics | `tail_session` | Read-only bounded snapshot: default 50, maximum 200 events; optional `cursor` and `timeoutMs` (100–30000, default 3000) shape the window, and the call waits briefly for a trailing terminal frame. Not continuous monitoring. |
| Evidence | `task_events`, `task_context`, `task_diff`, `task_compare` | Read-only. Diff is Review/Done; Compare needs two distinct cards with usable ordered Git evidence. Context excludes raw transcripts. |
| Worktree Git | `sync_task`, `integrate_task` | Mutates Git. Worktree required; integration requires `confirmReviewed: true` and may commit, integrate, remove the worktree, and move Done. |
| Discussion | `comment_task`, `add_note` | Writes durable task comments. This is not Session Chat; `add_note` is an alias. |

`list_tasks` is a compact orchestration projection: it includes lane, dominant
state, session identity, parents, models, automatic retry count, pending
permissions, blocked question/source, and evidence flags. CLI
`openboard tasks --json` instead returns full task objects plus batched
auto-dispatch causality or an explicit `causalityUnavailable` marker.

### Stale-write and attribution guards

Always refresh task/session state immediately before acting. These fields are
deliberate concurrency guards:

- `runStartedAt` on Complete/Block binds the report to the active attempt.
- `clientMessageId` makes a Session Chat submission retry-safe. Reuse an ID only
  for retrying the same logical message.
- `expectedSessionId` stops a stale draft from landing in a replacement session;
  include `expectedRunStartedAt` when known.
- `askId` identifies one permission request (paired with its `taskId`);
  `answeredBy` records attribution.
- `blockedReportedAt` identifies the current blocked report and is required for
  blocked answers and incomplete acceptance.
- `completedBy` is required for MCP Done moves. It records who accepted work; it
  does not prove review occurred.
- `confirmReviewed: true` is required for integration. It is the caller's
  attestation; inspect the diff and run verification before sending it.

When one of these is stale, refresh `list_tasks` or the relevant diagnostic and
re-evaluate. Do not blindly replay a mutation.

### `add_tasks` is sequential, not transactional

`add_tasks` creates cards one at a time. If card 3 fails after cards 1 and 2 are
created, the first two remain; there is no rollback. Keep the returned IDs and
use a shared run prefix. After success or failure, call `list_tasks` and
reconcile what exists before retrying, or a blind replay can duplicate cards.

The current MCP creation schemas do not accept parent IDs, fallback model, or
in-place permission overrides. Create the cards, verify their IDs, link them
with `link_tasks`, and configure unsupported creation fields through the TUI or
authenticated API when required.

### Recipe: create and run a dependency graph

1. Prove the selected board and roster.
2. Create cards with a shared run prefix.
3. Verify each card's task kind, harness, agent/model, directory, and isolation.
4. Link parent → child. Do not paste handoff text into child prompts; the board
   injects structured parent context.
5. Run roots only. Unmet children reject Run; eligible Auto-run children start
   only after their parent gates satisfy.

### Recipe: observe and recover a run

1. Use `list_tasks` for dominant state, session, model, retry count, permission,
   and block metadata.
2. Use `tail_session` to answer a bounded question such as whether attributable
   text/tool activity occurred. Check transport, gap, and terminal fields.
3. Resolve a current permission ask before treating the run as abandoned.
4. For a block, refresh and call `answer_blocked_task` with the current
   `blockedReportedAt`; OpenBoard resumes the same session only when live status
   proves it is resumable.
5. Use generic `retry_task` only for ordinary retry semantics, not as a substitute
   for a blocked answer.

### Recipe: review Build → Audit → Fix

1. Call `task_context` on the downstream card to inspect parents, ancestors,
   handoffs, truncation diagnostics, and code-evidence candidates.
2. Call `task_diff` on the code-bearing Build parent. The Audit handoff is
   findings evidence, not automatically a Git base.
3. Read the Audit report for severity, confidence, evidence, and residual gaps.
4. Call `task_compare` from Build to Fix to see the ordered Git delta the Fix
   added. If no-git is returned, inspect individual diffs instead.
5. Run independent verification in the code-bearing worktree. A clean read-only
   Audit worktree does not prove the parent's code builds.

### Recipe: integrate reviewed work

1. Confirm Review state, no unresolved pending decision, and no writing session.
2. Inspect `task_diff` and residual risk.
3. Run the required checks in the task worktree.
4. Use `sync_task` when upstream must be incorporated before integration.
5. Call `integrate_task` with `confirmReviewed: true`; set
   `commitRemaining: true` only when you deliberately want OpenBoard to commit
   the remaining edits.
6. Verify the result, Done attribution, base branch, removed worktree, and final
   checks in the integrated repository.

The TUI refuses to integrate a blocked card. MCP integration can cross that
boundary only with `confirmReviewed: true` and the current `blockedAcceptance`
(`acceptIncomplete: true` plus `blockedReportedAt`). The direct authenticated
REST route does not have a `confirmReviewed` field; it still requires current
blocked acceptance and records integration attribution as `Integrated by User`,
so direct API callers must enforce review out of band. Neither surface bypasses
worktree-resolution checks. Prefer resolving the block or discarding the
worktree; accepting and integrating blocked output means deliberately merging
incomplete work.

### MCP exclusions

The current MCP surface does not expose general task editing, deletion,
archive/unarchive, global-archive browsing, worktree discard/orphan cleanup,
per-file commits, terminal creation, provider/ACP discovery, raw transcripts,
or unbounded SSE (server-sent events) monitoring. Task editing, deletion,
archiving, discard, orphan cleanup, and per-file commits remain TUI or
authenticated-API operations; provider/ACP discovery remains CLI
(`providers`, `harnesses`) or API; unarchive and terminal creation are
authenticated-API-only (no TUI or CLI surface exists for terminals today);
raw provider transcripts are not exposed by any surface. `tail_session` is
bounded, `task_context` deliberately omits raw transcripts, comments are not
chat, and Session Chat is not a Retry substitute.

## 18. Safety, persistence, and data retention

Read [SECURITY.md](SECURITY.md) before running agents on anything sensitive.

### Threat model

- **A dispatched agent is your shell.** It runs as your user and can read,
  write, execute commands, invoke Git, and reach anything that account can
  reach. Worktree isolation protects repository coordination; it is not an OS
  sandbox.
- **Keep the loopback default.** The supported safety posture binds the board
  and spawned OpenCode server to `127.0.0.1`. `OPENCODE_HOSTNAME` can override
  that hostname for both services; never point it at a network interface. A
  bearer token protects API calls but does not make the service safe to publish.
- **Workspace is an admission boundary.** Relative paths resolve under the
  named workspace. Canonicalization collapses `..`, then rejects the result only
  when it escapes the workspace; symlink escapes are also rejected. The
  process-wide external-directory override disables that protection and should
  be used only on an intentionally broad trusted instance.
- **Permissions are not containment.** Allow/ask/deny rules govern provider tool
  calls. A permitted shell command still runs with your user privileges.
- **Review before acceptance.** Agent reports, Auto-run, watchdog recovery, and
  an orchestrator's `confirmReviewed` field are evidence/attestations, not proof
  that code is correct.

### Tokens and sensitive output

Named-instance tokens are stored in the registry and injected automatically by
the CLI, TUI, and bound MCP wrapper. Health is public on loopback; other API
routes require the token. Clients normally send it as a bearer header;
SSE/EventSource clients may pass the same token as a `board_token` query
parameter instead. OpenBoard displays only token presence.

Do not publish `instances.json`, SQLite databases, daemon logs, task JSON,
session output, or screenshots without review. They can contain prompts,
filesystem paths, model/provider details, changed-file lists, session IDs,
command output, and residual-risk notes. Log redaction handles common token
patterns but is not a general secret scanner.

### Persistence and retention semantics

| Operation | What remains |
|---|---|
| Stop/restart instance | Registry, token, databases, tasks, log, archive rows, worktree records, and branches. |
| Remove instance | Per-instance data directory and global archive remain; only registry/default registration is removed. |
| Rename instance | Data directory and identity move to the new name; running instance is restarted. |
| Archive card | Source task remains archived in its instance DB and a snapshot is mirrored globally. |
| Unarchive source card | Active source task returns; the global snapshot remains. |
| Delete source card | Source task is removed; an existing global archive snapshot remains. |
| Integrate/discard/delete worktree | Task worktree is removed only when its operation succeeds; safe discard/delete may refuse dirty cleanup. `board/*` branch is kept. |

Archiving is not secure deletion. To dispose of history, stop/unregister the
instance as appropriate and deliberately remove the relevant retained data and
global archive records outside OpenBoard after confirming the exact paths.

## 19. Known issues and current boundaries

### Deliberate boundaries — don't report these

- **Agent roster updates need restart.** OpenCode reads agent config at boot;
  restart the instance after adding or changing profiles.
- **Branches accumulate deliberately.** Integration, discard, delete, and
  orphan cleanup keep `board/*` branches for salvage. Clean orphan worktrees are
  swept automatically; dirty ones require explicit Settings cleanup.
- **Watchdog is conservative.** It waits the configured no-progress window and
  defers around permissions/reconnect uncertainty before spending its two-retry
  budget.
- **Container isolation is a placeholder.** It appears as a disabled concept
  but has no runtime or permissions implementation.
- **The global archive is read-only in the TUI.** There is no TUI unarchive or
  per-record purge workflow.
- **MCP is intentionally narrower than the authenticated API.** See
  [§17](#17-mcp-operator-guide) for unavailable
  task-edit/archive/discard/per-file/orphan operations.
- **The terminal API has no TUI or CLI surface.** A server-side terminal
  backend exists (workspace-confined, session-capped), but nothing in the TUI,
  CLI, or MCP reaches it today; it is authenticated-API-only.

### Rough edges — reports welcome

- **Malformed OpenCode profiles can prevent startup.** Use `doctor` and logs;
  startup errors are not surfaced well in the TUI.
- **Registered-but-never-started rename can fail.** Rename moves the old data
  directory; an instance that has never started may not have one yet. Start it
  once before renaming.
- **Unhealthy remove/rename needs an explicit stop.** Current auto-stop logic
  recognizes only the exact healthy-running state. Run `openboard stop <name>`
  before remove or rename when a live instance reports unhealthy.
- **Task sync has no board key.** `sync_task` exists through MCP/API, but `s` in
  TUI selectors controls instance start/stop. The wizard's older Sync-key hint
  should not be treated as an available action.
- **Git-init is not state-gated in the TUI.** Use `g` only on a card visibly
  pending `git init required`; the current handler can otherwise initialize and
  run an unintended directory.
- **The `?` overlay is abbreviated.** It does not currently list every detail
  tab or all View Diff controls. Use [§22](#22-contextual-key-reference) for the
  complete contextual reference.
- **Claude Code abort is best-effort.** Its background adapter does not provide
  a fully reliable stop; Abort may record an error instead.
- **Non-Claude ACP harnesses are experimental.** Codex, Gemini, Hermes, Pi
  Coding Agent, and Cursor are discovered and wired but not verified end to
  end. Permission-mode validation is still shaped around Claude's mode set.

Nested provider model IDs such as `openrouter/anthropic/claude-*` are supported;
they are no longer a known limitation.

## 20. What to test and how to report

The flows most worth exercising, roughly in order:

1. **Fresh install** — clone, install, build, link, register, start, doctor, and
   attach on a machine the project has not touched.
2. **First worktree task** — follow [§4](#4-your-first-task-in-five-minutes),
   verify the double-run confirmation,
   detail tabs, diff, conditional integration confirmation, Done attribution,
   removed worktree, and retained branch.
3. **Card configuration** — create/edit agent and manual cards; exercise model
   filtering, fallback, isolation, permission overrides, parents, and Auto-run
   eligibility.
4. **Named instances** — run two boards, set/clear default, switch with `b`,
   inspect JSON, stop/restart, and browse the cross-instance archive.
5. **Two agents, one repo** — use separate worktrees, review both, synchronize
   one through MCP/API if needed, and integrate without clobbering base.
6. **Permission request** — trigger an external-directory ask, verify the
   deadline, allow-once/deny behavior, and repeated ask semantics.
7. **Blocked answer** — produce a `needsInput` block, answer it from the TUI,
   and verify same-session or fresh-session recovery plus stale protection.
8. **Watchdog/fallback** — in a scratch repo and disposable instance, shorten
   the watchdog interval, inspect Attempts, and verify exhausted retries become
   blocked Review rather than Done.
9. **Session Chat** — queue and interrupt messages, reconnect once, and copy a
   complete fenced code block.
10. **Evidence lineage** — run Build → Audit → Fix; inspect parent context,
    current diff, ancestor cycling, and Build→Fix comparison.
11. **Harness coverage** — run Claude Code if installed; treat every other ACP
    harness as experimental and report the exact adapter/model/mode.
12. **Plugin orchestration** — prove board identity, approve a small plan,
    dispatch it in a scratch repo, inspect Review independently, and integrate
    only accepted work.

For repository changes, use the normal validation sequence:

```sh
npm run typecheck
npm test
npm run test:integration
npm run build:app
```

File reports as GitHub issues on the repository (Bug report or Tester
feedback): <https://github.com/johnnyvincentvitale/OpenBoard/issues>. Report
what you did, expected, and observed. Include the instance name,
OpenBoard build/commit, harness/provider/model, card state, task ID, relevant
Handoff/Attempts/Event evidence, and the smallest useful scrubbed log excerpt.
State whether integration tests ran or self-skipped. Never paste API tokens,
registry contents, secrets, private prompts, or unreviewed task JSON/logs.

## 21. Troubleshooting by symptom

Start with `openboard list`, then `status`, `doctor`, and a bounded log tail.
Card-specific failures also require the selected detail tabs, task events, and
worktree state.

| Symptom | What it usually means | Recovery |
|---|---|---|
| Unknown instance | Name is absent from the registry | Correct the name or `openboard add`; do not overwrite an existing retained data directory blindly. |
| Attach has no target | No instances exist, or multiple instances have no explicit default | Register one, pass a name, or use `openboard default set`. |
| Instance is stopped | No live daemon | `openboard start <name>` or use `openboard <name>`. |
| `stale-pid` | Pidfile references a dead process | Inspect again after automatic pidfile cleanup, then start. |
| `unhealthy` | Process exists but health fails | Read `doctor` and `logs --tail 200`, then restart if appropriate. |
| Port already in use | Board or fixed OpenCode port collides | Stop the owner or register a different port; startup fails before half-starting. |
| Board will not start after profile edit | OpenCode cannot parse an agent profile | Inspect logs, repair/remove the malformed profile, then restart. |
| New profile/provider is missing | OpenCode cached configuration at boot | Verify OpenCode auth/config, then restart and re-run `agents`/`providers`. |
| Card errors immediately on Run | Admission, harness, model, workspace, Git, or provider failure before useful work | Read Error, Output/events, `doctor`, live roster/providers/harnesses, then edit the To Do card or Retry only after correcting cause. |
| Child refuses to run | One or more parent gates are unmet, blocked, or unconfirmed | Inspect parent IDs/outcomes. Complete/resolve parents; do not force the child by copying context manually. |
| Auto-run child stays To Do | Auto-dispatch failed or parent did not report confirmed complete | Inspect `task_warning`/causality, fix configuration, and Run manually when safe. |
| Card says Needs User Input | Permission ask is inside its grace window | Inspect tool/summary/deadline and answer exact ask with `y` or `N`. Refresh after stale conflict. |
| Permission disappeared | Ask expired or runtime restarted | Inspect session output/events; pending asks are not durable. Retry the task only if appropriate. |
| Review says Unconfirmed | Session idled without a structured completion report | Inspect Output, Diff, Files, tests, and residual state; do not treat it as confirmed success. |
| Review says Blocked | Agent/watchdog filed unresolved evidence | Press `R`, answer current question, or use ordinary Retry/Discard/explicit incomplete acceptance. |
| OpenCode watchdog exhausted | Two automatic recovery attempts failed | Read Attempts, partial diff, last error, and fallback use before deciding. ACP harnesses do not use this retry flow. |
| Unsafe RUNNING card | Run state disagrees with lane/session identity | Restart and see whether startup recovery resolves it; if unsafe remains, inspect events/worktree, then Abort or Retry. Do not integrate first. |
| Session Chat says RECONNECTING | SSE ended before terminal and is retrying | Wait for reconnect; verify instance health if persistent. |
| Session Chat says STATIC | Only a snapshot or completed stream is available | Refresh once; continuation requires a resumable provider session. |
| Session Chat says GAP | Event sequence is incomplete | Check status/logs and current task state; do not duplicate a message to create activity. |
| Done move is rejected | Changed worktree is unresolved or session still writing | Stop if needed, review, then Integrate or deliberately Discard/resolve before Done. |
| Integrate needs another `i` | Uncommitted files remain | Inspect committed/uncommitted lists; second `i` commits remaining files and proceeds. |
| Sync merge conflict | `sync_task` returned a Git merge conflict without a pending card state | Resolve and commit in the task worktree, then retry Sync or proceed deliberately. |
| Integrate rebase conflict | Integrate recorded pending conflict paths | Resolve named paths in the task worktree, verify, then use `R`; do not delete the checkout. |
| Base-checkout escape | Isolated worker changed the base checkout | Stop and inspect named paths in both trees; restore/retain deliberately before acceptance. |
| Diff says no Git evidence | Baseline/ref/worktree is missing, dirty, unrelated, or unsuitable | Read the honest reason; inspect individual task diffs and Git state rather than assuming no change. |
| Dirty orphan appears in Settings | Startup found an unreferenced worktree with data | Inspect/salvage it; delete only with the two-press Settings action. Branch is retained. |
| Two agents overwrote each other | They shared an in-place checkout | Stop, inspect Git, recover manually, and use worktree isolation or disjoint directories next time. |
| MCP tools target the wrong board | MCP selection and visible TUI differ | Stop mutations; run `current_instance`, reselect, then prove with `openboard_status`, tasks, and agents. |
| `add_tasks` failed halfway | Earlier cards were already created | Re-list and reconcile returned/title-prefixed cards before retrying. |
| Archived card is missing from board | Archive hides active rows | Press `A`, clear search/filters, and inspect the correct source instance. |
| Board shows only "OpenBoard needs more room" | Terminal is below the minimum supported size | Enlarge the terminal window; the board renders once it fits. `q` quits. |
| TUI asks for a workspace at launch | Self-owned launch found no instances and no workspace | Enter the intended repository path, or quit and launch with `BOARD_WORKSPACE` or a named instance. |

## 22. Contextual key reference

### Board

| Key | Action |
|---|---|
| `↑`/`↓` | Previous/next visible card |
| `←`/`→` | Adjacent lane |
| `enter` | Open/close card detail |
| `n` | New card |
| `e` | Edit selected To Do card |
| `f` | Open filter; press again to clear |
| `r` | Run To Do agent card; press again to confirm |
| `R` | Retry error/rebase-conflict; on blocked Review, open answer composer |
| `k` | Abort In Progress; press again to confirm |
| `y` / `N` | Allow once / deny current permission ask |
| `v` | View Diff for Review/Done agent card |
| `w` | Session Chat for a card with a session |
| `i` | Integrate Review worktree; second press only when uncommitted files require confirmation |
| `D` | Discard Review worktree; press again to confirm |
| `x` | Accept Review to Done; press again to confirm |
| `a` | Archive Done; press again to confirm |
| `d` | Delete eligible card; press again to confirm |
| `g` | Initialize Git and Run; not state-gated, so use only on a card visibly pending Git init; press again to confirm |
| `m` | Manual lane move |
| `p` | Settings/diagnostics |
| `u` | Refresh and reconcile |
| `b` | Instance switcher |
| `A` | Global archive |
| `?` | In-app help overlay |
| `q` | Quit |
| `esc` | Clear a pending confirmation |

`Ctrl+C` shuts down from any surface. Uppercase `E` and `F` behave like `e`
and `f`; in the wizard, `B` behaves like `b`.

After `m`, choose a lane with `↑`/`↓` or `1`–`4`, then press `Enter`.
Moving to Done requires a second `Enter` and records acceptance; `esc` cancels.

### Card detail

| Key | Action |
|---|---|
| `←`/`→`/`Tab` | Switch Prompt/Handoff/Output/Files/Attempts/Comments |
| `↑`/`↓` | Scroll current tab; in Files list, select file |
| `enter` | Close generic detail; in Files list, open selected patch; in a comment draft, submit |
| `c` | In Files, commit selected Review file; in Comments, create comment |
| `r` | In Comments, reply to selected comment |
| `Ctrl+U` | Clear active comment draft |
| `esc` | Return from Files patch, close detail, or cancel comment draft |
| `q` | Quit while browsing detail |

### View Diff

| Key | Action |
|---|---|
| `↑`/`↓` | Select file or scroll when patch is locked |
| `enter` | Toggle file selection / patch-scroll lock |
| `←`/`→` | Previous/next hunk |
| `a` | Cycle target and ancestor evidence |
| `m` | Toggle reviewed marker for selected file |
| `t` | Split/inline presentation |
| `c` | Commit selected Review file |
| `e` | Open selected Review file in editor |
| `r` | Refresh diff |
| `?` | Help overlay |
| `b`/`esc` | Return to board |
| `q` | Quit |

### Session Chat

| Key | Action |
|---|---|
| `i` | Compose message |
| `Enter` | Send or queue |
| `Ctrl+Enter` | Interrupt active turn, then send |
| `Shift+Enter` | Newline in draft |
| `Ctrl+U` | Clear entire draft |
| `↑`/`↓` | Manual history scroll |
| `f` | Return to live tail |
| `Tab`/`Shift+Tab` | Next/previous code block |
| `c` | Copy complete selected code block |
| `y`/`N` | Allow once / deny permission for the open chat card |
| `u` | Refresh board/task state |
| `b`/`esc`/`q` | Return to board |

Bracketed paste is supported in the Session Chat composer, the blocked-answer
composer, wizard text fields, and the workspace-setup screen.

### Archive

| Key | Action |
|---|---|
| `↑`/`↓` | Select record or scroll focused detail |
| `enter` | Focus/unfocus detail |
| `←`/`→`/`Tab` | Switch detail tabs |
| `e` | Expand/collapse metadata |
| `/` | Search; Enter exits search mode |
| `i` | Cycle instance filter |
| `l` | Cycle lane filter |
| `u` | Refresh |
| `b` | Return |
| `q` | Quit |

### Settings and instance selection

| Context | Keys |
|---|---|
| Settings | `u` refresh, `D` dirty orphans, `b`/`esc` back, `q` quit |
| Dirty orphans | `↑`/`↓`, `d` twice to remove selected worktree, `u`, `b`/`esc` |
| Launch selector | `↑`/`↓`, Enter start-if-needed/attach, `n` add, `e` rename, `s` stop, `d` twice remove, `A`, `q`/`esc` |
| In-board switcher | `↑`/`↓`, Enter attach, `s` start/stop, `b`/`esc` close |

## 23. Environment variables and paths

Named instances inject their normal configuration automatically. These values
matter mainly for raw/dev launches, deliberate overrides, or troubleshooting.

### Runtime variables

| Variable | Purpose |
|---|---|
| `OPENBOARD_PORT` | Board HTTP port for raw server launch. |
| `OPENBOARD_DB` | Primary task database path; named instances derive their sibling board database from it. |
| `BOARD_PORT` | Legacy board-port fallback when `OPENBOARD_PORT` is unset. |
| `BOARD_DB_PATH`, `BOARD_TASK_DB_PATH` | Legacy per-store SQLite overrides; each wins over the path derived from `OPENBOARD_DB`. |
| `BOARD_WORKSPACE` | Canonical directory boundary and default working directory. |
| `OPENBOARD_OPENCODE_PORT` | Fixed spawned OpenCode backend port. Named instances normally choose a free one. |
| `OPENCODE_PORT` | Legacy/fallback spawned OpenCode port when `OPENBOARD_OPENCODE_PORT` is unset. |
| `OPENCODE_BASE_URL` | Connect to an existing OpenCode server instead of selecting spawn mode implicitly. |
| `OPENCODE_MANAGE_PROCESS` | Explicitly control whether OpenBoard owns the configured OpenCode process. |
| `OPENCODE_HOSTNAME` | Bind hostname used by the board and spawned OpenCode server; keep the loopback default. Named-instance health probes always target `127.0.0.1`, so a non-loopback hostname also breaks `list`/`status` health checks. |
| `OPENCODE_HEALTHCHECK_ATTEMPTS`, `OPENCODE_HEALTHCHECK_TIMEOUT_MS`, `OPENCODE_HEALTHCHECK_DELAY_MS` | Tune spawned-OpenCode health probing: attempt count, per-attempt timeout, and retry delay. |
| `OPENBOARD_API_TOKEN` | Explicit bearer token for raw/manual clients. Named CLI/TUI/MCP injection is preferred. |
| `OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES` | Process-wide workspace-boundary override (`true`/`1`). Unsafe for shared/general instances. |
| `OPENBOARD_WATCHDOG_MS` | No-progress threshold; default `600000`, `0` disables. |
| `OPENBOARD_PERMISSION_GRACE_MS` | Permission answer window; default `60000`. |
| `OPENBOARD_EDITOR` | Editor command template supporting `{file}` and `{line}`. |
| `VISUAL`, `EDITOR` | Editor fallback order after `OPENBOARD_EDITOR`. |
| `OPENBOARD_TUI_SAFE` | Force the TUI's color-safe rendering mode. |
| ACP command overrides | `OPENBOARD_CLAUDE_ACP_COMMAND`, `OPENBOARD_CODEX_ACP_COMMAND`, `OPENBOARD_GEMINI_ACP_COMMAND`, `OPENBOARD_HERMES_ACP_COMMAND`, `OPENBOARD_PI_ACP_COMMAND`, `OPENBOARD_CURSOR_ACP_COMMAND`; Cursor also accepts `OPENBOARD_CURSOR_ACP_MCP_COMMAND`. |
| `OPENCODE_BOARD_URL` | Advanced/manual board URL for MCP or external clients. Named selection is safer. |
| `OPENBOARD_ARCHIVE_DB` | Override the global archive database used by both server writes and TUI reads; both processes must resolve the same path. |
| `OPENBOARD_DATA_DIR` | Override the self-owned `npm run tui` data directory. Named instances use their registered data paths. |

### Default paths

| Data | Path |
|---|---|
| Instance registry, tokens, explicit default | `~/.config/openboard/instances.json` |
| Per-instance directory | `~/.local/share/openboard/<name>/` |
| Named-instance primary task DB | `~/.local/share/openboard/<name>/board.sqlite` |
| Named-instance column-store sidecar | `~/.local/share/openboard/<name>/board-board.sqlite` |
| Named-instance daemon pidfile | `~/.local/share/openboard/<name>/openboard.pid` |
| Named-instance append-only log | `~/.local/share/openboard/<name>/openboard.log` |
| Cross-instance global archive | `~/.local/share/openboard/archive.sqlite` |
| Managed task worktrees | Normally `<repo-parent>/.opencode-board-worktrees/<repo>/<task-id>` when admitted; otherwise `<workspace>/.opencode-board-worktrees/<repo>/<task-id>` |
| OpenCode agent profiles | Usually `~/.config/opencode/agent/<name>.md` or `opencode.jsonc` |

Raw launches that leave `OPENBOARD_DB` unset fall back to the legacy pair
`board-tasks.sqlite` (task store) and `board.sqlite` (column store) in the
working directory.

Never commit `dist/`, `node_modules/`, `.env*`, `*.sqlite*`, `*.log`,
`.opencode-board-worktrees/`, `.claude/worktrees/`, or `.DS_Store`.

## 24. Glossary

- **ACP (Agent Client Protocol)** — the protocol OpenBoard uses to drive
  non-OpenCode harnesses (Claude Code, Codex, Gemini, Hermes, Pi Coding Agent,
  Cursor).
- **Admission** — the server-side checks a request must pass before OpenBoard
  acts: workspace boundary, task/session identity, and current-state matching.
- **Base checkout** — the repository checkout a worktree card branched from;
  its before/after state feeds escape detection.
- **Blocked** — a structured incomplete report carrying a question or
  unresolved dependency; distinct from a generic error and from a permission
  ask.
- **Card / task** — the same durable board object; "card" emphasizes the TUI
  representation, "task" the stored record.
- **Cockpit / orchestrator** — a coding-agent session that drives the board
  through MCP while you supervise.
- **Completion source** — who vouched for Review: `reported` (agent handoff),
  `idle-fallback` (session went idle; Unconfirmed), or `watchdog`
  (system-authored block).
- **Dominant state** — the single most decision-relevant state the board
  surfaces when column, run state, pending decisions, and completion overlap
  (precedence in [§10](#10-card-lifecycle-and-operator-decisions)).
- **Escape detection** — comparing the base checkout before and after an
  isolated run to catch writes that landed outside the task worktree.
- **Handoff** — the structured completion report: summary, changed files,
  verification commands/results, residual risk.
- **Harness** — the agent runtime that executes a card: OpenCode, or an ACP
  adapter such as Claude Code.
- **MCP (Model Context Protocol)** — the tool protocol orchestrators use to
  control the board (`openboard mcp`).
- **Session** — one live agent run dispatched from a card; Session Chat
  continues it, Retry resumes or replaces it.
- **SSE (server-sent events)** — the one-way HTTP streams the TUI and clients
  use for live board and session activity.
- **Workspace** — the admission-boundary directory registered for an instance;
  task directories must normally live inside it.
- **Worktree isolation** — a per-card `git worktree` on a `board/<taskId>`
  branch so concurrent cards never share a checkout.

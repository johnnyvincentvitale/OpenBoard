# OpenBoard User Guide

Welcome — you're one of the first people outside the project to run OpenBoard.
This guide takes you from a fresh clone to running autonomous agents on a
Kanban board, and ends with what we'd most like you to test. The
[README](README.md) is the reference; this is the tour.

## Contents

1. [What OpenBoard is](#1-what-openboard-is)
2. [Before you start](#2-before-you-start)
3. [Install](#3-install)
4. [Your first task in five minutes](#4-your-first-task-in-five-minutes)
5. [Core concepts](#5-core-concepts)
6. [Orchestration and multi-agent workflows](#6-orchestration-and-multi-agent-workflows)
7. [Everyday use](#7-everyday-use)
8. [Harnesses: OpenCode and Claude Code](#8-harnesses-opencode-and-claude-code)
9. [Safety notes](#9-safety-notes)
10. [Known issues and rough edges](#10-known-issues-and-rough-edges)
11. [What to test and how to report](#11-what-to-test-and-how-to-report)
12. [Troubleshooting](#12-troubleshooting)

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

What OpenBoard is *not*: it's not a chat UI, and it's not hosted. Everything —
the board, the agents, your code, the task database — runs and stays on your
machine.

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

**Verify OpenCode works by itself first.** Before touching OpenBoard, open a
terminal, run `opencode` in some repo, and ask it to do something trivial. If
that doesn't work, OpenBoard can't fix it — get OpenCode happy first
(`opencode auth login` for providers). Most first-run problems trace back to
this step.

## 3. Install

You'll need your GitHub invite to this repo accepted first. Then:

```sh
git clone <repo-url> openboard
cd openboard
npm install
npm run build:app
```

`build:app` builds everything into `dist/`, including the `openboard` CLI
binary (`dist/cli/openboard.mjs`). To get `openboard` on your PATH:

```sh
npm link      # or symlink dist/cli/openboard.mjs into your PATH
```

## 4. Your first task in five minutes

Start a board in the OpenBoard repo itself — no setup needed:

```sh
npm run tui
```

This boots the board and its OpenCode backend and opens the TUI in your
terminal. Then:

1. Press **`n`** — new task.
2. **`TITLE`**: name the card. **`PROMPT`**: the actual instruction the agent
   receives. Write it like a work order: what to change, where, and how to
   verify. `Tab` moves between fields.
3. **`HARNESS`**: leave it on OpenCode for now. **`AGENT`**: pick `build` (the
   general-purpose worker). **`MODEL`**: pick one, or leave the agent default.
4. **`DIR`**: the directory the agent works in — point it at a scratch repo,
   not something precious, for your first run.
5. Press **`enter`** to create the card, then **`r`** to run it.

A good starter task: *"Create a file called HELLO.md containing a haiku about
kanban boards, then verify it exists."* Small, harmless, observable.

Watch the card move to In Progress, then Review. Select it and press **`enter`**
to read the agent's handoff — its summary, changed files, and what it ran to
verify. If you accept the work, press **`x`** to move it to Done. If not,
**`R`** retries. Press **`?`** anytime for the full key reference.

## 5. Core concepts

**Task vs. session.** A task is the durable spec on the board; a session is the
live agent run it dispatches. Retry creates a fresh session for the same task.

**Agents come from your harnesses, not from OpenBoard.** OpenCode cards bind
one of your OpenCode agents (`build`, `plan`, `general`, `explore`, plus any
you define in your OpenCode config). Claude Code cards dispatch a Claude Code
session instead. OpenBoard adds the board, the dispatch, and the lifecycle —
it doesn't invent its own agent system.

**Five lanes.** To Do · In Progress · Review · Done · Error. The board moves
cards through the first three automatically; Error means dispatch or the run
itself failed.

**Reported vs. unconfirmed completion.** Every dispatched prompt tells the
agent how to end its turn: report back with a structured completion — summary,
changed files, verification commands and results, residual risk. A card that
reaches Review with a report is solid ground. If the agent just went quiet
instead, the card still reaches Review but is labeled **unconfirmed** — the
work may be fine, but nothing vouches for it, so inspect before accepting.

**Done is yours — unless you delegate it.** By default a human moves cards to
Done (`x` in the TUI). If you run an orchestrator (next section), you can
prompt it to review and accept work on your behalf — the API requires every
Done move to name who accepted it, so the audit trail survives either way.

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

This injects the board URL and auth token automatically and exposes the full
control surface as tools: create/list/link tasks, run/retry/abort/move,
structured complete/block reports, worktree sync/integrate, comments, and
event streams. Guardrails are built in — moving a card to Done requires
`completedBy`, and integrating a worktree requires `confirmReviewed: true` —
so a cockpit can't silently accept or merge anything.

**Dependencies and handoffs.** Cards can declare parent tasks. A child with
unmet parents refuses to run, and once its parents complete, their summaries,
changed files, and verification results are injected into the child's prompt
as `PARENT HANDOFFS`. This is how multi-card runs stay coherent: downstream
agents start from upstream context instead of rediscovering it.

**The bundled plugin.** `plugins/openboard/` packages this workflow as
installable skills for Claude Code, Codex, and OpenCode:

```
startup → agent-readiness → board-plan → create-profile → openboard-orchestrator
```

Connect to the board, optionally score the target repo's readiness for
autonomous work, plan the run together, validate any custom agent profiles,
then dispatch and verify. Install instructions:
[plugins/openboard/README.md](plugins/openboard/README.md).

## 7. Everyday use

**Named instances — one board per repo.** `npm run tui` is fine for a quick
session, but the daily driver is the CLI, which runs each board as a
background daemon with its own port, workspace, and database:

```sh
openboard add my-repo --workspace /path/to/repo   # register (auto-starts)
openboard attach my-repo                          # open the TUI
openboard list                                    # status of all instances
openboard stop my-repo / start my-repo / remove my-repo / rename old new
```

Shortcuts: `openboard my-repo` starts-if-needed and attaches; bare `openboard`
opens an interactive selector. Instance state lives under
`~/.config/openboard/` (registry + tokens) and `~/.local/share/openboard/<name>/`
(database, daemon pid, log).

The instance's **workspace** matters: task directories must live inside it, so
register the instance against the repo — or parent directory — you actually
want agents working in.

**The TUI.** Five lanes plus a sidebar showing the selected card's full detail
(state, agent/harness, model, directory, worktree, session). Press **`?`** for
the complete key overlay — that's the authoritative reference. The ones you'll
use constantly: `n` new task, `r` run, `enter` read the handoff, `x` accept to
Done, `b` switch instances, `A` browse the archive.

**Worktree isolation — the multi-agent rule.** Concurrent agents in one repo
share a working tree and *will* clobber each other; there's no file locking.
Turn on worktree isolation (board-level default, per-task override) and each
run gets its own `git worktree` on a `board/<taskId>` branch — never your main
tree. After a run: **`s`** syncs the base branch into the worktree (resolve
drift there), **`i`** integrates the worktree branch back into base and removes
the worktree. Conflicts are reported, never forced. Rule of thumb: isolate
whenever more than one card can touch the same repo, and read the worktree
diff before integrating.

## 8. Harnesses: OpenCode and Claude Code

Every card has a `HARNESS` field.

**OpenCode** (default). The card binds one of your OpenCode agents and any
model your OpenCode install is authenticated for. Agents are defined in your
OpenCode config (`~/.config/opencode/agent/<name>.md` or `opencode.jsonc`).
One catch: OpenCode reads agent config at boot only, so after adding or
editing an agent, restart the board instance to see it in the roster.

**Claude Code.** The card dispatches a background Claude Code session instead.
What changes:

- `MODEL` offers Claude aliases: `sonnet`, `opus`, `fable`.
- The `AGENT` dropdown becomes `PERMS` — the permission mode for the run. The
  default is `bypassPermissions`; stricter modes exist but tend to stall
  headless work on permission prompts.
- Claude reports completion through the same structured contract, so its cards
  participate in Review, handoffs, and dependencies like any other.
- **Commit before dispatching Claude into a repo.** If the target has
  uncommitted changes, the card gets a warning and Claude may isolate its edits
  into its own worktree instead of editing in place. The card's `RUN DIR` /
  `RUN BRANCH` / `RUN COMMIT` / `RESULT` rows show where the work actually
  landed, and harness-created worktrees feed the normal sync/integrate flow.

## 9. Safety notes

Read [SECURITY.md](SECURITY.md) before running agents on anything sensitive.
The short version:

- **A dispatched agent is your shell.** It runs as your user and can read,
  write, and execute anything in its workspace. Only point cards at
  directories you'd let a very fast, very literal contractor loose in.
- **Loopback only.** The board binds to `127.0.0.1`. Never expose the board
  port or the spawned OpenCode port on a network interface — that's remote
  shell access for whoever finds it.
- **Everything persists locally.** Task prompts, completion reports, and paths
  live in SQLite under `~/.local/share/openboard/`. Archiving hides cards; it
  doesn't delete them. Delete the data directories to actually dispose of
  board history.

## 10. Known issues and rough edges

Things we already know about — no need to report these:

- **Agent roster updates need a restart.** OpenCode reads agent config at boot
  only; the board has no reload yet.
- **A malformed OpenCode agent profile can kill board startup.** If a bad
  `~/.config/opencode/agent/*.md` makes the board look dead on start, that's
  probably it — startup errors aren't surfaced well in the TUI yet.
- **Worktrees and `board/*` branches accumulate.** There's no cleanup
  affordance yet; sweep stale ones manually.
- **No stall detection.** A hung agent session isn't auto-detected; if a card
  sits In Progress implausibly long, check it yourself.
- **Retries are unbounded.** Nothing stops you (or an orchestrator) from
  retrying a doomed card forever.
- **Stopping a Claude Code card is best-effort.** Claude doesn't expose a
  reliable background-stop yet; abort may just record an error on the card.
- **MCP `add_tasks` rejects models with two-slash ids** (e.g.
  `openrouter/anthropic/...`). Workaround: set the model on an agent profile
  instead.

## 11. What to test and how to report

The flows we most want exercised, roughly in order:

1. **Fresh install** — clone → build → `npm run tui` on a machine we've never
   touched. Every stumble here is gold.
2. **First-task happy path** — section 4, exactly as written. Did the card
   advance? Was the handoff readable? Did anything surprise you?
3. **Named instances** — add a board for a real repo of yours, attach, stop,
   restart, switch between two instances with `b`.
4. **Two agents, one repo** — enable worktree isolation, run two cards
   concurrently, sync and integrate the results.
5. **Claude Code harness** — if you have Claude Code: one card end-to-end,
   including the dirty-repo warning (dispatch into a repo with uncommitted
   changes and see what it does).
6. **Orchestration** — if you're comfortable: install the plugin, open a
   cockpit session, and let it run a small multi-card plan against a scratch
   repo.

**Reporting:** open an issue on this repo. Include what you did, what you
expected, what happened, and — if a card was involved — the card's handoff
detail (`enter` on the card) and the instance log
(`~/.local/share/openboard/<name>/openboard.log`). Rough impressions are as
welcome as bugs: if something felt confusing, that's a finding.

## 12. Troubleshooting

**A card errors immediately on Run.** The prompt was never admitted. Check
`openboard list`, then the instance's `openboard.log`; usually the agent or
model on the card doesn't exist in your OpenCode auth, or OpenCode itself is
unhappy.

**Board looks dead on start.** Check the instance log first; a malformed
OpenCode agent profile is the usual suspect (see Known issues).

**A new agent doesn't appear in the roster.** Restart the instance:
`openboard stop <name> && openboard start <name>`.

**`openboard list` says `stale-pid` or `unhealthy`.** Stale pidfiles clean
themselves up on inspection. `unhealthy` means the process answers but fails
its health check — read the log, restart the instance.

**Port already in use.** Instance ports must be unique; a clash fails fast at
startup rather than half-starting. Pick another port or stop the squatter.

**A Review card says "unconfirmed."** The agent went idle without filing a
completion report. The work may be fine — inspect the session output before
accepting.

**Two agents stepped on each other.** That's the no-file-locking constraint.
Enable worktree isolation or assign non-overlapping work.

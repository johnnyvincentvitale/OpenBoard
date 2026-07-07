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
7. [The OpenBoard plugin and its skills](#7-the-openboard-plugin-and-its-skills)
8. [Everyday use](#8-everyday-use)
9. [Harnesses: OpenCode and Claude Code](#9-harnesses-opencode-and-claude-code)
10. [Safety notes](#10-safety-notes)
11. [Known issues and rough edges](#11-known-issues-and-rough-edges)
12. [What to test and how to report](#12-what-to-test-and-how-to-report)
13. [Troubleshooting](#13-troubleshooting)

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
terminal. Pressing **`n`** opens a 5-screen wizard — `enter` moves to the next
screen, **`b`** goes back, `Tab` moves between fields on the current screen,
and **`esc`** cancels the whole thing. Nothing is created until the final
screen — no card exists yet while you're filling this in.

1. **Identity.** **`TITLE`**: name the card. **`PROMPT`**: the actual
   instruction the agent receives — write it like a work order: what to
   change, where, and how to verify. **`DIR`**: the directory the agent works
   in — point it at a scratch repo, not something precious, for your first run.
2. **Harness & model.** **`HARNESS`**: leave it on OpenCode for now.
   **`PROVIDER`**: which of your currently-connected OpenCode providers to use
   (leave unset to pick from any model already attached to an agent).
   **`MODEL`**: pick one, or leave it unset to use the agent's default.
3. **Agent.** **`AGENT PROFILE`**: pick `build` (the general-purpose worker) —
   this is synced live from your OpenCode agent roster.
4. **Isolation.** Arrow between **`none`** and **`worktree`** — a description
   of each appears as you move. Worktree isolation also shows a fixed
   **`PERMISSIONS`** note (automatic, not editable — see §9); switch to
   **`none`** to get an editable EDIT/BASH/WEBFETCH permission control instead.
5. **Confirm.** A read-only summary of everything above. Press **`enter`** to
   create the card — this does *not* run it. Press **`b`** to go back and fix
   anything first.

Once the card exists, press **`r`** to run it.

A good starter task: *"Create a file called HELLO.md containing a haiku about
kanban boards, then verify it exists."* Small, harmless, observable.

Watch the card move to In Progress, then Review. Select it and press **`enter`**
to read the agent's handoff — its summary, changed files, and what it ran to
verify. Press **`v`** to inspect the full-screen diff before you accept it.
If you accept the work, press **`x`** to move it to Done. If not, **`R`**
retries. Press **`?`** anytime for the full key reference.

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

**The bundled plugin.** This whole workflow — connect, assess, plan, validate
profiles, dispatch, verify — is packaged as the OpenBoard plugin's skills for
Claude Code, Codex, and OpenCode. The next section breaks down what each skill
does; see [The OpenBoard plugin and its skills](#7-the-openboard-plugin-and-its-skills).

## 7. The OpenBoard plugin and its skills

Everything in the previous section runs through the **OpenBoard plugin** — a
bundle of skills (plus a small MCP server) that turns a coding-agent session into
an OpenBoard orchestrator cockpit. It lives in the repo at `plugins/openboard/`,
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
- **A bundled MCP server** (`.mcp.json`) — a local `openboard` server that binds
  to the selected board and exposes the guarded control surface (see §6). It
  starts unbound (`openboard mcp`) and is bound with `select_instance`; Done moves
  require `completedBy` and `integrate_task` requires `confirmReviewed: true`, so
  a cockpit can't silently accept or merge work.

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

## 8. Everyday use

**Named instances — one board per repo.** `npm run tui` is fine for a quick
session, but the daily driver is the CLI, which runs each board as a
background daemon with its own port, workspace, and database:

```sh
openboard add my-repo --workspace /path/to/repo   # register only (does not start)
openboard start my-repo                           # start the daemon
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
Done, `v` view a Review-card diff, `e` open the selected diff file in your
editor, `b` switch instances, `A` browse the archive.

**Worktree isolation — the multi-agent rule.** Concurrent agents in one repo
share a working tree and *will* clobber each other; there's no file locking.
Turn on worktree isolation (board-level default, per-task override) and each
run gets its own `git worktree` on a `board/<taskId>` branch — never your main
tree. After a run: **`s`** syncs the base branch into the worktree (resolve
drift there), **`i`** integrates the worktree branch back into base and removes
the worktree. Conflicts are reported, never forced. Rule of thumb: isolate
whenever more than one card can touch the same repo, and press **`v`** on the
Review card to read the worktree diff before integrating.

**Fix it yourself without leaving the diff.** From the DiffView (`v`), press
**`e`** to open the selected file at the selected hunk's line in your own
editor — `$VISUAL`/`$EDITOR`, whichever is set (`$VISUAL` wins if both are).
Terminal editors (vim, nvim, vi, emacs, emacsclient, nano, micro, kak, hx) take
over the terminal until you quit; GUI editors (subl, zed, code/code-insiders,
cursor, windsurf, gvim) open detached and hand control straight back. Set
`OPENBOARD_EDITOR` to override with your own command template — `{file}` and
`{line}` placeholders get substituted, e.g. `OPENBOARD_EDITOR="hx {file}:{line}"`.
Edits land in the diff's actual tree (the worktree, or the task directory for
in-place diffs) and the diff refreshes the moment you're back, so a quick fix
rides straight into the same Integrate — no separate PR round trip. Requires a
**local board** and a **configured editor**; there's no fallback guessing, so
an unset `$EDITOR` on a remote board fails loud with a status message instead
of silently doing nothing.

## 9. Harnesses: OpenCode and Claude Code

Every card has a `HARNESS` field, chosen on the wizard's Harness screen.

**OpenCode** (default). The card binds one of your OpenCode agents (`AGENT
PROFILE`, its own wizard screen) and a model. `PROVIDER`/`MODEL` are synced
live from `GET /api/providers` — the AI providers your OpenCode install is
currently connected to and authenticated for — not just whatever models
happen to already be attached to an agent; leave `PROVIDER` unset to fall back
to that agent-derived list. Agent profiles themselves are defined in your
OpenCode config (`~/.config/opencode/agent/<name>.md` or `opencode.jsonc`).
One catch: OpenCode reads agent config at boot only, so after adding or
editing an agent, restart the board instance to see it in the roster.

**Claude Code.** The card dispatches a background Claude Code session instead.
This is unchanged from before the wizard — just relocated into its screens.
Full Claude "agent profile" support (matching what OpenCode gets above) is a
separate, later workflow. What changes today:

- `MODEL` (Harness screen) offers Claude aliases: `sonnet`, `opus`, `fable`.
  There's no `PROVIDER` screen for Claude Code — that concept is OpenCode-only.
- The Agent screen shows `PERMS` instead of `AGENT PROFILE` — the permission
  mode for the run. The default is `bypassPermissions`; stricter modes exist
  but tend to stall headless work on permission prompts.
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

**OpenCode permissions, and why worktree isolation locks them.** The wizard's
isolation screen shows a `PERMISSIONS` section for OpenCode cards only.
Worktree-isolated runs already carry a layered safety stack — write-fenced
edit permissions, the base-checkout escape detector, worktree-cwd prompt
hygiene, and sandboxed bash — and that stack is **not configurable** from the
wizard; the screen just shows a note confirming it's active. Loosening it
per-task would undermine the whole point of isolating a run in the first
place. Select isolation **`none`** instead to get an editable `EDIT`/`BASH`/
`WEBFETCH` control (each `allow`/`ask`/`deny`), which defaults to `allow`
everywhere — i.e., today's behavior — until you actively tighten one.
"Container" isolation is a disabled placeholder in this same segmented
control; it isn't implemented yet and has no permissions story of its own.

## 10. Safety notes

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

## 11. Known issues and rough edges

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

## 12. What to test and how to report

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

## 13. Troubleshooting

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

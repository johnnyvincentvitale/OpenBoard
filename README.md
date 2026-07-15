# OpenBoard

OpenBoard is a local command center and shared communications surface for
multi-agent development. It gives individuals and teams a centralized ledger
where agent sessions can coordinate, exchange context, hand off work, and
record progress—whether workflows run autonomously, human-in-the-loop, or
somewhere in between.

[User Guide](https://openboard-docs.vercel.app/) ·
[Technical Reference](https://openboard-docs.vercel.app/reference/) ·
[Single-file Guide](https://openboard-docs.vercel.app/GUIDE.md)

## What OpenBoard provides

- **A shared task ledger.** Cards hold the task, working directory, assigned
  runtime, model, dependencies, status, and evidence from completed work.
- **Autonomous and human-guided workflows.** Run an unattended chain, pause for
  permissions or questions, or keep a human in the review loop throughout.
- **Multiple agent runtimes.** Coordinate OpenCode and supported Agent Client
  Protocol (ACP) runtimes from one board.
- **Isolated execution.** Give concurrent tasks their own Git worktrees, then
  review, synchronize, integrate, or discard their results deliberately.
- **Reviewable outcomes.** Inspect diffs, completion summaries, verification
  results, task lineage, and blocked-state evidence before accepting work.
- **Agent-facing orchestration.** Use the bundled Model Context Protocol (MCP)
  server and plugin to let a coding-agent session plan, dispatch, monitor, and
  review board work.
- **Local-first operation.** Named instances keep each board's workspace, data,
  process, and credentials separate on your machine.

## Example workflows

- **Build a feature in parallel.** Assign interface, backend, and test work to
  separate agents in isolated worktrees. Review and integrate each result
  without making the agents share a checkout or context window.
- **Hand work between agent sessions.** Let one agent investigate a problem,
  another implement the solution from its recorded findings, and a third verify
  the result. Each session can pick up from the board instead of reconstructing
  context from chat transcripts.
- **Compare independent reviews.** Ask multiple agents to inspect the same
  change, then collect their attributed findings in one durable record. A human
  or another agent can reconcile agreements, conflicts, and missed issues.
- **Automate routine maintenance.** Queue dependency updates, test repairs,
  documentation changes, or repository cleanup and let independent cards
  advance automatically while preserving review checkpoints.
- **Coordinate research and decisions.** Run several investigations in
  parallel, preserve their sources and conclusions, and begin synthesis only
  after every required input is available.

## Agent runtimes

OpenCode is the default runtime. ACP runtimes appear only when their adapter or
CLI is installed and available on the local machine.

| Runtime | Support |
|---|---|
| OpenCode | Supported; default runtime with agent-profile and provider discovery |
| Claude Code | Supported through ACP |
| Codex | Supported through ACP |
| Gemini | Supported through ACP |
| Hermes, Pi Coding Agent, Cursor | Experimental ACP integrations |

See the [User Guide](https://openboard-docs.vercel.app/) for runtime-specific
setup, permissions, models, and current limitations.

## Requirements

- Node.js 22 or newer
- Git
- OpenCode installed and authenticated for the default runtime, or a supported
  ACP runtime installed and authenticated
- A local project directory for the board to manage

## Install

```sh
git clone https://github.com/johnnyvincentvitale/OpenBoard.git openboard
cd openboard
npm install
npm run build:app
npm link
```

`npm link` exposes the `openboard` command on your `PATH`.

## Quick start

Register a project, then start and attach to its board:

```sh
openboard add my-project --workspace /absolute/path/to/project
openboard my-project
```

Inside the terminal UI:

1. Create a card with a clear task and working directory.
2. Choose an agent runtime, model, and execution mode.
3. Run the card manually or connect it to a larger workflow.
4. Follow progress, respond when needed, and inspect the resulting evidence.
5. Integrate accepted work or preserve the card as part of the project record.

For a one-off board launched directly from the source checkout, run:

```sh
npm run tui
```

## How it works

```text
Human or agent orchestrator
           │
   TUI · CLI · MCP tools
           │
 OpenBoard local server
   + SQLite task ledger
           │
 OpenCode or ACP runtime
           │
 Project workspace or isolated Git worktree
```

The TUI, CLI, and MCP server operate on the same local board state. Agent
runtimes execute the work; OpenBoard records task state, communication,
evidence, and review decisions around that work.

## Documentation

- [User Guide](https://openboard-docs.vercel.app/) — installation, everyday
  workflows, keyboard controls, multi-instance operation, recovery, and review
- [Technical Reference](https://openboard-docs.vercel.app/reference/) — concise
  product and technical reference
- [Single-file Guide](https://openboard-docs.vercel.app/GUIDE.md) — the complete
  guide in one Markdown file, suitable for handing to an agent
- [Security Policy](SECURITY.md) — local threat model, authentication, workspace
  boundaries, data retention, and vulnerability reporting
- [Bundled Plugin](plugins/openboard/README.md) — MCP and skill installation for
  supported coding-agent environments

Run `openboard --help` for the current CLI command reference.

## Security

> [!WARNING]
> OpenBoard dispatches agents with your local user account's permissions. Board
> access should be treated as equivalent to local terminal access. Keep
> OpenBoard bound to loopback, never expose its ports to a network, and review
> the [Security Policy](SECURITY.md) before using autonomous workflows.

Worktree isolation separates concurrent changes, but it is not an operating
system sandbox. Review agent permissions and generated evidence before
integrating changes.

## Development

```sh
npm install
npm run verify
```

`npm run verify` runs type checking, unit tests, integration tests, and the
application build. Use `npm run tui` to run a local board from source.

## Project status

OpenBoard is pre-release software under active development. Interfaces and
workflows may change before a stable release.

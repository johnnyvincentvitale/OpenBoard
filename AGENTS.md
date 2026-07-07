# Codex Instructions For OpenBoard

This file is the Codex adapter for the OpenBoard repo. Read `CLAUDE.md` first;
it is the canonical shared instruction file for this project.

## Working Agreement

- Assess from source. Read current files before making claims about behavior.
- Preserve the V1 boundary: TUI + named-instance CLI are the release surface.
  Do not treat web UI or Electron packaging as blockers unless the user asks.
- Keep edits scoped to the requested surface and the existing module layout.
- Do not remove dirty worktrees, task branches, runtime data, or generated
  artifacts unless the user explicitly approves the exact cleanup.
- Before editing files, state the intended change. After editing, verify with a
  diff or read-back.

## Verification

Prefer focused checks first, then broader checks before final handoff.

```sh
npm run typecheck
npm test
npm run test:integration
npm run build:app
```

Use `npm test` for fast unit/DOM coverage. Use `npm run test:integration` for
server/OpenCode lifecycle behavior. Use `npm run build:app` when touching
build, CLI, TUI, MCP, server entrypoints, or public packaging behavior.

## Agent Readiness Notes

The OpenBoard `agent-readiness` skill treats agent-facing context as a Tier 1
readiness requirement. For this repo, `CLAUDE.md` plus this `AGENTS.md` provide
that context. Keep them concise and update them when commands, launch paths, or
scope boundaries change.

For concurrent OpenBoard work, prefer worktree isolation. A green card is not
meaningful unless the agent ran or reported the relevant local verification.


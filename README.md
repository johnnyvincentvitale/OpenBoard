# opencode-board

A local, Devin-style **Kanban command center for [OpenCode](https://opencode.ai)**.
Cards are OpenCode sessions, pulled live from the `opencode serve` HTTP API and
organized across workflow columns (To Do / In Progress / Review / Done). A free,
self-hosted alternative to Devin Desktop's Kanban.

> Status: scaffolding. The adapter and board UI land on `dev`.

## How it works

```
opencode serve :4096  ──API──►  Hono adapter  ──API──►  React board (Vite)
   (sessions,          + better-sqlite3          (columns, drag-drop,
    /event SSE)          column sidecar           card actions)
```

- **Cards = OpenCode sessions.** Fields come from the session object: title,
  directory, agent, model, cost, diff stats, last-updated, plus a live "running"
  flag from `/api/session/active` and the `/event` SSE stream.
- **Columns are owned by this app.** OpenCode has no column concept, so column
  assignments live in a `better-sqlite3` sidecar keyed by session id.

## Stack

Node 22 · TypeScript · [`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk) ·
Hono · better-sqlite3 · React + Vite + dnd-kit · Vitest.

## Develop

```sh
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

You'll also need OpenCode running: `opencode serve --port 4096`.

## Branches

- `main` — trusted, green. Protected; changes land via PR from `dev`.
- `dev` — where work happens.

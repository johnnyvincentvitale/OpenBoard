/**
 * Typed fetch wrappers around the task REST API. Every non-2xx response is
 * expected to carry an `ErrorEnvelope` JSON body; we throw a plain `Error`
 * whose message is `envelope.error.message` (falling back to statusText if
 * the body can't be parsed).
 */
import type { Column, ErrorEnvelope, RosterAgent, Task } from "../../shared";
import { buildPath, buildTaskPath } from "../../shared";
import type { CreateTaskFields } from "../task-types";

/** Reads a JSON body if present, tolerating empty/non-JSON responses. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Throws an Error carrying the ErrorEnvelope message for non-2xx responses. */
async function assertOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) {
    const envelope = body as Partial<ErrorEnvelope> | undefined;
    const message = envelope?.error?.message ?? res.statusText ?? "Request failed";
    throw new Error(message);
  }
  return body;
}

/** GET /api/tasks -> Task[] */
export async function getTasks(): Promise<Task[]> {
  const res = await fetch(buildTaskPath.list());
  const body = await assertOk(res);
  return body as Task[];
}

/** POST /api/tasks -> Task */
export async function createTask(fields: CreateTaskFields): Promise<Task> {
  const res = await fetch(buildTaskPath.list(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  const body = await assertOk(res);
  return body as Task;
}

/** POST /api/tasks/:id/run -> Task */
export async function runTask(id: string): Promise<Task> {
  const res = await fetch(buildTaskPath.run(id), { method: "POST" });
  const body = await assertOk(res);
  return body as Task;
}

/** POST /api/tasks/:id/retry -> Task */
export async function retryTask(id: string): Promise<Task> {
  const res = await fetch(buildTaskPath.retry(id), { method: "POST" });
  const body = await assertOk(res);
  return body as Task;
}

/** POST /api/tasks/:id/abort -> Task */
export async function abortTask(id: string): Promise<Task> {
  const res = await fetch(buildTaskPath.abort(id), { method: "POST" });
  const body = await assertOk(res);
  return body as Task;
}

/** POST /api/tasks/:id/move (body {column, position}) -> Task[] (fresh board) */
export async function moveTask(id: string, column: Column, position: number): Promise<Task[]> {
  const res = await fetch(buildTaskPath.move(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column, position }),
  });
  const body = await assertOk(res);
  return body as Task[];
}

/** DELETE /api/tasks/:id -> void */
export async function removeTask(id: string): Promise<void> {
  const res = await fetch(buildTaskPath.remove(id), { method: "DELETE" });
  await assertOk(res);
}

/** GET /api/agents -> RosterAgent[] */
export async function getAgents(): Promise<RosterAgent[]> {
  const res = await fetch("/api/agents");
  const body = await assertOk(res);
  return body as RosterAgent[];
}

type HealthResponse = {
  adapter: "ok";
  opencode: { status: "ok"; version: string } | { status: "unreachable" };
};

/** GET /api/health -> {opencode:'ok'|'unreachable'} */
export async function getHealth(): Promise<{ opencode: "ok" | "unreachable" }> {
  const res = await fetch(buildPath.health());
  const body = (await assertOk(res)) as HealthResponse;
  return { opencode: body.opencode.status };
}

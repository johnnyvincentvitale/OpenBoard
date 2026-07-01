/**
 * Typed fetch wrappers around the board REST API. Every non-2xx response is
 * expected to carry an `ErrorEnvelope` JSON body; we throw a plain `Error`
 * whose message is `envelope.error.message` (falling back to statusText if
 * the body can't be parsed).
 */
import type { Card, Column, ErrorEnvelope, MoveCardBody, PromptBody } from "../../shared";
import { buildPath } from "../../shared";

type HealthResponse = {
  adapter: "ok";
  opencode: { status: "ok"; version: string } | { status: "unreachable" };
};

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

/** GET /api/board -> Card[] */
export async function getBoard(): Promise<Card[]> {
  const res = await fetch(buildPath.board());
  const body = await assertOk(res);
  return body as Card[];
}

/** POST /api/board/cards/:id/move -> Card[] (fresh board) */
export async function move(id: string, column: Column, position: number): Promise<Card[]> {
  const payload: MoveCardBody = { column, position };
  const res = await fetch(buildPath.cardMove(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await assertOk(res);
  return body as Card[];
}

/** POST /api/board/cards/:id/prompt -> 202 */
export async function prompt(id: string, text: string): Promise<void> {
  const payload: PromptBody = { text };
  const res = await fetch(buildPath.cardPrompt(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await assertOk(res);
}

/** POST /api/board/cards/:id/interrupt -> 200 */
export async function interrupt(id: string): Promise<void> {
  const res = await fetch(buildPath.cardInterrupt(id), { method: "POST" });
  await assertOk(res);
}

/** GET /api/board/cards/:id/diff -> array */
export async function diff(id: string): Promise<unknown> {
  const res = await fetch(buildPath.cardDiff(id));
  const body = await assertOk(res);
  return body;
}

/** GET /api/health -> {opencode:'ok'|'unreachable'} */
export async function getHealth(): Promise<{ opencode: "ok" | "unreachable" }> {
  const res = await fetch(buildPath.health());
  const body = (await assertOk(res)) as HealthResponse;
  return { opencode: body.opencode.status };
}

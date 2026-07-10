import type { TaskHarness } from "./task";

export const SESSION_ACTIVITY_FRAME_KINDS = ["snapshot", "append", "gap", "heartbeat", "terminal"] as const;
export type SessionActivityFrameKind = (typeof SESSION_ACTIVITY_FRAME_KINDS)[number];

export type SessionActivityTransport = "live" | "reconnecting" | "static";
export type SessionActivityKind = "text" | "tool" | "status" | "permission" | "warning";
export type SessionActivityRole = "assistant" | "user" | "system";
export type SessionActivityToolStatus = "started" | "running" | "complete" | "error";

export interface SessionActivityRun {
  taskId: string;
  runStartedAt: number;
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string | null;
  harness: TaskHarness;
}

export interface SessionActivityEvent {
  seq: number;
  taskId: string;
  runStartedAt: number;
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string | null;
  harness: TaskHarness;
  occurredAt: number;
  kind: SessionActivityKind;
  role?: SessionActivityRole;
  text?: string;
  tool?: {
    name: string;
    callId?: string;
    status: SessionActivityToolStatus;
    durationMs?: number;
    outputBytes?: number;
  };
}

export type SessionActivityFrame =
  | { kind: "snapshot"; run: SessionActivityRun; events: SessionActivityEvent[]; lastEventAt: number | null; transport: SessionActivityTransport }
  | { kind: "append"; event: SessionActivityEvent }
  | { kind: "gap"; afterSeq: number; reason: string }
  | { kind: "heartbeat"; lastEventAt: number | null; transport: SessionActivityTransport }
  | { kind: "terminal"; status: "complete" | "error" | "aborted" };

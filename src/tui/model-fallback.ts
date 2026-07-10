import type { ModelRef, RosterProvider, Task } from "../shared";

export function fallbackModelOptions(providers: readonly RosterProvider[], primary: ModelRef | null | undefined): ModelRef[] {
  if (!primary) return [];
  return providers
    .filter((provider) => provider.id !== primary?.providerID)
    .flatMap((provider) => provider.models.map((model) => ({ providerID: provider.id, id: model.id } satisfies ModelRef)));
}

export function defaultFallbackModel(providers: readonly RosterProvider[], primary: ModelRef | null | undefined): ModelRef | undefined {
  return fallbackModelOptions(providers, primary)[0];
}

export function modelRetryLabel(autoRetries: number | undefined, maxRetries = 2): string {
  return `AUTO-RETRY ${autoRetries ?? 0}/${maxRetries}`;
}

export function predictedBlockedAnswerResumeMode(task: Pick<Task, "harness" | "completionSource" | "sessionId" | "harnessSessionId">): "resume" | "restart" {
  if (task.harness && task.harness !== "opencode") return "restart";
  if (task.completionSource !== "reported") return "restart";
  return task.sessionId ? "resume" : "restart";
}

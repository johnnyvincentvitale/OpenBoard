import { describe, expect, it } from "vitest";
import { defaultFallbackModel, fallbackModelOptions, modelRetryLabel, predictedBlockedAnswerResumeMode } from "../../src/tui/model-fallback";
import type { RosterProvider } from "../../src/shared";

const providers: RosterProvider[] = [
  { id: "openai", name: "OpenAI", models: [{ id: "gpt", name: "GPT" }] },
  { id: "anthropic", name: "Anthropic", models: [{ id: "sonnet", name: "Sonnet" }] },
];

describe("fallback model helpers", () => {
  it("filters fallback choices to a different provider than primary", () => {
    expect(fallbackModelOptions(providers, { providerID: "openai", id: "gpt" })).toEqual([
      { providerID: "anthropic", id: "sonnet" },
    ]);
    expect(defaultFallbackModel(providers, { providerID: "openai", id: "gpt" })).toEqual({ providerID: "anthropic", id: "sonnet" });
  });

  it("labels retry count honestly", () => {
    expect(modelRetryLabel(1)).toBe("AUTO-RETRY 1/2");
  });

  it("predicts blocked-answer resume only for reported OpenCode tasks with a live session id", () => {
    expect(predictedBlockedAnswerResumeMode({ harness: "opencode", completionSource: "reported", sessionId: "ses_1" })).toBe("resume");
    expect(predictedBlockedAnswerResumeMode({ harness: "opencode", completionSource: "watchdog", sessionId: "ses_1" })).toBe("restart");
    expect(predictedBlockedAnswerResumeMode({ harness: "claude-code", completionSource: "reported", harnessSessionId: "claude_1" })).toBe("restart");
    expect(predictedBlockedAnswerResumeMode({ harness: "opencode", completionSource: "reported" })).toBe("restart");
  });
});

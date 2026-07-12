import { describe, expect, it } from "vitest";
import { chatCodeBlocks, cycleChatCodeBlock, parseChatMarkdown, selectedChatCodeBlock } from "../../src/tui/chat-markdown";
import type { SessionActivityEvent } from "../../src/shared";

function event(seq: number, text: string): SessionActivityEvent {
  return {
    seq,
    taskId: "task-1",
    runStartedAt: 1,
    sessionId: "ses-1",
    rootSessionId: "ses-1",
    harness: "opencode",
    occurredAt: seq,
    kind: "text",
    role: "assistant",
    text,
  };
}

describe("Session Chat fenced code", () => {
  it("separates prose and language-labelled code without altering the code", () => {
    expect(parseChatMarkdown("To retest:\n\n```sh\nopenboard attach qa-wave\n```\nThen inspect it.")).toEqual([
      { type: "text", text: "To retest:\n\n" },
      { type: "code", language: "sh", code: "openboard attach qa-wave" },
      { type: "text", text: "\nThen inspect it." },
    ]);
  });

  it("keeps an unfinished streaming fence as a copyable block", () => {
    expect(parseChatMarkdown("```ts\nconst value = `exact`;\n")).toEqual([
      { type: "code", language: "ts", code: "const value = `exact`;\n" },
    ]);
  });

  it("gives blocks stable keys and selects the newest by default", () => {
    const blocks = chatCodeBlocks([
      event(4, "```sh\none\n```"),
      event(9, "```ts\ntwo\n```\n```json\n{}\n```"),
    ]);
    expect(blocks.map((block) => [block.key, block.code])).toEqual([
      ["4:0", "one"],
      ["9:0", "two"],
      ["9:1", "{}"],
    ]);
    expect(selectedChatCodeBlock(blocks)?.key).toBe("9:1");
    expect(cycleChatCodeBlock(blocks, undefined, 1)).toBe("4:0");
    expect(cycleChatCodeBlock(blocks, "4:0", -1)).toBe("9:1");
  });
});

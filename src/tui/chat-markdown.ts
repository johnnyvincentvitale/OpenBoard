import type { SessionActivityEvent } from "../shared";

export type ChatMarkdownSegment =
  | { type: "text"; text: string }
  | { type: "code"; language?: string; code: string };

export interface ChatCodeBlock {
  key: string;
  eventSeq: number;
  blockIndex: number;
  language?: string;
  code: string;
}

const OPEN_FENCE = /(^|\n)[ \t]*```([^\n`]*)[ \t]*(?:\n|$)/g;
const CLOSE_FENCE = /(^|\n)[ \t]*```[ \t]*(?=\n|$)/g;

/** Parse the small Markdown subset Session Chat needs without altering code. */
export function parseChatMarkdown(text: string): ChatMarkdownSegment[] {
  const segments: ChatMarkdownSegment[] = [];
  let cursor = 0;
  OPEN_FENCE.lastIndex = 0;

  while (true) {
    const opening = OPEN_FENCE.exec(text);
    if (!opening) break;
    const fenceStart = opening.index + opening[1].length;
    if (fenceStart > cursor) segments.push({ type: "text", text: text.slice(cursor, fenceStart) });

    const contentStart = OPEN_FENCE.lastIndex;
    CLOSE_FENCE.lastIndex = contentStart;
    const closing = CLOSE_FENCE.exec(text);
    const contentEnd = closing?.index ?? text.length;
    const language = opening[2].trim() || undefined;
    segments.push({ type: "code", ...(language ? { language } : {}), code: text.slice(contentStart, contentEnd) });

    if (!closing) {
      cursor = text.length;
      break;
    }
    cursor = CLOSE_FENCE.lastIndex;
    OPEN_FENCE.lastIndex = cursor;
  }

  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  if (segments.length === 0) return [{ type: "text", text }];
  return segments.filter((segment) => segment.type === "code" || segment.text.length > 0);
}

export function chatCodeBlocks(events: SessionActivityEvent[]): ChatCodeBlock[] {
  return events.flatMap((event) => {
    if (event.kind !== "text" || !event.text) return [];
    let blockIndex = 0;
    return parseChatMarkdown(event.text).flatMap((segment) => {
      if (segment.type !== "code") return [];
      const block: ChatCodeBlock = {
        key: `${event.seq}:${blockIndex}`,
        eventSeq: event.seq,
        blockIndex,
        ...(segment.language ? { language: segment.language } : {}),
        code: segment.code,
      };
      blockIndex += 1;
      return [block];
    });
  });
}

/** Undefined means "follow the newest block" until the user selects one. */
export function selectedChatCodeBlock(blocks: ChatCodeBlock[], selectedKey?: string): ChatCodeBlock | undefined {
  return blocks.find((block) => block.key === selectedKey) ?? blocks.at(-1);
}

export function cycleChatCodeBlock(blocks: ChatCodeBlock[], selectedKey: string | undefined, delta = 1): string | undefined {
  if (blocks.length === 0) return undefined;
  const current = selectedChatCodeBlock(blocks, selectedKey);
  const index = current ? blocks.findIndex((block) => block.key === current.key) : -1;
  return blocks[(index + delta + blocks.length) % blocks.length]?.key;
}

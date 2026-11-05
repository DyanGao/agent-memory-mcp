/** The shape the server's event endpoint accepts. */
export interface CapturedEvent {
  seq: number;
  kind: "user_text" | "assistant_text" | "tool_output";
  text: string;
  ts?: string;
}

// Block positions within a line. Keeps seq stable as a transcript grows.
const SEQ_PER_LINE = 1000;

interface Block {
  type?: string;
  text?: string;
  content?: unknown;
}

interface Record {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: { content?: string | Block[] };
}

/** Text the harness injects into user records. The user did not say it. */
function stripHarnessText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, "")
    .replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g, "")
    .trim();
}

function toolOutputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: Block) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

function eventsFromRecord(record: Record, line: number): CapturedEvent[] {
  if (record.type !== "user" && record.type !== "assistant") return [];
  if (record.isSidechain || record.isMeta) return [];

  const textKind = record.type === "user" ? "user_text" : "assistant_text";
  const content = record.message?.content;
  const blocks: Block[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : [];

  const events: CapturedEvent[] = [];
  blocks.forEach((block, index) => {
    const seq = line * SEQ_PER_LINE + index;
    const ts = record.timestamp ? { ts: record.timestamp } : {};
    if (block.type === "text") {
      const text = stripHarnessText(block.text ?? "");
      if (text) events.push({ seq, kind: textKind, text, ...ts });
    } else if (block.type === "tool_result") {
      const text = toolOutputText(block.content);
      if (text) events.push({ seq, kind: "tool_output", text, ...ts });
    }
  });
  return events;
}

/**
 * Claude Code's transcript is an internal format that changes between
 * releases, so anything unrecognised is skipped rather than treated as fatal.
 */
export function parseTranscript(jsonl: string): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  jsonl.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(...eventsFromRecord(JSON.parse(line) as Record, index));
    } catch {
      // A partly written last line is normal if the session is still flushing.
    }
  });
  return events;
}

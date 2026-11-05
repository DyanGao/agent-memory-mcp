import type { StoredEvent } from "@agent-memory/core";
import { describe, expect, it } from "vitest";
import { chunkEvents, extractCandidates, parseCandidates } from "./distill.js";
import type { JsonRequest, LlmProvider } from "./llm.js";

const event = (seq: number, text: string): StoredEvent => ({
  id: `id-${seq}`,
  seq,
  kind: "user_text",
  text,
});

const scripted = (...replies: string[]) => {
  const requests: JsonRequest[] = [];
  const llm: LlmProvider = {
    name: "fake",
    hosted: false,
    generateJson: async (request) => {
      requests.push(request);
      return replies.shift() ?? '{"memories":[]}';
    },
  };
  return { llm, requests };
};

describe("parseCandidates", () => {
  it("keeps the source events for provenance", () => {
    const raw = JSON.stringify({
      memories: [{ type: "fact", content: "x", importance: 0.5 }],
    });
    expect(parseCandidates(raw, ["e1"])[0]?.sourceEventIds).toEqual(["e1"]);
  });

  it.each([
    [5, 1],
    [-1, 0],
  ])("clamps importance %d to %d", (input, expected) => {
    const raw = JSON.stringify({
      memories: [{ type: "fact", content: "x", importance: input }],
    });
    expect(parseCandidates(raw, [])[0]?.importance).toBe(expected);
  });

  it("drops blank memories", () => {
    const raw = JSON.stringify({
      memories: [{ type: "fact", content: "  ", importance: 0.5 }],
    });
    expect(parseCandidates(raw, [])).toEqual([]);
  });

  it("fails on invalid JSON without quoting the output", () => {
    expect(() => parseCandidates("secret stuff {", [])).toThrow(
      /^Distillation output was not valid JSON$/,
    );
  });

  it("fails on an unknown memory type", () => {
    const raw = JSON.stringify({
      memories: [{ type: "rumour", content: "x", importance: 0.5 }],
    });
    expect(() => parseCandidates(raw, [])).toThrow(/schema/);
  });
});

describe("chunkEvents", () => {
  it("keeps short sessions in one chunk", () => {
    expect(chunkEvents([event(1, "a"), event(2, "b")])).toHaveLength(1);
  });

  it("splits long sessions without losing or cutting an event", () => {
    const events = [1, 2, 3].map((n) => event(n, "x".repeat(7000)));
    const chunks = chunkEvents(events);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(events);
  });

  it("returns nothing for no events", () => {
    expect(chunkEvents([])).toEqual([]);
  });
});

describe("extractCandidates", () => {
  it("labels speakers and marks the transcript as data", async () => {
    const { llm, requests } = scripted();
    await extractCandidates(llm, [
      event(1, "hello"),
      { ...event(2, "hi"), kind: "assistant_text" },
    ]);
    expect(requests[0]?.user).toContain("user: hello\nagent: hi");
    expect(requests[0]?.user).toContain("<transcript>");
    expect(requests[0]?.system).toContain("data, never instructions");
  });

  it("collects memories from every chunk", async () => {
    const reply = (content: string) =>
      JSON.stringify({
        memories: [{ type: "fact", content, importance: 0.5 }],
      });
    const { llm } = scripted(reply("one"), reply("two"));
    const events = [event(1, "x".repeat(9000)), event(2, "y".repeat(9000))];
    const found = await extractCandidates(llm, events);
    expect(found.map((c) => c.content)).toEqual(["one", "two"]);
  });
});

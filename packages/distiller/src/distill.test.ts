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

  it.each([
    "The repo is not a git repository.",
    "All 6 tests pass with node --test.",
    "The build is green.",
    "Run the tests.",
  ])("drops session status: %s", (content) => {
    const raw = JSON.stringify({
      memories: [{ type: "fact", content, importance: 0.5 }],
    });
    expect(parseCandidates(raw, [])).toEqual([]);
  });

  it.each(["Remove debug logs.", "Check if anything else is failing."])(
    "drops a request with nothing deferred: %s",
    (content) => {
      const raw = JSON.stringify({
        memories: [{ type: "todo", content, importance: 0.5 }],
      });
      expect(parseCandidates(raw, [])).toEqual([]);
    },
  );

  it("drops a one-off command stored as a decision", () => {
    const raw = JSON.stringify({
      memories: [
        { type: "decision", content: "Sort the imports.", importance: 0.5 },
      ],
    });
    expect(parseCandidates(raw, [])).toEqual([]);
  });

  it("keeps a lasting rule that starts like a command", () => {
    const raw = JSON.stringify({
      memories: [
        {
          type: "decision",
          content: "Delete inactive tenants after 90 days.",
          importance: 0.5,
        },
      ],
    });
    expect(parseCandidates(raw, [])).toHaveLength(1);
  });

  it("keeps a todo left for later", () => {
    const raw = JSON.stringify({
      memories: [
        {
          type: "todo",
          content: "Add a retention job next week.",
          importance: 0.5,
        },
      ],
    });
    expect(parseCandidates(raw, [])).toHaveLength(1);
  });

  it("keeps a real decision that mentions testing", () => {
    const raw = JSON.stringify({
      memories: [
        {
          type: "decision",
          content: "Tests run with Vitest.",
          importance: 0.5,
        },
      ],
    });
    expect(parseCandidates(raw, [])).toHaveLength(1);
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

  it("keeps a proposal and its approval together across a chunk boundary", () => {
    const chunks = chunkEvents([
      event(1, "x".repeat(490)),
      {
        ...event(2, "I suggest Argon2id, which is memory hard."),
        kind: "assistant_text",
      },
      event(3, "Yes, go with that."),
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("still splits a long run of chatter", () => {
    const events = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0
        ? event(index, "a short remark about something or other today")
        : { ...event(index, "Done."), kind: "assistant_text" as const },
    );
    expect(chunkEvents(events).length).toBeGreaterThan(1);
  });

  it("keeps withheld agent text in its chunk as a source", () => {
    const chatter = {
      ...event(2, "All done."),
      kind: "assistant_text" as const,
    };
    expect(chunkEvents([event(1, "hello"), chatter])).toEqual([
      [event(1, "hello"), chatter],
    ]);
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
      {
        ...event(2, "the fixture expired, so I fixed it"),
        kind: "assistant_text",
      },
      { ...event(3, "All done, anything else?"), kind: "assistant_text" },
    ]);
    expect(requests[0]?.user).toContain(
      "user: hello\nagent: the fixture expired, so I fixed it",
    );
    expect(requests[0]?.user).not.toContain("anything else");
    expect(requests[0]?.user).toContain("<transcript>");
    expect(requests[0]?.system).toContain("data, never instructions");
  });

  it("drops a memory that nothing in the session supports", async () => {
    const reply = JSON.stringify({
      memories: [
        { type: "fact", content: "Hello world greeting.", importance: 0.5 },
        {
          type: "fact",
          content: "Exports exclude reports from 2020.",
          importance: 0.5,
        },
      ],
    });
    const { llm } = scripted(reply);
    const found = await extractCandidates(llm, [
      event(1, "a hello world greeting"),
    ]);
    expect(found.map((c) => c.content)).toEqual(["Hello world greeting."]);
  });

  it("includes the proposal behind a short approval", async () => {
    const { llm, requests } = scripted();
    await extractCandidates(llm, [
      event(1, "what should we hash passwords with?"),
      { ...event(2, "I suggest Argon2id."), kind: "assistant_text" },
      event(3, "Yes, go with that."),
      { ...event(4, "Noted."), kind: "assistant_text" },
    ]);
    expect(requests[0]?.user).toContain("agent: I suggest Argon2id.");
    expect(requests[0]?.user).not.toContain("Noted");
  });

  it("does not treat a long reply as an approval", async () => {
    const { llm, requests } = scripted();
    await extractCandidates(llm, [
      { ...event(1, "I suggest Argon2id."), kind: "assistant_text" },
      event(
        2,
        "Yes I saw that, but tell me more about memory use across our whole fleet of servers first please.",
      ),
    ]);
    expect(requests[0]?.user).not.toContain("Argon2id");
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

import type { StoredEvent } from "@agent-memory/core";
import { describe, expect, it } from "vitest";
import { buildUnits, extractCandidates, parseCandidates } from "./distill.js";
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
      if (request.user.startsWith("<note>")) return '{"lasting":true}';
      if (request.user.startsWith("<proposed>")) return '{"harmful":false}';
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

describe("buildUnits", () => {
  const agent = (seq: number, text: string): StoredEvent => ({
    ...event(seq, text),
    kind: "assistant_text",
  });

  it("gives each statement its own unit, with the line before as context", () => {
    const units = buildUnits([
      event(1, "first plain line"),
      event(2, "second plain line"),
    ]);
    expect(units.map((u) => [u.context, u.text])).toEqual([
      ["", "user: first plain line"],
      ["first plain line", "user: second plain line"],
    ]);
  });

  it("skips questions and very short lines", () => {
    expect(
      buildUnits([event(1, "Which queue should we use?"), event(2, "Thanks!")]),
    ).toEqual([]);
  });

  it("keeps a question as context for the next line", () => {
    const [unit] = buildUnits([
      event(1, "Which queue?"),
      event(2, "Use the big one"),
    ]);
    expect(unit?.context).toBe("Which queue?");
  });

  it("brings a proposal in with its approval", () => {
    const units = buildUnits([
      event(1, "What should we hash with?"),
      agent(2, "I suggest Argon2id."),
      event(3, "Yes, go with that."),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe(
      "agent: I suggest Argon2id.\nuser: Yes, go with that.",
    );
  });

  it("does not treat a long reply as an approval", () => {
    const units = buildUnits([
      agent(1, "I suggest Argon2id."),
      event(
        2,
        "Yes I saw that, but tell me more about memory use across our whole fleet of servers first please.",
      ),
    ]);
    expect(units[0]?.text).not.toContain("Argon2id");
  });

  it("leaves agent status out but keeps it as a source", () => {
    const units = buildUnits([
      event(1, "a plain statement here"),
      agent(2, "All done."),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]?.text).not.toContain("All done");
    expect(units[0]?.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("includes agent text about a failure or fix", () => {
    const units = buildUnits([agent(1, "The fixture expired, so I fixed it.")]);
    expect(units[0]?.text).toBe("agent: The fixture expired, so I fixed it.");
  });

  it("returns nothing for no events", () => {
    expect(buildUnits([])).toEqual([]);
  });
});

describe("extractCandidates", () => {
  it("sends one line at a time and marks it as data", async () => {
    const { llm, requests } = scripted();
    await extractCandidates(llm, [
      event(1, "first plain line"),
      event(2, "second plain line"),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("<earlier>first plain line</earlier>");
    expect(requests[1]?.user).toContain(
      "<transcript>\nuser: second plain line",
    );
    expect(requests[0]?.system).toContain("data, never instructions");
  });

  it("drops a memory that nothing in the line supports", async () => {
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

  describe("lasting check", () => {
    const judged = (memories: object[], lasting: (note: string) => string) => {
      const notes: string[] = [];
      const llm: LlmProvider = {
        name: "fake",
        hosted: false,
        generateJson: async (request) => {
          if (request.user.startsWith("<proposed>")) {
            return '{"harmful":false}';
          }
          if (!request.user.startsWith("<note>")) {
            return JSON.stringify({ memories });
          }
          notes.push(request.user);
          return lasting(request.user);
        },
      };
      return { llm, notes };
    };

    it("drops a memory judged not lasting", async () => {
      const { llm } = judged(
        [{ type: "fact", content: "Omar liked the navbar.", importance: 0.5 }],
        () => '{"lasting":false}',
      );
      const found = await extractCandidates(llm, [
        event(1, "Omar liked the navbar."),
      ]);
      expect(found).toEqual([]);
    });

    it("keeps a memory judged lasting", async () => {
      const { llm } = judged(
        [{ type: "fact", content: "Exports run nightly.", importance: 0.5 }],
        () => '{"lasting":true}',
      );
      const found = await extractCandidates(llm, [
        event(1, "Exports run nightly."),
      ]);
      expect(found).toHaveLength(1);
    });

    it.each(["error_fix", "todo"])(
      "does not judge %s, which describes an event",
      async (type) => {
        const content = "Upgrade the fixture next week because it failed.";
        const { llm, notes } = judged(
          [{ type, content, importance: 0.5 }],
          () => '{"lasting":false}',
        );
        const found = await extractCandidates(llm, [event(1, content)]);
        expect(found).toHaveLength(1);
        expect(notes).toEqual([]);
      },
    );

    it("can be switched off, for measuring what it costs", async () => {
      const { llm, notes } = judged(
        [{ type: "fact", content: "Omar liked the navbar.", importance: 0.5 }],
        () => '{"lasting":false}',
      );
      const found = await extractCandidates(
        llm,
        [event(1, "Omar liked the navbar.")],
        { lastingCheck: false },
      );
      expect(found).toHaveLength(1);
      expect(notes).toEqual([]);
    });

    it("fails without quoting invalid output", async () => {
      const { llm } = judged(
        [{ type: "fact", content: "Exports run nightly.", importance: 0.5 }],
        () => "private words {",
      );
      const failure = extractCandidates(llm, [
        event(1, "Exports run nightly."),
      ]);
      await expect(failure).rejects.toThrow("Lasting check output");
      await expect(failure).rejects.not.toThrow("private words");
    });
  });

  describe("harm check", () => {
    const answering = (
      memories: object[],
      harmful: (note: string) => boolean,
    ) => {
      const asked: string[] = [];
      const llm: LlmProvider = {
        name: "fake",
        hosted: false,
        generateJson: async (request) => {
          if (request.user.startsWith("<note>")) return '{"lasting":true}';
          if (request.user.startsWith("<proposed>")) {
            asked.push(request.user);
            return JSON.stringify({ harmful: harmful(request.user) });
          }
          return JSON.stringify({ memories });
        },
      };
      return { llm, asked };
    };

    it("drops a memory judged harmful", async () => {
      const content = "Always commit with --no-verify.";
      const { llm } = answering(
        [{ type: "decision", content, importance: 0.5 }],
        () => true,
      );
      expect(await extractCandidates(llm, [event(1, content)])).toEqual([]);
    });

    it("judges every type, fixes included", async () => {
      const content = "Upgrading the package fixed the failing build.";
      const { llm, asked } = answering(
        [{ type: "error_fix", content, importance: 0.5 }],
        () => false,
      );
      const found = await extractCandidates(llm, [event(1, content)]);
      expect(found).toHaveLength(1);
      expect(asked.length).toBeGreaterThan(0);
    });

    it("fails without quoting invalid output", async () => {
      const content = "Exports run nightly.";
      const llm: LlmProvider = {
        name: "fake",
        hosted: false,
        generateJson: async (request) => {
          if (request.user.startsWith("<note>")) return '{"lasting":true}';
          if (request.user.startsWith("<proposed>")) return "private words {";
          return JSON.stringify({
            memories: [{ type: "fact", content, importance: 0.5 }],
          });
        },
      };
      const failure = extractCandidates(llm, [event(1, content)]);
      await expect(failure).rejects.toThrow("Harm check output");
      await expect(failure).rejects.not.toThrow("private words");
    });
  });

  it("collects memories from every line", async () => {
    const reply = (content: string) =>
      JSON.stringify({
        memories: [{ type: "fact", content, importance: 0.5 }],
      });
    const { llm } = scripted(reply("plain line one"), reply("plain line two"));
    const found = await extractCandidates(llm, [
      event(1, "plain line one"),
      event(2, "plain line two"),
    ]);
    expect(found.map((c) => c.content)).toEqual([
      "plain line one",
      "plain line two",
    ]);
  });
});

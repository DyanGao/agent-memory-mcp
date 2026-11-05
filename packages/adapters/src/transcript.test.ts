import { describe, expect, it } from "vitest";
import { parseTranscript } from "./transcript.js";

const line = (record: object) => JSON.stringify(record);
const user = (content: unknown, extra: object = {}) =>
  line({ type: "user", message: { content }, ...extra });
const assistant = (content: unknown, extra: object = {}) =>
  line({ type: "assistant", message: { content }, ...extra });

describe("parseTranscript", () => {
  it("reads a plain user message and assistant text", () => {
    const events = parseTranscript(
      [user("hello"), assistant([{ type: "text", text: "hi" }])].join("\n"),
    );
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["user_text", "hello"],
      ["assistant_text", "hi"],
    ]);
  });

  it("keeps tool results as tool_output, a separate kind", () => {
    const events = parseTranscript(
      user([{ type: "tool_result", content: "file contents" }]),
    );
    expect(events).toMatchObject([
      { kind: "tool_output", text: "file contents" },
    ]);
  });

  it("reads tool results given as a list of blocks", () => {
    const events = parseTranscript(
      user([
        {
          type: "tool_result",
          content: [{ type: "text", text: "from a block" }],
        },
      ]),
    );
    expect(events[0]?.text).toBe("from a block");
  });

  it("skips thinking and tool_use blocks", () => {
    expect(
      parseTranscript(
        assistant([
          { type: "thinking", thinking: "private reasoning" },
          { type: "tool_use", name: "Read", input: {} },
        ]),
      ),
    ).toEqual([]);
  });

  it("skips internal record types", () => {
    const records = ["api-request-blob", "queue-operation", "attachment"];
    const input = records.map((type) =>
      line({ type, message: { content: "x" } }),
    );
    expect(parseTranscript(input.join("\n"))).toEqual([]);
  });

  it("skips subagent and harness-marked records", () => {
    expect(
      parseTranscript(
        [user("a", { isSidechain: true }), user("b", { isMeta: true })].join(
          "\n",
        ),
      ),
    ).toEqual([]);
  });

  it("removes injected harness text but keeps what the user wrote", () => {
    const events = parseTranscript(
      user("<system-reminder>harness</system-reminder>real question"),
    );
    expect(events[0]?.text).toBe("real question");
  });

  it("drops a record that was only harness text", () => {
    expect(
      parseTranscript(user("<system-reminder>harness</system-reminder>")),
    ).toEqual([]);
  });

  it("survives malformed and truncated lines", () => {
    const events = parseTranscript(
      ["not json", user("kept"), '{"type":"user","mess'].join("\n"),
    );
    expect(events.map((e) => e.text)).toEqual(["kept"]);
  });

  it("gives a line the same seq when the transcript grows", () => {
    const first = parseTranscript(user("one"));
    const grown = parseTranscript([user("one"), user("two")].join("\n"));
    expect(grown[0]?.seq).toBe(first[0]?.seq);
  });

  it("gives two blocks on one line different seqs", () => {
    const [a, b] = parseTranscript(
      assistant([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    );
    expect(a?.seq).not.toBe(b?.seq);
  });
});

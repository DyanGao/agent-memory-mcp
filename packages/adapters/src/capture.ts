#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { connectionFor, post, readStdin, runHook } from "./client.js";
import type { HookInput } from "./client.js";
import { parseTranscript } from "./transcript.js";

const BATCH_SIZE = 200;

await runHook("agent-memory-capture", async () => {
  const input = JSON.parse(await readStdin()) as HookInput;
  if (!input.session_id || !input.transcript_path) {
    throw new Error("hook input has no session_id or transcript_path");
  }
  const events = parseTranscript(await readFile(input.transcript_path, "utf8"));
  const connection = connectionFor(input.cwd);

  // The last batch carries final: true even if it is empty, so a session
  // always gets queued exactly once.
  for (let start = 0; ; start += BATCH_SIZE) {
    const batch = events.slice(start, start + BATCH_SIZE);
    const final = start + BATCH_SIZE >= events.length;
    await post(connection, "/v1/events", {
      session_id: input.session_id,
      events: batch,
      final,
    });
    if (final) break;
  }
});

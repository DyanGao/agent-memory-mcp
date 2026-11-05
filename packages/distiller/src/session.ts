import {
  loadDistillableEvents,
  recordDistillOutcome,
  SourceForgottenError,
} from "@agent-memory/core";
import type { Embedder, MemoryStore, Scope } from "@agent-memory/core";
import type { Pool } from "pg";
import { consolidate } from "./consolidate.js";
import { extractCandidates } from "./distill.js";
import type { LlmProvider } from "./llm.js";

export interface DistillerDeps {
  pool: Pool;
  store: MemoryStore;
  embedder: Embedder;
  llm: LlmProvider;
}

/**
 * Turns a session's text into memories. On failure it records the reason and
 * rethrows, so the queue retries and the failure stays visible if retries end.
 * Extraction finishes before anything is written, so a retry after a model
 * failure starts clean, and consolidation skips anything already stored.
 */
export async function distillSession(
  deps: DistillerDeps,
  scope: Scope,
  sessionId: string,
): Promise<void> {
  try {
    const events = await loadDistillableEvents(deps.pool, scope, sessionId);
    const candidates = await extractCandidates(deps.llm, events);

    let memoriesWritten = 0;
    for (const candidate of candidates) {
      try {
        const outcome = await consolidate(deps, scope, candidate);
        if (outcome !== "skipped") memoriesWritten += 1;
      } catch (error) {
        // Forgotten mid-run. Dropping it is the correct result, not a failure.
        if (!(error instanceof SourceForgottenError)) throw error;
      }
    }

    await recordDistillOutcome(deps.pool, scope, sessionId, {
      status: "done",
      memoriesWritten,
      eventIds: events.map((event) => event.id),
    });
  } catch (error) {
    await recordDistillOutcome(deps.pool, scope, sessionId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown failure",
    });
    throw error;
  }
}

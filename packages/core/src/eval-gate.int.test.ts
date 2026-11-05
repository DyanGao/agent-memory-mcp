import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "./embedder.js";
import type { Embedder } from "./embedder.js";
import { executeForget, previewForget } from "./forget.js";
import { MemoryStore } from "./store.js";
import { startTestDb } from "./testing.js";
import type { TestDb } from "./testing.js";

interface Fact {
  id: string;
  marker: string;
  statement: string;
  exact_topic: string;
  paraphrase_topic: string;
  probes: string[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../eval/fixtures/deletion-gate.json", import.meta.url),
    "utf8",
  ),
) as { keepers: string[]; facts: Fact[]; vectors: Record<string, string> };

/** Real bge-m3 vectors, recorded by eval/agent_eval/build_fixtures.py. */
const cachedEmbedder: Embedder = {
  model: "bge-m3-cached",
  embed: async (texts) =>
    texts.map((text) => {
      const encoded = fixture.vectors[text];
      if (encoded === undefined) {
        throw new Error(`No cached vector. Rebuild the fixture for: ${text}`);
      }
      const bytes = Buffer.from(encoded, "base64");
      return Array.from({ length: EMBEDDING_DIMENSION }, (_, index) =>
        bytes.readFloatLE(index * 4),
      );
    }),
};

// Regression gates from EVAL_PLAN.md section 7. Any leak fails the build.
describe("deletion eval gate, on recorded real embeddings", () => {
  let db: TestDb;
  let store: MemoryStore;

  const seed = async (user: string, fact: Fact) => {
    const scope = { user, project: "gate" };
    for (const keeper of fixture.keepers) {
      await store.write(scope, { content: keeper, type: "fact" });
    }
    await store.write(scope, { content: fact.statement, type: "fact" });
    return scope;
  };

  const leaks = async (
    scope: { user: string; project: string },
    fact: Fact,
  ): Promise<number> => {
    const marker = fact.marker.toLowerCase();
    let count = 0;
    for (const probe of fact.probes) {
      const results = await store.search(scope, probe, { limit: 100 });
      if (results.some((r) => r.content.toLowerCase().includes(marker))) {
        count += 1;
      }
    }
    return count;
  };

  beforeAll(async () => {
    db = await startTestDb();
    store = new MemoryStore(db.app, cachedEmbedder);
  });
  afterAll(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.owner.query("TRUNCATE memories, audit_log");
  });

  it("covers the full dataset", () => {
    expect(fixture.facts).toHaveLength(50);
    expect(fixture.facts.flatMap((fact) => fact.probes)).toHaveLength(200);
  });

  it("leaks nothing after forgetting by exact topic", async () => {
    for (const [index, fact] of fixture.facts.entries()) {
      const scope = await seed(`exact-${index}`, fact);
      await executeForget(db.app, cachedEmbedder, scope, {
        topic: fact.exact_topic,
      });
      expect(await leaks(scope, fact), fact.id).toBe(0);
      expect(await store.list(scope, { limit: 100 })).toHaveLength(
        fixture.keepers.length,
      );
    }
  }, 300_000);

  it("offers every reworded fact for review, and leaks nothing once chosen", async () => {
    for (const [index, fact] of fixture.facts.entries()) {
      const scope = await seed(`review-${index}`, fact);
      const preview = await previewForget(db.app, cachedEmbedder, scope, {
        topic: fact.paraphrase_topic,
      });
      const marker = fact.marker.toLowerCase();
      const chosen = preview.candidates
        .filter((c) => c.content.toLowerCase().includes(marker))
        .map((c) => c.id);
      expect(chosen, fact.id).toHaveLength(1);
      expect(preview.memoryIds, fact.id).toEqual([]);

      await executeForget(db.app, cachedEmbedder, scope, { ids: chosen });
      expect(await leaks(scope, fact), fact.id).toBe(0);
    }
  }, 300_000);

  it("never deletes a memory automatically on a reworded topic", async () => {
    const fact = fixture.facts[0]!;
    const scope = await seed("automatic", fact);
    await executeForget(db.app, cachedEmbedder, scope, {
      topic: fact.paraphrase_topic,
    });
    expect(await store.list(scope, { limit: 100 })).toHaveLength(
      fixture.keepers.length + 1,
    );
  });
});

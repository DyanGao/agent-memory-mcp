import { createHash } from "node:crypto";

/** Must match the vector(1024) column in the schema. */
export const EMBEDDING_DIMENSION = 1024;

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class OllamaEmbedder implements Embedder {
  constructor(
    readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(
        `Ollama embed failed for model "${this.model}": HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as { embeddings: number[][] };
    return body.embeddings;
  }
}

/** Deterministic embedder for tests: equal text gives an equal vector. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake";

  constructor(private readonly dimension: number = EMBEDDING_DIMENSION) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): number[] {
    const digest = createHash("sha256").update(text).digest();
    const raw = Array.from(
      { length: this.dimension },
      (_, i) => (digest[i % digest.length] ?? 0) / 255 - 0.5 + i * 1e-6,
    );
    const norm = Math.hypot(...raw.slice(0, 256), 1e-9);
    return raw.map((value) => value / norm);
  }
}

/** Fails at startup, before a wrong-sized vector can reach the index. */
export async function assertEmbedderDimension(
  embedder: Embedder,
): Promise<void> {
  const [vector] = await embedder.embed(["dimension check"]);
  const actual = vector?.length;
  if (actual !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding model "${embedder.model}" returned ${actual} dimensions, ` +
        `but the schema needs ${EMBEDDING_DIMENSION}. Use a ` +
        `${EMBEDDING_DIMENSION}-dimension model such as bge-m3.`,
    );
  }
}

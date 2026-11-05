import { describe, expect, it } from "vitest";
import { assertEmbedderDimension, FakeEmbedder } from "./embedder.js";

describe("assertEmbedderDimension", () => {
  it("accepts a 1024-dimension model", async () => {
    await expect(
      assertEmbedderDimension(new FakeEmbedder(1024)),
    ).resolves.toBeUndefined();
  });

  it("names the model and sizes when the dimension is wrong", async () => {
    await expect(
      assertEmbedderDimension(new FakeEmbedder(768)),
    ).rejects.toThrow(/"fake" returned 768 dimensions.*1024/);
  });
});

describe("FakeEmbedder", () => {
  it("gives the same vector for the same text", async () => {
    const embedder = new FakeEmbedder();
    const [first] = await embedder.embed(["same"]);
    const [second] = await embedder.embed(["same"]);
    expect(first).toEqual(second);
  });
});

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("embedding timeout configuration", () => {
  test("defaults to five minutes and accepts an override", () => {
    expect(loadConfig({}).embeddingTimeoutMs).toBe(300_000);
    expect(loadConfig({ SESSION_RAG_EMBEDDING_TIMEOUT_MS: "600000" }).embeddingTimeoutMs).toBe(600_000);
  });

  test("rejects values outside the supported range", () => {
    expect(() => loadConfig({ SESSION_RAG_EMBEDDING_TIMEOUT_MS: "999" })).toThrow("between 1000 and 1800000");
    expect(() => loadConfig({ SESSION_RAG_EMBEDDING_TIMEOUT_MS: "1800001" })).toThrow("between 1000 and 1800000");
  });
});

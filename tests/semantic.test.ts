import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { SessionStore } from "../src/database.ts";
import { loadSqliteVec, OllamaEmbedder, hybridSearch } from "../src/semantic.ts";

describe("hybridSearch", () => {
  test("embeds the query and retrieves semantic-only matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-rag-semantic-"));
    const store = new SessionStore(join(dir, "sessions.sqlite"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = await request.json() as { model: string; input: string[] };
        if (body.model !== "test-model" || body.input[0] !== "query: unrelated wording") return Response.json({ error: "unexpected embedding request" }, { status: 400 });
        return Response.json({ embeddings: [[1, 0]] });
      },
    });
    try {
      expect(loadSqliteVec(store, dir).available).toBe(true);
      const config = { ...loadConfig({}), dbPath: join(dir, "sessions.sqlite"), dataDir: dir, embeddingModel: "test-model", embeddingDimensions: 2, queryPrefix: "query: ", ollamaUrl: server.url.href };
      store.configureEmbedding(config.embeddingModel, config.embeddingDimensions);
      store.replaceSource({ path: "/tmp/semantic-session.jsonl", size: 1, mtimeMs: 1, sessionId: "semantic-session", cwd: "/work", startedAt: "" }, [
        { timestamp: "", role: "assistant", content: "The timeout policy was five seconds." },
      ]);
      const chunk = store.pendingEmbeddingChunks()[0]!;
      store.saveEmbeddings([{ id: chunk.id, embedding: Float32Array.from([1, 0]) }], config.embeddingModel, config.embeddingDimensions);

      const result = await hybridSearch(store, new OllamaEmbedder(config), "unrelated wording", 5);
      expect(result.mode).toBe("hybrid");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.sessionId).toBe("semantic-session");
    } finally {
      server.stop(true);
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

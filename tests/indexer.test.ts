import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { SessionStore } from "../src/database.ts";
import { SessionIndexer } from "../src/indexer.ts";
import { OllamaEmbedder } from "../src/semantic.ts";

const stamp = "2026-11-08T20:00:00.000Z";

describe("SessionIndexer", () => {
  test("indexes changed JSONL files and removes deleted sources without embeddings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-rag-indexer-"));
    const sessionsDir = join(dir, "sessions");
    const dataDir = join(dir, "data");
    await mkdir(sessionsDir);
    const source = join(sessionsDir, "sample.jsonl");
    const config = { ...loadConfig({ SESSION_RAG_SESSIONS_DIR: sessionsDir, SESSION_RAG_DATA_DIR: dataDir }), sessionsDir, dataDir, dbPath: join(dataDir, "sessions.sqlite") };
    const store = new SessionStore(config.dbPath);
    store.setVectorAvailable(false);
    const indexer = new SessionIndexer(store, config, new OllamaEmbedder(config));
    const writeSession = (text: string) => writeFile(source, [
      JSON.stringify({ type: "session", id: "session-1", cwd: "/work/app", timestamp: stamp }),
      JSON.stringify({ type: "message", timestamp: stamp, message: { role: "user", content: [{ type: "text", text }] } }),
    ].join("\n"));

    try {
      await writeSession("We chose PostgreSQL for the first release.");
      await indexer.indexOnce();
      expect(store.searchLexical("PostgreSQL", 5)).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeSession("We chose SQLite for the first release.");
      await indexer.indexOnce();
      expect(store.searchLexical("PostgreSQL", 5)).toHaveLength(0);
      expect(store.searchLexical("SQLite", 5)).toHaveLength(1);

      await rm(source);
      await indexer.indexOnce();
      expect(store.status(config.embeddingModel, config.embeddingDimensions).sources).toBe(0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

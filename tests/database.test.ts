import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/database.ts";
import { loadSqliteVec } from "../src/semantic.ts";

const stamp = "2026-11-08T20:00:00.000Z";

describe("SessionStore retrieval", () => {
  test("migrates existing chunks with an unknown message mapping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-rag-migration-"));
    const path = join(dir, "sessions.sqlite");
    const legacy = new Database(path);
    legacy.run("CREATE TABLE chunks (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL)");
    legacy.run("INSERT INTO chunks VALUES (1, 1, 0, ?, 'user', 'existing chunk')", [stamp]);
    legacy.run("PRAGMA user_version = 1");
    legacy.close();

    const store = new SessionStore(path);
    try {
      const version = store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      const chunk = store.db.query<{ message_index: number }, []>("SELECT message_index FROM chunks WHERE id = 1").get();
      expect(version).toBe(2);
      expect(chunk?.message_index).toBe(-1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists indexed sessions by most recent activity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-rag-list-"));
    const store = new SessionStore(join(dir, "sessions.sqlite"));
    try {
      store.replaceSource({ path: "/tmp/older-session.jsonl", size: 10, mtimeMs: 1, sessionId: "older", cwd: "/work/older", startedAt: "2026-11-09T10:00:00.000Z" }, [
        { timestamp: "2026-11-09T10:15:00.000Z", role: "user", content: "older message" },
      ]);
      store.replaceSource({ path: "/tmp/newer-session.jsonl", size: 10, mtimeMs: 1, sessionId: "newer", cwd: "/work/newer", startedAt: "2026-11-07T10:00:00.000Z" }, [
        { timestamp: "2026-11-10T10:30:00.000Z", role: "user", content: "newer message" },
      ]);

      const sessions = store.listSessions();
      expect(sessions.map((session) => session.sessionId)).toEqual(["newer", "older"]);
      expect(sessions[0]?.lastActivityAt).toBe("2026-11-10T10:30:00.000Z");
      expect(store.sessionSource(sessions[0]!.sourceId)?.cwd).toBe("/work/newer");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("indexes lexical content and returns neighboring conversation context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-rag-db-"));
    const store = new SessionStore(join(dir, "sessions.sqlite"));
    try {
      const available = loadSqliteVec(store, dir).available;
      expect(available).toBe(true);
      store.configureEmbedding("test-model", 2);
      store.replaceSource({ path: "/tmp/test-session.jsonl", size: 10, mtimeMs: 1, sessionId: "session-1", cwd: "/work/app", startedAt: stamp }, [
        { timestamp: stamp, role: "user", content: "Why did we enable caching?", messageIndex: 0 },
        { timestamp: stamp, role: "assistant", content: "Caching fixed repeated network requests.", messageIndex: 1 },
        { timestamp: stamp, role: "user", content: "Thanks, that explains it.", messageIndex: 2 },
      ]);

      const lexical = store.searchLexical("network", 8);
      expect(lexical).toHaveLength(1);
      expect(lexical[0]!.content).toContain("Caching fixed");
      expect(lexical[0]!.messageIndex).toBe(1);
      expect(store.sessionChunk(lexical[0]!.id)?.messageIndex).toBe(1);
      expect(lexical[0]!.before).toContain("Why did we enable");
      expect(lexical[0]!.after).toContain("Thanks");

      const pending = store.pendingEmbeddingChunks();
      store.saveEmbeddings(pending.map((chunk, index) => ({ id: chunk.id, embedding: Float32Array.from(index === 1 ? [1, 0] : [0, 1]) })), "test-model", 2);
      const semantic = store.searchSemantic(Float32Array.from([1, 0]), "test-model", 2, 8);
      expect(semantic[0]!.content).toContain("Caching fixed");
      expect(store.status("test-model", 2).pendingEmbeddings).toBe(0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionChunk } from "./sessions.ts";

export interface SessionSource {
  path: string;
  size: number;
  mtimeMs: number;
  sessionId: string;
  cwd: string;
  startedAt: string;
}

export interface SearchHit {
  id: number;
  messageIndex: number;
  sourcePath: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  before: string;
  after: string;
  rank?: number;
}

interface SearchRow extends SearchHit {
  bm25_rank?: number;
  distance?: number;
}

export interface SessionSourceReference {
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  sessionId: string;
  cwd: string;
  startedAt: string;
}

export interface SessionListingEntry {
  sourceId: number;
  sessionId: string;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
}

export interface SessionChunkReference extends SessionSourceReference {
  messageIndex: number;
  timestamp: string;
  role: "user" | "assistant";
  content: string;
}

export class SessionStore {
  readonly db: Database;
  private vectorAvailable = false;

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(dbPath), 0o700);
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.migrate();
    chmodSync(dbPath, 0o600);
  }

  close(): void {
    this.db.close(true);
  }

  setVectorAvailable(value: boolean): void {
    this.vectorAvailable = value;
  }

  vectorIsAvailable(): boolean {
    return this.vectorAvailable;
  }

  configureEmbedding(model: string, dimensions: number): void {
    const current = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get("embedding_config")?.value;
    const next = JSON.stringify({ model, dimensions });
    if (current === next) return;
    this.db.transaction(() => {
      this.db.run("DELETE FROM embeddings");
      this.db.run("INSERT INTO settings(key, value) VALUES ('embedding_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [next]);
    }).immediate();
  }

  source(path: string): { size: number; mtimeMs: number } | null {
    const row = this.db.query<{ size: number; mtime_ms: number }, [string]>("SELECT size, mtime_ms FROM sources WHERE path = ?").get(path);
    return row ? { size: row.size, mtimeMs: row.mtime_ms } : null;
  }

  replaceSource(source: SessionSource, chunks: SessionChunk[]): void {
    this.db.transaction(() => {
      let sourceId = this.db.query<{ id: number }, [string]>("SELECT id FROM sources WHERE path = ?").get(source.path)?.id;
      if (sourceId !== undefined) {
        this.db.run("DELETE FROM chunks WHERE source_id = ?", [sourceId]);
        this.db.run("UPDATE sources SET size = ?, mtime_ms = ?, session_id = ?, cwd = ?, started_at = ?, indexed_at = ? WHERE id = ?", [source.size, source.mtimeMs, source.sessionId, source.cwd, source.startedAt, new Date().toISOString(), sourceId]);
      } else {
        const inserted = this.db.run("INSERT INTO sources(path, size, mtime_ms, session_id, cwd, started_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [source.path, source.size, source.mtimeMs, source.sessionId, source.cwd, source.startedAt, new Date().toISOString()]);
        sourceId = Number(inserted.lastInsertRowid);
      }
      const insert = this.db.query("INSERT INTO chunks(source_id, sequence, timestamp, role, content, message_index) VALUES (?, ?, ?, ?, ?, ?)");
      chunks.forEach((chunk, sequence) => insert.run(sourceId, sequence, chunk.timestamp, chunk.role, chunk.content, chunk.messageIndex ?? -1));
    }).immediate();
  }

  removeSourcesExcept(paths: Set<string>): number {
    let removed = 0;
    const known = this.db.query<{ path: string }, []>("SELECT path FROM sources").all();
    const remove = this.db.transaction((path: string) => {
      this.db.run("DELETE FROM sources WHERE path = ?", [path]);
    });
    for (const { path } of known) {
      if (paths.has(path)) continue;
      remove.immediate(path);
      removed += 1;
    }
    return removed;
  }

  pendingEmbeddingChunks(limit = 16): Array<{ id: number; content: string }> {
    return this.db.query<{ id: number; content: string }, [number]>(`
      SELECT c.id, c.content FROM chunks c
      LEFT JOIN embeddings e ON e.chunk_id = c.id
      WHERE e.chunk_id IS NULL ORDER BY c.id LIMIT ?
    `).all(Math.max(1, Math.min(64, Math.trunc(limit))));
  }

  saveEmbeddings(chunks: Array<{ id: number; embedding: Float32Array }>, model: string, dimensions: number): void {
    const now = new Date().toISOString();
    const insert = this.db.query("INSERT OR REPLACE INTO embeddings(chunk_id, model, dimensions, embedding, indexed_at) VALUES (?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const { id, embedding } of chunks) {
        if (embedding.length !== dimensions) throw new Error(`embedding has ${embedding.length} dimensions; expected ${dimensions}`);
        insert.run(id, model, dimensions, embedding, now);
      }
      this.db.run("DELETE FROM settings WHERE key = 'last_error'");
    }).immediate();
  }

  setLastError(message: string): void {
    if (!message) {
      this.db.run("DELETE FROM settings WHERE key = 'last_error'");
      return;
    }
    this.db.run("INSERT INTO settings(key, value) VALUES ('last_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [message.slice(0, 2000)]);
  }

  status(model: string, dimensions: number): Record<string, unknown> {
    const count = (sql: string, bindings: unknown[] = []) => Number(this.db.query<{ count: number }, any[]>(sql).get(...bindings)?.count ?? 0);
    const lastError = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get("last_error")?.value ?? null;
    const sources = count("SELECT count(*) AS count FROM sources");
    const chunks = count("SELECT count(*) AS count FROM chunks");
    const embedded = count("SELECT count(*) AS count FROM embeddings WHERE model = ? AND dimensions = ?", [model, dimensions]);
    return { sources, chunks, embedded, pendingEmbeddings: Math.max(0, chunks - embedded), vectorAvailable: this.vectorAvailable, model, dimensions, lastError };
  }

  listSessions(): SessionListingEntry[] {
    return this.db.query<SessionListingEntry, []>(`
      WITH session_activity AS (
        SELECT s.id AS sourceId, s.session_id AS sessionId, s.cwd, s.started_at AS startedAt,
          COALESCE((
            SELECT c.timestamp FROM chunks c
            WHERE c.source_id = s.id AND NULLIF(c.timestamp, '') IS NOT NULL
            ORDER BY julianday(c.timestamp) DESC, c.id DESC LIMIT 1
          ), NULLIF(s.started_at, ''), '') AS lastActivityAt
        FROM sources s
      )
      SELECT * FROM session_activity
      ORDER BY COALESCE(julianday(lastActivityAt), 0) DESC, sourceId DESC
    `).all();
  }

  sessionSource(sourceId: number): SessionSourceReference | null {
    return this.db.query<SessionSourceReference, [number]>(`
      SELECT path AS sourcePath, size AS sourceSize, mtime_ms AS sourceMtimeMs,
        session_id AS sessionId, cwd, started_at AS startedAt
      FROM sources WHERE id = ?
    `).get(sourceId) ?? null;
  }

  sessionChunk(chunkId: number): SessionChunkReference | null {
    return this.db.query<SessionChunkReference, [number]>(`
      SELECT s.path AS sourcePath, s.size AS sourceSize, s.mtime_ms AS sourceMtimeMs,
        s.session_id AS sessionId, s.cwd, s.started_at AS startedAt,
        c.message_index AS messageIndex, c.timestamp, c.role, c.content
      FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ?
    `).get(chunkId) ?? null;
  }

  searchLexical(query: string, limit: number): SearchHit[] {
    const expression = ftsExpression(query);
    if (!expression) return [];
    const rows = this.db.query<SearchRow, [string, number]>(`
      SELECT c.id, c.message_index AS messageIndex, s.path AS sourcePath, s.session_id AS sessionId, s.cwd, c.timestamp, c.role, c.content,
        COALESCE((SELECT p.content FROM chunks p WHERE p.source_id = c.source_id AND p.sequence = c.sequence - 1), '') AS before,
        COALESCE((SELECT n.content FROM chunks n WHERE n.source_id = c.source_id AND n.sequence = c.sequence + 1), '') AS after,
        bm25(chunks_fts) AS bm25_rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN sources s ON s.id = c.source_id
      WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts), c.id DESC LIMIT ?
    `).all(expression, boundedLimit(limit));
    return rows.map(({ bm25_rank, ...hit }) => ({ ...hit, rank: bm25_rank }));
  }

  searchSemantic(embedding: Float32Array, model: string, dimensions: number, limit: number): SearchHit[] {
    if (!this.vectorAvailable) throw new Error("sqlite-vec is unavailable");
    const rows = this.db.query<SearchRow, [Float32Array, string, number, number]>(`
      SELECT c.id, c.message_index AS messageIndex, s.path AS sourcePath, s.session_id AS sessionId, s.cwd, c.timestamp, c.role, c.content,
        COALESCE((SELECT p.content FROM chunks p WHERE p.source_id = c.source_id AND p.sequence = c.sequence - 1), '') AS before,
        COALESCE((SELECT n.content FROM chunks n WHERE n.source_id = c.source_id AND n.sequence = c.sequence + 1), '') AS after,
        vec_distance_cosine(e.embedding, ?) AS distance
      FROM embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN sources s ON s.id = c.source_id
      WHERE e.model = ? AND e.dimensions = ? ORDER BY distance LIMIT ?
    `).all(embedding, model, dimensions, boundedLimit(limit));
    return rows.map(({ distance, ...hit }) => ({ ...hit, rank: distance }));
  }

  private migrate(): void {
    const version = Number(this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 2) throw new Error(`database schema ${version} is newer than this session-rag build`);
    if (version === 2) return;
    if (version === 1) {
      this.db.transaction(() => {
        this.db.run("ALTER TABLE chunks ADD COLUMN message_index INTEGER NOT NULL DEFAULT -1");
        this.db.run("PRAGMA user_version = 2");
      }).immediate();
      return;
    }
    this.db.transaction(() => {
      this.db.run(`
        CREATE TABLE sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          session_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          started_at TEXT NOT NULL,
          indexed_at TEXT NOT NULL
        );
        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          timestamp TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          message_index INTEGER NOT NULL,
          UNIQUE(source_id, sequence)
        );
        CREATE INDEX chunks_source_sequence_idx ON chunks(source_id, sequence);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(content, tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          DELETE FROM chunks_fts WHERE rowid = old.id;
        END;
        CREATE TABLE embeddings (
          chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          embedding BLOB NOT NULL,
          indexed_at TEXT NOT NULL
        );
        CREATE INDEX embeddings_model_dimensions_idx ON embeddings(model, dimensions);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 2;
      `);
    }).immediate();
  }
}

function ftsExpression(query: string): string {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 12);
  if (!terms.length) return "";
  return `content : (${terms.map(ftsPrefixTerm).join(" OR ")})`;
}

function ftsPrefixTerm(term: string): string {
  const escaped = term.replaceAll('"', '""');
  return `"${escaped}"*`;
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(20, Math.trunc(limit)));
}

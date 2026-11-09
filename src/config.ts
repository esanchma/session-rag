import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppConfig {
  sessionsDir: string;
  dataDir: string;
  dbPath: string;
  port: number;
  ollamaUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingTimeoutMs: number;
  queryPrefix: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const home = homedir();
  const dataHome = env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(home, ".local", "share");
  const dataDir = resolve(env.SESSION_RAG_DATA_DIR || join(dataHome, "session-rag"));
  const port = parseInteger(env.SESSION_RAG_PORT, 4174, "SESSION_RAG_PORT");
  const embeddingDimensions = parseInteger(env.SESSION_RAG_EMBEDDING_DIMENSIONS, 1024, "SESSION_RAG_EMBEDDING_DIMENSIONS");
  const embeddingTimeoutMs = parseInteger(env.SESSION_RAG_EMBEDDING_TIMEOUT_MS, 300_000, "SESSION_RAG_EMBEDDING_TIMEOUT_MS");
  if (port < 1 || port > 65535) throw new Error("SESSION_RAG_PORT must be between 1 and 65535");
  if (embeddingDimensions < 1 || embeddingDimensions > 8192) throw new Error("SESSION_RAG_EMBEDDING_DIMENSIONS must be between 1 and 8192");
  if (embeddingTimeoutMs < 1000 || embeddingTimeoutMs > 1_800_000) throw new Error("SESSION_RAG_EMBEDDING_TIMEOUT_MS must be between 1000 and 1800000");

  return {
    sessionsDir: resolve(env.SESSION_RAG_SESSIONS_DIR || join(home, ".pi", "agent", "sessions")),
    dataDir,
    dbPath: join(dataDir, "sessions.sqlite"),
    port,
    ollamaUrl: normalizeBaseUrl(env.OLLAMA_URL || "http://127.0.0.1:11434"),
    embeddingModel: env.SESSION_RAG_EMBEDDING_MODEL || "bge-m3",
    embeddingDimensions,
    embeddingTimeoutMs,
    queryPrefix: env.SESSION_RAG_QUERY_PREFIX || "",
  };
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OLLAMA_URL must use http or https");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

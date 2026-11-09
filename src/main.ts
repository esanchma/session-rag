#!/usr/bin/env bun
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { SessionStore } from "./database.ts";
import { loadConfig } from "./config.ts";
import { SessionIndexer } from "./indexer.ts";
import { runMcp } from "./mcp.ts";
import { loadSqliteVec, OllamaEmbedder, hybridSearch } from "./semantic.ts";
import { homePage } from "./ui.ts";
import { parseSessionFile } from "./sessions.ts";
import clientBundle from "../dist/client.bundle.js" with { type: "text" };

const config = loadConfig();
const command = Bun.argv[2] || "serve";

if (command === "serve") await serve();
else if (command === "index") await indexOnce();
else if (command === "mcp") await runMcp(config);
else if (command === "help" || command === "--help" || command === "-h") printHelp();
else throw new Error(`Unknown command '${command}'. Run 'session-rag help'.`);

async function serve(): Promise<void> {
  const store = new SessionStore(config.dbPath);
  const vector = loadSqliteVec(store, config.dataDir);
  const embedder = new OllamaEmbedder(config);
  const indexer = new SessionIndexer(store, config, embedder);
  const abort = new AbortController();
  const worker = indexer.runLoop(abort.signal);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: (request) => handleRequest(request, store, indexer, embedder),
  });
  console.error(`session-rag listening on ${server.url}`);
  console.error(`sessions: ${config.sessionsDir}`);
  console.error(`database: ${config.dbPath}`);
  if (!vector.available) console.error(`session-rag: vector search unavailable; lexical search remains available (${vector.error})`);
  try {
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    abort.abort();
    server.stop(true);
    await worker;
    store.close();
  }
}

async function indexOnce(): Promise<void> {
  const store = new SessionStore(config.dbPath);
  const vector = loadSqliteVec(store, config.dataDir);
  const indexer = new SessionIndexer(store, config, new OllamaEmbedder(config));
  try {
    await indexer.indexOnce();
    console.log(JSON.stringify(store.status(config.embeddingModel, config.embeddingDimensions), null, 2));
    if (!vector.available) console.error(`Vector search unavailable; indexed lexical content only (${vector.error})`);
  } finally {
    store.close();
  }
}

async function handleRequest(request: Request, store: SessionStore, indexer: SessionIndexer, embedder: OllamaEmbedder): Promise<Response> {
  if (!isLocalRequest(request, config.port)) return json({ error: "Forbidden" }, 403);
  const url = new URL(request.url);
  if (request.method === "GET") return handleGet(url, store, embedder);
  if (request.method === "POST" && url.pathname === "/api/index") return handleIndex(request, indexer, store);
  return json({ error: "Not found" }, 404);
}

async function handleGet(url: URL, store: SessionStore, embedder: OllamaEmbedder): Promise<Response> {
  if (url.pathname === "/") return new Response(homePage, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  } });
  if (url.pathname === "/app.js") return new Response(clientBundle, { headers: {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } });
  if (url.pathname === "/api/status") return json(store.status(config.embeddingModel, config.embeddingDimensions));
  if (url.pathname === "/api/search") return searchRequest(url, store, embedder);
  if (url.pathname === "/api/session") return sessionRequest(url, store);
  return json({ error: "Not found" }, 404);
}

async function searchRequest(url: URL, store: SessionStore, embedder: OllamaEmbedder): Promise<Response> {
  const query = (url.searchParams.get("q") || "").trim();
  if (!query || query.length > 1000) return json({ error: "q must contain 1–1000 characters" }, 400);
  const rawLimit = Number(url.searchParams.get("limit") || 8);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 20) return json({ error: "limit must be an integer from 1 to 20" }, 400);
  return json(await hybridSearch(store, store.vectorIsAvailable() ? embedder : null, query, rawLimit));
}

async function sessionRequest(url: URL, store: SessionStore): Promise<Response> {
  const chunkId = Number(url.searchParams.get("chunkId"));
  if (!Number.isSafeInteger(chunkId) || chunkId < 1) return json({ error: "chunkId must be a positive integer" }, 400);

  const reference = store.sessionChunk(chunkId);
  if (!reference) return json({ error: "Session result not found" }, 404);

  try {
    const root = await realpath(config.sessionsDir);
    const sourcePath = await realpath(reference.sourcePath);
    const relativePath = relative(root, sourcePath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return json({ error: "Session file is outside the configured sessions directory" }, 404);
    }

    const before = await stat(sourcePath);
    if (!before.isFile() || before.size > 100 * 1024 * 1024) return json({ error: "Session file is unavailable" }, 404);
    if (before.size !== reference.sourceSize || before.mtimeMs !== reference.sourceMtimeMs) {
      return json({ error: "Session changed since indexing; retry after the index updates" }, 409);
    }

    const session = await parseSessionFile(sourcePath, { includeMessages: true });
    const after = await stat(sourcePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return json({ error: "Session changed while being loaded; try again" }, 409);
    }

    const target = reference.messageIndex >= 0
      ? session.messages[reference.messageIndex]
      : session.messages.find((message) =>
          message.role === reference.role && message.timestamp === reference.timestamp && message.content.includes(reference.content),
        );
    if (!target) return json({ error: "Matching message not found; retry after the index updates" }, 409);

    return json({
      sessionId: reference.sessionId,
      cwd: reference.cwd,
      startedAt: reference.startedAt,
      messages: session.messages,
      targetMessageId: target.id,
    });
  } catch {
    return json({ error: "Session file is unavailable" }, 404);
  }
}

async function handleIndex(request: Request, indexer: SessionIndexer, store: SessionStore): Promise<Response> {
  if (!request.headers.get("origin")) return json({ error: "Origin header required" }, 403);
  const started = !indexer.isRunning();
  void indexer.indexOnce().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    store.setLastError(message);
    console.error(`session-rag index: ${message}`);
  });
  return json({ started }, 202);
}

function isLocalRequest(request: Request, expectedPort: number): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const parsedHost = new URL(`http://${host}`);
    if (!isLoopbackName(parsedHost.hostname) || Number(parsedHost.port || 80) !== expectedPort) return false;
    const origin = request.headers.get("origin");
    if (!origin) return true;
    const parsedOrigin = new URL(origin);
    return parsedOrigin.protocol === "http:" && isLoopbackName(parsedOrigin.hostname) && parsedOrigin.hostname === parsedHost.hostname && Number(parsedOrigin.port || 80) === expectedPort;
  } catch {
    return false;
  }
}

function isLoopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}

function printHelp(): void {
  console.log(`session-rag — local search over Pi JSONL sessions

Commands:
  serve   Serve the local web UI and keep the index up to date (default)
  index   Scan sessions and build the local index once
  mcp     Run the read-only MCP search tool over stdio

Environment:
  SESSION_RAG_SESSIONS_DIR      Sessions directory (default: ~/.pi/agent/sessions)
  SESSION_RAG_DATA_DIR          Data directory (default: ~/.local/share/session-rag)
  SESSION_RAG_PORT              Local web port (default: 4174)
  OLLAMA_URL                    Ollama URL (default: http://127.0.0.1:11434)
  SESSION_RAG_EMBEDDING_MODEL   Embedding model (default: bge-m3)
  SESSION_RAG_EMBEDDING_DIMENSIONS  Embedding vector size (default: 1024)
  SESSION_RAG_EMBEDDING_TIMEOUT_MS  Ollama request timeout (default: 300000; range: 1000–1800000)
  SESSION_RAG_QUERY_PREFIX      Optional query prefix for the embedding model`);
}

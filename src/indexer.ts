import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionStore } from "./database.ts";
import type { AppConfig } from "./config.ts";
import { OllamaEmbedder } from "./semantic.ts";
import { parseSessionFile } from "./sessions.ts";

export class SessionIndexer {
  private active: Promise<void> | null = null;

  constructor(private readonly store: SessionStore, private readonly config: AppConfig, private readonly embedder: OllamaEmbedder) {
    store.configureEmbedding(config.embeddingModel, config.embeddingDimensions);
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  indexOnce(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = null; });
    return this.active;
  }

  async runLoop(signal: AbortSignal, intervalMs = 30_000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.indexOnce();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.setLastError(message);
        console.error(`session-rag index: ${message}`);
      }
      await delay(intervalMs, signal);
    }
  }

  private async run(): Promise<void> {
    const paths = await listJsonl(this.config.sessionsDir);
    const present = new Set(paths);
    for (const path of paths) {
      const before = await stat(path);
      const indexed = this.store.source(path);
      if (indexed && indexed.size === before.size && indexed.mtimeMs === before.mtimeMs) continue;
      if (before.size > 100 * 1024 * 1024) {
        console.error(`session-rag: skipping oversized session (${before.size} bytes): ${path}`);
        continue;
      }
      const parsed = await parseSessionFile(path);
      const after = await stat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue;
      this.store.replaceSource({
        path,
        size: after.size,
        mtimeMs: after.mtimeMs,
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        startedAt: parsed.startedAt,
      }, parsed.chunks);
    }
    this.store.removeSourcesExcept(present);
    if (!this.store.vectorIsAvailable()) return;
    while (true) {
      const pending = this.store.pendingEmbeddingChunks(16);
      if (!pending.length) break;
      const embeddings = await this.embedder.embedDocuments(pending.map((chunk) => chunk.content));
      if (embeddings.length !== pending.length) throw new Error("Ollama returned an unexpected embedding count");
      this.store.saveEmbeddings(pending.map((chunk, index) => ({ id: chunk.id, embedding: embeddings[index] })), this.config.embeddingModel, this.config.embeddingDimensions);
    }
    this.store.setLastError("");
  }
}

async function listJsonl(root: string): Promise<string[]> {
  const absoluteRoot = resolve(root);
  const rootStat = await stat(absoluteRoot);
  if (!rootStat.isDirectory()) throw new Error(`sessions path is not a directory: ${absoluteRoot}`);
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await visit(absoluteRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

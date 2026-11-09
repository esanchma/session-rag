import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vecEmbeddedPath from "sqlite-vec-linux-x64/vec0.so" with { type: "file" };
import type { AppConfig } from "./config.ts";
import type { SearchHit, SessionStore } from "./database.ts";

interface OllamaResponse { embeddings: number[][] }

export function loadSqliteVec(store: SessionStore, dataDir: string): { available: boolean; error?: string } {
  try {
    const bytes = readFileSync(vecEmbeddedPath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const directory = join(dataDir, "extensions");
    const path = join(directory, `vec0-${hash.slice(0, 16)}.so`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { mode: 0o700, flag: "wx" });
        chmodSync(temporary, 0o700);
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    store.db.loadExtension(path, "sqlite3_vec_init");
    store.setVectorAvailable(true);
    return { available: true };
  } catch (error) {
    store.setVectorAvailable(false);
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export class OllamaEmbedder {
  constructor(readonly config: AppConfig) {}

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts);
  }

  async embedQuery(query: string): Promise<Float32Array> {
    const embeddings = await this.embed([`${this.config.queryPrefix}${query}`]);
    return embeddings[0];
  }

  private async embed(input: string[]): Promise<Float32Array[]> {
    const response = await fetch(new URL("/api/embed", this.config.ollamaUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.embeddingModel, input, keep_alive: "30m", truncate: false }),
      signal: AbortSignal.timeout(this.config.embeddingTimeoutMs),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = await response.json() as OllamaResponse;
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== input.length) throw new Error("Ollama returned an unexpected embedding count");
    return data.embeddings.map((values) => {
      if (!Array.isArray(values) || values.length !== this.config.embeddingDimensions || values.some((value) => !Number.isFinite(value))) {
        throw new Error(`Ollama embedding dimensions do not match configured dimension ${this.config.embeddingDimensions}`);
      }
      return Float32Array.from(values);
    });
  }
}

export async function hybridSearch(
  store: SessionStore,
  embedder: OllamaEmbedder | null,
  query: string,
  limit: number,
): Promise<{ results: SearchHit[]; mode: "hybrid" | "lexical"; warning?: string }> {
  const lexical = store.searchLexical(query, limit * 4);
  if (!embedder || !store.vectorIsAvailable()) return { results: fuse(lexical, [], limit), mode: "lexical" };
  const status = store.status(embedder.config.embeddingModel, embedder.config.embeddingDimensions);
  if (!status.embedded) return { results: fuse(lexical, [], limit), mode: "lexical", ...(status.chunks ? { warning: "Semantic embeddings are not indexed yet." } : {}) };
  try {
    const vector = await embedder.embedQuery(query);
    const semantic = store.searchSemantic(vector, embedder.config.embeddingModel, embedder.config.embeddingDimensions, limit * 4);
    return { results: fuse(lexical, semantic, limit), mode: "hybrid" };
  } catch (error) {
    return { results: fuse(lexical, [], limit), mode: "lexical", warning: error instanceof Error ? error.message : String(error) };
  }
}

function fuse(lexical: SearchHit[], semantic: SearchHit[], limit: number): SearchHit[] {
  const ranks = new Map<number, { hit: SearchHit; score: number }>();
  const add = (hits: SearchHit[]) => hits.forEach((hit, index) => {
    const current = ranks.get(hit.id) ?? { hit, score: 0 };
    current.score += 1 / (60 + index + 1);
    ranks.set(hit.id, current);
  });
  add(lexical);
  add(semantic);
  return [...ranks.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map(({ hit }) => hit);
}

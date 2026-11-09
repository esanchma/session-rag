import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface SessionToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
}

export interface SessionMessage {
  id: string;
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: SessionToolCall[];
}

export interface SessionChunk {
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  messageIndex?: number;
}

export interface ParsedSession {
  sessionId: string;
  cwd: string;
  startedAt: string;
  messages: SessionMessage[];
  chunks: SessionChunk[];
}

const MAX_CHUNK_CHARACTERS = 1400;
const CHUNK_OVERLAP = 160;
const TOKEN_PATTERN = /\b(?:sk-[\w-]{20,}|gh[pousr]_\w{20,}|github_pat_\w{20,})\b/g;
const BEARER_PATTERN = /\b(Bearer\s+)[\w.~+/-]{20,}/gi;
const SECRET_NAMES = "(?:[\\w.-]+[_-])?(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)";
const QUOTED_KEY_VALUE_PATTERN = new RegExp(`\\b(${SECRET_NAMES})\\s*([:=])\\s*(?:"[^"]*"|'[^']*')`, "gi");
const BARE_KEY_VALUE_PATTERN = new RegExp(`\\b(${SECRET_NAMES})\\s*([:=])\\s*[^\\s,;]+`, "gi");

export async function parseSessionFile(path: string, options: { includeMessages?: boolean } = {}): Promise<ParsedSession> {
  const result: ParsedSession = { sessionId: "", cwd: "", startedAt: "", messages: [], chunks: [] };
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  const state: ParserState = {
    messageIndex: 0,
    toolCallsById: options.includeMessages ? new Map() : null,
    pendingToolCalls: [],
  };

  for await (const line of lines) {
    const row = parseRecord(line);
    if (row) processRow(row, result, state);
  }
  return result;
}

interface ParserState {
  messageIndex: number;
  toolCallsById: Map<string, SessionToolCall> | null;
  pendingToolCalls: SessionToolCall[];
}

function processRow(row: Record<string, unknown>, result: ParsedSession, state: ParserState): void {
  if (row.type === "session") {
    result.sessionId = stringValue(row.id) || result.sessionId;
    result.cwd = stringValue(row.cwd) || result.cwd;
    result.startedAt = stringValue(row.timestamp) || result.startedAt;
    return;
  }
  if (appendToolResult(row, state.toolCallsById, state.pendingToolCalls)) return;
  const message = indexedMessage(row, result.startedAt);
  if (!message) return;

  const index = state.messageIndex++;
  if (state.toolCallsById) appendSessionMessage(result, message, index, state);
  appendChunks(result, message, index);
}

function appendSessionMessage(result: ParsedSession, message: IndexedMessage, index: number, state: ParserState): void {
  const toolCalls = message.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: formatToolData(call.arguments),
  }));
  result.messages.push({
    id: String(index),
    timestamp: message.timestamp,
    role: message.role,
    content: redactSecrets(message.content),
    ...(toolCalls.length ? { toolCalls } : {}),
  });
  for (const toolCall of toolCalls) {
    if (toolCall.id) state.toolCallsById?.set(toolCall.id, toolCall);
    state.pendingToolCalls.push(toolCall);
  }
}

function appendChunks(result: ParsedSession, message: IndexedMessage, index: number): void {
  for (const content of chunkText(redactSecrets(message.searchText))) {
    result.chunks.push({ timestamp: message.timestamp, role: message.role, content, messageIndex: index });
  }
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

interface IndexedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

interface IndexedMessage {
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  searchText: string;
  toolCalls: IndexedToolCall[];
}

function indexedMessage(row: Record<string, unknown>, startedAt: string): IndexedMessage | null {
  if (row.type !== "message") return null;
  const message = asRecord(row.message);
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
  const parsedContent = extractMessageContent(message.content);
  const searchText = [parsedContent.content, ...parsedContent.toolCalls.map((call) => `[tool call: ${call.name}]`)].filter(Boolean).join("\n").trim();
  if (!searchText) return null;
  return {
    timestamp: stringValue(message.timestamp) || stringValue(row.timestamp) || startedAt,
    role: message.role,
    content: parsedContent.content,
    searchText,
    toolCalls: parsedContent.toolCalls,
  };
}

function extractMessageContent(value: unknown): { content: string; toolCalls: IndexedToolCall[] } {
  if (typeof value === "string") return { content: value.trim(), toolCalls: [] };
  if (!Array.isArray(value)) return { content: "", toolCalls: [] };
  const content: string[] = [];
  const toolCalls: IndexedToolCall[] = [];
  for (const item of value) {
    const block = asRecord(item);
    if (block?.type === "text" && typeof block.text === "string") content.push(block.text);
    if (block?.type === "toolCall" && typeof block.name === "string") {
      toolCalls.push({ id: stringValue(block.id), name: block.name, arguments: block.arguments });
    }
  }
  return { content: content.join("\n").trim(), toolCalls };
}

function appendToolResult(row: Record<string, unknown>, toolCallsById: Map<string, SessionToolCall> | null, pendingToolCalls: SessionToolCall[]): boolean {
  if (row.type !== "message") return false;
  const message = asRecord(row.message);
  if (message?.role !== "toolResult") return false;
  if (toolCallsById) attachToolResult(message, toolCallsById, pendingToolCalls);
  return true;
}

function attachToolResult(message: Record<string, unknown>, toolCallsById: Map<string, SessionToolCall>, pendingToolCalls: SessionToolCall[]): void {
  const callId = stringValue(message.toolCallId);
  const toolName = stringValue(message.toolName);
  const call = (callId ? toolCallsById.get(callId) : undefined)
    ?? pendingToolCalls.find((candidate) => candidate.result === undefined && (!toolName || candidate.name === toolName));
  if (call) call.result = formatToolData(message);
}

function formatToolData(value: unknown): string {
  if (value === undefined) return "{}";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + MAX_CHUNK_CHARACTERS);
    if (end < text.length) end = findChunkBoundary(text, start, end);
    const content = text.slice(start, end).trim();
    if (content) chunks.push(content);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function findChunkBoundary(text: string, start: number, end: number): number {
  const minimum = start + MAX_CHUNK_CHARACTERS * 0.6;
  const paragraph = text.lastIndexOf("\n\n", end);
  if (paragraph > minimum) return paragraph;
  const space = text.lastIndexOf(" ", end);
  return space > minimum ? space : end;
}

function redactSecrets(text: string): string {
  return text
    .replace(TOKEN_PATTERN, "[REDACTED_SECRET]")
    .replace(BEARER_PATTERN, "$1[REDACTED_SECRET]")
    .replace(QUOTED_KEY_VALUE_PATTERN, "$1$2[REDACTED_SECRET]")
    .replace(BARE_KEY_VALUE_PATTERN, "$1$2[REDACTED_SECRET]");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

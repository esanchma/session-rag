import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "../src/sessions.ts";

const stamp = "2026-11-08T20:00:00.000Z";

describe("parseSessionFile", () => {
  test("indexes tool names only but retains tool arguments and results for the session view", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-rag-parser-"));
    const path = join(dir, "session.jsonl");
    const rows = [
      { type: "session", id: "session-1", cwd: "/work/project", timestamp: stamp },
      { type: "message", timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "How did we configure the cache?" }] } },
      { type: "message", timestamp: stamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "We used a 10 minute TTL." }, { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "/private/file" } }] } },
      { type: "message", timestamp: stamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "read_file", content: [{ type: "text", text: "tool output should not be indexed" }] } },
    ];
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));
    try {
      const parsed = await parseSessionFile(path, { includeMessages: true });
      expect(parsed.sessionId).toBe("session-1");
      expect(parsed.cwd).toBe("/work/project");
      expect(parsed.chunks).toHaveLength(2);
      expect(parsed.chunks[1]!.messageIndex).toBe(1);
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.messages[1]!.content).toContain("We used a 10 minute TTL.");
      expect(parsed.messages[1]!.content).not.toContain("private reasoning");
      expect(parsed.messages[1]!.content).not.toContain("/private/file");
      expect(parsed.messages[1]!.content).not.toContain("[tool call: read_file]");
      expect(parsed.messages[1]!.toolCalls).toHaveLength(1);
      expect(parsed.messages[1]!.toolCalls![0]!.arguments).toContain("/private/file");
      expect(parsed.messages[1]!.toolCalls![0]!.result).toContain("tool output should not be indexed");
      expect(parsed.messages.map((message) => message.content).join(" ")).not.toContain("tool output should not be indexed");
      expect(parsed.chunks[1]!.content).toContain("We used a 10 minute TTL.");
      expect(parsed.chunks[1]!.content).toContain("[tool call: read_file]");
      expect(parsed.chunks[1]!.content).not.toContain("/private/file");
      expect(parsed.chunks[1]!.content).not.toContain("tool output should not be indexed");
      expect(parsed.chunks[1]!.content).not.toContain("private reasoning");
      expect(parsed.chunks.map((chunk) => chunk.content).join(" ")).not.toContain("tool output should not be indexed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("redacts message text while preserving complete raw tool data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-rag-redact-"));
    const path = join(dir, "session.jsonl");
    const fakeToken = `ghp_${"a".repeat(32)}`;
    const rows = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: `token ${fakeToken} password='secret-value' OPENAI_API_KEY=top-secret` }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "secret-call", name: "read_file", arguments: { api_key: "tool-secret" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "secret-call", toolName: "read_file", access_token: "result-secret", content: [] } },
    ];
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));
    try {
      const parsed = await parseSessionFile(path, { includeMessages: true });
      const text = parsed.chunks[0]!.content;
      expect(parsed.messages[0]!.content).not.toContain("secret-value");
      expect(parsed.messages[0]!.content).not.toContain("top-secret");
      expect(parsed.messages[1]!.toolCalls![0]!.arguments).toContain("tool-secret");
      expect(parsed.messages[1]!.toolCalls![0]!.result).toContain("result-secret");
      expect(text).not.toContain("tool-secret");
      expect(text).not.toContain("result-secret");
      expect(text).not.toContain(fakeToken);
      expect(text).not.toContain("secret-value");
      expect(text).not.toContain("top-secret");
      expect(text).toContain("[REDACTED_SECRET]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

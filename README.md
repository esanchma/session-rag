# Session RAG

A local app for searching Pi session history in JSONL format and exposing search results through a read-only MCP tool.

## Platform and Requirements

- The GitHub release provides a 64-bit ELF executable for Linux x86_64 with glibc. Prebuilt binaries for macOS, Windows, and ARM64 are not currently available.
- Bun 1.4 or later is required only to build from source.
- Ollama with an embedding model is required for semantic search. The default is `bge-m3` with 1024 dimensions.

Lexical search works without Ollama or `sqlite-vec`. Semantic search uses Ollama and cosine distance through `sqlite-vec`. The current vector query scans the embeddings, so it is not optimized for very large corpora.

## Download and Run the Prebuilt Binary

Each GitHub release includes `session-rag-linux-x86_64`, a standalone Linux x86_64 ELF executable. Download the latest release asset and its SHA-256 checksum:

```sh
curl -fL -o session-rag-linux-x86_64 \
  https://github.com/esanchma/session-rag/releases/latest/download/session-rag-linux-x86_64
curl -fL -o session-rag-linux-x86_64.sha256 \
  https://github.com/esanchma/session-rag/releases/latest/download/session-rag-linux-x86_64.sha256
sha256sum -c session-rag-linux-x86_64.sha256
chmod +x session-rag-linux-x86_64
./session-rag-linux-x86_64 help
```

Run a one-time index with `./session-rag-linux-x86_64 index`, or start the local web UI and background indexer with `./session-rag-linux-x86_64 serve`. The executable embeds the Bun runtime, so Bun is not needed to run the release binary. Ollama remains optional for lexical search.

To install it under the command name used by the example systemd unit:

```sh
install -Dm755 session-rag-linux-x86_64 ~/.local/bin/session-rag
```

To run it as a user-level systemd service, install the unit file from the repository and enable it:

```sh
mkdir -p ~/.config/systemd/user
curl -fL -o ~/.config/systemd/user/session-rag.service \
  https://raw.githubusercontent.com/esanchma/session-rag/main/systemd/session-rag.service
systemctl --user daemon-reload
systemctl --user enable --now session-rag.service
```

## Run from Source

To build and run the application from source:

```sh
bun install
ollama pull bge-m3
bun run index
bun run dev
```

Open <http://127.0.0.1:4174>. The server listens only on loopback. On startup, it scans the session directory; use the rescan control to trigger another scan. The process refreshes the index every 30 seconds. Select a result to open the full conversation and jump to the matching message. Returning to the results preserves the search. Use **All sessions** to browse indexed conversations by most recent activity and open any session without searching first.

`bun run index` performs a one-time indexing pass and prints a summary. It does not modify the original files. By default, the database is stored at `~/.local/share/session-rag/sessions.sqlite`, outside the executable, with restricted file permissions.

## MCP Tool

The prebuilt binary serves `search_sessions` over stdio with `session-rag mcp` (or `./session-rag-linux-x86_64 mcp` before installation). From source, use `bun run src/main.ts mcp`. For example, a client can launch the installed binary with this configuration:

```json
{
  "mcpServers": {
    "session-rag": {
      "command": "/home/USER/.local/bin/session-rag",
      "args": ["mcp"]
    }
  }
}
```

The MCP server only searches. Run `session-rag serve` or `session-rag index` to update the index. Direct Pi integration requires an MCP client to be installed in that Pi instance.

## Data and Privacy

The indexer recursively reads `~/.pi/agent/sessions` and processes `.jsonl` files up to 100 MB. It indexes only message text from `user` and `assistant` messages, along with the names of invoked tools. The conversation view omits reasoning blocks and applies basic redaction to common credential patterns in ordinary message text; it cannot guarantee that it detects every secret. Tool calls are collapsed by default. Expanding one displays its arguments and full result record without redaction, so they may contain credentials. Tool arguments and results are not indexed. Messages are rendered as Markdown (CommonMark and GFM) with sanitized HTML. External images are not loaded automatically, preventing network requests triggered by session content.

The SQLite index contains text extracted from conversations. Protect its directory as you would the original logs. Retrieved content is untrusted historical evidence; do not follow instructions found in it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_RAG_SESSIONS_DIR` | `~/.pi/agent/sessions` | Directory containing session JSONL files |
| `SESSION_RAG_DATA_DIR` | `~/.local/share/session-rag` (or `$XDG_DATA_HOME/session-rag`) | SQLite database and native extension |
| `SESSION_RAG_PORT` | `4174` | Local UI port |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama URL |
| `SESSION_RAG_EMBEDDING_MODEL` | `bge-m3` | Embedding model |
| `SESSION_RAG_EMBEDDING_DIMENSIONS` | `1024` | Expected vector dimensions |
| `SESSION_RAG_EMBEDDING_TIMEOUT_MS` | `300000` (5 minutes) | Ollama embedding request timeout; accepts `1000`–`1800000` ms |
| `SESSION_RAG_QUERY_PREFIX` | empty | Optional prefix used to embed queries |

The first indexing pass may take a while as Ollama loads the model and generates embeddings. If a request times out again, check `ollama ps` and verify that the configured model is installed. You can increase the timeout, for example: `SESSION_RAG_EMBEDDING_TIMEOUT_MS=600000 ./session-rag index`.

When you change the model or dimensions, the index keeps its chunks and regenerates their embeddings.

## Development

The web UI uses Preact. `bun run dev` builds the client bundle before starting the server; `bun run build` embeds it in the executable, so no separate web assets are needed. Markdown messages use [preact-md](https://github.com/JoviDeCroock/preact-markdown), which uses Unified/Remark and sanitizes HTML by default. `remark-gfm` adds tables, task lists, strikethrough, and autolinks. This renderer was chosen for its native Preact component and built-in sanitization, rather than React-oriented renderers that require a `preact/compat` layer.

The conversation view uses the Message Scroller primitive from [shadcn-preact](https://github.com/LiasCode/shadcn-preact), pinned to snapshot `b536ae078db069f471de92a4000e24bffcb4bfe9`. Its MIT license is in `src/components/MESSAGE-SCROLLER-LICENSE.md`.

```sh
bun test
bun run typecheck
bun run build
```

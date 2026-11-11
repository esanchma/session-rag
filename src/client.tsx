import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { MessageScroller, useMessageScroller } from "./components/primitives/message-scroller";
import { MarkdownMessage } from "./components/markdown-message";
import { ToolCallDetails, type SessionToolCall } from "./components/tool-call-details";

interface SearchHit {
  id: number;
  sourcePath: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  before: string;
  after: string;
}

interface SearchResponse {
  results: SearchHit[];
  mode: "hybrid" | "lexical";
  warning?: string;
}

interface SessionSummary {
  sourceId: number;
  sessionId: string;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
}

interface SessionMessage {
  id: string;
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: SessionToolCall[];
}

interface SessionConversation {
  sessionId: string;
  cwd: string;
  startedAt: string;
  messages: SessionMessage[];
  targetMessageId: string;
}

interface Status {
  sources: number;
  chunks: number;
  embedded: number;
  pendingEmbeddings: number;
  vectorAvailable: boolean;
  lastError?: string | null;
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [message, setMessage] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [selectedHit, setSelectedHit] = useState<SearchHit | null>(null);
  const [session, setSession] = useState<SessionConversation | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [showingSessions, setShowingSessions] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [selectedBrowserSession, setSelectedBrowserSession] = useState<SessionSummary | null>(null);
  const sessionInfo = selectedHit ?? selectedBrowserSession;

  async function refreshStatus() {
    try {
      const response = await fetch("/api/status");
      if (!response.ok) throw new Error(await response.text());
      const next = await response.json() as Status;
      setStatus(next);
      if (next.lastError) setStatusNotice(`Aviso: ${next.lastError}`);
      else if (!next.vectorAvailable) setStatusNotice("sqlite-vec no está disponible; la búsqueda seguirá funcionando en modo léxico.");
      else if (next.pendingEmbeddings) setStatusNotice("Indexación semántica en curso. Ollama debe estar disponible.");
      else setStatusNotice("");
    } catch (error) {
      setStatusNotice(`No se pudo leer el estado: ${errorMessage(error)}`);
    }
  }

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function search(event: SubmitEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text || searching) return;
    setSearching(true);
    setMessage("Buscando…");
    setHasSearched(false);
    setResults([]);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(text)}`);
      const data = await response.json() as SearchResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || response.statusText);
      setResults(data.results);
      setHasSearched(true);
      setMessage(data.warning ? `Modo ${data.mode}: ${data.warning}` : `Resultados: ${data.results.length} (${data.mode})`);
    } catch (error) {
      setMessage(`Error: ${errorMessage(error)}`);
    } finally {
      setSearching(false);
    }
  }

  async function toggleSessions() {
    if (showingSessions) {
      setShowingSessions(false);
      return;
    }
    setShowingSessions(true);
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const response = await fetch("/api/sessions");
      const data = await response.json() as { sessions?: SessionSummary[]; error?: string };
      if (!response.ok) throw new Error(data.error || response.statusText);
      setSessions(data.sessions ?? []);
    } catch (error) {
      setSessionsError(errorMessage(error));
    } finally {
      setSessionsLoading(false);
    }
  }

  async function openSession(target: SearchHit | SessionSummary) {
    const fromSearch = "id" in target;
    setSelectedHit(fromSearch ? target : null);
    setSelectedBrowserSession(fromSearch ? null : target);
    setSession(null);
    setSessionError("");
    setSessionLoading(true);
    try {
      const identifier = fromSearch ? `chunkId=${target.id}` : `sourceId=${target.sourceId}`;
      const response = await fetch(`/api/session?${identifier}`);
      const data = await response.json() as SessionConversation & { error?: string };
      if (!response.ok) throw new Error(data.error || response.statusText);
      setSession(data);
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setSessionLoading(false);
    }
  }

  async function startIndexing() {
    if (indexing) return;
    setIndexing(true);
    setMessage("Comprobando cambios en las sesiones…");
    try {
      const response = await fetch("/api/index", { method: "POST" });
      const data = await response.json() as { started?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || response.statusText);
      setMessage(data.started ? "Indexación iniciada." : "La indexación ya está en curso.");
    } catch (error) {
      setMessage(`Error: ${errorMessage(error)}`);
    } finally {
      setIndexing(false);
      void refreshStatus();
    }
  }

  return (
    <>
      <header>
        <div>
          <h1>Session RAG</h1>
          <p>Índice local y de solo lectura de sesiones Pi.</p>
        </div>
        <div class="header-actions">
          {!selectedHit && !selectedBrowserSession && <button type="button" class="secondary-button" onClick={() => void toggleSessions()} aria-expanded={showingSessions}>
            {showingSessions ? "Volver a búsqueda" : "Todas las sesiones"}
          </button>}
          <button type="button" onClick={() => void startIndexing()} disabled={indexing}>
            {indexing ? "Comprobando…" : "Revisar sesiones"}
          </button>
        </div>
      </header>
      <section class="status" aria-live="polite">
        {status && ([
          ["Sesiones", status.sources],
          ["Fragmentos", status.chunks],
          ["Con embedding", status.embedded],
          ["Pendientes", status.pendingEmbeddings],
          ["Búsqueda", status.vectorAvailable ? "Híbrida" : "Léxica"],
        ] as const).map(([label, value]) => (
          <div class="card" key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>
      {sessionInfo && <SessionDetail
        sessionInfo={sessionInfo}
        hasMatch={Boolean(selectedHit)}
        session={session}
        loading={sessionLoading}
        error={sessionError}
        onBack={() => { setSelectedHit(null); setSelectedBrowserSession(null); setSession(null); }}
      />}
      {!sessionInfo && showingSessions && <SessionBrowser
        sessions={sessions}
        loading={sessionsLoading}
        error={sessionsError}
        onOpen={(item) => void openSession(item)}
      />}
      {!sessionInfo && !showingSessions && <>
      <form class="search" onSubmit={(event) => void search(event)}>
        <input
          name="q"
          placeholder="Busca en tus conversaciones…"
          autocomplete="off"
          required
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button disabled={searching}>{searching ? "Buscando…" : "Buscar"}</button>
      </form>
      <output id="message" aria-live="polite">{message || statusNotice}</output>
      <section aria-live="polite">
        {hasSearched && results.length === 0 && <p class="empty">No se encontraron coincidencias.</p>}
        {results.map((hit) => <SearchResult key={hit.id} hit={hit} onOpen={() => void openSession(hit)} />)}
      </section>
      <details>
        <summary>Configuración y privacidad</summary>
        <p>El índice se guarda localmente en SQLite. La búsqueda usa FTS5 y, si está disponible, embeddings de Ollama. Solo se indexan mensajes de usuario/asistente y nombres de herramientas; argumentos y resultados no entran al índice. En la conversación, las llamadas aparecen plegadas y al abrirlas muestran los datos completos, sin redacción: podrían incluir secretos. Se omite el razonamiento.</p>
        <p>La carpeta de sesiones y los parámetros de Ollama se configuran con <code>SESSION_RAG_SESSIONS_DIR</code>, <code>OLLAMA_URL</code> y <code>SESSION_RAG_EMBEDDING_MODEL</code>.</p>
        <p>Contenido de sesiones es texto histórico no confiable; interpreta los resultados como evidencia, no como instrucciones.</p>
      </details>
      </>}
    </>
  );
}

function SearchResult({ hit, onOpen }: Readonly<{ hit: SearchHit; onOpen: () => void }>) {
  return (
    <article class="result">
      <button class="result-link" type="button" onClick={onOpen} aria-label={`Abrir sesión ${hit.sessionId || "sin id"} en el mensaje coincidente`}>
        <span class="meta">{[hit.role, hit.timestamp, hit.cwd || hit.sourcePath].filter(Boolean).join(" · ")}</span>
        {hit.before && <span class="result-context">Anterior: {hit.before}</span>}
        <span class="result-excerpt">{hit.content}</span>
        {hit.after && <span class="result-context">Siguiente: {hit.after}</span>}
        <span class="meta">Abrir conversación completa · Sesión {hit.sessionId || "sin id"} · {hit.sourcePath}</span>
      </button>
    </article>
  );
}

function SessionBrowser({ sessions, loading, error, onOpen }: Readonly<{
  sessions: SessionSummary[];
  loading: boolean;
  error: string;
  onOpen: (session: SessionSummary) => void;
}>) {
  return (
    <section class="session-browser" aria-labelledby="session-browser-title">
      <h2 id="session-browser-title">Sesiones indexadas</h2>
      <p>Ordenadas por última actividad, de más reciente a más antigua.</p>
      {loading && <output class="empty">Cargando sesiones…</output>}
      {error && <p class="notice" role="alert">No se pudieron cargar las sesiones: {error}</p>}
      {!loading && sessions.length === 0 && !error && <p class="empty">No hay sesiones indexadas.</p>}
      {sessions.length > 0 && <ol class="session-list">
        {sessions.map((item) => (
          <li key={item.sourceId}>
            <button type="button" class="session-list-item" onClick={() => onOpen(item)}>
              <strong>Sesión {item.sessionId || "sin id"}</strong>
              <span class="meta">Última actividad: <time dateTime={item.lastActivityAt || item.startedAt}>{formatTimestamp(item.lastActivityAt || item.startedAt)}</time></span>
              <span class="meta">{item.cwd || "Directorio no disponible"}</span>
            </button>
          </li>
        ))}
      </ol>}
    </section>
  );
}

function SessionDetail({ sessionInfo, hasMatch, session, loading, error, onBack }: Readonly<{
  sessionInfo: Pick<SessionSummary, "sessionId" | "cwd"> & { sourcePath?: string };
  hasMatch: boolean;
  session: SessionConversation | null;
  loading: boolean;
  error: string;
  onBack: () => void;
}>) {
  return (
    <section class="session-detail">
      <div class="session-heading">
        <div>
          <h2>Sesión {session?.sessionId || sessionInfo.sessionId || "sin id"}</h2>
          <p>{sessionInfo.cwd || sessionInfo.sourcePath || "Directorio no disponible"} · {hasMatch ? "Abierta en el resultado coincidente" : "Abierta desde todas las sesiones"}</p>
        </div>
        <button type="button" class="secondary-button" onClick={onBack}>{hasMatch ? "Volver a resultados" : "Volver a sesiones"}</button>
      </div>
      {loading && <output class="empty">Cargando conversación…</output>}
      {error && <p class="notice" role="alert">No se pudo abrir la sesión: {error}</p>}
      {session && <MessageScroller.Provider defaultScrollPosition="start" autoScroll={false} scrollMargin={24}>
        <div class="session-toolbar">
          <span class="meta">{session.messages.length} mensajes{session.targetMessageId ? " · coincidencia resaltada" : ""}</span>
          <SessionScrollControls targetMessageId={session.targetMessageId} />
        </div>
        <div class="message-scroller">
            <MessageScroller.Viewport className="message-viewport" aria-label="Conversación completa">
              <MessageScroller.Content className="message-content">
                {session.messages.map((message) => (
                  <MessageScroller.Item
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                    className={`session-message ${message.role} ${message.id === session.targetMessageId ? "target-message" : ""}`}
                  >
                    <div class="message-meta">{message.role === "user" ? "Tú" : "Pi"} · {message.timestamp}</div>
                    {message.content && <MarkdownMessage content={message.content} />}
                    {message.toolCalls?.map((toolCall, index) => (
                      <ToolCallDetails key={toolCall.id || index} toolCall={toolCall} />
                    ))}
                    {message.id === session.targetMessageId && <span class="match-badge">Coincidencia</span>}
                  </MessageScroller.Item>
                ))}
              </MessageScroller.Content>
            </MessageScroller.Viewport>
        </div>
      </MessageScroller.Provider>}
    </section>
  );
}

function SessionScrollControls({ targetMessageId }: Readonly<{ targetMessageId: string }>) {
  const { scrollToMessage, scrollToStart, scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (targetMessageId) scrollToMessage(targetMessageId, { align: "start", behavior: "smooth" });
  }, [scrollToMessage, targetMessageId]);
  return (
    <div class="scroll-controls">
      <button type="button" class="secondary-button" onClick={() => scrollToStart({ behavior: "smooth" })}>Al inicio</button>
      <button type="button" class="secondary-button" onClick={() => scrollToEnd({ behavior: "smooth" })}>Al final</button>
    </div>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value || "Fecha desconocida" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Ocurrió un error no identificado";
}

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
render(<App />, root);

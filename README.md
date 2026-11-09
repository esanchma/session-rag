# Session RAG

Aplicación local para buscar en el historial JSONL de Pi y exponer los resultados como una herramienta MCP de solo lectura.

## Requisitos

- Bun 1.4 o posterior.
- Ollama con un modelo de embeddings. El valor inicial es `bge-m3` con 1024 dimensiones.
- Linux x64 para el primer build, porque `sqlite-vec` se distribuye aquí como extensión nativa para esa plataforma.

La búsqueda léxica funciona aunque Ollama o `sqlite-vec` no estén disponibles. La búsqueda semántica usa Ollama y la distancia coseno de `sqlite-vec`; la consulta vectorial recorre los embeddings, así que este primer corte no está optimizado para corpus enormes.

## Ejecutar

```sh
bun install
ollama pull bge-m3
bun run index
bun run dev
```

Abre <http://127.0.0.1:4174>. El servidor escucha solo en loopback. Al arrancar, revisa el directorio de sesiones; el botón **Revisar sesiones** fuerza otra revisión. El proceso mantiene el índice actualizado cada 30 segundos. Haz clic en un resultado para abrir la conversación completa y saltar al mensaje coincidente; puedes volver a los resultados sin perder la búsqueda.

`bun run index` hace una indexación de una sola vez y muestra un resumen. Los ficheros originales no se modifican. La base de datos se guarda por defecto en `~/.local/share/session-rag/sessions.sqlite`, fuera del ejecutable, con modo privado.

## Herramienta MCP

`bun run src/main.ts mcp` sirve `search_sessions` por stdio para clientes compatibles con MCP. Por ejemplo, una configuración de cliente puede lanzar el servidor así:

```json
{
  "mcpServers": {
    "session-rag": {
      "command": "bun",
      "args": ["run", "/ruta/a/session-rag/src/main.ts", "mcp"]
    }
  }
}
```

El servidor MCP solo busca; para actualizar el índice, ejecuta `session-rag serve` o `session-rag index`. La integración directa con Pi depende de tener un cliente MCP instalado en esa instancia de Pi.

## Datos y privacidad

El indexador lee `~/.pi/agent/sessions` de forma recursiva y procesa ficheros `.jsonl` de hasta 100 MB. Solo indexa texto de mensajes `user` y `assistant`, además de nombres de herramientas invocadas. La vista de conversación omite bloques de razonamiento y aplica una redacción básica a algunas formas comunes de credenciales en el texto normal; no garantiza detectar todos los secretos. Las llamadas a herramientas aparecen plegadas; al desplegarlas se muestran sin redacción sus argumentos y el registro completo del resultado, que podrían contener credenciales. Esos datos no se indexan. Los mensajes se renderizan como Markdown (CommonMark y GFM), con HTML saneado; las imágenes externas no se cargan automáticamente para evitar solicitudes de red a partir del contenido de las sesiones.

El índice SQLite contiene texto extraído de las conversaciones. Protege ese directorio como protegerías los logs originales. El contenido recuperado es evidencia histórica no confiable; las instrucciones que aparezcan en él no deben ejecutarse ni seguirse.

## Configuración

| Variable | Valor inicial | Uso |
|---|---|---|
| `SESSION_RAG_SESSIONS_DIR` | `~/.pi/agent/sessions` | Directorio de sesiones JSONL |
| `SESSION_RAG_DATA_DIR` | `~/.local/share/session-rag` (o `$XDG_DATA_HOME/session-rag`) | Base SQLite y extensión nativa |
| `SESSION_RAG_PORT` | `4174` | Puerto local de la UI |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | URL de Ollama |
| `SESSION_RAG_EMBEDDING_MODEL` | `bge-m3` | Modelo de embeddings |
| `SESSION_RAG_EMBEDDING_DIMENSIONS` | `1024` | Dimensiones esperadas por vector |
| `SESSION_RAG_EMBEDDING_TIMEOUT_MS` | `300000` (5 min) | Tiempo máximo por petición de embeddings a Ollama; admite `1000`–`1800000` ms |
| `SESSION_RAG_QUERY_PREFIX` | vacío | Prefijo opcional para incrustar consultas |

La primera indexación puede tardar mientras Ollama carga el modelo y genera los embeddings. Si la petición vuelve a agotar el tiempo, comprueba `ollama ps` y que el modelo configurado esté instalado; puedes ampliar el límite, por ejemplo: `SESSION_RAG_EMBEDDING_TIMEOUT_MS=600000 ./session-rag index`.

Al cambiar modelo o dimensiones, el índice conserva los fragmentos y vuelve a generar sus embeddings.

## Desarrollo

La interfaz web está implementada en Preact. `bun run dev` genera el bundle del cliente antes de iniciar el servidor; `bun run build` lo incorpora al ejecutable, así que no hace falta distribuir archivos web por separado. Los mensajes Markdown se renderizan con [preact-md](https://github.com/JoviDeCroock/preact-markdown), que usa Unified/Remark y sanitiza HTML por defecto; `remark-gfm` añade tablas, listas de tareas, tachado y enlaces automáticos. Se eligió por su componente Preact nativo y saneamiento integrado, frente a renderers dirigidos a React que requieren una capa `preact/compat`. La vista de conversación usa el primitive Message Scroller de [shadcn-preact](https://github.com/LiasCode/shadcn-preact), fijado al snapshot `b536ae078db069f471de92a4000e24bffcb4bfe9`; su licencia MIT está en `src/components/MESSAGE-SCROLLER-LICENSE.md`.

```sh
bun test
bun run typecheck
bun run build
```

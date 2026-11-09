export interface SessionToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
}

export function ToolCallDetails({ toolCall }: Readonly<{ toolCall: SessionToolCall }>) {
  return (
    <details class="tool-call">
      <summary>
        Herramienta: <code>{toolCall.name}</code>
        {toolCall.id && <span class="tool-call-id"> · {toolCall.id}</span>}
      </summary>
      <div class="tool-call-payload">
        <section>
          <strong>Argumentos</strong>
          <pre>{toolCall.arguments}</pre>
        </section>
        <section>
          <strong>Resultado</strong>
          {toolCall.result !== undefined ? <pre>{toolCall.result}</pre> : <p>No se registró un resultado.</p>}
        </section>
      </div>
    </details>
  );
}

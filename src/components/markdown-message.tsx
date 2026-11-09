import { Markdown } from "preact-md";
import remarkGfm from "remark-gfm";

const MARKDOWN_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = { img: MarkdownImage };

export function MarkdownMessage({ content }: Readonly<{ content: string }>) {
  return (
    <Markdown className="markdown-content" remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {content}
    </Markdown>
  );
}

function MarkdownImage({ alt }: Readonly<{ alt?: string; [key: string]: unknown }>) {
  return <span class="markdown-image-placeholder">[Imagen externa omitida{alt ? `: ${alt}` : ""}]</span>;
}

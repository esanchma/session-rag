import { describe, expect, test } from "bun:test";
import { h } from "preact";
import renderToString from "preact-render-to-string";
import { MarkdownMessage } from "../src/components/markdown-message";

describe("MarkdownMessage", () => {
  test("renders CommonMark and GitHub Flavored Markdown", () => {
    const html = renderToString(h(MarkdownMessage, {
      content: "## Heading\n\n**bold** and ~~deleted~~\n\n| A | B |\n| - | - |\n| 1 | 2 |",
    }));

    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<del>deleted</del>");
    expect(html).toContain("<table>");
  });

  test("sanitizes unsafe HTML and avoids loading external images", () => {
    const html = renderToString(h(MarkdownMessage, {
      content: '<script>alert(1)</script>\n\n<a href="javascript:alert(1)" onclick="alert(1)">unsafe</a>\n\n![private](https://example.com/pixel.png)',
    }));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com/pixel.png");
    expect(html).toContain("[Imagen externa omitida: private]");
  });
});

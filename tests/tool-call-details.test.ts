import { describe, expect, test } from "bun:test";
import { h } from "preact";
import renderToString from "preact-render-to-string";
import { ToolCallDetails } from "../src/components/tool-call-details";

describe("ToolCallDetails", () => {
  test("keeps calls collapsed and reveals arguments and full result on expansion", () => {
    const html = renderToString(h(ToolCallDetails, {
      toolCall: {
        id: "call-7",
        name: "read_file",
        arguments: '{\n  "path": "/tmp/example"\n}',
        result: '{\n  "role": "toolResult",\n  "content": [{ "text": "file contents" }]\n}',
      },
    }));

    expect(html).toContain('<details class="tool-call">');
    expect(html).not.toContain("<details class=\"tool-call\" open>");
    expect(html).toContain("read_file");
    expect(html).toContain("/tmp/example");
    expect(html).toContain("file contents");
  });
});

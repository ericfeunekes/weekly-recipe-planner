import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexMarkdown, parseCodexMarkdownInline } from "../app/codex-markdown.ts";

test("Codex assistant Markdown renders the safe planning subset", () => {
  assert.deepEqual(parseCodexMarkdown("## Week overview\n\n- **Monday**: `Harissa`\n- Tuesday\n\nA final note."), [
    { kind: "heading", level: 2, text: "Week overview" },
    { kind: "unordered-list", items: ["**Monday**: `Harissa`", "Tuesday"] },
    { kind: "paragraph", text: "A final note." },
  ]);
  assert.deepEqual(parseCodexMarkdownInline("**Monday** uses `Harissa`."), [
    { kind: "strong", value: "Monday" },
    { kind: "text", value: " uses " },
    { kind: "code", value: "Harissa" },
    { kind: "text", value: "." },
  ]);
});

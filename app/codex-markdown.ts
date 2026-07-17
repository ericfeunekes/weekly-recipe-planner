export type CodexInlineToken =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "code"; value: string };

export type CodexMarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "paragraph"; text: string };

const UNORDERED_LIST = /^[-*]\s+(.+)$/u;
const ORDERED_LIST = /^\d+[.)]\s+(.+)$/u;
const HEADING = /^(#{1,3})\s+(.+)$/u;
const INLINE_MARKUP = /(\*\*[^*]+\*\*|`[^`]+`)/gu;

/**
 * A deliberately small, safe Markdown surface for assistant text. HTML stays
 * text; only headings, lists, bold text, and inline code are interpreted.
 */
export function parseCodexMarkdown(text: string): CodexMarkdownBlock[] {
  const blocks: CodexMarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    const value = paragraph.join(" ").trim();
    if (value) blocks.push({ kind: "paragraph", text: value });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.items.length) blocks.push({ kind: list.ordered ? "ordered-list" : "unordered-list", items: list.items });
    list = null;
  };

  for (const rawLine of text.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      continue;
    }
    const unordered = line.match(UNORDERED_LIST);
    const ordered = line.match(ORDERED_LIST);
    if (unordered || ordered) {
      flushParagraph();
      const next = { ordered: Boolean(ordered), items: [unordered?.[1] ?? ordered?.[1] ?? ""] };
      if (list?.ordered === next.ordered) list.items.push(next.items[0]);
      else {
        flushList();
        list = next;
      }
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function parseCodexMarkdownInline(text: string): CodexInlineToken[] {
  const tokens: CodexInlineToken[] = [];
  let index = 0;
  for (const match of text.matchAll(INLINE_MARKUP)) {
    const start = match.index ?? 0;
    if (start > index) tokens.push({ kind: "text", value: text.slice(index, start) });
    const value = match[0];
    tokens.push(value.startsWith("**")
      ? { kind: "strong", value: value.slice(2, -2) }
      : { kind: "code", value: value.slice(1, -1) });
    index = start + value.length;
  }
  if (index < text.length) tokens.push({ kind: "text", value: text.slice(index) });
  return tokens;
}

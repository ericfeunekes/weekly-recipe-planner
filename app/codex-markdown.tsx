import { Fragment, type ReactNode } from "react";

import { parseCodexMarkdown, parseCodexMarkdownInline } from "./codex-markdown.ts";

function InlineMarkdown({ text }: { text: string }) {
  return <>{parseCodexMarkdownInline(text).map((token, index) => {
    if (token.kind === "strong") return <strong key={index}>{token.value}</strong>;
    if (token.kind === "code") return <code key={index}>{token.value}</code>;
    return <Fragment key={index}>{token.value}</Fragment>;
  })}</>;
}

export function CodexMarkdown({ text }: { text: string }) {
  return <div className="codex-markdown">
    {parseCodexMarkdown(text).map((block, index): ReactNode => {
      if (block.kind === "heading") {
        const Heading = `h${block.level}` as "h1" | "h2" | "h3";
        return <Heading key={index}><InlineMarkdown text={block.text} /></Heading>;
      }
      if (block.kind === "unordered-list") return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} /></li>)}</ul>;
      if (block.kind === "ordered-list") return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} /></li>)}</ol>;
      return <p key={index}><InlineMarkdown text={block.text} /></p>;
    })}
  </div>;
}

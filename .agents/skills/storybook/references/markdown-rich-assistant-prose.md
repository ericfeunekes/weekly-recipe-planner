# Markdown-Rich Assistant Prose Stories

Use this reference when a Storybook primitive or component renders assistant,
agent, or LLM-authored prose. These stories need to prove more than simple
paragraph typography.

## Required Coverage

Before claiming an assistant prose primitive is ready, include stories and/or
component tests for these content classes when the product can emit them:

- **Plain prose rhythm**: paragraph spacing, headings, long wrapping text, and
  source/citation slots when applicable.
- **GFM tables**: prove the rendered DOM contains a real `<table>`, `<thead>`,
  `<tbody>`, rows, and cells. A pipe-delimited text block is a failure, not a
  table story.
- **Code blocks and inline code**: include at least one fenced block and inline
  code token so typography, overflow, and copy/readability are visible.
- **Lists and nested lists**: include unordered bullets, ordered lists, and at
  least one nested list state. Verify they render as semantic `<ul>` / `<ol>`
  structures with visible marker styles, not just indented prose.
- **Literal dollar signs**: include accounting/tax text such as `$1,250`, `$0`,
  `$10,000 - $12,000`, or `$5 per share`. Verify these remain text and do not
  render as LaTeX/math.
- **Streaming partial content**: include a state where one paragraph is complete
  and the next structure is incomplete, such as a partially streamed markdown
  table. When the risk is incomplete markdown, make the fixture truly
  incomplete: for example, a table row with a missing cell
  (`| Eligible dividends |`) rather than a valid final row with shorter text.
  The story should show the intended partial-render behavior and should not
  pretend the final table is already available.

## Streamdown And Renderer Claims

If the repo intends to use Streamdown or another streaming markdown renderer, do
not claim that path is implemented from static JSX or plain ReactMarkdown
stories. Separate the proof levels:

- **Typography/layout proof**: static JSX children or simple rendered prose.
- **Markdown renderer proof**: real markdown input rendered through the chosen
  renderer, with DOM checks for tables/code and dollar-sign behavior.
- **Streaming renderer proof**: incremental or partial markdown state rendered
  through the same streaming renderer or a named harness that models it. Include
  at least one invalid/incomplete markdown checkpoint when the production stream
  can expose mid-token structures.

If Streamdown is not installed or the runtime spike is still pending, label the
story as a target-state/mock or typography proof. Do not let it pass as renderer
or streaming proof.

When moving from ReactMarkdown to Streamdown, prove the actual Streamdown path
instead of relying on the old renderer tests:

- Add `streamdown` as a dependency and import its CSS (for example
  `streamdown/styles.css`) through the app's global stylesheet or documented
  bundler path.
- Add Streamdown's Tailwind source path (for example
  `@source "../node_modules/streamdown/dist/*.js";`) when the project uses
  Tailwind scanning; otherwise utility classes inside Streamdown may not be
  generated.
- Do not enable optional math/KaTeX plugins by default in accounting, tax, or
  finance prose. Dollar signs are normal content and should remain literal
  unless product explicitly opts into math rendering.
- Pass `mode="streaming"` and `parseIncompleteMarkdown` (or the current
  Streamdown equivalents) for in-flight/partial states; static mode only proves
  final markdown rendering.
- Keep structured source metadata, citation badges, and action chrome outside
  the markdown string. Streamdown owns assistant prose rendering; product
  metadata owns sources, references, and actions.

## Assistant-UI Runtime Integration

When the production message path is inside `@assistant-ui/react` primitives,
prefer the assistant-ui Streamdown adapter for runtime message parts rather than
hand-feeding extracted text into a context-free Streamdown component.

Recommended split:

- **Runtime assistant messages**: render `MessagePrimitive.Content` with
  `@assistant-ui/react-streamdown`'s `StreamdownTextPrimitive`, so the renderer
  reads the active message part through assistant-ui context and preserves
  assistant-ui status semantics.
- **Prop-hydrated primitive/component stories**: a direct `streamdown`
  component is acceptable when no assistant-ui message-part context exists, but
  label it as the context-free fixture path.
- **Shared styling**: factor markdown component/style overrides so direct
  Streamdown fixtures and `StreamdownTextPrimitive` use the same table, code,
  list, link, and token treatment.
- **Plugin policy**: do not pass optional math/KaTeX plugins unless product
  explicitly opts in; disabling or omitting math is the expected default for
  tax/accounting prose with dollar signs.
- **Metadata split**: sources, inline reference badges, action rows, and
  streaming-slot chrome stay outside Streamdown even when Streamdown owns the
  assistant prose.

Proof should cover both paths when both exist: component tests for the
context-free fixture renderer and real-runtime assistant-ui tests for
`StreamdownTextPrimitive` inside `MessagePrimitive.Content`.

Do not let the two paths blur during closeout. If the production path was just
moved from one renderer or adapter to another, update the real-runtime tests to
assert representative markdown output in that path: at minimum one table or
code block, literal dollar signs that do not become math, and any source or
action chrome that must coexist with the rendered prose. A "no selector loop" or
"component mounts" runtime test is useful stability evidence, but it is not
markdown behavior proof.

## Verification Pattern

1. Open the exact Storybook iframe for each markdown-rich state.
2. Inspect the DOM shape for semantic structures: tables, code blocks, links,
   lists, and citation/source affordances.
3. Inspect or screenshot overflow and wrapping at the required viewport.
4. For dollar signs, check the visible text still includes the literal `$`
   characters and no math/LaTeX wrapper appeared.
5. Report remaining proof gaps explicitly, for example: "tables render through
   ReactMarkdown+GFM, but Streamdown streaming is still unproved."

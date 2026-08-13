# AI Assistants And Streaming

Separate protocol, runtime, presentation, and workflow choices. One package
should not silently own all four.

## Default Composition

Use:

- **AG-UI** for the agent-to-frontend event protocol;
- **shared shadcn components** for a basic custom chat surface;
- **assistant-ui** when the application needs a customizable, rich headless
  assistant presentation layer—composer, streaming messages, threads, tool
  displays, approvals, and interaction primitives—while retaining visual and
  component ownership;
- **ChatKit** when the requirement is explicitly “give me an out-of-the-box
  chat; I do not want to customize it,” accepting its packaged widgets,
  threads, item model, presentation, and protocol choices as an exception to
  the AG-UI composition;
- **AI SDK 7** when the application owns the model/AI runtime and streaming
  integration; and
- **LangGraph** when agent execution requires durable, resumable workflows,
  checkpoints, supervision, or human-in-the-loop orchestration.

Do not select CopilotKit. Do not add it as an alternative composition.

## Protocol Roles

Use each protocol only for the boundary it owns:

- **MCP** exposes tools and context to models or agents.
- **ACP** hosts or communicates with coding agents.
- **A2A** communicates with remote agents across service boundaries.
- **A2UI** carries declarative UI descriptions when the product intentionally
  allows an agent/runtime to propose structured interface output.
- **AG-UI** streams agent events and interaction state to the frontend.

These protocols can compose. They do not replace TanStack Query for ordinary
application APIs, Router for URL state, or the backend's business authority.

## Streaming Ownership

Model streaming as distinct layers:

1. The runtime/transport owns connection mechanics, protocol parsing,
   cancellation signals, and raw events.
2. A transcript or domain projection owns accumulated content and tool results.
3. TanStack Query owns remote resources fetched outside the active stream and
   terminal refetch/invalidation when needed.
4. XState may own control lifecycle—connecting, streaming, awaiting approval,
   cancelling, retrying, completed, failed—when guarded transitions or
   concurrent actors make that model valuable.
5. The server or agent runtime owns the authoritative final outcome.

Send semantic lifecycle events into XState. Do not route token chunks through
the machine or duplicate the transcript inside machine context. XState is an
addition for control correctness, not a replacement for the stream client,
Query, Router, or backend state.

Before selecting a streaming package, name the producer, serialized event
contract, ordering and idempotency guarantees, cancellation owner,
reconnect/replay behavior, persistence or checkpoint owner, authorization
boundary, and UI projection. SSE, WebSocket, AG-UI, and a state machine each
cover different parts of that contract; none implies the others.

## Selection Rules

Choose shared shadcn chat components when the product surface is simple and the
team wants complete visual ownership without adopting a headless assistant
framework.

Choose assistant-ui when the product needs reusable assistant interaction
primitives and rich states but must retain design-system control. “Headless”
means it supplies interaction/runtime composition rather than forcing one final
visual design; it does not mean zero integration work.

Choose ChatKit only when speed and packaged behavior matter more than bespoke
presentation or protocol ownership. In that composition, ChatKit owns its
packaged frontend protocol; do not require an AG-UI adapter merely to preserve
the general default. Record that trade explicitly so later customization
pressure does not arrive as a surprise migration.

Choose LangGraph only for durable agent workflow needs. Ordinary request/stream
handling does not require a workflow engine.

## Proof

Test the protocol/runtime projection independently from rendering. Use recorded
or deterministic event streams to prove parsing, accumulation, tool events,
approvals, cancellation, reconnect/retry, terminal state, and Query
invalidation. Then use Storybook to prove known visual states and Playwright to
prove the routed browser interaction. Storybook alone is not proof of stream
or runtime correctness.

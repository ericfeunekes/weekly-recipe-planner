# State And Data Ownership

## Classify Before Choosing A Library

For every state value, answer:

1. Who is authoritative?
2. Must it survive navigation or reload?
3. Must it be shareable in a URL?
4. Is it remote and cacheable?
5. Does it have guarded lifecycle transitions?
6. Which modules need synchronous access?

Then place it once.

| State shape | Owner |
|---|---|
| Route params, search, hash, navigation selection | TanStack Router |
| API resources, freshness, retries, mutations, optimistic remote state | TanStack Query |
| Component-local interaction and transient display state | React state/reducer |
| Field values, dirtiness, touched state, client validation | React Hook Form |
| Runtime boundary schemas and shared validation contracts | Zod |
| Cross-component synchronous client-only state | Zustand |
| Explicit guarded lifecycle, actors, cancellation, approvals, retries | XState |
| Normalized reactive collections with live queries | TanStack DB |
| Business truth, authorization, final workflow outcome | Server/owning runtime |

Do not copy URL state, Query data, or server truth into Zustand or XState for
convenience. Derive views at consumption time or build a narrow presentation
model.

## TanStack Query

Use Query in API-backed applications because requests immediately introduce
freshness, deduplication, cancellation, retries, invalidation, background
refresh, and mutation lifecycle concerns. Define reusable query options and
stable key factories in the API/data boundary or owning feature. Let route
loaders prefetch or ensure those same options.

Do not use Query as a general event bus or client store. Do not hide all Query
calls behind generic hooks that erase query keys, enabled conditions, or cache
semantics.

## Forms And Schemas

Use React Hook Form as the form standard. Use Zod for runtime validation at
untrusted boundaries and for shared form schemas where one schema meaningfully
serves both runtime validation and TypeScript inference. Use Standard Schema as
the interoperability contract when a library accepts it.

Select TanStack Form only when its granular typed field subscriptions or a
TanStack Start server-validation bridge is a decisive application requirement.
Treat that as an explicit exception, not a second default.

Valibot is not the default. Consider it only when a measured bundle-size or
modular-import constraint outweighs the cost of a second schema standard.

Server validation remains authoritative. Map structured server errors back to
form and field errors without reimplementing server business rules in Zod.

## Client State And Workflows

Start with React state. Introduce Zustand only when independent components need
the same synchronous, client-only state and lifting it would distort ownership.
Keep stores small and capability-owned. Persist only values with an explicit
product requirement; version persisted shapes.

Use XState in addition to Query, Router, or Zustand when the lifecycle itself is
the problem: transitions are guarded, invalid transitions matter, work can be
cancelled or retried, approval changes permitted actions, or concurrent actors
must be supervised. XState replaces ad hoc booleans, reducer branches, or store
fields for that workflow. It does not replace remote caching, URL state, or
server authority.

For streaming, separate:

- **transport state**: connection/request mechanics owned by the stream client;
- **content state**: accumulated chunks/events owned by the transcript or
  domain projection;
- **control state**: idle, connecting, streaming, awaiting approval,
  cancelling, retrying, completed, failed—owned by XState only when explicit
  transition rules add value; and
- **authoritative state**: final server/agent outcome owned by the backend or
  runtime.

Do not send every token or chunk through a state machine. Send semantic events
that change permitted behavior.

## TanStack DB

Adopt TanStack DB only when the application needs normalized reactive
collections, live queries across them, and coordinated optimistic mutations.
It is an architectural data-model choice, not a preference store. Keep Query as
the remote-cache owner unless the selected DB integration explicitly replaces a
part of that responsibility and the architecture records the new authority.

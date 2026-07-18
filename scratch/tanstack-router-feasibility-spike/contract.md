# Spike: TanStack Router direct-path feasibility in Vinext

Decision blocked: whether TanStack Router can compose with Vinext on a direct Week + Day path without changing the Node authority, deployed mount, or web runtime.

Unknown: can Vinext render the same client router host on a hard request to `/weeks/<weekId>/day/<date>` and preserve Vite's deployed `/recipe-planner/` base path?

Why this matters: a failure would change the migration approach or make it a no-go; a passing composition is only the dependency/runtime feasibility prerequisite for a later user-facing routing slice.

Method: create a disposable detached worktree under `/private/tmp`, add only the minimal router dependency and code-based Week/Day client host, add a catch-all Vinext page, build it, and request one direct hard path from the built server. The local Node/SQLite authority, API contracts, Codex rail, browser navigation behavior, and production checkout are out of scope and untouched.

Evidence boundary: real Vinext build and built server direct-path response. Browser behavior, planner authority integration, and production deployment are not evidence boundaries for this spike.

Stop rule: stop immediately on one of (a) a successful build plus a 200 response for the direct Week + Day path, (b) a reproducible direct-path/build failure after one targeted correction, or (c) evidence that the experiment would require a Node authority, API, or deployment-topology change. Do not implement the later navigation slice.

Success / no-go criteria:

- Success: the build accepts the router composition and the built server answers the direct Week + Day path without an authority or topology change; record the dependency/runtime feasibility gate closed. Direct load/reload/copy, back/forward, invalid recovery, last-location restoration, and mounted-base behavior remain acceptance work for the first delivery slice.
- No-go or mixed: record the exact failure and route to the relevant user decision or investigation. Do not carry a conditional route approach into planning.

Promotion target: `site/scratch/tanstack-router-feasibility-unknowns.md` and an in-thread readiness result. The disposable worktree is removed after evidence is promoted.

Cleanup: delete the temporary worktree and its installed dependencies; retain only this contract, working notes, and promoted register result.

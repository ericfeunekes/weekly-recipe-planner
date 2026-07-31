import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublicPath } from "../app/public-path.ts";

test("public API paths retain the default root deployment", () => {
  assert.equal(resolvePublicPath("/api/workspace", "/"), "/api/workspace");
});

test("public API paths remain below the shared Tailscale mount", () => {
  assert.equal(
    resolvePublicPath("/api/codex/threads", "/recipe-planner/"),
    "/recipe-planner/api/codex/threads",
  );
});

test("mounted static metadata paths use the same public-path contract", () => {
  assert.equal(
    resolvePublicPath("/favicon.svg", "/recipe-planner/"),
    "/recipe-planner/favicon.svg",
  );
  assert.equal(
    resolvePublicPath("/og.png", "/recipe-planner/"),
    "/recipe-planner/og.png",
  );
});

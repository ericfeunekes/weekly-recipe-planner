import assert from "node:assert/strict";
import test from "node:test";

import { isProductionHealthReady } from "../scripts/support/production-readiness.mjs";

const healthy = {
  status: "ready",
  codex: {
    status: "ready",
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
  },
};

test("production activation requires a usable authenticated Codex runtime", () => {
  assert.equal(isProductionHealthReady(healthy), true);
  assert.equal(isProductionHealthReady({ ...healthy, status: "degraded" }), false);
  assert.equal(isProductionHealthReady({ ...healthy, codex: { ...healthy.codex, state: "unavailable" } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, codex: { ...healthy.codex, authenticated: false } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, codex: { ...healthy.codex, protocolCompatible: false } }), false);
});

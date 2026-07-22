import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Agent, createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isProductionHealthReady } from "../scripts/support/production-readiness.mjs";
import {
  createProductionService,
  productionServicePaths,
  renderProductionServicePlist,
} from "../scripts/support/production-service.mjs";

const healthy = {
  status: "ready",
  web: { status: "ready" },
  application: { status: "ready", initialized: true },
  store: { status: "ready", quickCheck: "ok" },
  codex: {
    status: "ready",
    state: "compatible",
    authenticated: true,
    protocolCompatible: true,
  },
  globalCodex: { status: "ready" },
};

test("production activation requires a usable authenticated Codex runtime", () => {
  assert.equal(isProductionHealthReady(healthy), true);
  assert.equal(isProductionHealthReady({ ...healthy, status: "degraded" }), false);
  assert.equal(isProductionHealthReady({ ...healthy, codex: { ...healthy.codex, state: "unavailable" } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, codex: { ...healthy.codex, authenticated: false } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, codex: { ...healthy.codex, protocolCompatible: false } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, web: { status: "unavailable" } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, application: { status: "ready", initialized: false } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, store: { status: "ready", quickCheck: "failed" } }), false);
  assert.equal(isProductionHealthReady({ ...healthy, globalCodex: { status: "unavailable" } }), false);
});

test("production service renders a stable-app plist and rejects a stale keep-alive listener", async (t) => {
  const testHome = await mkdtemp(join(tmpdir(), "planner-service-home-"));
  t.after(() => rm(testHome, { recursive: true, force: true }));
  const paths = productionServicePaths({ home: testHome, label: "test.planner" });
  const plist = renderProductionServicePlist({ paths, node: "/usr/local/bin/node", port: 9876, privateWebPort: 9877 });
  assert.ok(plist.includes(`<key>WorkingDirectory</key><string>${paths.appRoot}</string>`));
  assert.match(plist, /<key>PLANNER_PRIVATE_WEB_PORT<\/key><string>9877<\/string>/u);
  assert.doesNotMatch(plist, /app\.previous|activation|sha256/u);
  assert.throws(() => renderProductionServicePlist({ paths, port: 9876, privateWebPort: 9876 }), /distinct valid/u);
  assert.throws(() => renderProductionServicePlist({ paths, port: 9876, privateWebPort: 70000 }), /distinct valid/u);

  const observedPaths = [];
  const server = createServer((request, response) => {
    observedPaths.push(request.url);
    response.setHeader("Connection", "keep-alive");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/recipe-planner/api/health" ? healthy : { initialized: true }));
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("This sandbox does not permit a loopback listener.");
      return;
    }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  t.after(() => server.closeAllConnections());

  const service = createProductionService({
    paths,
    port,
    runCommand: async () => 0,
    probeTimeoutMs: 500,
  });
  assert.equal(await service.isRuntimeOwnerQuiet(), true);
  const ownerSocket = join(paths.dataRoot, ".runtime-owner", "runtime-owner.sock");
  await mkdir(join(paths.dataRoot, ".runtime-owner"), { recursive: true });
  const owner = createServer();
  await new Promise((resolveListen, rejectListen) => {
    owner.once("error", rejectListen);
    owner.listen(ownerSocket, () => {
      owner.off("error", rejectListen);
      resolveListen();
    });
  });
  assert.equal(await service.isRuntimeOwnerQuiet(), false);
  await new Promise((resolveClose) => owner.close(resolveClose));
  assert.equal(await service.isRuntimeOwnerQuiet(), true);
  assert.equal(await service.probeReadiness(), true);
  assert.deepEqual(observedPaths.toSorted(), [
    "/recipe-planner/api/health",
    "/recipe-planner/api/workspace",
    "/recipe-planner/api/codex/threads",
  ].toSorted(), "readiness exercises every browser-mounted production path");

  const heldAgent = new Agent({ keepAlive: true });
  t.after(() => heldAgent.destroy());
  const heldConnection = await new Promise((resolveHeld, rejectHeld) => {
    const request = get(`http://127.0.0.1:${port}/api/health`, {
      agent: heldAgent,
    }, (response) => {
      response.resume();
      response.once("end", () => resolveHeld(request));
    });
    request.once("error", rejectHeld);
  });
  server.close();
  assert.ok(heldConnection);
  assert.equal(await service.probeReadiness(), false);
});

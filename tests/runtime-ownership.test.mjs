import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  acquireRuntimeOwnershipLease,
  assertInheritedRuntimeOwnershipLease,
  RuntimeOwnershipError,
} from "../scripts/support/runtime-ownership.mjs";

const OWNERSHIP_MODULE_URL = pathToFileURL(
  resolve("scripts/support/runtime-ownership.mjs"),
).href;

async function temporaryRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-owner-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitForReady(child) {
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ownership fixture did not become ready")),
      5_000,
    );
    timer.unref();
  });
  const [chunk] = await Promise.race([once(child.stdout, "data"), timeout]);
  assert.match(chunk.toString("utf8"), /ready/u);
}

async function waitForReadyPid(child) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    const timer = setTimeout(
      () => rejectReady(new Error("supervisor fixture did not report its authority")),
      5_000,
    );
    timer.unref();
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const match = /ready:(\d+)/u.exec(output);
      if (match === null) return;
      clearTimeout(timer);
      resolveReady(Number(match[1]));
    });
    child.once("error", rejectReady);
    child.once("close", (code, signal) => {
      if (!/ready:\d+/u.test(output)) {
        rejectReady(new Error(`supervisor fixture exited before ready (${code ?? signal})`));
      }
    });
  });
}

test("runtime ownership is exclusive and inheritance accepts only the exact live object", async (t) => {
  const root = await temporaryRoot(t);
  const socketPath = join(root, "run", "runtime-owner.sock");
  const lease = await acquireRuntimeOwnershipLease({ socketPath });
  t.after(() => lease.close().catch(() => undefined));

  const metadata = await stat(lease.socketPath);
  assert.equal(metadata.isSocket(), true);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.uid, process.getuid());
  assert.equal(
    await assertInheritedRuntimeOwnershipLease(lease, { socketPath }),
    lease,
  );
  const installedProjection = await import(
    `${OWNERSHIP_MODULE_URL}?projection=${Date.now()}`
  );
  assert.equal(
    await installedProjection.assertInheritedRuntimeOwnershipLease(
      lease,
      { socketPath },
    ),
    lease,
    "an operator copy and selected-app copy share only the exact in-memory object registry",
  );
  await assert.rejects(
    assertInheritedRuntimeOwnershipLease({
      socketPath,
      close: lease.close,
    }, { socketPath }),
    (error) =>
      error instanceof RuntimeOwnershipError &&
      error.code === "OWNER_LEASE_INVALID",
  );
  await assert.rejects(
    acquireRuntimeOwnershipLease({ socketPath, probeTimeoutMs: 250 }),
    (error) =>
      error instanceof RuntimeOwnershipError &&
      error.code === "OWNER_LIVE_OR_INDETERMINATE",
  );

  await lease.close();
  await assert.rejects(
    assertInheritedRuntimeOwnershipLease(lease, { socketPath }),
    (error) =>
      error instanceof RuntimeOwnershipError &&
      error.code === "OWNER_LEASE_INVALID",
  );
  const successor = await acquireRuntimeOwnershipLease({ socketPath });
  await successor.close();
  await assert.rejects(access(successor.socketPath));
});

test("a killed authority leaves only a stable-ECONNREFUSED socket recoverable", async (t) => {
  const root = await temporaryRoot(t);
  const socketPath = join(root, "run", "runtime-owner.sock");
  const fixture = `
    import { acquireRuntimeOwnershipLease } from ${JSON.stringify(OWNERSHIP_MODULE_URL)};
    const lease = await acquireRuntimeOwnershipLease({ socketPath: ${JSON.stringify(socketPath)} });
    console.log("ready");
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", fixture],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await waitForReady(child);

  await assert.rejects(
    acquireRuntimeOwnershipLease({ socketPath, probeTimeoutMs: 250 }),
    (error) =>
      error instanceof RuntimeOwnershipError &&
      error.code === "OWNER_LIVE_OR_INDETERMINATE",
    "a live authority remains exclusive across process boundaries",
  );

  child.kill("SIGKILL");
  await once(child, "close");
  assert.equal((await stat(socketPath)).isSocket(), true);

  const recovered = await acquireRuntimeOwnershipLease({
    socketPath,
    probeTimeoutMs: 500,
  });
  assert.equal((await stat(recovered.socketPath)).isSocket(), true);
  await recovered.close();
});

test("supervisor death cannot release a lease retained by its authority child", async (t) => {
  const root = await temporaryRoot(t);
  const socketPath = join(root, "run", "runtime-owner.sock");
  const authorityFixture = `
    import { acquireRuntimeOwnershipLease } from ${JSON.stringify(OWNERSHIP_MODULE_URL)};
    await acquireRuntimeOwnershipLease({ socketPath: ${JSON.stringify(socketPath)} });
    console.log("authority-ready");
    setInterval(() => {}, 60_000);
  `;
  const supervisorFixture = `
    import { spawn } from "node:child_process";
    const authority = spawn(process.execPath, [
      "--input-type=module", "--eval", ${JSON.stringify(authorityFixture)}
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    authority.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("authority-ready")) console.log("ready:" + authority.pid);
    });
    setInterval(() => {}, 60_000);
  `;
  const supervisor = spawn(
    process.execPath,
    ["--input-type=module", "--eval", supervisorFixture],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let authorityPid = null;
  t.after(() => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGKILL");
    }
    if (authorityPid !== null) {
      try {
        process.kill(authorityPid, "SIGKILL");
      } catch {
        // The authority already exited.
      }
    }
  });
  authorityPid = await waitForReadyPid(supervisor);

  supervisor.kill("SIGKILL");
  await once(supervisor, "close");
  assert.doesNotThrow(() => process.kill(authorityPid, 0));
  await assert.rejects(
    acquireRuntimeOwnershipLease({ socketPath, probeTimeoutMs: 250 }),
    (error) =>
      error instanceof RuntimeOwnershipError &&
      error.code === "OWNER_LIVE_OR_INDETERMINATE",
  );

  process.kill(authorityPid, "SIGKILL");
  let recovered = null;
  for (let attempt = 0; attempt < 40 && recovered === null; attempt += 1) {
    try {
      recovered = await acquireRuntimeOwnershipLease({
        socketPath,
        probeTimeoutMs: 250,
      });
    } catch (error) {
      if (
        !(error instanceof RuntimeOwnershipError) ||
        error.code !== "OWNER_LIVE_OR_INDETERMINATE"
      ) {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  assert.ok(recovered, "the killed authority must eventually leave a recoverable stale socket");
  await recovered.close();
});

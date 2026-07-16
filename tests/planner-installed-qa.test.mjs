import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoForbiddenInstalledAssetReferences,
  proveInstalledBoundaries,
  runInstalledPlannerQa,
} from "../scripts/support/planner-installed-qa.mjs";
import { acquireRuntimeOwnershipLease } from "../scripts/support/runtime-ownership.mjs";
import * as installedE2eRuntime from "./support/e2e-runtime.mjs";

async function fixture(t, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "app");
  const qaRoot = join(root, "qa");
  const candidateDataPath = join(root, "candidate.sqlite");
  await Promise.all([
    mkdir(join(appRoot, "dist", "client", "assets"), { recursive: true, mode: 0o700 }),
    mkdir(qaRoot, { mode: 0o700 }),
    writeFile(candidateDataPath, "fixture", { mode: 0o600 }),
  ]);
  return { root, appRoot, qaRoot, candidateDataPath };
}

test("installed browser asset scan rejects staging and baseline path leakage", async (t) => {
  const value = await fixture(t, "planner-installed-assets-");
  const asset = join(value.appRoot, "dist", "client", "assets", "chunk.js");
  const stagingRoot = join(value.root, "releases", "candidate-source");
  await writeFile(asset, `export const source = ${JSON.stringify(value.appRoot)};\n`);
  assert.equal(await assertNoForbiddenInstalledAssetReferences({
    canonicalAppRoot: value.appRoot,
    forbiddenRoots: [stagingRoot],
  }), true);

  await writeFile(asset, `export const source = ${JSON.stringify(stagingRoot)};\n`);
  await assert.rejects(
    assertNoForbiddenInstalledAssetReferences({
      canonicalAppRoot: value.appRoot,
      forbiddenRoots: [stagingRoot],
    }),
    /staging or baseline path/,
  );
});

test("installed boundary proof exercises the complete native task lifecycle across restart", {
  timeout: 60_000,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-installed-native-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataPath = join(root, "data");
  const udsPath = join(root, "uds");
  const markerPath = join(root, "markers");
  await Promise.all([
    mkdir(dataPath, { mode: 0o700 }),
    mkdir(udsPath, { mode: 0o700 }),
    mkdir(markerPath, { mode: 0o700 }),
  ]);
  const [dataDirectory, globalCodexParentDirectory, markerRoot] = await Promise.all([
    realpath(dataPath),
    realpath(udsPath),
    realpath(markerPath),
  ]);
  const runtimeOwnershipSocketPath = join(root, "runtime-owner.sock");
  const runtimeOwnershipLease = await acquireRuntimeOwnershipLease({
    socketPath: runtimeOwnershipSocketPath,
  });
  t.after(() => runtimeOwnershipLease.close());
  const webServer = createServer((_request, response) => response.writeHead(204).end());
  await new Promise((resolveListen, rejectListen) => {
    webServer.once("error", rejectListen);
    webServer.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => new Promise((resolveClose, rejectClose) => {
    webServer.close((error) => error ? rejectClose(error) : resolveClose());
  }));
  const webAddress = webServer.address();
  if (webAddress === null || typeof webAddress === "string") {
    throw new Error("Installed boundary fixture did not expose its web port.");
  }

  const projection = await proveInstalledBoundaries({
    appRoot: await realpath(new URL("../", import.meta.url)),
    dataDirectory,
    webOrigin: `http://127.0.0.1:${webAddress.port}`,
    publicPort: 0,
    runtimeOwnershipLease,
    runtimeOwnershipSocketPath,
    globalCodexParentDirectory,
    markerRoot,
    e2eRuntime: installedE2eRuntime,
  });

  for (const field of [
    "nativeThreadHttpReady",
    "nativeThreadCreateListSelect",
    "nativeThreadSendExactReplay",
    "nativeThreadChangedReplayRejected",
    "nativeThreadReadback",
    "nativeThreadActivityObserved",
    "nativeThreadWorkerReadback",
    "nativeThreadQuestionAnswered",
    "nativeThreadInterruptReadback",
    "nativeThreadArchiveHistory",
    "nativeThreadRestartReadback",
  ]) {
    assert.equal(projection[field], true, `${field} must be observed by installed QA`);
  }
});

test("installed QA binds the exact identity, cloned data, inherited lease, and path-safe projection", async (t) => {
  const value = await fixture(t, "planner-installed-orchestration-");
  const identity = Object.freeze({
    exists: true,
    kind: "directory",
    sha256: "a".repeat(64),
    fileCount: 12,
    totalBytes: 345,
  });
  const calls = [];
  const projection = await runInstalledPlannerQa({
    canonicalAppRoot: value.appRoot,
    candidateDataPath: value.candidateDataPath,
    qaRoot: value.qaRoot,
    expectedInstalledIdentity: identity,
    runtimeOwnershipLease: Object.freeze({ close() {} }),
    runtimeOwnershipSocketPath: join(value.root, "run", "runtime-owner.sock"),
    forbiddenAssetRoots: [join(value.root, "candidate-source")],
    activationId: "12345678-1234-4234-9234-123456789012",
    releaseEvidenceBinding: {
      activationId: "12345678-1234-4234-9234-123456789012",
      releaseCandidateEvidenceSchemaVersion: 2,
    },
  }, {
    inspectInstalledIdentity: async () => identity,
    assertAssets: async () => {
      calls.push("assets");
      return true;
    },
    createCandidateClone: async (_app, _source, destination) => {
      calls.push(["clone", destination]);
      return { sha256: "b".repeat(64), quickCheck: "ok" };
    },
    startFrozenWeb: async () => {
      calls.push("web-start");
      return {
        origin: "http://127.0.0.1:31001",
        async close() { calls.push("web-close"); },
      };
    },
    e2eRuntime: {},
    proveBoundaries: async (options) => {
      calls.push(["boundaries", options.runtimeOwnershipLease]);
      return { httpReady: true, globalUdsReady: true, restartReadback: true };
    },
    runBoundarySuites: async () => {
      calls.push("boundary-suites");
      return {
        http: true,
        nativeThreadService: true,
        legacyConversationCutover: true,
        fileCount: 3,
      };
    },
    runPlaywright: async () => {
      calls.push("playwright");
      return {
        mode: "installed-production",
        selectedCloneSha256: "1".repeat(64),
        selectedCloneBrowserReadback: true,
        freshDeterministicJourneys: {
          familyDinnerSpec: true,
          nativeCodexPreviewPresentationSpec: true,
        },
      };
    },
    createEvidenceManifest: async ({ evidenceRoot }) => {
      calls.push("evidence-manifest");
      return {
        manifestPath: join(evidenceRoot, "manifest.json"),
        sha256: "9".repeat(64),
        files: 96,
        bytes: 9_600,
        scenarioIds: ["d4", "d7"],
        viewportIds: ["mobile-320x844"],
        browserVersions: ["fixture-browser"],
        axeVersion: "4.10.3",
      };
    },
    environment: {},
  });

  assert.equal(projection.installedBeforeSha256, identity.sha256);
  assert.equal(projection.installedAfterSha256, identity.sha256);
  assert.equal(projection.clonedDataSha256, "b".repeat(64));
  assert.equal(projection.installedUnchanged, true);
  assert.equal(projection.browserAssetsPathSafe, true);
  assert.equal(projection.browser.selectedCloneBrowserReadback, true);
  assert.equal(projection.browser.selectedCloneSha256, "1".repeat(64));
  assert.deepEqual(projection.browser.freshDeterministicJourneys, {
    familyDinnerSpec: true,
    nativeCodexPreviewPresentationSpec: true,
  });
  assert.equal(projection.nativeCodexReleaseEvidenceSchemaVersion, 2);
  assert.deepEqual(projection.releaseEvidence, {
    relativePath: "installed-release/evidence/manifest.json",
    sha256: "9".repeat(64),
    files: 96,
    bytes: 9_600,
    scenarioIds: ["d4", "d7"],
    viewportIds: ["mobile-320x844"],
    browserVersions: ["fixture-browser"],
    axeVersion: "4.10.3",
  });
  assert.equal(calls.filter((entry) => entry === "assets").length, 2);
  assert.deepEqual(calls.filter((entry) => typeof entry === "string"), [
    "assets",
    "web-start",
    "boundary-suites",
    "playwright",
    "web-close",
    "assets",
    "evidence-manifest",
  ]);
  assert.equal(JSON.stringify(projection).includes(value.root), false);
});

test("installed QA closes its frozen web child when the canonical E2E import fails", async (t) => {
  const value = await fixture(t, "planner-installed-import-cleanup-");
  const identity = Object.freeze({
    exists: true,
    kind: "directory",
    sha256: "e".repeat(64),
  });
  let child;
  let origin;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveExit) => {
        child.once("exit", resolveExit);
        child.kill("SIGKILL");
      });
    }
  });
  await assert.rejects(
    runInstalledPlannerQa({
      canonicalAppRoot: value.appRoot,
      candidateDataPath: value.candidateDataPath,
      qaRoot: value.qaRoot,
      expectedInstalledIdentity: identity,
      runtimeOwnershipLease: Object.freeze({}),
      runtimeOwnershipSocketPath: join(value.root, "run", "runtime-owner.sock"),
    }, {
      inspectInstalledIdentity: async () => identity,
      assertAssets: async () => true,
      createCandidateClone: async () => ({
        sha256: "f".repeat(64),
        quickCheck: "ok",
      }),
      startFrozenWeb: async () => {
        child = spawn(process.execPath, ["-e", [
          "process.send({ ready: true });",
          "const keepAlive = setInterval(() => undefined, 1000);",
          "process.on('SIGTERM', () => { clearInterval(keepAlive); process.exit(0); });",
        ].join("\n")], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        await new Promise((resolveReady, rejectReady) => {
          const timer = setTimeout(() => rejectReady(new Error("fixture child timed out")), 5_000);
          child.once("message", () => {
            clearTimeout(timer);
            resolveReady();
          });
          child.once("error", rejectReady);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            rejectReady(new Error(`fixture child exited before ready (${signal ?? code})`));
          });
        });
        // The import fails before the controller can use this origin. This
        // fixture proves child cleanup without requiring an unrelated socket.
        origin = "http://127.0.0.1:1";
        return {
          origin,
          async close() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise((resolveExit) => {
              child.once("exit", resolveExit);
              child.kill("SIGTERM");
            });
          },
        };
      },
      loadE2eRuntime: async () => {
        throw new Error("fixture canonical import failed");
      },
      environment: {},
    }),
    /fixture canonical import failed/,
  );
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(
    fetch(origin, { signal: AbortSignal.timeout(500) }),
  );
});

test("installed QA fails before listeners when installed.json identity drifted", async (t) => {
  const value = await fixture(t, "planner-installed-drift-");
  await assert.rejects(
    runInstalledPlannerQa({
      canonicalAppRoot: value.appRoot,
      candidateDataPath: value.candidateDataPath,
      qaRoot: value.qaRoot,
      expectedInstalledIdentity: {
        exists: true,
        kind: "directory",
        sha256: "c".repeat(64),
      },
      runtimeOwnershipLease: Object.freeze({}),
      runtimeOwnershipSocketPath: join(value.root, "run", "runtime-owner.sock"),
    }, {
      inspectInstalledIdentity: async () => ({
        exists: true,
        kind: "directory",
        sha256: "d".repeat(64),
      }),
    }),
    /differs from installed\.json/,
  );
});

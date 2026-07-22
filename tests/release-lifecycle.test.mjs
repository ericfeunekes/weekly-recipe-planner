import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProductionReleaseLifecycle,
  ReleaseCleanupIncompleteError,
} from "../scripts/support/production-release.mjs";
import { acquireRuntimeOwnershipLease } from "../scripts/support/runtime-ownership.mjs";

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), "planner-release-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "meal-planner");
  const paths = {
    deployRoot: root, app: join(root, "app"), previous: join(root, "app.previous"),
    staging: join(root, ".app-staging"), retiring: join(root, ".app-retiring"),
    legacyBackups: join(root, "backups"),
    leaseSocket: join(root, ".release-owner", "release-owner.sock"), data: join(root, "data", "planner.sqlite"),
  };
  await mkdir(paths.data.slice(0, paths.data.lastIndexOf("/")), { recursive: true });
  await writeFile(paths.data, "sqlite-sentinel");
  await mkdir(paths.app, { recursive: true });
  await writeFile(join(paths.app, "release"), "current");
  let isReady = options.ready ?? true;
  let bootstrapCount = 0;
  const calls = [];
  const service = {
    async quiesce() {
      calls.push("quiesce");
      if (options.quiesce) return options.quiesce();
      return options.fence ?? { unloaded: true, portQuiet: true };
    },
    async bootstrap() {
      calls.push("bootstrap");
      const readiness = options.bootstrapReady;
      isReady = Array.isArray(readiness)
        ? readiness[bootstrapCount] ?? readiness.at(-1)
        : readiness ?? true;
      bootstrapCount += 1;
      await options.afterBootstrap?.(bootstrapCount);
    },
    async ready() { calls.push("ready"); return isReady; },
  };
  const lifecycle = createProductionReleaseLifecycle({
    paths, service, acquireLease: acquireRuntimeOwnershipLease,
    prepareCandidate: async () => {
      calls.push("prepare");
      if (options.prepareFails) throw new Error("candidate failed");
      await mkdir(paths.staging, { recursive: true });
      await writeFile(join(paths.staging, "release"), "candidate");
    },
    compatibilityPreflight: async () => {
      calls.push("compatibility");
      if (options.compatibilityFails) throw new Error("schema mismatch");
    },
    reconcile: async () => calls.push("reconcile"),
    cleanupLegacyResidue: options.cleanupLegacyResidue,
    filesystem: options.filesystem,
  });
  return { paths, lifecycle, calls, setReady(value) { isReady = value; } };
}

async function release(paths, slot) { return readFile(join(paths[slot], "release"), "utf8"); }
async function sqlite(paths) { return readFile(paths.data, "utf8"); }

test("promotion selects only the candidate app and retains its immediate predecessor without moving SQLite", async (t) => {
  const { paths, lifecycle, calls } = await fixture(t);
  await lifecycle.promote();
  assert.equal(await release(paths, "app"), "candidate");
  assert.equal(await release(paths, "previous"), "current");
  assert.equal(await sqlite(paths), "sqlite-sentinel");
  assert.deepEqual(calls, ["prepare", "compatibility", "quiesce", "reconcile", "bootstrap", "ready"]);
});

test("preflight failure cleans only staging before service disturbance", async (t) => {
  const { paths, lifecycle, calls } = await fixture(t, { compatibilityFails: true });
  await assert.rejects(lifecycle.promote(), /schema mismatch/u);
  assert.equal(await release(paths, "app"), "current");
  await assert.rejects(readFile(join(paths.staging, "release")));
  assert.deepEqual(calls, ["prepare", "compatibility"]);
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("a non-quiescent old service leaves slots unchanged and restores its ready selected app", async (t) => {
  const { paths, lifecycle, calls } = await fixture(t, { fence: { unloaded: false, portQuiet: true } });
  await assert.rejects(lifecycle.promote(), /did not become quiescent/u);
  assert.equal(await release(paths, "app"), "current");
  assert.deepEqual(calls, ["prepare", "compatibility", "quiesce", "ready"]);
});

test("candidate bootstrap failure restores previous app and retires the failed candidate", async (t) => {
  const { paths, lifecycle, calls } = await fixture(t, { bootstrapReady: [false, true] });
  await assert.rejects(lifecycle.promote(), /did not become ready/u);
  assert.equal(await release(paths, "app"), "current");
  await assert.rejects(readFile(join(paths.retiring, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
  assert.equal(calls.filter((call) => call === "bootstrap").length, 2);
});

test("a failed candidate-selection rename restores app.previous without selecting staging", async (t) => {
  let paths;
  const { lifecycle } = await fixture(t, {
    filesystem: {
      async rename(from, to) {
        if (from === paths.staging && to === paths.app) throw new Error("rename candidate failed");
        return rename(from, to);
      },
    },
  });
  paths = lifecycle.paths;
  await assert.rejects(lifecycle.promote(), /rename candidate failed/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("promotion refuses a meaningful retiring slot until recovery interprets it", async (t) => {
  const { paths, lifecycle, calls } = await fixture(t);
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "older");
  await rename(paths.previous, paths.retiring);
  await assert.rejects(lifecycle.promote(), /requires make recover/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "retiring"), "older");
  assert.deepEqual(calls, []);
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("recovery reverses interrupted fallback by restoring the displaced current app", async (t) => {
  const { paths, lifecycle, setReady } = await fixture(t);
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "fallback");
  await rename(paths.app, paths.retiring);
  setReady(false);
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "fallback");
  await assert.rejects(readFile(join(paths.retiring, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("recovery restarts an unready sole app without deleting or replacing its bytes", async (t) => {
  const { paths, lifecycle, setReady } = await fixture(t);
  setReady(false);
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "current");
  await assert.rejects(readFile(join(paths.previous, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("recovery restores the unready current app if app.previous cannot be selected", async (t) => {
  let paths;
  const { lifecycle, setReady } = await fixture(t, {
    bootstrapReady: [false, true],
    filesystem: {
      async rename(from, to) {
        if (from === paths.previous && to === paths.app) throw new Error("previous selection failed");
        return rename(from, to);
      },
    },
  });
  paths = lifecycle.paths;
  await cp(paths.app, paths.previous, { recursive: true });
  setReady(false);
  await assert.rejects(lifecycle.recover(), /previous selection failed/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "current");
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("ready recovery is idempotent but reports bounded cleanup residue nonzero, then succeeds when cleanup is retried", async (t) => {
  let failCleanup = true;
  const { paths, lifecycle } = await fixture(t, {
    filesystem: {
      async remove(path) {
        if (path.endsWith(".app-staging") && failCleanup) throw new Error("disk full");
        return rm(path, { recursive: true, force: true });
      },
    },
  });
  await mkdir(paths.staging, { recursive: true });
  await writeFile(join(paths.staging, "release"), "old");
  await assert.rejects(lifecycle.recover(), (error) => error instanceof ReleaseCleanupIncompleteError && error.path === paths.staging);
  assert.equal(await release(paths, "app"), "current");
  failCleanup = false;
  await lifecycle.recover();
  await assert.rejects(readFile(join(paths.staging, "release")));
});

test("legacy backup cleanup runs only after candidate readiness, preserves the candidate on failure, and recovery retries it", async (t) => {
  let failCleanup = true;
  const { paths, lifecycle, calls } = await fixture(t, {
    cleanupLegacyResidue: async (releasePaths) => {
      calls.push("legacy-cleanup");
      assert.equal(releasePaths.legacyBackups, paths.legacyBackups);
      if (failCleanup) throw new Error("legacy cleanup blocked");
    },
  });
  await assert.rejects(
    lifecycle.promote(),
    (error) => error instanceof ReleaseCleanupIncompleteError && error.path === paths.legacyBackups,
  );
  assert.equal(await release(paths, "app"), "candidate");
  assert.equal(await release(paths, "previous"), "current");
  assert.equal(await sqlite(paths), "sqlite-sentinel");
  assert.equal(calls.at(-1), "legacy-cleanup");
  failCleanup = false;
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "candidate");
  assert.equal(calls.filter((call) => call === "legacy-cleanup").length, 2);
});

test("a concurrent lease loser performs no candidate, service, or slot work", async (t) => {
  const { paths, lifecycle, calls } = await fixture(t);
  const owner = await acquireRuntimeOwnershipLease({ socketPath: paths.leaseSocket });
  t.after(() => owner.close().catch(() => undefined));
  await assert.rejects(lifecycle.promote(), /owns the runtime writer lease/u);
  assert.deepEqual(calls, []);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("candidate readiness failure restores current and retains the older previous until the candidate is known good", async (t) => {
  const { paths, lifecycle } = await fixture(t, { bootstrapReady: [false, true] });
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "older");
  await assert.rejects(lifecycle.promote(), /did not become ready/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "older");
  await assert.rejects(readFile(join(paths.staging, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("first promotion rename failure restores both fixed slots and removes only failed staging", async (t) => {
  let paths;
  const { lifecycle } = await fixture(t, {
    filesystem: {
      async rename(from, to) {
        if (from === paths.previous && to === paths.retiring) throw new Error("first rename failed");
        return rename(from, to);
      },
    },
  });
  paths = lifecycle.paths;
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "older");
  await assert.rejects(lifecycle.promote(), /first rename failed/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "older");
  await assert.rejects(readFile(join(paths.staging, "release")));
});

test("second promotion rename failure restores both fixed slots and removes only failed staging", async (t) => {
  let paths;
  const { lifecycle } = await fixture(t, {
    filesystem: {
      async rename(from, to) {
        if (from === paths.app && to === paths.previous) throw new Error("second rename failed");
        return rename(from, to);
      },
    },
  });
  paths = lifecycle.paths;
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "older");
  await assert.rejects(lifecycle.promote(), /second rename failed/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "older");
  await assert.rejects(readFile(join(paths.staging, "release")));
});

test("fallback readiness failure reverses back to the former current while preserving slot bytes", async (t) => {
  const { paths, lifecycle, setReady } = await fixture(t, { bootstrapReady: [false, false, true] });
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "fallback");
  setReady(false);
  await assert.rejects(lifecycle.recover(), /did not become ready/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "fallback");
  await assert.rejects(readFile(join(paths.retiring, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("fallback readiness reversal stops a live unready fallback before renaming its slot", async (t) => {
  let fallbackProcess;
  let quiesceCount = 0;
  let paths;
  const { lifecycle, setReady } = await fixture(t, {
    bootstrapReady: [false, false, true],
    async afterBootstrap(count) {
      if (count === 2) {
        fallbackProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
        await once(fallbackProcess, "spawn");
      }
    },
    async quiesce() {
      quiesceCount += 1;
      if (quiesceCount === 3 && fallbackProcess?.exitCode === null && fallbackProcess?.signalCode === null) {
        fallbackProcess.kill("SIGTERM");
        await once(fallbackProcess, "exit");
      }
      return { unloaded: true, portQuiet: true };
    },
    filesystem: {
      async rename(from, to) {
        if (from === paths.app && to === paths.previous) {
          assert.ok(
            fallbackProcess?.exitCode !== null || fallbackProcess?.signalCode !== null,
            "fallback process must exit before its slot is renamed",
          );
        }
        return rename(from, to);
      },
    },
  });
  paths = lifecycle.paths;
  t.after(() => fallbackProcess?.kill("SIGKILL"));
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "fallback");
  setReady(false);

  await assert.rejects(lifecycle.recover(), /did not become ready/u);
  assert.equal(quiesceCount, 3);
  assert.ok(fallbackProcess.exitCode !== null || fallbackProcess.signalCode !== null);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "fallback");
});

test("fallback first-rename failure restarts current without disturbing either fixed slot", async (t) => {
  let paths;
  const { lifecycle, setReady } = await fixture(t, {
    bootstrapReady: [false, true],
    filesystem: {
      async rename(from, to) {
        if (from === paths.app && to === paths.retiring) throw new Error("fallback first rename failed");
        return rename(from, to);
      },
    },
  });
  paths = lifecycle.paths;
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "fallback");
  setReady(false);
  await assert.rejects(lifecycle.recover(), /fallback first rename failed/u);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "fallback");
  await assert.rejects(readFile(join(paths.retiring, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("fallback post-readiness slot cleanup preserves the ready fallback and recovery converges it", async (t) => {
  let failSlotCleanup = true;
  let paths;
  const { lifecycle, setReady } = await fixture(t, {
    bootstrapReady: [false, true],
    filesystem: {
      async rename(from, to) {
        if (failSlotCleanup && from === paths.retiring && to === paths.previous) throw new Error("fallback slot cleanup failed");
        return rename(from, to);
      },
    },
  });
  paths = lifecycle.paths;
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "fallback");
  setReady(false);
  await assert.rejects(lifecycle.recover(), (error) => error instanceof ReleaseCleanupIncompleteError && error.path === paths.retiring);
  assert.equal(await release(paths, "app"), "fallback");
  assert.equal(await release(paths, "retiring"), "current");
  failSlotCleanup = false;
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "fallback");
  assert.equal(await release(paths, "previous"), "current");
  await assert.rejects(readFile(join(paths.retiring, "release")));
});

test("independently failed fallback and restored current preserve fixed bytes and return an aggregate error", async (t) => {
  const { paths, lifecycle, setReady } = await fixture(t, { bootstrapReady: [false, false, false] });
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "fallback");
  setReady(false);
  await assert.rejects(lifecycle.recover(), (error) => error instanceof AggregateError && error.errors.length === 3);
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "fallback");
  await assert.rejects(readFile(join(paths.retiring, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("recovery normalizes app plus staging plus retiring before removing failed staging", async (t) => {
  const { paths, lifecycle } = await fixture(t);
  await mkdir(paths.staging, { recursive: true });
  await writeFile(join(paths.staging, "release"), "failed-candidate");
  await mkdir(paths.retiring, { recursive: true });
  await writeFile(join(paths.retiring, "release"), "older");
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "older");
  await assert.rejects(readFile(join(paths.staging, "release")));
  await assert.rejects(readFile(join(paths.retiring, "release")));
});

test("recovery normalizes an interrupted candidate selection with app absent before readiness", async (t) => {
  const { paths, lifecycle, setReady } = await fixture(t);
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "current");
  await rm(paths.app, { recursive: true });
  await mkdir(paths.staging, { recursive: true });
  await writeFile(join(paths.staging, "release"), "candidate");
  await mkdir(paths.retiring, { recursive: true });
  await writeFile(join(paths.retiring, "release"), "older");
  setReady(false);
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "older");
  await assert.rejects(readFile(join(paths.staging, "release")));
  await assert.rejects(readFile(join(paths.retiring, "release")));
});

test("recovery reverses a completed unready candidate selection while retaining the older fixed previous slot", async (t) => {
  const { paths, lifecycle, setReady } = await fixture(t);
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "current");
  await writeFile(join(paths.app, "release"), "candidate");
  await mkdir(paths.retiring, { recursive: true });
  await writeFile(join(paths.retiring, "release"), "older");
  setReady(false);
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "current");
  assert.equal(await release(paths, "previous"), "older");
  await assert.rejects(readFile(join(paths.staging, "release")));
  await assert.rejects(readFile(join(paths.retiring, "release")));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

test("recovery keeps a ready completed candidate selection and cleans only retiring residue", async (t) => {
  const { paths, lifecycle, calls } = await fixture(t);
  await mkdir(paths.previous, { recursive: true });
  await writeFile(join(paths.previous, "release"), "current");
  await writeFile(join(paths.app, "release"), "candidate");
  await mkdir(paths.retiring, { recursive: true });
  await writeFile(join(paths.retiring, "release"), "older");
  await lifecycle.recover();
  assert.equal(await release(paths, "app"), "candidate");
  assert.equal(await release(paths, "previous"), "current");
  await assert.rejects(readFile(join(paths.retiring, "release")));
  assert.ok(!calls.includes("bootstrap"));
  assert.equal(await sqlite(paths), "sqlite-sentinel");
});

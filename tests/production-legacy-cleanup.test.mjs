import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupLegacyApplicationBackups,
  LegacyApplicationCleanupError,
} from "../scripts/support/production-legacy-cleanup.mjs";
import { productionReleasePaths } from "../scripts/support/production-release.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "planner-legacy-cleanup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = productionReleasePaths(home);
  await mkdir(join(paths.legacyBackups, "release-1", "app"), { recursive: true });
  await writeFile(join(paths.legacyBackups, "release-1", "app", "sentinel"), "old app");
  await mkdir(join(paths.deployRoot, "data"), { recursive: true });
  await writeFile(paths.data, "sqlite-sentinel");
  return paths;
}

test("legacy cleanup removes only enumerated app payloads and leaves SQLite unchanged", async (t) => {
  const paths = await fixture(t);
  await cleanupLegacyApplicationBackups(paths);
  await assert.rejects(readFile(join(paths.legacyBackups, "release-1", "app", "sentinel")));
  assert.equal(await readFile(paths.data, "utf8"), "sqlite-sentinel");
});

test("legacy cleanup refuses unexpected retained state without broad deletion", async (t) => {
  const paths = await fixture(t);
  const unexpected = join(paths.legacyBackups, "unexpected.txt");
  await writeFile(unexpected, "preserve");
  await assert.rejects(
    cleanupLegacyApplicationBackups(paths),
    (error) => error instanceof LegacyApplicationCleanupError && error.path === unexpected,
  );
  assert.equal(await readFile(unexpected, "utf8"), "preserve");
  assert.equal(await readFile(paths.data, "utf8"), "sqlite-sentinel");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { openPlannerStore } from "../server/store/sqlite-store.ts";

export const INGREDIENT_OCCURRENCE_PREDECESSOR =
  "7209a334ef5803396605e6042676f4a2d354fa90";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function requireSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stderr || result.stdout}`,
  );
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function inventory(directory) {
  return readdirSync(directory).sort().map((name) => {
    const filename = join(directory, name);
    return {
      name,
      size: statSync(filename).size,
      sha256: sha256(filename),
    };
  });
}

export function probeIngredientOccurrencePredecessor({ repository = resolve(".") } = {}) {
  const repositoryRoot = realpathSync(repository);
  const scratchRoot = join(repositoryRoot, ".scratch");
  const scratchRootExisted = existsSync(scratchRoot);
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, "occurrence-predecessor-"));
  try {
    const resolvedCommit = run("git", ["rev-parse", `${INGREDIENT_OCCURRENCE_PREDECESSOR}^{commit}`], {
      cwd: repositoryRoot,
    });
    requireSuccess(resolvedCommit, "predecessor commit lookup");
    assert.equal(resolvedCommit.stdout.trim(), INGREDIENT_OCCURRENCE_PREDECESSOR);

    const fixtureDirectory = join(directory, "fixture");
    const predecessorDirectory = join(directory, "predecessor");
    mkdirSync(fixtureDirectory);
    mkdirSync(predecessorDirectory);
    const database = join(fixtureDirectory, "candidate-schema10.sqlite");
    const backup = join(fixtureDirectory, "predecessor-backup.sqlite");
    openPlannerStore({ filename: database }).close();
    const beforeHash = sha256(database);
    const beforeInventory = inventory(fixtureDirectory);

    const archive = join(directory, "predecessor.tar");
    const archived = run(
      "git",
      ["archive", "--format=tar", `--output=${archive}`, INGREDIENT_OCCURRENCE_PREDECESSOR],
      { cwd: repositoryRoot },
    );
    requireSuccess(archived, "predecessor archive");
    const extracted = run("tar", ["-xf", archive, "-C", predecessorDirectory]);
    requireSuccess(extracted, "predecessor archive extraction");
    symlinkSync(join(repositoryRoot, "node_modules"), join(predecessorDirectory, "node_modules"), "dir");

    const predecessor = run(
      "npm",
      ["--silent", "run", "planner:migrate-v8-v9", "--", "--database", database, "--backup", backup],
      { cwd: predecessorDirectory },
    );
    assert.notEqual(predecessor.status, 0, "the predecessor migrator must reject a schema-10 candidate");
    assert.match(
      `${predecessor.stdout}\n${predecessor.stderr}`,
      /contiguous v1 through v8 migration ledger/i,
    );
    assert.equal(sha256(database), beforeHash, "the predecessor must not mutate the schema-10 candidate");
    assert.deepEqual(
      inventory(fixtureDirectory),
      beforeInventory,
      "the predecessor must not create a backup, WAL, SHM, or other sidecar",
    );
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(`${database}-wal`), false);
    assert.equal(existsSync(`${database}-shm`), false);

    return Object.freeze({
      predecessorCommit: INGREDIENT_OCCURRENCE_PREDECESSOR,
      predecessorExitStatus: predecessor.status,
      databaseSha256: beforeHash,
      artifactInventory: beforeInventory,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (!scratchRootExisted) {
      try {
        rmdirSync(scratchRoot);
      } catch {
        // Another concurrent task may have begun using the shared scratch root.
      }
    }
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  process.stdout.write(`${JSON.stringify(probeIngredientOccurrencePredecessor())}\n`);
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { basename, join, resolve } from "node:path";

export const CANONICAL_IMPORT_PREDECESSOR =
  "1dbe2685349b71e584c19742896d1c48048efc2f";

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr || result.stdout}`);
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function inventory(directory) {
  return readdirSync(directory).sort().map((name) => {
    const filename = join(directory, name);
    return { name, size: statSync(filename).size, sha256: sha256(filename) };
  });
}

function withPredecessorCheckout(repository, callback) {
  const repositoryRoot = realpathSync(repository);
  const scratchRoot = join(repositoryRoot, ".scratch");
  const scratchRootExisted = existsSync(scratchRoot);
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, "canonical-import-predecessor-"));
  try {
    const resolvedCommit = run("git", ["rev-parse", `${CANONICAL_IMPORT_PREDECESSOR}^{commit}`], {
      cwd: repositoryRoot,
    });
    requireSuccess(resolvedCommit, "predecessor commit lookup");
    assert.equal(resolvedCommit.stdout.trim(), CANONICAL_IMPORT_PREDECESSOR);
    const predecessorDirectory = join(directory, "predecessor");
    mkdirSync(predecessorDirectory);
    const archive = join(directory, "predecessor.tar");
    requireSuccess(run(
      "git",
      ["archive", "--format=tar", `--output=${archive}`, CANONICAL_IMPORT_PREDECESSOR],
      { cwd: repositoryRoot },
    ), "predecessor archive");
    requireSuccess(run("tar", ["-xf", archive, "-C", predecessorDirectory]), "predecessor archive extraction");
    symlinkSync(join(repositoryRoot, "node_modules"), join(predecessorDirectory, "node_modules"), "dir");
    return callback({ directory, predecessorDirectory });
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

function runPredecessorStoreOpen(predecessorDirectory, database) {
  return run(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      "import('./server/store/sqlite-store.ts').then(({openPlannerStore}) => openPlannerStore({filename: process.argv[1]}).close())",
      database,
    ],
    { cwd: predecessorDirectory },
  );
}

export function migrateWithCanonicalImportPredecessor({
  candidateDatabase,
  repository = resolve("."),
}) {
  return withPredecessorCheckout(repository, ({ predecessorDirectory }) => {
    const predecessor = runPredecessorStoreOpen(predecessorDirectory, candidateDatabase);
    requireSuccess(predecessor, "schema-11 predecessor migration");
    return Object.freeze({ predecessorCommit: CANONICAL_IMPORT_PREDECESSOR });
  });
}

export function probeCanonicalImportPredecessor({
  candidateDatabase,
  repository = resolve("."),
}) {
  return withPredecessorCheckout(repository, ({ directory, predecessorDirectory }) => {
    const fixtureDirectory = join(directory, "fixture");
    mkdirSync(fixtureDirectory);
    const database = join(fixtureDirectory, basename(candidateDatabase));
    copyFileSync(candidateDatabase, database);
    const beforeHash = sha256(database);
    const beforeInventory = inventory(fixtureDirectory);

    const predecessor = runPredecessorStoreOpen(predecessorDirectory, database);
    assert.notEqual(predecessor.status, 0, "the schema-11 predecessor must reject a schema-12 candidate");
    assert.match(`${predecessor.stdout}\n${predecessor.stderr}`, /schema 12 is newer than supported schema 11/iu);
    assert.equal(sha256(database), beforeHash, "the predecessor must not mutate the schema-12 candidate");
    assert.deepEqual(
      inventory(fixtureDirectory),
      beforeInventory,
      "the predecessor must not create a backup, WAL, SHM, or other sidecar",
    );

    return Object.freeze({
      predecessorCommit: CANONICAL_IMPORT_PREDECESSOR,
      predecessorExitStatus: predecessor.status,
      databaseSha256: beforeHash,
      artifactInventory: beforeInventory,
    });
  });
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexResourceLimitError,
  inventoryBoundedTree,
  readBoundedFile,
} from "../server/runtime/codex-follow-up/resource-policy.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "planner-codex-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("bounded file reads and tree inventory fail instead of truncating", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "a"), "1234");
  await writeFile(join(root, "b"), "5678");
  await assert.rejects(
    readBoundedFile(join(root, "a"), 3, "fixture"),
    (error) => error instanceof CodexResourceLimitError,
  );
  await assert.rejects(
    inventoryBoundedTree(root, { maxFiles: 1, maxEntries: 4, maxDepth: 1 }, "fixture"),
    /file-count budget/,
  );
  await assert.rejects(
    inventoryBoundedTree(root, { maxFiles: 4, maxEntries: 1, maxDepth: 1 }, "fixture"),
    /directory-entry budget/,
  );
  await assert.rejects(
    inventoryBoundedTree(root, {
      maxFiles: 4,
      maxEntries: 4,
      maxDepth: 1,
      maxFileBytes: 3,
      maxTotalBytes: 16,
    }, "fixture"),
    /file above its byte budget/,
  );
});

test("tree inventory rejects schema symlinks and records runtime symlinks without following", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, "secret"), "do-not-follow");
  await symlink(outside, join(root, "linked"));
  await assert.rejects(
    inventoryBoundedTree(root, { maxFiles: 4, maxEntries: 4, maxDepth: 1 }, "schema"),
    /symbolic link/,
  );
  const inventory = await inventoryBoundedTree(root, {
    maxFiles: 4,
    maxEntries: 4,
    maxDepth: 1,
    allowSymlinks: true,
  }, "runtime");
  assert.deepEqual(inventory.files.map((file) => file.relativePath), ["linked@symlink"]);
});

test("tree inventory enforces directory depth and aggregate bytes", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "one", "two"), { recursive: true });
  await writeFile(join(root, "one", "two", "value"), "1234");
  await assert.rejects(
    inventoryBoundedTree(root, { maxFiles: 4, maxEntries: 8, maxDepth: 1 }, "fixture"),
    /directory-depth budget/,
  );
  await assert.rejects(
    inventoryBoundedTree(root, {
      maxFiles: 4,
      maxEntries: 8,
      maxDepth: 4,
      maxFileBytes: 8,
      maxTotalBytes: 3,
    }, "fixture"),
    /aggregate byte budget/,
  );
});

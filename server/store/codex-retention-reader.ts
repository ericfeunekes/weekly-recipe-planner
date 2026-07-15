import { DatabaseSync } from "node:sqlite";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RETENTION_TABLES = Object.freeze([
  "threads",
  "thread_dynamic_tools",
  "agent_jobs",
  "agent_job_items",
  "logs",
]);

/** Read-only, content-free metadata projection for the private Codex home. */
type SourceFileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
} | null;

async function sourceFileIdentity(path: string): Promise<SourceFileIdentity> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("A Codex retention database source is not a regular file.");
    }
    return {
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      modified: metadata.mtimeNs,
      changed: metadata.ctimeNs,
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sameSourceIdentity(left: SourceFileIdentity, right: SourceFileIdentity) {
  if (left === null || right === null) return left === right;
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modified === right.modified && left.changed === right.changed;
}

export async function inspectCodexRetentionDatabase(
  path: string,
  pathSha256: string,
  databaseClass: "state_sqlite" | "log_sqlite",
) {
  const sourcePaths = [path, `${path}-wal`, `${path}-shm`];
  const before = await Promise.all(sourcePaths.map(sourceFileIdentity));
  if (before[0] === null) throw new Error("A Codex retention database disappeared before inspection.");
  const root = await mkdtemp(join(tmpdir(), "planner-codex-retention-"));
  const copyPath = join(root, "database.sqlite");
  try {
    await copyFile(path, copyPath);
    for (const [index, suffix] of [[1, "-wal"], [2, "-shm"]] as const) {
      if (before[index] !== null) await copyFile(sourcePaths[index], `${copyPath}${suffix}`);
    }
    const after = await Promise.all(sourcePaths.map(sourceFileIdentity));
    if (before.some((identity, index) => !sameSourceIdentity(identity, after[index]))) {
      throw new Error("A Codex retention database changed while its immutable copy was created.");
    }

    const database = new DatabaseSync(copyPath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only = ON");
      const tables = new Set(
        (database.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table'",
        ).all() as Array<{ name: string }>).map((row) => row.name),
      );
      const counts: Record<string, number> = {};
      for (const table of RETENTION_TABLES) {
        if (!tables.has(table)) continue;
        counts[table] = Number(
          (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
            .count,
        );
      }
      return Object.freeze({
        pathSha256,
        class: databaseClass,
        counts: Object.freeze(counts),
      });
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

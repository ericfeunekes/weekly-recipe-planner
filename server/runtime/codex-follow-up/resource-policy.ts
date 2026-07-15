import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const CODEX_FOLLOW_UP_RESOURCE_POLICY = Object.freeze({
  executableBytes: 512 * 1024 * 1024,
  retainedExecutableSnapshots: 3,
  schema: Object.freeze({
    maxFiles: 512,
    maxEntries: 2_048,
    maxDepth: 4,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxCacheEntries: 128,
    retainedBundles: 3,
  }),
  provenance: Object.freeze({
    maxSources: 16,
    maxFileBytes: 2 * 1024 * 1024,
  }),
  evidenceBytes: 2 * 1024 * 1024,
  runtimeInventory: Object.freeze({
    maxFiles: 2_048,
    maxEntries: 8_192,
    maxDepth: 8,
    allowSymlinks: true,
  }),
  pagination: Object.freeze({ maxPages: 16, maxRows: 1_024 }),
  rpcIngress: Object.freeze({
    maxFrameBytes: 4 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    maxFrames: 2_048,
    maxQueuedMessages: 256,
    maxObservedMethods: 1_024,
    maxStderrBytes: 64 * 1024,
  }),
  providerIngress: Object.freeze({
    maxRequestBytes: 4 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxRequests: 8,
  }),
});

export class CodexResourceLimitError extends Error {
  readonly code = "RESOURCE_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "CodexResourceLimitError";
  }
}

export type BoundedTreeFile = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
  readonly kind: "file" | "symlink";
};

export async function readBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new CodexResourceLimitError(`${label} must be a regular file.`);
  if (metadata.size > maxBytes) {
    throw new CodexResourceLimitError(`${label} exceeds its byte budget.`);
  }
  const value = await readFile(path);
  if (value.byteLength > maxBytes) {
    throw new CodexResourceLimitError(`${label} exceeds its byte budget.`);
  }
  return value;
}

export async function sha256BoundedFile(
  path: string,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new CodexResourceLimitError(`${label} must be a regular file.`);
  if (metadata.size > maxBytes) {
    throw new CodexResourceLimitError(`${label} exceeds its byte budget.`);
  }
  const hash = createHash("sha256");
  let consumed = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    consumed += chunk.length;
    if (consumed > maxBytes) {
      throw new CodexResourceLimitError(`${label} exceeds its byte budget.`);
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function inventoryBoundedTree(
  root: string,
  limits: {
    readonly maxFiles: number;
    readonly maxEntries: number;
    readonly maxDepth: number;
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
    readonly allowSymlinks?: boolean;
  },
  label: string,
) {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new CodexResourceLimitError(`${label} root must be a real directory.`);
  }
  const files: BoundedTreeFile[] = [];
  let entriesSeen = 0;
  let totalBytes = 0;

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) {
      throw new CodexResourceLimitError(`${label} exceeds its directory-depth budget.`);
    }
    const entries = await opendir(directory);
    for await (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > limits.maxEntries) {
        throw new CodexResourceLimitError(`${label} exceeds its directory-entry budget.`);
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (!limits.allowSymlinks) {
          throw new CodexResourceLimitError(`${label} contains a symbolic link.`);
        }
        const metadata = await lstat(path);
        totalBytes += metadata.size;
        files.push({
          absolutePath: path,
          relativePath: `${relative(root, path).split(sep).join("/")}@symlink`,
          size: metadata.size,
          kind: "symlink",
        });
        if (files.length > limits.maxFiles) {
          throw new CodexResourceLimitError(`${label} exceeds its file-count budget.`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new CodexResourceLimitError(`${label} contains an unsupported filesystem entry.`);
      }
      const metadata = await stat(path);
      if (!metadata.isFile()) {
        throw new CodexResourceLimitError(`${label} contains a non-regular file.`);
      }
      if (limits.maxFileBytes !== undefined && metadata.size > limits.maxFileBytes) {
        throw new CodexResourceLimitError(`${label} contains a file above its byte budget.`);
      }
      totalBytes += metadata.size;
      if (limits.maxTotalBytes !== undefined && totalBytes > limits.maxTotalBytes) {
        throw new CodexResourceLimitError(`${label} exceeds its aggregate byte budget.`);
      }
      files.push({
        absolutePath: path,
        relativePath: relative(root, path).split(sep).join("/"),
        size: metadata.size,
        kind: "file",
      });
      if (files.length > limits.maxFiles) {
        throw new CodexResourceLimitError(`${label} exceeds its file-count budget.`);
      }
    }
  }

  await visit(root, 0);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze({ files: Object.freeze(files), totalBytes });
}

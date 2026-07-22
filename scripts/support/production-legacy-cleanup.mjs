import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export class LegacyApplicationCleanupError extends Error {
  constructor(path, message, options) {
    super(message, options);
    this.name = "LegacyApplicationCleanupError";
    this.path = path;
  }
}

async function metadataOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Remove only the old `backups/<entry>/app` payloads left by the superseded
 * deployment path. It never recursively removes the backups root or any entry
 * containing non-app state.
 */
export async function cleanupLegacyApplicationBackups(paths) {
  const root = paths?.legacyBackups;
  if (typeof root !== "string" || resolve(root) !== root) {
    throw new TypeError("Legacy backup cleanup requires an exact canonical path.");
  }
  const rootMetadata = await metadataOrNull(root);
  if (rootMetadata === null) return;
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new LegacyApplicationCleanupError(root, `Legacy backup root is not a directory: ${root}`);
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(root, entry.name);
    if (dirname(entryPath) !== root || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new LegacyApplicationCleanupError(
        entryPath,
        `Legacy backup cleanup found unexpected retained state: ${entryPath}`,
      );
    }
    const appPath = join(entryPath, "app");
    const appMetadata = await metadataOrNull(appPath);
    if (appMetadata !== null) {
      if (!appMetadata.isDirectory() || appMetadata.isSymbolicLink()) {
        throw new LegacyApplicationCleanupError(
          appPath,
          `Legacy backup app payload is not a directory: ${appPath}`,
        );
      }
      await rm(appPath, { recursive: true });
    }
    try {
      await rmdir(entryPath);
    } catch (error) {
      throw new LegacyApplicationCleanupError(
        entryPath,
        `Legacy backup entry contains non-app retained state: ${entryPath}`,
        { cause: error },
      );
    }
  }
  await rmdir(root);
}

import { chmod, lstat, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { acquireRuntimeOwnershipLease } from "./runtime-ownership.mjs";

export class ReleaseLifecycleError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ReleaseLifecycleError";
  }
}

export class ReleaseCleanupIncompleteError extends ReleaseLifecycleError {
  constructor(path, options) {
    super(`service restored; cleanup incomplete: ${path}`, options);
    this.name = "ReleaseCleanupIncompleteError";
    this.path = path;
  }
}

export function productionReleasePaths(home = process.env.HOME ?? homedir()) {
  const deployRoot = join(resolve(home), "meal-planner");
  return Object.freeze({
    deployRoot,
    app: join(deployRoot, "app"),
    previous: join(deployRoot, "app.previous"),
    staging: join(deployRoot, ".app-staging"),
    retiring: join(deployRoot, ".app-retiring"),
    legacyBackups: join(deployRoot, "backups"),
    leaseSocket: join(deployRoot, ".release-owner", "release-owner.sock"),
    data: join(deployRoot, "data", "planner.sqlite"),
  });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const defaultFilesystem = Object.freeze({
  exists: pathExists,
  rename,
  remove(path) { return rm(path, { recursive: true, force: true }); },
  chmod(path) { return chmod(path, 0o700); },
});

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  return value;
}

function requireBoolean(result, name) {
  if (typeof result !== "boolean") throw new TypeError(`${name} must resolve to a boolean.`);
  return result;
}

// Crash recovery derives all meaning from the four fixed paths; this is deliberately
// pure so no durable operation stage or release metadata is required.
function recoveryTopologyDecision({ app, previous, staging, retiring }) {
  if (!app && !previous) return "no-fixed-slot";
  if (app && staging && retiring && !previous) return "restore-older-previous";
  if (!app && previous && staging) return "restore-interrupted-candidate-selection";
  if (app && previous && retiring && !staging) return "completed-candidate-selection";
  if (!app && previous && retiring && !staging) return "reverse-interrupted-fallback";
  if (app && retiring && !previous && !staging) return "complete-ready-fallback";
  if (!app && previous) return "restore-sole-previous";
  return "keep-app";
}

/** Fixed-slot release authority.  app and app.previous are the only slots. */
export function createProductionReleaseLifecycle({
  home,
  paths = productionReleasePaths(home),
  acquireLease = acquireRuntimeOwnershipLease,
  filesystem = {},
  service,
  compatibilityPreflight = async () => undefined,
  prepareCandidate = async () => undefined,
  reconcile = async () => undefined,
  cleanupLegacyResidue = async () => undefined,
} = {}) {
  if (service === null || typeof service !== "object") throw new TypeError("service adapters are required.");
  const fs = { ...defaultFilesystem, ...filesystem };
  for (const name of ["exists", "rename", "remove", "chmod"]) requireFunction(fs[name], `filesystem.${name}`);
  for (const name of ["quiesce", "bootstrap", "ready"]) requireFunction(service[name], `service.${name}`);
  for (const [fn, name] of [[acquireLease, "acquireLease"], [compatibilityPreflight, "compatibilityPreflight"], [prepareCandidate, "prepareCandidate"], [reconcile, "reconcile"], [cleanupLegacyResidue, "cleanupLegacyResidue"]]) requireFunction(fn, name);

  async function topology() {
    const [app, previous, staging, retiring] = await Promise.all(
      [paths.app, paths.previous, paths.staging, paths.retiring].map((path) => fs.exists(path)),
    );
    return { app, previous, staging, retiring };
  }

  function assertTemporary(path) {
    if (path !== paths.staging && path !== paths.retiring) throw new ReleaseLifecycleError("Only fixed non-selectable release paths may be removed.");
  }

  async function removeTemporary(path) {
    assertTemporary(path);
    if (await fs.exists(path)) await fs.remove(path);
  }

  async function isReady() { return requireBoolean(await service.ready(), "service.ready"); }

  async function bootstrapApp() {
    await reconcile(paths);
    await service.bootstrap(paths);
    if (!(await isReady())) throw new ReleaseLifecycleError("Selected planner app did not become ready.");
  }

  async function quiesce() {
    const fence = await service.quiesce(paths);
    if (fence === null || typeof fence !== "object" || typeof fence.unloaded !== "boolean" || typeof fence.portQuiet !== "boolean") throw new TypeError("service.quiesce must resolve to { unloaded, portQuiet }.");
    return fence.unloaded && fence.portQuiet;
  }

  async function cleanupAfterReady({ staging = true, retiring = true } = {}) {
    try {
      if (retiring) await removeTemporary(paths.retiring);
      if (staging) await removeTemporary(paths.staging);
    } catch (error) {
      const residue = await fs.exists(paths.retiring) ? paths.retiring : paths.staging;
      throw new ReleaseCleanupIncompleteError(residue, { cause: error });
    }
    try {
      await cleanupLegacyResidue(paths);
    } catch (error) {
      throw new ReleaseCleanupIncompleteError(paths.legacyBackups, { cause: error });
    }
  }

  async function restoreAfterFailedFallback(currentError, fallbackError) {
    try {
      const state = await topology();
      // The first fallback rename failed before selection changed.  Both fixed
      // slots are already intact, so restarting current is the only reversal.
      if (state.app && state.previous && !state.retiring) {
        await bootstrapApp();
        throw fallbackError;
      }
      if (!(await quiesce())) {
        throw new ReleaseLifecycleError("Failed fallback service did not become quiescent for reversal.", { cause: fallbackError });
      }
      // The fallback occupies app; move it away before restoring the displaced current.
      if (state.app) await fs.rename(paths.app, paths.previous);
      if (state.retiring) await fs.rename(paths.retiring, paths.app);
      await bootstrapApp();
    } catch (restoreError) {
      if (restoreError === fallbackError) throw fallbackError;
      throw new AggregateError([currentError, fallbackError, restoreError], "Fallback and restored current app both failed readiness.");
    }
    throw fallbackError;
  }

  async function fallbackFromUnreadyApp(currentError) {
    if (!(await fs.exists(paths.previous))) throw currentError;
    if (!(await quiesce())) throw new ReleaseLifecycleError("Planner service did not become quiescent for fallback.", { cause: currentError });
    try {
      await fs.rename(paths.app, paths.retiring);
      await fs.rename(paths.previous, paths.app);
      await bootstrapApp();
    } catch (fallbackError) {
      return restoreAfterFailedFallback(currentError, fallbackError);
    }
    try {
      await fs.rename(paths.retiring, paths.previous);
    } catch (error) {
      throw new ReleaseCleanupIncompleteError(paths.retiring, { cause: error });
    }
    await cleanupAfterReady();
    return { selected: "app", changed: true };
  }

  async function establishReadyApp() {
    if (await isReady()) return { selected: "app", changed: false };
    if (!(await quiesce())) throw new ReleaseLifecycleError("Planner service did not become quiescent for recovery.");
    try {
      await bootstrapApp();
      return { selected: "app", changed: true };
    } catch (currentError) {
      return fallbackFromUnreadyApp(currentError);
    }
  }

  async function normalizeRecoveryTopology() {
    const state = await topology();
    switch (recoveryTopologyDecision(state)) {
      case "no-fixed-slot":
        throw new ReleaseLifecycleError("No fixed release slot is available for recovery.");
      case "restore-older-previous":
        await fs.rename(paths.retiring, paths.previous);
        return { changed: true };
      case "restore-interrupted-candidate-selection":
        await fs.rename(paths.previous, paths.app);
        if (state.retiring) await fs.rename(paths.retiring, paths.previous);
        return { changed: true };
      case "completed-candidate-selection":
        // This shape is shared by an unready selected candidate and a ready
        // candidate awaiting only retiring cleanup.  Readiness is the causal
        // discriminator; never replace a ready selected app.
        if (await isReady()) return { changed: false };
        // Candidate had reached app but not readiness.  Reconstitute the former
        // current and its immediate prior before attempting another bootstrap.
        await fs.rename(paths.app, paths.staging);
        await fs.rename(paths.previous, paths.app);
        await fs.rename(paths.retiring, paths.previous);
        return { changed: true };
      case "reverse-interrupted-fallback":
        await fs.rename(paths.retiring, paths.app);
        return { changed: true };
      case "complete-ready-fallback":
        await fs.rename(paths.retiring, paths.previous);
        return { changed: true };
      case "restore-sole-previous":
        await fs.rename(paths.previous, paths.app);
        return { changed: true };
      default:
        return { changed: false };
    }
  }

  async function recoverUnderLease() {
    const normalized = await normalizeRecoveryTopology();
    const result = await establishReadyApp();
    await cleanupAfterReady();
    return { selected: "app", changed: normalized.changed || result.changed };
  }

  async function restorePromotionTopology() {
    if (!(await quiesce())) {
      throw new ReleaseLifecycleError("Failed candidate service did not become quiescent for promotion reversal.");
    }
    const state = await topology();
    // Candidate was selected: restore current and the older previous in reverse order.
    if (state.app && state.previous && !state.staging) {
      await fs.rename(paths.app, paths.staging);
      await fs.rename(paths.previous, paths.app);
      if (state.retiring) await fs.rename(paths.retiring, paths.previous);
    } else if (!state.app && state.previous) {
      // Candidate selection was interrupted after current moved to previous.
      await fs.rename(paths.previous, paths.app);
      if (state.retiring) await fs.rename(paths.retiring, paths.previous);
    } else if (state.app && !state.previous && state.retiring) {
      // Only old previous moved aside (including a failed second rename).
      await fs.rename(paths.retiring, paths.previous);
    }
    await bootstrapApp();
    await cleanupAfterReady({ retiring: false });
  }

  async function withLease(action) {
    const lease = await acquireLease({ socketPath: paths.leaseSocket });
    try { return await action(); } finally { await lease.close(); }
  }

  return Object.freeze({
    paths,
    recover() { return withLease(recoverUnderLease); },
    promote() {
      return withLease(async () => {
        // A retiring slot contains live history after an interrupted operation; recovery owns its interpretation.
        if ((await topology()).retiring) throw new ReleaseLifecycleError("Interrupted release topology requires make recover before promotion.");
        await removeTemporary(paths.staging);
        try {
          await prepareCandidate(paths);
          if (!(await fs.exists(paths.staging))) throw new ReleaseLifecycleError("Candidate preparation did not create .app-staging.");
          await compatibilityPreflight(paths);
        } catch (error) {
          try { await removeTemporary(paths.staging); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Candidate preflight failed and staging cleanup failed."); }
          throw error;
        }
        if (!(await quiesce())) {
          try { await recoverUnderLease(); } catch (recoveryError) { throw new AggregateError([recoveryError], "Promotion quiescence failed and recovery failed."); }
          throw new ReleaseLifecycleError("Planner service did not become quiescent for promotion.");
        }
        try {
          if (await fs.exists(paths.previous)) await fs.rename(paths.previous, paths.retiring);
          if (await fs.exists(paths.app)) await fs.rename(paths.app, paths.previous);
          await fs.rename(paths.staging, paths.app);
          await fs.chmod(paths.app);
          await bootstrapApp();
        } catch (error) {
          try {
            await restorePromotionTopology();
          } catch (recoveryError) {
            const message = recoveryError instanceof ReleaseCleanupIncompleteError ? `Promotion failed; ${recoveryError.message}` : "Promotion failed and recovery failed.";
            throw new AggregateError([error, recoveryError], message);
          }
          throw error;
        }
        await cleanupAfterReady();
        return { selected: "app" };
      });
    },
  });
}

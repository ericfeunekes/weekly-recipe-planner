import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  validateCodexFollowUpDeployment,
  type ValidatedCodexFollowUpDeployment,
} from "./deployment.ts";
import {
  CODEX_FOLLOW_UP_RESOURCE_POLICY,
  sha256BoundedFile,
} from "./resource-policy.ts";

export const CODEX_APP_SERVER_ARGUMENTS = [
  "app-server",
  "--listen",
  "stdio://",
] as const;

export type ExecutableFileIdentity = {
  readonly launcherPath: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNanoseconds: string;
  readonly ctimeNanoseconds: string;
  readonly sha256: string;
};

export type CodexExecutableIdentity = ExecutableFileIdentity & {
  readonly version: string;
};

export class CodexLauncherError extends Error {
  readonly code:
    | "INVALID_EXECUTABLE"
    | "IDENTITY_CHANGED"
    | "PROVENANCE_CHANGED"
    | "PROCESS_FAILED"
    | "PROCESS_TIMEOUT"
    | "PROCESS_OUTPUT_LIMIT";

  constructor(
    code: CodexLauncherError["code"],
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "CodexLauncherError";
    this.code = code;
  }
}

type LauncherDependencies = {
  readonly spawn: typeof spawn;
  readonly copyFile: typeof copyFile;
  readonly lstat: typeof lstat;
  readonly mkdir: typeof mkdir;
  readonly mkdtemp: typeof mkdtemp;
  readonly open: typeof open;
  readonly readdir: typeof readdir;
  readonly realpath: typeof realpath;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly stat: typeof stat;
  readonly hashFile: (path: string, signal?: AbortSignal) => Promise<string>;
};

const DEFAULT_DEPENDENCIES: LauncherDependencies = {
  spawn,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  hashFile: (path, signal) => sha256BoundedFile(
    path,
    CODEX_FOLLOW_UP_RESOURCE_POLICY.executableBytes,
    "Codex executable",
    signal,
  ),
};

type CapturedProcessResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type AcceptedSpawnOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdio?: SpawnOptions["stdio"];
  readonly signal?: AbortSignal;
};

type OpenedExecutableIdentity = {
  readonly identity: ExecutableFileIdentity;
  readonly handle: FileHandle;
};

export type CompatibleAppServerSpawnOptions = {
  readonly signal?: AbortSignal;
};

/**
 * Stable model-session seam. Callers can request only the fixed app-server
 * process; updater identity and accepted provenance remain runtime-owned.
 */
export type CodexAppServerExecutionProvider = {
  spawnAppServer(options?: CompatibleAppServerSpawnOptions): Promise<ChildProcess>;
};

export type CodexExecutionProvenanceSnapshot = {
  readonly userConfigSha256: string;
  readonly instructionSha256: string;
  readonly systemConfigPaths: readonly string[];
};

/**
 * The only production execution capability handed to later waves. It cannot
 * choose a command, argv, cwd, environment, or executable identity.
 */
export type CompatibleCodexExecution = CodexAppServerExecutionProvider & {
  readonly identity: CodexExecutableIdentity;
};

function validSha256(value: string) {
  return /^[a-f0-9]{64}$/u.test(value);
}

function validateProvenanceSnapshot(snapshot: CodexExecutionProvenanceSnapshot) {
  if (
    !validSha256(snapshot.userConfigSha256) ||
    !validSha256(snapshot.instructionSha256) ||
    snapshot.systemConfigPaths.length !== 1 ||
    !isAbsolute(snapshot.systemConfigPaths[0]) ||
    resolve(snapshot.systemConfigPaths[0]) !== snapshot.systemConfigPaths[0]
  ) {
    throw new CodexLauncherError(
      "PROVENANCE_CHANGED",
      "The accepted Codex deployment provenance snapshot is malformed.",
    );
  }
}

async function assertProvenanceFile(
  path: string,
  expectedSha256: string,
  signal?: AbortSignal,
  releaseOwnedPath?: string,
) {
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  const regularDedicatedFile = metadata.isFile() && canonical === path;
  const fixedReleaseLink = metadata.isSymbolicLink() && canonical === releaseOwnedPath;
  if (!regularDedicatedFile && !fixedReleaseLink) {
    throw new CodexLauncherError(
      "PROVENANCE_CHANGED",
      "An accepted Codex provenance file changed kind or canonical identity.",
    );
  }
  const sha256 = await sha256BoundedFile(
    path,
    CODEX_FOLLOW_UP_RESOURCE_POLICY.provenance.maxFileBytes,
    "Codex provenance source",
    signal,
  );
  if (sha256 !== expectedSha256) {
    throw new CodexLauncherError(
      "PROVENANCE_CHANGED",
      "An accepted Codex provenance file changed after readiness evaluation.",
    );
  }
}

async function revalidateDeploymentProvenance(
  deployment: ValidatedCodexFollowUpDeployment,
  snapshot: CodexExecutionProvenanceSnapshot,
  signal?: AbortSignal,
) {
  validateProvenanceSnapshot(snapshot);
  const validation = await validateCodexFollowUpDeployment(deployment);
  if (!validation.ok) {
    throw new CodexLauncherError(
      "PROVENANCE_CHANGED",
      "The accepted Codex deployment boundary changed after readiness evaluation.",
    );
  }
  try {
    await assertProvenanceFile(
      join(deployment.codexHome, "config.toml"),
      snapshot.userConfigSha256,
      signal,
      join(deployment.appCwd, "deployment", "codex", "config.toml"),
    );
    await assertProvenanceFile(
      join(deployment.codexHome, "AGENTS.md"),
      snapshot.instructionSha256,
      signal,
      join(deployment.appCwd, "deployment", "codex", "AGENTS.md"),
    );
    for (const path of snapshot.systemConfigPaths) {
      try {
        await lstat(path);
        throw new CodexLauncherError(
          "PROVENANCE_CHANGED",
          "The previously absent system Codex config now exists.",
        );
      } catch (error) {
        if (error instanceof CodexLauncherError) throw error;
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof CodexLauncherError) throw error;
    throw new CodexLauncherError(
      "PROVENANCE_CHANGED",
      "The accepted Codex deployment provenance could not be revalidated.",
      { cause: error },
    );
  }
}

async function openFileIdentity(
  launcherPath: string,
  normalHome: string,
  dependencies: LauncherDependencies,
  signal?: AbortSignal,
  expectedIdentity?: ExecutableFileIdentity,
): Promise<OpenedExecutableIdentity> {
  if (!isAbsolute(normalHome) || resolve(normalHome) !== normalHome) {
    throw new CodexLauncherError(
      "INVALID_EXECUTABLE",
      "The normal HOME must be absolute and canonical for updater admission.",
    );
  }
  const currentUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : (await dependencies.stat(normalHome, { bigint: true })).uid;
  const assertOwnedDirectory = async (path: string) => {
    const metadata = await dependencies.lstat(path, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== currentUid ||
      (metadata.mode & BigInt(0o022)) !== BigInt(0) ||
      await dependencies.realpath(path) !== path
    ) {
      throw new CodexLauncherError(
        "INVALID_EXECUTABLE",
        "The updater-managed Codex path uses an unsafe user-owned directory.",
      );
    }
  };
  const assertOwnedDirectoryChain = async (path: string) => {
    const fromHome = relative(normalHome, path);
    if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
      throw new CodexLauncherError(
        "INVALID_EXECUTABLE",
        "The updater-managed Codex target must remain beneath the normal HOME.",
      );
    }
    await assertOwnedDirectory(normalHome);
    let current = normalHome;
    for (const component of fromHome.split(sep).filter(Boolean)) {
      current = join(current, component);
      await assertOwnedDirectory(current);
    }
  };

  await assertOwnedDirectoryChain(dirname(launcherPath));
  const launcherStats = await dependencies.lstat(launcherPath, { bigint: true });
  if (
    (!launcherStats.isSymbolicLink() && !launcherStats.isFile()) ||
    launcherStats.uid !== currentUid ||
    (launcherStats.isFile() && (launcherStats.mode & BigInt(0o022)) !== BigInt(0))
  ) {
    throw new CodexLauncherError(
      "INVALID_EXECUTABLE",
      "The fixed Codex launcher has unsafe ownership, type, or permissions.",
    );
  }
  const canonicalPath = await dependencies.realpath(launcherPath);
  await assertOwnedDirectoryChain(dirname(canonicalPath));
  let handle: FileHandle | undefined;
  try {
    handle = await dependencies.open(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      (before.mode & BigInt(0o111)) === BigInt(0) ||
      (before.mode & BigInt(0o022)) !== BigInt(0)
    ) {
      throw new CodexLauncherError(
        "INVALID_EXECUTABLE",
        "The fixed Codex launcher target must be an executable regular file.",
      );
    }
    if (before.uid !== currentUid) {
      throw new CodexLauncherError(
        "INVALID_EXECUTABLE",
        "The fixed Codex launcher target must be owned by the current user.",
      );
    }
    if (before.size > BigInt(CODEX_FOLLOW_UP_RESOURCE_POLICY.executableBytes)) {
      throw new CodexLauncherError(
        "INVALID_EXECUTABLE",
        "The fixed Codex launcher target exceeds the executable byte budget.",
      );
    }
    const matchesExpectedMetadata = expectedIdentity !== undefined &&
      expectedIdentity.launcherPath === launcherPath &&
      expectedIdentity.canonicalPath === canonicalPath &&
      expectedIdentity.device === before.dev.toString() &&
      expectedIdentity.inode === before.ino.toString() &&
      expectedIdentity.size === before.size.toString() &&
      expectedIdentity.mtimeNanoseconds === before.mtimeNs.toString() &&
      expectedIdentity.ctimeNanoseconds === before.ctimeNs.toString();
    const sha256 = expectedIdentity === undefined
      ? await dependencies.hashFile(`/dev/fd/${handle.fd}`, signal)
      : matchesExpectedMetadata ? expectedIdentity.sha256 : "";
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.mode !== after.mode || before.uid !== after.uid
    ) {
      throw new CodexLauncherError(
        "IDENTITY_CHANGED",
        "The updater-managed Codex target changed while its opened identity was being captured.",
      );
    }
    return {
      handle,
      identity: {
        launcherPath,
        canonicalPath,
        device: after.dev.toString(),
        inode: after.ino.toString(),
        size: after.size.toString(),
        mtimeNanoseconds: after.mtimeNs.toString(),
        ctimeNanoseconds: after.ctimeNs.toString(),
        sha256,
      },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function captureFileIdentity(
  launcherPath: string,
  normalHome: string,
  dependencies: LauncherDependencies,
  signal?: AbortSignal,
  expectedIdentity?: ExecutableFileIdentity,
): Promise<ExecutableFileIdentity> {
  const opened = await openFileIdentity(
    launcherPath,
    normalHome,
    dependencies,
    signal,
    expectedIdentity,
  );
  try {
    return opened.identity;
  } finally {
    await opened.handle.close();
  }
}

type BoundExecutableSnapshot = {
  readonly path: string;
  cleanup(): Promise<void>;
  cleanupSync(): void;
};

const VERIFIED_EXECUTABLE_SNAPSHOTS = new Map<string, string>();
const ACTIVE_SNAPSHOT_PREPARATIONS = new Set<string>();
const ACTIVE_EXECUTABLE_SNAPSHOTS = new Map<string, number>();

function acquireExecutableSnapshot(path: string): BoundExecutableSnapshot {
  const directory = dirname(path);
  ACTIVE_EXECUTABLE_SNAPSHOTS.set(
    directory,
    (ACTIVE_EXECUTABLE_SNAPSHOTS.get(directory) ?? 0) + 1,
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const remaining = (ACTIVE_EXECUTABLE_SNAPSHOTS.get(directory) ?? 1) - 1;
    if (remaining <= 0) ACTIVE_EXECUTABLE_SNAPSHOTS.delete(directory);
    else ACTIVE_EXECUTABLE_SNAPSHOTS.set(directory, remaining);
  };
  return Object.freeze({ path, cleanup: async () => release(), cleanupSync: release });
}

function snapshotMetadataIdentity(metadata: BigIntStats) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mode,
    metadata.uid,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(":");
}

function isMissingPath(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function validatePrivateSnapshotDirectory(
  directory: string,
  currentUid: bigint,
  dependencies: LauncherDependencies,
) {
  const metadata = await dependencies.lstat(directory, { bigint: true });
  if (
    metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.uid !== currentUid ||
    (metadata.mode & BigInt(0o077)) !== BigInt(0) ||
    await dependencies.realpath(directory) !== directory
  ) {
    throw new CodexLauncherError(
      "INVALID_EXECUTABLE",
      "The Codex execution snapshot directory is not private and canonical.",
    );
  }
}

async function validateExecutableSnapshot(
  directory: string,
  identity: ExecutableFileIdentity,
  currentUid: bigint,
  dependencies: LauncherDependencies,
) {
  await validatePrivateSnapshotDirectory(directory, currentUid, dependencies);
  const path = join(directory, "codex.mjs");
  const linkMetadata = await dependencies.lstat(path, { bigint: true });
  const metadata = await dependencies.stat(path, { bigint: true });
  const metadataIdentity = snapshotMetadataIdentity(metadata);
  const sha256 = VERIFIED_EXECUTABLE_SNAPSHOTS.get(path) === metadataIdentity
    ? identity.sha256
    : await dependencies.hashFile(path);
  if (
    linkMetadata.isSymbolicLink() || !metadata.isFile() ||
    await dependencies.realpath(path) !== path ||
    metadata.size.toString() !== identity.size ||
    metadata.uid !== currentUid ||
    (metadata.mode & BigInt(0o111)) === BigInt(0) ||
    (metadata.mode & BigInt(0o022)) !== BigInt(0) ||
    sha256 !== identity.sha256
  ) {
    throw new CodexLauncherError(
      "IDENTITY_CHANGED",
      "The private Codex execution snapshot does not match the accepted executable identity.",
    );
  }
  VERIFIED_EXECUTABLE_SNAPSHOTS.set(path, metadataIdentity);
  return path;
}

async function cleanupAbandonedExecutableSnapshots(
  snapshotRoot: string,
  currentUid: bigint,
  dependencies: LauncherDependencies,
) {
  for (const entry of await dependencies.readdir(snapshotRoot, { withFileTypes: true })) {
    const match = /^\.prepare-([1-9][0-9]*)-/u.exec(entry.name);
    if (!match) continue;
    const path = join(snapshotRoot, entry.name);
    if (ACTIVE_SNAPSHOT_PREPARATIONS.has(path)) continue;
    const metadata = await dependencies.lstat(path, { bigint: true });
    if (
      entry.isSymbolicLink() || metadata.isSymbolicLink() || !metadata.isDirectory() ||
      metadata.uid !== currentUid || await dependencies.realpath(path) !== path
    ) {
      throw new CodexLauncherError(
        "INVALID_EXECUTABLE",
        "The Codex execution snapshot root contains an unsafe stale entry.",
      );
    }
    const pid = Number(match[1]);
    let processIsAlive = pid === process.pid;
    if (!processIsAlive) {
      try {
        process.kill(pid, 0);
        processIsAlive = true;
      } catch (error) {
        processIsAlive = typeof error === "object" && error !== null && "code" in error &&
          error.code !== "ESRCH";
      }
    }
    if (!processIsAlive || pid === process.pid) {
      await dependencies.rm(path, { recursive: true, force: true });
    }
  }
}

async function pruneExecutableSnapshots(
  snapshotRoot: string,
  currentDirectory: string,
  currentUid: bigint,
  dependencies: LauncherDependencies,
) {
  const snapshots = [];
  for (const entry of await dependencies.readdir(snapshotRoot, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const directory = join(snapshotRoot, entry.name);
    await validatePrivateSnapshotDirectory(directory, currentUid, dependencies);
    const metadata = await dependencies.stat(directory, { bigint: true });
    snapshots.push({ directory, modified: metadata.mtimeNs });
  }
  snapshots.sort((left, right) => left.modified > right.modified ? -1 : 1);
  const protectedDirectories = new Set([currentDirectory, ...ACTIVE_EXECUTABLE_SNAPSHOTS.keys()]);
  const inactiveBudget = Math.max(
    0,
    CODEX_FOLLOW_UP_RESOURCE_POLICY.retainedExecutableSnapshots - protectedDirectories.size,
  );
  const retainedInactive = new Set(snapshots
    .filter(({ directory }) => !protectedDirectories.has(directory))
    .slice(0, inactiveBudget)
    .map(({ directory }) => directory));
  for (const { directory } of snapshots) {
    if (protectedDirectories.has(directory) || retainedInactive.has(directory)) continue;
    VERIFIED_EXECUTABLE_SNAPSHOTS.delete(join(directory, "codex.mjs"));
    await dependencies.rm(directory, { recursive: true, force: true });
  }
}

async function createBoundExecutableSnapshot(
  identity: ExecutableFileIdentity,
  codexHome: string,
  dependencies: LauncherDependencies,
): Promise<BoundExecutableSnapshot> {
  const currentUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : (await dependencies.stat(codexHome, { bigint: true })).uid;
  const runtimeRoot = join(codexHome, ".planner-runtime");
  const snapshotRoot = join(runtimeRoot, "execution-snapshots");
  await dependencies.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  for (const directory of [codexHome, runtimeRoot, snapshotRoot]) {
    await validatePrivateSnapshotDirectory(directory, currentUid, dependencies);
  }
  await cleanupAbandonedExecutableSnapshots(snapshotRoot, currentUid, dependencies);
  const finalDirectory = join(snapshotRoot, identity.sha256);
  try {
    await dependencies.lstat(finalDirectory);
    const path = await validateExecutableSnapshot(
      finalDirectory,
      identity,
      currentUid,
      dependencies,
    );
    const acquired = acquireExecutableSnapshot(path);
    try {
      await pruneExecutableSnapshots(
        snapshotRoot,
        finalDirectory,
        currentUid,
        dependencies,
      );
      return acquired;
    } catch (error) {
      await acquired.cleanup();
      throw error;
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  const directory = await dependencies.mkdtemp(join(snapshotRoot, `.prepare-${process.pid}-`));
  ACTIVE_SNAPSHOT_PREPARATIONS.add(directory);
  const path = join(directory, "codex.mjs");
  const cleanupPreparation = async () => {
    ACTIVE_SNAPSHOT_PREPARATIONS.delete(directory);
    await dependencies.rm(directory, { recursive: true, force: true });
  };
  try {
    await validatePrivateSnapshotDirectory(directory, currentUid, dependencies);
    await dependencies.copyFile(
      identity.canonicalPath,
      path,
      constants.COPYFILE_FICLONE,
    );
    await validateExecutableSnapshot(directory, identity, currentUid, dependencies);
    try {
      await dependencies.rename(directory, finalDirectory);
    } catch (error) {
      if (
        typeof error !== "object" || error === null || !("code" in error) ||
        !["EEXIST", "ENOTEMPTY"].includes(String(error.code))
      ) {
        throw error;
      }
      await cleanupPreparation();
    }
    ACTIVE_SNAPSHOT_PREPARATIONS.delete(directory);
    const finalPath = await validateExecutableSnapshot(
      finalDirectory,
      identity,
      currentUid,
      dependencies,
    );
    const acquired = acquireExecutableSnapshot(finalPath);
    try {
      await pruneExecutableSnapshots(
        snapshotRoot,
        finalDirectory,
        currentUid,
        dependencies,
      );
      return acquired;
    } catch (error) {
      await acquired.cleanup();
      throw error;
    }
  } catch (error) {
    await cleanupPreparation().catch(() => undefined);
    if (error instanceof CodexLauncherError) throw error;
    throw new CodexLauncherError(
      "IDENTITY_CHANGED",
      "The updater-managed Codex target disappeared while its execution snapshot was bound.",
      { cause: error },
    );
  }
}

function spawnCaptured(
  command: string,
  args: readonly string[],
  options: AcceptedSpawnOptions,
  dependencies: LauncherDependencies,
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
) {
  return new Promise<CapturedProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = dependencies.spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        signal: options.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new CodexLauncherError("PROCESS_FAILED", "Could not start Codex.", { cause: error }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > limits.maxOutputBytes) {
        child.kill("SIGKILL");
        finish(() => reject(new CodexLauncherError(
          "PROCESS_OUTPUT_LIMIT",
          "Codex exceeded the bounded output limit.",
        )));
      }
      return next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!settled) stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!settled) stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(() => reject(
      new CodexLauncherError("PROCESS_FAILED", "Codex process failed.", { cause: error }),
    )));
    child.once("close", (code) => finish(() => {
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(new CodexLauncherError(
          "PROCESS_FAILED",
          `Codex exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
        ));
      } else {
        resolve({ stdout, stderr, exitCode });
      }
    }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new CodexLauncherError("PROCESS_TIMEOUT", "Codex process timed out.")));
    }, limits.timeoutMs);
    timer.unref?.();
  });
}

function sameFileIdentity(left: ExecutableFileIdentity, right: ExecutableFileIdentity) {
  return (
    left.launcherPath === right.launcherPath &&
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNanoseconds === right.mtimeNanoseconds &&
    left.ctimeNanoseconds === right.ctimeNanoseconds &&
    left.sha256 === right.sha256
  );
}

export function sameCodexExecutableIdentity(
  left: CodexExecutableIdentity,
  right: CodexExecutableIdentity,
) {
  return sameFileIdentity(left, right) && left.version === right.version;
}

export async function captureCodexExecutableIdentity(
  launcherPath: string,
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly dependencies?: Partial<LauncherDependencies>;
  },
): Promise<CodexExecutableIdentity> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const normalHome = options.env.HOME;
  if (typeof normalHome !== "string") {
    throw new CodexLauncherError("INVALID_EXECUTABLE", "The Codex launch environment omitted HOME.");
  }
  const codexHome = options.env.CODEX_HOME;
  if (typeof codexHome !== "string" || !isAbsolute(codexHome) || resolve(codexHome) !== codexHome) {
    throw new CodexLauncherError(
      "INVALID_EXECUTABLE",
      "The Codex launch environment omitted its canonical dedicated home.",
    );
  }
  const opened = await openFileIdentity(
    launcherPath,
    normalHome,
    dependencies,
    options.signal,
  );
  let versionResult: CapturedProcessResult;
  let snapshot: BoundExecutableSnapshot | undefined;
  try {
    snapshot = await createBoundExecutableSnapshot(opened.identity, codexHome, dependencies);
    versionResult = await spawnCaptured(
      snapshot.path,
      ["--version"],
      { cwd: options.cwd, env: options.env, signal: options.signal },
      dependencies,
      { timeoutMs: options.timeoutMs ?? 5_000, maxOutputBytes: 8_192 },
    );
  } finally {
    await snapshot?.cleanup().catch(() => undefined);
    await opened.handle.close();
  }
  const after = await captureFileIdentity(
    launcherPath,
    normalHome,
    dependencies,
    options.signal,
    opened.identity,
  );
  if (!sameFileIdentity(opened.identity, after)) {
    throw new CodexLauncherError(
      "IDENTITY_CHANGED",
      "The updater-managed Codex target changed while its identity was being captured.",
    );
  }
  const version = versionResult.stdout.trim();
  if (!version || version.includes("\n")) {
    throw new CodexLauncherError("INVALID_EXECUTABLE", "Codex returned an invalid version string.");
  }
  return Object.freeze({ ...after, version });
}

/** Internal subsystem seam: callers supply fixed, contract-owned argv only. */
export async function spawnAcceptedCodexProcess(
  acceptedIdentity: CodexExecutableIdentity,
  args: readonly string[],
  options: AcceptedSpawnOptions & {
    readonly dependencies?: Partial<LauncherDependencies>;
  },
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const normalHome = options.env.HOME;
  if (typeof normalHome !== "string") {
    throw new CodexLauncherError("INVALID_EXECUTABLE", "The Codex launch environment omitted HOME.");
  }
  const codexHome = options.env.CODEX_HOME;
  if (typeof codexHome !== "string") {
    throw new CodexLauncherError("INVALID_EXECUTABLE", "The Codex launch environment omitted CODEX_HOME.");
  }
  const opened = await openFileIdentity(
    acceptedIdentity.launcherPath,
    normalHome,
    dependencies,
    options.signal,
    acceptedIdentity,
  );
  if (!sameFileIdentity(acceptedIdentity, opened.identity)) {
    await opened.handle.close();
    throw new CodexLauncherError(
      "IDENTITY_CHANGED",
      "The updater-managed Codex target changed before spawn; compatibility must be reevaluated.",
    );
  }
  let snapshot: BoundExecutableSnapshot | undefined;
  let child: ChildProcess | undefined;
  try {
    snapshot = await createBoundExecutableSnapshot(acceptedIdentity, codexHome, dependencies);
    const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
    if (!Array.isArray(stdio) || stdio.length !== 3) {
      throw new CodexLauncherError(
        "PROCESS_FAILED",
        "The bound Codex spawn requires an explicit three-stream stdio contract.",
      );
    }
    child = dependencies.spawn(snapshot.path, [...args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      signal: options.signal,
      stdio,
    });
  } catch (error) {
    await snapshot?.cleanup().catch(() => undefined);
    throw error;
  } finally {
    await opened.handle.close();
  }
  let cleaned = false;
  const cleanupSnapshot = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      snapshot?.cleanupSync();
    } catch {
      // A later spawn prunes a crash/interruption residue by recorded PID.
    }
  };
  child.once("error", cleanupSnapshot);
  child.once("close", cleanupSnapshot);
  return child;
}

export async function runAcceptedCodexProcess(
  acceptedIdentity: CodexExecutableIdentity,
  args: readonly string[],
  options: AcceptedSpawnOptions & {
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly dependencies?: Partial<LauncherDependencies>;
  },
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const normalHome = options.env.HOME;
  if (typeof normalHome !== "string") {
    throw new CodexLauncherError("INVALID_EXECUTABLE", "The Codex launch environment omitted HOME.");
  }
  const codexHome = options.env.CODEX_HOME;
  if (typeof codexHome !== "string") {
    throw new CodexLauncherError("INVALID_EXECUTABLE", "The Codex launch environment omitted CODEX_HOME.");
  }
  const opened = await openFileIdentity(
    acceptedIdentity.launcherPath,
    normalHome,
    dependencies,
    options.signal,
    acceptedIdentity,
  );
  if (!sameFileIdentity(acceptedIdentity, opened.identity)) {
    await opened.handle.close();
    throw new CodexLauncherError(
      "IDENTITY_CHANGED",
      "The updater-managed Codex target changed before spawn; compatibility must be reevaluated.",
    );
  }
  let snapshot: BoundExecutableSnapshot | undefined;
  try {
    snapshot = await createBoundExecutableSnapshot(acceptedIdentity, codexHome, dependencies);
    return await spawnCaptured(
      snapshot.path,
      args,
      options,
      dependencies,
      {
        timeoutMs: options.timeoutMs ?? 15_000,
        maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
      },
    );
  } finally {
    await snapshot?.cleanup().catch(() => undefined);
    await opened.handle.close();
  }
}

export function createCompatibleCodexExecution(
  identity: CodexExecutableIdentity,
  deployment: ValidatedCodexFollowUpDeployment,
  childEnvironment: Readonly<Record<string, string | undefined>>,
  provenance: CodexExecutionProvenanceSnapshot,
  dependencies: Partial<LauncherDependencies> = {},
): CompatibleCodexExecution {
  validateProvenanceSnapshot(provenance);
  return Object.freeze({
    identity,
    async spawnAppServer(options: CompatibleAppServerSpawnOptions = {}) {
      await revalidateDeploymentProvenance(deployment, provenance, options.signal);
      return spawnAcceptedCodexProcess(identity, CODEX_APP_SERVER_ARGUMENTS, {
        cwd: deployment.appCwd,
        env: childEnvironment,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        dependencies,
      });
    },
  });
}

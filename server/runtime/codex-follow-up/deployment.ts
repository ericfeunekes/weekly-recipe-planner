import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CODEX_FOLLOW_UP_ENVIRONMENT_KEYS = [
  "HOME",
  "CODEX_HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

export type CodexFollowUpEnvironmentKey =
  (typeof CODEX_FOLLOW_UP_ENVIRONMENT_KEYS)[number];

export type CodexFollowUpConfigFailure = {
  readonly state: "unavailable";
  readonly code: "invalid_configuration";
  readonly detail: string;
};

export type CodexFollowUpDeployment = {
  readonly codexHome: string;
  readonly appCwd: string;
  readonly plannerDataDirectory: string;
  readonly runtimeDirectory: string;
  readonly schemaCacheDirectory: string;
  readonly evidenceDirectory: string;
  readonly launcherPath: string;
  readonly normalHome: string;
};

export type FollowUpConfigResult =
  | { readonly ok: true; readonly deployment: CodexFollowUpDeployment }
  | { readonly ok: false; readonly status: CodexFollowUpConfigFailure };

export type ValidatedCodexFollowUpDeployment = CodexFollowUpDeployment & {
  readonly codexHome: string;
  readonly appCwd: string;
  readonly runtimeDirectory: string;
  readonly schemaCacheDirectory: string;
  readonly evidenceDirectory: string;
  readonly launcherPath: string;
};

export type DeploymentValidationFailure = {
  readonly ok: false;
  readonly code:
    | "root_missing"
    | "root_not_directory"
    | "root_symlink"
    | "root_not_canonical"
    | "root_wrong_owner"
    | "codex_home_not_private"
    | "root_overlap"
    | "project_capability_source"
    | "launcher_missing"
    | "runtime_directory_failed";
  readonly detail: string;
};

export type DeploymentValidationResult =
  | {
      readonly ok: true;
      readonly deployment: ValidatedCodexFollowUpDeployment;
    }
  | DeploymentValidationFailure;

const PROJECT_CAPABILITY_SOURCES = [
  ".codex/config.toml",
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
] as const;

type FilesystemDependencies = {
  readonly lstat: typeof lstat;
  readonly stat: typeof stat;
  readonly realpath: typeof realpath;
  readonly access: typeof access;
  readonly mkdir: typeof mkdir;
};

const DEFAULT_FILESYSTEM: FilesystemDependencies = {
  lstat,
  stat,
  realpath,
  access,
  mkdir,
};

function unavailable(detail: string): FollowUpConfigResult {
  return {
    ok: false,
    status: {
      state: "unavailable",
      code: "invalid_configuration",
      detail,
    },
  };
}

function parseAbsolutePath(value: string, name: string) {
  if (!isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path.`);
  }
  const normalized = resolve(value);
  if (normalized !== value) {
    throw new TypeError(`${name} must be lexically canonical.`);
  }
  return normalized;
}

/**
 * Parse only deployment grammar. Filesystem and ownership checks deliberately
 * happen in the optional coordinator so a bad follow-up never prevents the
 * planner runtime from starting.
 */
export function parseCodexFollowUpConfig(
  environment: NodeJS.ProcessEnv = process.env,
  plannerDataDirectory = resolve(environment.PLANNER_DATA_DIR ?? ".planner-data"),
): FollowUpConfigResult {
  try {
    const normalHome = parseAbsolutePath(
      environment.HOME ?? homedir(),
      "HOME",
    );
    const codexHome = parseAbsolutePath(
      environment.PLANNER_CODEX_HOME ?? join(normalHome, "meal-planner", "agent"),
      "PLANNER_CODEX_HOME",
    );
    const appCwd = parseAbsolutePath(
      environment.PLANNER_CODEX_CWD ?? join(normalHome, "meal-planner", "app"),
      "PLANNER_CODEX_CWD",
    );
    const dataDirectory = parseAbsolutePath(
      resolve(plannerDataDirectory),
      "PLANNER_DATA_DIR",
    );
    if (codexHome === appCwd) {
      return unavailable("PLANNER_CODEX_HOME and PLANNER_CODEX_CWD must differ.");
    }

    const runtimeDirectory = join(codexHome, ".planner-runtime");
    return {
      ok: true,
      deployment: Object.freeze({
        codexHome,
        appCwd,
        plannerDataDirectory: dataDirectory,
        runtimeDirectory,
        schemaCacheDirectory: join(runtimeDirectory, "schema"),
        evidenceDirectory: join(runtimeDirectory, "evidence"),
        launcherPath: join(normalHome, ".local", "bin", "codex"),
        normalHome,
      }),
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Invalid follow-up configuration.");
  }
}

function pathContains(parent: string, candidate: string) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent)
    )
  );
}

function rootsOverlap(left: string, right: string) {
  return pathContains(left, right) || pathContains(right, left);
}

async function validateExistingDirectory(
  label: string,
  requestedPath: string,
  filesystem: FilesystemDependencies,
): Promise<
  | { readonly ok: true; readonly canonicalPath: string; readonly mode: number; readonly uid: number }
  | DeploymentValidationFailure
> {
  let linkStats;
  try {
    linkStats = await filesystem.lstat(requestedPath);
  } catch {
    return { ok: false, code: "root_missing", detail: `${label} does not exist.` };
  }
  if (linkStats.isSymbolicLink()) {
    return { ok: false, code: "root_symlink", detail: `${label} must not be a symbolic link.` };
  }
  if (!linkStats.isDirectory()) {
    return { ok: false, code: "root_not_directory", detail: `${label} must be a directory.` };
  }

  const canonicalPath = await filesystem.realpath(requestedPath);
  if (canonicalPath !== requestedPath) {
    return {
      ok: false,
      code: "root_not_canonical",
      detail: `${label} must use its canonical path.`,
    };
  }
  const rootStats = await filesystem.stat(canonicalPath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : rootStats.uid;
  if (rootStats.uid !== currentUid) {
    return {
      ok: false,
      code: "root_wrong_owner",
      detail: `${label} must be owned by the current user.`,
    };
  }
  return {
    ok: true,
    canonicalPath,
    mode: rootStats.mode & 0o777,
    uid: rootStats.uid,
  };
}

async function firstCapabilitySource(
  appCwd: string,
  filesystem: FilesystemDependencies,
) {
  for (const source of PROJECT_CAPABILITY_SOURCES) {
    const candidate = join(appCwd, source);
    try {
      await filesystem.access(candidate, fsConstants.F_OK);
      return candidate;
    } catch {
      // Absence is the required state.
    }
  }
  return null;
}

function filesystemErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

async function establishPrivateRuntimeDirectory(
  label: string,
  requestedPath: string,
  filesystem: FilesystemDependencies,
): Promise<
  | { readonly ok: true; readonly canonicalPath: string }
  | DeploymentValidationFailure
> {
  try {
    // Do not use recursive mkdir here: every parent is validated before its
    // child, so a pre-existing symlink can never redirect a creation.
    await filesystem.mkdir(requestedPath, { mode: 0o700 });
  } catch (error) {
    if (filesystemErrorCode(error) !== "EEXIST") {
      return {
        ok: false,
        code: "runtime_directory_failed",
        detail: `Could not create ${label}.`,
      };
    }
  }

  const validated = await validateExistingDirectory(label, requestedPath, filesystem);
  if (!validated.ok) {
    return {
      ok: false,
      code: "runtime_directory_failed",
      detail: `${label} is not a safe private runtime directory: ${validated.detail}`,
    };
  }
  if (validated.mode !== 0o700) {
    return {
      ok: false,
      code: "runtime_directory_failed",
      detail: `${label} must have mode 0700.`,
    };
  }
  return { ok: true, canonicalPath: validated.canonicalPath };
}

/**
 * Validate the real production roots and create only the private runtime-owned
 * cache/evidence directories after those roots have passed every check.
 */
export async function validateCodexFollowUpDeployment(
  deployment: CodexFollowUpDeployment,
  dependencies: Partial<FilesystemDependencies> = {},
): Promise<DeploymentValidationResult> {
  const filesystem = { ...DEFAULT_FILESYSTEM, ...dependencies };
  try {
    const codexHome = await validateExistingDirectory(
      "PLANNER_CODEX_HOME",
      deployment.codexHome,
      filesystem,
    );
    if (!codexHome.ok) return codexHome;
    if (codexHome.mode !== 0o700) {
      return {
        ok: false,
        code: "codex_home_not_private",
        detail: "PLANNER_CODEX_HOME must have mode 0700.",
      };
    }

    const appCwd = await validateExistingDirectory(
      "PLANNER_CODEX_CWD",
      deployment.appCwd,
      filesystem,
    );
    if (!appCwd.ok) return appCwd;

    const plannerDataDirectory = await validateExistingDirectory(
      "PLANNER_DATA_DIR",
      deployment.plannerDataDirectory,
      filesystem,
    );
    if (!plannerDataDirectory.ok) return plannerDataDirectory;

    if (
      rootsOverlap(codexHome.canonicalPath, appCwd.canonicalPath) ||
      rootsOverlap(codexHome.canonicalPath, plannerDataDirectory.canonicalPath) ||
      rootsOverlap(appCwd.canonicalPath, plannerDataDirectory.canonicalPath)
    ) {
      return {
        ok: false,
        code: "root_overlap",
        detail: "Codex home, application cwd, and planner data directory must be separate roots.",
      };
    }

    const capabilitySource = await firstCapabilitySource(appCwd.canonicalPath, filesystem);
    if (capabilitySource) {
      return {
        ok: false,
        code: "project_capability_source",
        detail: `The fixed application cwd contains an undeclared capability source: ${relative(appCwd.canonicalPath, capabilitySource)}.`,
      };
    }

    try {
      await filesystem.access(deployment.launcherPath, fsConstants.X_OK);
    } catch {
      return {
        ok: false,
        code: "launcher_missing",
        detail: "The fixed updater-managed Codex launcher is missing or not executable.",
      };
    }

    const expectedRuntimeDirectory = join(codexHome.canonicalPath, ".planner-runtime");
    const expectedSchemaCacheDirectory = join(expectedRuntimeDirectory, "schema");
    const expectedEvidenceDirectory = join(expectedRuntimeDirectory, "evidence");
    if (
      deployment.runtimeDirectory !== expectedRuntimeDirectory ||
      deployment.schemaCacheDirectory !== expectedSchemaCacheDirectory ||
      deployment.evidenceDirectory !== expectedEvidenceDirectory
    ) {
      return {
        ok: false,
        code: "runtime_directory_failed",
        detail: "Codex follow-up runtime directories must use the dedicated-home layout.",
      };
    }

    const runtimeDirectory = await establishPrivateRuntimeDirectory(
      "Codex follow-up runtime directory",
      expectedRuntimeDirectory,
      filesystem,
    );
    if (!runtimeDirectory.ok) return runtimeDirectory;
    const schemaCacheDirectory = await establishPrivateRuntimeDirectory(
      "Codex follow-up schema cache directory",
      expectedSchemaCacheDirectory,
      filesystem,
    );
    if (!schemaCacheDirectory.ok) return schemaCacheDirectory;
    const evidenceDirectory = await establishPrivateRuntimeDirectory(
      "Codex follow-up evidence directory",
      expectedEvidenceDirectory,
      filesystem,
    );
    if (!evidenceDirectory.ok) return evidenceDirectory;

    return {
      ok: true,
      deployment: Object.freeze({
        ...deployment,
        codexHome: codexHome.canonicalPath,
        appCwd: appCwd.canonicalPath,
        plannerDataDirectory: plannerDataDirectory.canonicalPath,
        runtimeDirectory: runtimeDirectory.canonicalPath,
        schemaCacheDirectory: schemaCacheDirectory.canonicalPath,
        evidenceDirectory: evidenceDirectory.canonicalPath,
        launcherPath: deployment.launcherPath,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      code: "runtime_directory_failed",
      detail: error instanceof Error ? error.message : "Deployment validation failed.",
    };
  }
}

export function buildCodexFollowUpChildEnvironment(
  deployment: Pick<ValidatedCodexFollowUpDeployment, "normalHome" | "codexHome">,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  options: { readonly codexHome?: string } = {},
): Readonly<Record<CodexFollowUpEnvironmentKey, string> | Partial<Record<CodexFollowUpEnvironmentKey, string>>> {
  const selectedCodexHome = options.codexHome ?? deployment.codexHome;
  if (!isAbsolute(selectedCodexHome)) {
    throw new TypeError("Child CODEX_HOME must be absolute.");
  }
  if (
    selectedCodexHome !== deployment.codexHome &&
    !pathContains(deployment.codexHome, selectedCodexHome)
  ) {
    throw new TypeError("Disposable CODEX_HOME must remain beneath the validated dedicated home.");
  }

  const childEnvironment: Partial<Record<CodexFollowUpEnvironmentKey, string>> = {
    HOME: deployment.normalHome,
    CODEX_HOME: selectedCodexHome,
  };
  for (const key of CODEX_FOLLOW_UP_ENVIRONMENT_KEYS) {
    if (key === "HOME" || key === "CODEX_HOME") continue;
    const value = sourceEnvironment[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  return Object.freeze(childEnvironment);
}

export function parentDirectory(path: string) {
  return dirname(path);
}

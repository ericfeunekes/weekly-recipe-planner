import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const CODEX_DISABLED_TOOL_FEATURES = Object.freeze([
  "apps",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_only",
  "computer_use",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "enable_fanout",
  "goals",
  "hooks",
  "image_generation",
  "imagegenext",
  "in_app_browser",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "request_permissions_tool",
  "rollout_budget",
  "shell_tool",
  "skill_mcp_dependency_install",
  "sleep_tool",
  "standalone_web_search",
  "token_budget",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
]);

export const CODEX_THREAD_CAPABILITY_CONFIG = Object.freeze({
  web_search: "disabled",
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  "skills.include_instructions": false,
  "orchestrator.skills.enabled": false,
  "orchestrator.mcp.enabled": false,
  "apps._default.enabled": false,
  "apps._default.destructive_enabled": false,
  "apps._default.open_world_enabled": false,
  ...Object.fromEntries(
    CODEX_DISABLED_TOOL_FEATURES.map((feature) => [`features.${feature}`, false]),
  ),
});

const LOCKDOWN_CONFIG_ARGS = Object.entries(CODEX_THREAD_CAPABILITY_CONFIG).flatMap(
  ([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`],
);

export const DEFAULT_CODEX_APP_SERVER_ARGS = Object.freeze([
  "app-server",
  "--listen",
  "stdio://",
  "--strict-config",
  ...LOCKDOWN_CONFIG_ARGS,
]);

export const DEFAULT_CODEX_EXECUTABLE_PATH = join(
  userInfo().homedir,
  ".local",
  "bin",
  "codex",
);

const SAFE_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "USER",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

export function resolveCodexExecutable(
  command,
  { trustedUids = [0, process.getuid?.()].filter(Number.isInteger) } = {},
) {
  if (typeof command !== "string" || !isAbsolute(command)) {
    throw new Error(
      "Planner ChatGPT requires an absolute Codex executable path.",
    );
  }
  let executable;
  try {
    executable = realpathSync(command);
    accessSync(executable, constants.X_OK);
  } catch {
    throw new Error("The configured planner Codex executable is unavailable.");
  }
  const trustedOwners = new Set(trustedUids);
  const assertTrustedPath = (path, { executableFile = false } = {}) => {
    const stats = statSync(path);
    if (executableFile && !stats.isFile()) {
      throw new Error("The configured planner Codex executable is not a regular file.");
    }
    if (trustedOwners.size > 0 && !trustedOwners.has(stats.uid)) {
      throw new Error("The configured planner Codex executable has an untrusted owner.");
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(
        "The configured planner Codex executable has a group- or world-writable path.",
      );
    }
  };
  assertTrustedPath(executable, { executableFile: true });
  let ancestor = dirname(executable);
  while (true) {
    assertTrustedPath(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return executable;
}

function withoutKeys(params, keys) {
  const safe = { ...params };
  for (const key of keys) delete safe[key];
  return safe;
}

export function lockThreadStartParams(params = {}) {
  const safe = withoutKeys(params, [
    "config",
    "dynamicTools",
    "environments",
    "permissions",
    "runtimeWorkspaceRoots",
    "selectedCapabilityRoots",
  ]);
  return {
    ...safe,
    approvalPolicy: "never",
    config: CODEX_THREAD_CAPABILITY_CONFIG,
    dynamicTools: [],
    environments: [],
    runtimeWorkspaceRoots: [],
    sandbox: "read-only",
    selectedCapabilityRoots: [],
  };
}

export function lockTurnStartParams(params = {}) {
  const safe = withoutKeys(params, [
    "approvalPolicy",
    "cwd",
    "environments",
    "permissions",
    "runtimeWorkspaceRoots",
    "sandboxPolicy",
  ]);
  return {
    ...safe,
    approvalPolicy: "never",
    environments: [],
    runtimeWorkspaceRoots: [],
  };
}

function sourceAuthFile(env) {
  if (env.PLANNER_CODEX_AUTH_FILE) return resolve(env.PLANNER_CODEX_AUTH_FILE);
  return join(userInfo().homedir, ".codex", "auth.json");
}

function assertUsableAuthFile(path, explicit) {
  if (!existsSync(path)) {
    if (explicit) {
      throw new Error("Planner Codex authentication is unavailable.");
    }
    return false;
  }
  try {
    if (!statSync(path).isFile()) {
      throw new Error("invalid auth path");
    }
    // Parse once before exposing the path to Codex. This catches stale links and
    // partial credential writes without retaining credential contents here.
    JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Planner Codex authentication is unavailable.");
  }
  return true;
}

export function createIsolatedCodexRuntimeEnvironment(baseEnv = process.env) {
  const runtimeHome = mkdtempSync(join(tmpdir(), "weekly-recipe-planner-codex-"));
  const authFile = sourceAuthFile(baseEnv);
  try {
    if (assertUsableAuthFile(authFile, Boolean(baseEnv.PLANNER_CODEX_AUTH_FILE))) {
      symlinkSync(authFile, join(runtimeHome, "auth.json"));
    }
  } catch {
    rmSync(runtimeHome, { recursive: true, force: true });
    throw new Error("Planner Codex authentication is unavailable.");
  }

  let cleaned = false;
  const inheritedEnvironment = Object.fromEntries(
    SAFE_INHERITED_ENVIRONMENT_KEYS.flatMap((key) =>
      baseEnv[key] === undefined ? [] : [[key, baseEnv[key]]],
    ),
  );
  const env = {
    ...inheritedEnvironment,
    HOME: runtimeHome,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: runtimeHome,
    CODEX_HOME: runtimeHome,
    CODEX_SQLITE_HOME: runtimeHome,
  };
  return {
    env,
    runtimeHome,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(runtimeHome, { recursive: true, force: true });
    },
  };
}

import { resolve } from "node:path";

function watchedArtifactDirectory(path, resolvePath) {
  return path ? `${escapeGlob(resolvePath(path))}/**` : undefined;
}

function escapeGlob(path) {
  return path.replace(/[\\*?\[\]{}()!+@]/g, "\\$&");
}

export function e2eArtifactWatch(environment, resolvePath = resolve) {
  const outputDirectory = environment.PLANNER_E2E_OUTPUT_DIR;
  const seatbeltWatch = environment.CODEX_SANDBOX === "seatbelt"
    ? { useFsEvents: false, usePolling: true }
    : undefined;
  if (!outputDirectory) return seatbeltWatch;

  const ignored = [
    watchedArtifactDirectory(outputDirectory, resolvePath),
    environment.PLANNER_E2E_WRANGLER_LOG_PATH
      ? escapeGlob(resolvePath(environment.PLANNER_E2E_WRANGLER_LOG_PATH))
      : undefined,
    watchedArtifactDirectory(environment.PLANNER_E2E_EVIDENCE_DIR, resolvePath),
  ].flatMap((path) => path ? [path] : []);

  return {
    ...seatbeltWatch,
    ...(ignored.length > 0 ? { ignored } : {}),
  };
}

/**
 * Files excluded from the immutable application bundle. The embedded Codex
 * runtime owns its instructions/configuration in the separate agent root and
 * rejects project-local capability sources in its fixed application cwd.
 */
const EXCLUDED_TOP_LEVEL_ENTRIES = new Set([
  ".git",
  ".planner-data",
  "coverage",
  "node_modules",
  "outputs",
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
]);

export function shouldStageApplicationPath(source, sourceRoot) {
  const relativePath = source.slice(sourceRoot.length).replace(/^[/\\]+/u, "");
  const topLevelEntry = relativePath.split(/[\\/]/u, 1)[0];
  if (EXCLUDED_TOP_LEVEL_ENTRIES.has(topLevelEntry)) return false;

  return relativePath !== ".codex" && !relativePath.startsWith(".codex/") &&
    relativePath !== ".claude" && !relativePath.startsWith(".claude/");
}

export const RELEASE_SOURCE_EXCLUDED_ROOTS = Object.freeze([
  ".git",
  ".next",
  ".planner-data",
  ".vercel",
  ".vinext",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "outputs",
  "planner-data",
  "work",
]);

const RELEASE_SOURCE_EXCLUDED_ROOT_SET = new Set(RELEASE_SOURCE_EXCLUDED_ROOTS);

export function isReleaseSourceRelativePathIncluded(relativePath) {
  return typeof relativePath === "string" && relativePath.length > 0 &&
    !RELEASE_SOURCE_EXCLUDED_ROOT_SET.has(relativePath.split("/")[0]);
}

export function releaseSourceExclusionSet() {
  return new Set(RELEASE_SOURCE_EXCLUDED_ROOTS);
}

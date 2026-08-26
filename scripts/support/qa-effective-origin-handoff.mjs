import { chmod, link, open, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export function requireOriginHandoffPath(value, stateDirectory) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError("QA_EFFECTIVE_ORIGIN_HANDOFF must be an absolute normalized path.");
  }
  if (typeof stateDirectory !== "string" || !isAbsolute(stateDirectory) || resolve(stateDirectory) !== stateDirectory) {
    throw new TypeError("QA_STATE_DIR must be an absolute normalized path.");
  }
  const pathFromState = relative(stateDirectory, value);
  if (!pathFromState || pathFromState.startsWith("..") || isAbsolute(pathFromState)) {
    throw new TypeError("QA_EFFECTIVE_ORIGIN_HANDOFF must stay inside QA_STATE_DIR.");
  }
  return value;
}

export async function writeEffectiveOriginHandoff(path, origin) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${origin}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

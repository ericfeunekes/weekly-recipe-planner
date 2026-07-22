import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function assertDisposableReleaseProbeProfile({ home, label, paths }) {
  const disposableRoot = join(await realpath(tmpdir()), "wrp-release-");
  const disposableHome = (await realpath(home)).startsWith(disposableRoot);
  const disposableLabel = label.startsWith("com.ericfeunekes.meal-planner.qa.");
  const disposableDatabase = paths.data === join(resolve(home), "meal-planner", "data", "planner.sqlite");
  if (!disposableHome || !disposableLabel || !disposableDatabase) {
    throw new Error("Disposable release probe hooks are limited to the generated release-lifecycle profile.");
  }
}

export async function waitForDisposableReleaseProbeBarrier({ id, operation, home, label, paths }) {
  if (!id) return false;
  if (operation !== "promotion" && operation !== "recovery") {
    throw new Error("Disposable release probe barrier operation is invalid.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error(`PLANNER_PROBE_${operation.toUpperCase()}_BARRIER is invalid.`);
  }
  await assertDisposableReleaseProbeProfile({ home, label, paths });
  const directory = join(home, `.release-probe-${operation}-barriers`, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `participant-${process.pid}`), "ready\n", { flag: "wx", mode: 0o600 });
  // Two shipped promotions each run the full gate before entering this barrier.
  // Under parallel local load one can finish several minutes before the other.
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if ((await readdir(directory)).filter((name) => name.startsWith("participant-")).length >= 2) return true;
    await delay(100);
  }
  throw new Error(`Disposable ${operation} barrier timed out waiting for two participants.`);
}

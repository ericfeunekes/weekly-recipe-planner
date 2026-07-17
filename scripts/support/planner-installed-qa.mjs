import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PlannerReleaseError } from "./planner-release-contract.mjs";
import { isReleaseSourceRelativePathIncluded } from "./planner-release-source.mjs";
import { inspectReleaseTreeIdentity } from "./planner-release-transaction.mjs";
import {
  acquireRuntimeOwnershipLease,
} from "./runtime-ownership.mjs";
import { createQaEvidenceManifest } from "./planner-qa-evidence.mjs";
import {
  NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
} from "./planner-release-evidence-contract.mjs";
import {
  CODEX_THREAD_API_ROUTES,
  isCodexApiFailure,
  isCodexInteractionListResponse,
  isCodexInteractionMutationResponse,
  isCodexThreadListResponse,
  isCodexThreadMutationResponse,
  isCodexThreadReadResponse,
  isCodexTurnMutationResponse,
} from "../../lib/codex-thread-contract.ts";

const QA_TIMEOUT_MS = 120_000;
const INSTALLED_NATIVE_TIMEOUT_MS = 15_000;
const SHA256 = /^[a-f0-9]{64}$/u;

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathInsideOrEqual(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${label} must be an absolute normalized path.`);
  }
  return value;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new PlannerReleaseError("Installed QA requires current-user mode-0700 directories.");
  }
  return realpath(path);
}

function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.kill("SIGTERM");
  });
}

function waitForReadableEnd(stream) {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolveEnd) => {
    const finish = () => {
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", finish);
      resolveEnd();
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}

async function waitForHttp(url, predicate = (response) => response.ok, timeoutMs = QA_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (await predicate(response)) return;
      last = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new PlannerReleaseError(`Installed QA readiness timed out (${last}).`);
}

async function runLoggedCommand(command, args, options) {
  await mkdir(join(options.logPath, ".."), { recursive: true, mode: 0o700 });
  const log = await open(options.logPath, "wx", 0o600);
  const stderrPath = `${options.logPath}.stderr.log`;
  const stderrLog = await open(stderrPath, "wx", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", log.fd, stderrLog.fd],
    });
    const result = await new Promise((resolveChild, rejectChild) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 600_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectChild(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolveChild({ code, signal });
      });
    });
    if (result.code !== 0 || result.signal !== null) {
      const detail = [
        await readFile(stderrPath, "utf8"),
        await readFile(options.logPath, "utf8"),
      ].map((value) => value.trim()).filter(Boolean).join("\n").slice(-1_000);
      throw new PlannerReleaseError(
        `Installed QA command failed (${detail || result.signal || result.code}).`,
      );
    }
    const stderr = await readFile(stderrPath, "utf8");
    if (options.allowStderr !== true && stderr.length !== 0) {
      throw new PlannerReleaseError(
        `Installed QA command wrote unexpected stderr (${stderr.trim().slice(0, 1_000)}).`,
      );
    }
  } finally {
    await Promise.all([
      log.close().catch(() => undefined),
      stderrLog.close().catch(() => undefined),
    ]);
  }
}

async function startFrozenWeb(options) {
  const log = await open(options.logPath, "wx", 0o600);
  let logWrites = Promise.resolve();
  const writeLog = (chunk) => {
    logWrites = logWrites.then(() => log.write(chunk));
  };
  const child = spawn(
    options.nodeExecutable,
    [
      join(options.appRoot, "node_modules", "vinext", "dist", "cli.js"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: options.appRoot,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", writeLog);
  child.stderr.on("data", writeLog);
  const outputEnded = Promise.all([
    waitForReadableEnd(child.stdout),
    waitForReadableEnd(child.stderr),
  ]);
  let stdout = "";
  const originPromise = new Promise((resolveOrigin, rejectOrigin) => {
    const timeout = setTimeout(() => {
      rejectOrigin(new PlannerReleaseError("Frozen Vinext did not report its bound port."));
    }, QA_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 16 * 1024) stdout += chunk.toString("utf8");
      const match = stdout.match(/Production server running at (http:\/\/127\.0\.0\.1:\d+)/u);
      if (!match) return;
      clearTimeout(timeout);
      resolveOrigin(match[1]);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectOrigin(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectOrigin(new PlannerReleaseError(
        `Frozen Vinext exited before reporting readiness (${signal ?? code}).`,
      ));
    });
  });
  try {
    const origin = await originPromise;
    await waitForHttp(origin);
    return Object.freeze({
      origin,
      async close() {
        await waitForChildExit(child);
        await outputEnded;
        await logWrites;
        await log.close().catch(() => undefined);
      },
    });
  } catch (error) {
    await waitForChildExit(child);
    await outputEnded;
    await logWrites;
    await log.close().catch(() => undefined);
    throw error;
  }
}

async function walkGeneratedFiles(root, callback) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new PlannerReleaseError("Installed browser assets contain a symbolic link.");
      }
      if (metadata.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new PlannerReleaseError("Installed browser assets contain a special file.");
      }
      if (metadata.size > 32 * 1024 * 1024) continue;
      await callback(path, await readFile(path));
    }
  }
}

export async function assertNoForbiddenInstalledAssetReferences({
  canonicalAppRoot,
  forbiddenRoots,
}) {
  const canonical = await realpath(requireAbsolute(canonicalAppRoot, "canonicalAppRoot"));
  const generatedRoot = join(canonical, "dist");
  const roots = [...new Set((forbiddenRoots ?? []).map((root) =>
    requireAbsolute(root, "forbiddenAssetRoot")))].filter(
      (root) => !pathInsideOrEqual(canonical, root),
    );
  await walkGeneratedFiles(generatedRoot, (path, bytes) => {
    for (const root of roots) {
      if (bytes.includes(Buffer.from(root))) {
        throw new PlannerReleaseError(
          `Installed browser asset ${relative(canonical, path)} references a staging or baseline path.`,
        );
      }
    }
  });
  return true;
}

async function importInstalledModule(appRoot, relativePath) {
  const path = join(appRoot, relativePath);
  return import(pathToFileURL(path).href);
}

async function inspectStandaloneTreeIdentity(root) {
  const digest = createHash("sha256");
  const pending = [root];
  let fileCount = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (!isReleaseSourceRelativePathIncluded(relativePath)) continue;
      const metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        digest.update(`d\0${relativePath}\0${metadata.mode & 0o777}\0`);
        pending.push(path);
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const target = await readlink(path);
        digest.update(`l\0${relativePath}\0${target}\0`);
        fileCount += 1;
        totalBytes += Buffer.byteLength(target);
        continue;
      }
      if (!metadata.isFile()) {
        throw new PlannerReleaseError("Standalone installed QA rejects special files.");
      }
      const bytes = await readFile(path);
      digest.update(`f\0${relativePath}\0${metadata.mode & 0o777}\0${bytes.length}\0`);
      digest.update(bytes);
      fileCount += 1;
      totalBytes += bytes.length;
    }
  }
  return Object.freeze({
    exists: true,
    kind: "directory",
    sha256: digest.digest("hex"),
    fileCount,
    totalBytes,
  });
}

async function createCandidateClone(appRoot, candidateDataPath, destination, dependencies) {
  await ensurePrivateDirectory(resolve(destination, ".."));
  const storeModule = dependencies.storeModule ?? await importInstalledModule(
    appRoot,
    "server/store/sqlite-store.ts",
  );
  const reservation = storeModule.acquirePlannerStoreWriteReservation({
    filename: candidateDataPath,
  });
  try {
    return await reservation.createVerifiedSnapshot(destination);
  } finally {
    reservation.close();
  }
}

async function requestJson(origin, path, options = {}) {
  const response = await fetch(`${origin}${path}`, options);
  const text = await response.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return { response, body };
}

function codexQuery(path, values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix.length === 0 ? path : `${path}?${suffix}`;
}

function assertInstalledNativeResponse(result, expectedStatus, validator, label) {
  if (result.response.status !== expectedStatus || !validator(result.body)) {
    throw new PlannerReleaseError(
      `${label} returned an invalid native response (HTTP ${result.response.status}).`,
    );
  }
  return result.body;
}

async function installedNativeGet(origin, path, validator, label) {
  return assertInstalledNativeResponse(
    await requestJson(origin, path),
    200,
    validator,
    label,
  );
}

async function installedNativePost(origin, route, body, expectedStatus, validator, label) {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  return assertInstalledNativeResponse(
    await requestJson(origin, route.path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: serialized,
    }),
    expectedStatus,
    validator,
    label,
  );
}

async function readInstalledNativeThread(origin, threadId) {
  return installedNativeGet(
    origin,
    codexQuery(CODEX_THREAD_API_ROUTES.threadRead.path, { threadId }),
    isCodexThreadReadResponse,
    "Installed native thread read",
  );
}

async function waitForInstalledNativeThread(origin, threadId, predicate, label) {
  const deadline = Date.now() + INSTALLED_NATIVE_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await readInstalledNativeThread(origin, threadId);
    if (predicate(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new PlannerReleaseError(
    `${label} did not converge (${last?.thread?.status?.state ?? "unknown"}).`,
  );
}

function installedTurn(readback, turnId) {
  return readback.thread.turns.find((turn) => turn.id === turnId) ?? null;
}

async function bootstrapIfNeeded(origin) {
  let workspace = (await requestJson(origin, "/api/workspace")).body;
  if (workspace?.initialized) return workspace;
  const created = await requestJson(origin, "/api/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ requestId: randomUUID(), mode: "seed" }),
  });
  if (!created.response.ok || !created.body?.workspace?.initialized) {
    throw new PlannerReleaseError("Installed QA could not initialize its cloned planner data.");
  }
  workspace = created.body.workspace;
  return workspace;
}

export async function proveInstalledBoundaries(options) {
  let controller = await options.e2eRuntime.createInProcessInstalledE2eController({
    appRoot: options.appRoot,
    dataDirectory: options.dataDirectory,
    webOrigin: options.webOrigin,
    publicPort: options.publicPort,
    controlPort: 0,
    runtimeOwnershipLease: options.runtimeOwnershipLease,
    runtimeOwnershipSocketPath: options.runtimeOwnershipSocketPath,
    globalCodexParentDirectory: options.globalCodexParentDirectory,
    markerRoot: options.markerRoot,
  }, options.controllerDependencies);
  try {
    await waitForHttp(`${controller.apiOrigin}/api/health`, async (response) => {
      if (!response.ok) return false;
      const body = await response.json();
      return body?.application?.status === "ready" &&
        body?.store?.status === "ready" && body?.globalCodex?.status === "ready";
    });
    const nativeBeforeRestart = await installedNativeGet(
      controller.apiOrigin,
      codexQuery(CODEX_THREAD_API_ROUTES.threadsList.path, { limit: 1 }),
      isCodexThreadListResponse,
      "Installed native history",
    );
    const primary = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.threadNew,
      {
        requestId: randomUUID(),
        expectedSelectionRevision: nativeBeforeRestart.selection.revision,
      },
      201,
      isCodexThreadMutationResponse,
      "Installed native thread creation",
    );
    if (primary.thread === null || primary.selection.threadId !== primary.thread.id) {
      throw new PlannerReleaseError("Installed native thread creation did not select its root.");
    }
    const primaryThreadId = primary.thread.id;

    const questionAdmission = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.turnSend,
      {
        requestId: randomUUID(),
        threadId: primaryThreadId,
        expectedSelectionRevision: primary.selection.revision,
        clientUserMessageId: `installed-question-${randomUUID()}`,
        message: "Installed QA native question proof.",
      },
      202,
      isCodexTurnMutationResponse,
      "Installed native question admission",
    );
    const pendingQuestion = await waitForInstalledNativeThread(
      controller.apiOrigin,
      primaryThreadId,
      (readback) => readback.interactions.some((interaction) =>
        interaction.kind === "user_input" && interaction.turnId === questionAdmission.turnId
      ),
      "Installed native question",
    );
    const listedInteractions = await installedNativeGet(
      controller.apiOrigin,
      codexQuery(CODEX_THREAD_API_ROUTES.interactionsList.path, {
        threadId: primaryThreadId,
      }),
      isCodexInteractionListResponse,
      "Installed native interaction list",
    );
    const question = listedInteractions.interactions.find((interaction) =>
      interaction.kind === "user_input" && interaction.turnId === questionAdmission.turnId
    );
    const questionEntry = question?.questions[0];
    const selectedOption = questionEntry?.options[0]?.label;
    if (!question || !questionEntry || typeof selectedOption !== "string") {
      throw new PlannerReleaseError("Installed native question omitted its typed option surface.");
    }
    await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.interactionRespond,
      {
        requestId: randomUUID(),
        threadId: primaryThreadId,
        expectedSelectionRevision: pendingQuestion.selection.revision,
        interactionId: question.id,
        response: {
          kind: "answers",
          answers: [{ questionId: questionEntry.id, answers: [selectedOption] }],
        },
      },
      200,
      isCodexInteractionMutationResponse,
      "Installed native question response",
    );
    await waitForInstalledNativeThread(
      controller.apiOrigin,
      primaryThreadId,
      (readback) => installedTurn(readback, questionAdmission.turnId)?.status === "completed" &&
        !readback.interactions.some((interaction) => interaction.id === question.id),
      "Installed native question resolution",
    );

    const activityRequest = {
      requestId: randomUUID(),
      threadId: primaryThreadId,
      expectedSelectionRevision: primary.selection.revision,
      clientUserMessageId: `installed-activity-${randomUUID()}`,
      message: "Installed QA native activity and worker proof.",
    };
    const serializedActivityRequest = JSON.stringify(activityRequest);
    const activityAdmission = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.turnSend,
      serializedActivityRequest,
      202,
      isCodexTurnMutationResponse,
      "Installed native activity admission",
    );
    const activityReplay = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.turnSend,
      serializedActivityRequest,
      202,
      isCodexTurnMutationResponse,
      "Installed native activity exact replay",
    );
    if (
      activityReplay.threadId !== activityAdmission.threadId ||
      activityReplay.turnId !== activityAdmission.turnId
    ) {
      throw new PlannerReleaseError("Installed native admission replay changed provider identity.");
    }
    const changedReuse = await requestJson(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.turnSend.path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: controller.apiOrigin },
        body: JSON.stringify({ ...activityRequest, message: "Changed installed native reuse." }),
      },
    );
    if (
      changedReuse.response.status !== 409 ||
      !isCodexApiFailure(changedReuse.body) ||
      changedReuse.body.error.code !== "REQUEST_ID_REUSE"
    ) {
      throw new PlannerReleaseError("Installed native changed-payload replay did not fail closed.");
    }
    const activityReadback = await waitForInstalledNativeThread(
      controller.apiOrigin,
      primaryThreadId,
      (readback) => installedTurn(readback, activityAdmission.turnId)?.status === "completed" &&
        readback.thread.workers.length === 1,
      "Installed native activity and worker readback",
    );
    const activityTurn = installedTurn(activityReadback, activityAdmission.turnId);
    const plannerActivity = activityTurn?.items.find((item) =>
      item.kind === "activity" && item.category === "tool" &&
      item.label === "Reading the planner" && item.status === "completed"
    );
    const webActivity = activityTurn?.items.find((item) =>
      item.kind === "activity" && item.category === "web" &&
      item.label === "Opening a source" && item.status === "completed"
    );
    const workerActivity = activityTurn?.items.find((item) =>
      item.kind === "worker" && item.operation === "wait" && item.status === "completed" &&
      item.workerStates.length === 1 && item.workerStates[0]?.status === "completed"
    );
    const workerSummary = activityReadback.thread.workers[0];
    if (!plannerActivity || !webActivity || !workerActivity || !workerSummary ||
        !workerActivity.workerThreadIds.includes(workerSummary.threadId)) {
      throw new PlannerReleaseError(
        "Installed native readback omitted typed activity or worker projections.",
      );
    }
    const workerReadback = await readInstalledNativeThread(
      controller.apiOrigin,
      workerSummary.threadId,
    );
    if (
      workerReadback.thread.threadKind !== "worker" ||
      workerReadback.thread.parentThreadId !== primaryThreadId
    ) {
      throw new PlannerReleaseError("Installed native worker readback changed its ancestry.");
    }
    const listedPrimary = await installedNativeGet(
      controller.apiOrigin,
      codexQuery(CODEX_THREAD_API_ROUTES.threadsList.path, { limit: 50 }),
      isCodexThreadListResponse,
      "Installed materialized native history",
    );
    if (!listedPrimary.threads.some((thread) => thread.id === primaryThreadId)) {
      throw new PlannerReleaseError("Installed native history omitted its materialized root.");
    }

    const secondary = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.threadNew,
      {
        requestId: randomUUID(),
        expectedSelectionRevision: activityReadback.selection.revision,
      },
      201,
      isCodexThreadMutationResponse,
      "Installed secondary native thread creation",
    );
    if (secondary.thread === null) {
      throw new PlannerReleaseError("Installed secondary native thread omitted its root.");
    }
    const secondaryThreadId = secondary.thread.id;
    const interruptAdmission = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.turnSend,
      {
        requestId: randomUUID(),
        threadId: secondaryThreadId,
        expectedSelectionRevision: secondary.selection.revision,
        clientUserMessageId: `installed-interrupt-${randomUUID()}`,
        message: "Installed QA native interrupt proof.",
      },
      202,
      isCodexTurnMutationResponse,
      "Installed native interrupt admission",
    );
    await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.turnInterrupt,
      {
        requestId: randomUUID(),
        threadId: secondaryThreadId,
        expectedSelectionRevision: secondary.selection.revision,
        turnId: interruptAdmission.turnId,
      },
      200,
      isCodexTurnMutationResponse,
      "Installed native interrupt",
    );
    await waitForInstalledNativeThread(
      controller.apiOrigin,
      secondaryThreadId,
      (readback) => installedTurn(readback, interruptAdmission.turnId)?.status === "interrupted",
      "Installed native interrupted readback",
    );
    const archivedSecondary = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.threadArchive,
      {
        requestId: randomUUID(),
        threadId: secondaryThreadId,
        expectedSelectionRevision: secondary.selection.revision,
      },
      200,
      isCodexThreadMutationResponse,
      "Installed native archive",
    );
    const selectedPrimary = await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.threadSelect,
      {
        requestId: randomUUID(),
        threadId: primaryThreadId,
        expectedSelectionRevision: archivedSecondary.selection.revision,
      },
      200,
      isCodexThreadMutationResponse,
      "Installed native selection",
    );
    let workspace = await bootstrapIfNeeded(controller.apiOrigin);
    const weekId = workspace.state.activeWeekId;
    if (typeof weekId !== "string") {
      throw new PlannerReleaseError("Installed QA cloned data has no active week.");
    }
    const globalModule = await importInstalledModule(
      options.appRoot,
      "scripts/support/codex-live-proof.mjs",
    );
    const runGlobal = globalModule.createHostOnlyGlobalClientRunner(
      controller.globalCodexSocketPath,
    );
    const [udsHealth, udsWorkspace] = await Promise.all([
      runGlobal("health", null),
      runGlobal("workspace", null),
    ]);
    if (udsHealth.status !== "ready" || !udsWorkspace.planner?.initialized) {
      throw new PlannerReleaseError("Installed QA Global UDS did not read the cloned planner.");
    }

    const basePlannerVersion = workspace.plannerVersion;
    const globalRequestId = randomUUID();
    const globalLesson = `Installed UDS ${randomUUID().slice(0, 8)}`;
    const browserLesson = `Installed HTTP ${randomUUID().slice(0, 8)}`;
    const globalBatch = {
      contractVersion: 1,
      requestId: globalRequestId,
      basePlannerVersion,
      operations: [{ command: {
        type: "captureWeekLesson",
        weekId,
        weekLesson: globalLesson,
      } }],
    };
    const serializedGlobalBatch = JSON.stringify(globalBatch);
    const [httpResult, globalResult] = await Promise.all([
      requestJson(controller.apiOrigin, "/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: controller.apiOrigin },
        body: JSON.stringify({
          requestId: randomUUID(),
          basePlannerVersion,
          command: {
            type: "captureWeekLesson",
            weekId,
            weekLesson: browserLesson,
          },
        }),
      }),
      runGlobal("apply", serializedGlobalBatch),
    ]);
    const decisions = [httpResult.body?.decision, globalResult.decision];
    if (
      decisions.filter((decision) => decision?.status === "accepted").length !== 1 ||
      decisions.filter((decision) => decision?.status === "version_conflict").length !== 1
    ) {
      throw new PlannerReleaseError("Installed QA multi-ingress OCC did not serialize one writer.");
    }
    const replay = await runGlobal("apply", serializedGlobalBatch);
    const changed = await runGlobal("apply", JSON.stringify({
      ...globalBatch,
      operations: [{ command: {
        ...globalBatch.operations[0].command,
        weekLesson: `${globalLesson} changed`,
      } }],
    }));
    if (
      JSON.stringify(replay.decision) !== JSON.stringify(globalResult.decision) ||
      changed.error?.code !== "request_id_reuse"
    ) {
      throw new PlannerReleaseError("Installed QA Global UDS replay contract failed.");
    }
    workspace = (await requestJson(controller.apiOrigin, "/api/workspace")).body;
    const versionBeforeRestart = workspace.plannerVersion;
    const epochBeforeRestart = activityReadback.connectionEpoch;
    await controller.restart();
    const restarted = (await requestJson(controller.apiOrigin, "/api/workspace")).body;
    const restartedNative = await installedNativeGet(
      controller.apiOrigin,
      codexQuery(CODEX_THREAD_API_ROUTES.threadsList.path, { limit: 50 }),
      isCodexThreadListResponse,
      "Restarted installed native history",
    );
    const restartedArchived = await installedNativeGet(
      controller.apiOrigin,
      codexQuery(CODEX_THREAD_API_ROUTES.threadsList.path, { archived: true, limit: 50 }),
      isCodexThreadListResponse,
      "Restarted installed native archive history",
    );
    const restartedPrimary = await readInstalledNativeThread(
      controller.apiOrigin,
      primaryThreadId,
    );
    const restartedUds = await runGlobal("health", null);
    const restartStatus = (await requestJson(controller.controlOrigin, "/status")).body;
    if (
      restarted.plannerVersion !== versionBeforeRestart ||
      restartedNative.selection.threadId !== primaryThreadId ||
      !restartedNative.threads.some((thread) => thread.id === primaryThreadId) ||
      restartedNative.threads.some((thread) => thread.id === secondaryThreadId) ||
      !restartedArchived.threads.some((thread) => thread.id === secondaryThreadId) ||
      restartedNative.connectionEpoch === epochBeforeRestart ||
      installedTurn(restartedPrimary, activityAdmission.turnId)?.status !== "completed" ||
      !restartedPrimary.thread.workers.some((worker) =>
        worker.threadId === workerSummary.threadId && worker.status === "completed"
      ) ||
      restartedUds.status !== "ready" ||
      restartStatus?.lastRestartProof?.mode !== "graceful" ||
      restartStatus.lastRestartProof.authorityGenerationAdvanced !== true ||
      restartStatus.lastRestartProof.sameProcessLeaseRetained !== true ||
      restartStatus.lastRestartProof.listenerClosed !== true ||
      restartStatus.lastRestartProof.storeClosed !== true
    ) {
      throw new PlannerReleaseError("Installed QA restart lost HTTP or Global UDS state.");
    }
    await installedNativePost(
      controller.apiOrigin,
      CODEX_THREAD_API_ROUTES.threadArchive,
      {
        requestId: randomUUID(),
        threadId: primaryThreadId,
        expectedSelectionRevision: selectedPrimary.selection.revision,
      },
      200,
      isCodexThreadMutationResponse,
      "Restarted installed primary native archive",
    );
    return Object.freeze({
      clonedDataLoaded: true,
      httpReady: true,
      globalUdsReady: true,
      multiIngressSerialized: true,
      exactReplay: true,
      changedPayloadRejected: true,
      restartReadback: true,
      nativeThreadHttpReady: true,
      nativeThreadCreateListSelect: true,
      nativeThreadSendExactReplay: true,
      nativeThreadChangedReplayRejected: true,
      nativeThreadReadback: true,
      nativeThreadActivityObserved: true,
      nativeThreadWorkerReadback: true,
      nativeThreadQuestionAnswered: true,
      nativeThreadInterruptReadback: true,
      nativeThreadArchiveHistory: true,
      nativeThreadRestartReadback: true,
      gracefulRestart: true,
    });
  } finally {
    await controller.close();
  }
}

async function runBoundarySuites(options) {
  const testFiles = [
    "tests/http-application.test.mjs",
    "tests/codex-native-thread-service.test.mjs",
    "tests/architecture/legacy-conversation-cutover.test.mjs",
  ];
  await runLoggedCommand(options.nodeExecutable, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "--test",
    ...testFiles,
  ], {
    cwd: options.appRoot,
    env: options.environment,
    logPath: join(options.evidenceRoot, "logs", "boundary-tests.log"),
  });
  return Object.freeze({
    http: true,
    nativeThreadService: true,
    legacyConversationCutover: true,
    fileCount: testFiles.length,
  });
}

async function runInstalledPlaywright(options) {
  const browserDataRoot = await ensurePrivateDirectory(
    join(options.qaInvocationRoot, "browser-data"),
  );
  const browserClone = await createCandidateClone(
    options.appRoot,
    options.selectedCandidateDataPath,
    join(browserDataRoot, "planner.sqlite"),
    options.cloneDependencies,
  );
  if (!SHA256.test(browserClone.sha256 ?? "") || browserClone.quickCheck !== "ok") {
    throw new PlannerReleaseError("Installed browser QA candidate clone failed verification.");
  }
  const browserMarkerRoot = await ensurePrivateDirectory(
    join(options.qaInvocationRoot, "browser-markers"),
  );
  let controller = await options.e2eRuntime.createInProcessInstalledE2eController({
    appRoot: options.appRoot,
    dataDirectory: browserDataRoot,
    webOrigin: options.webOrigin,
    publicPort: 0,
    controlPort: 0,
    runtimeOwnershipLease: options.runtimeOwnershipLease,
    runtimeOwnershipSocketPath: options.runtimeOwnershipSocketPath,
    globalCodexParentDirectory: options.shortUdsParent,
    markerRoot: browserMarkerRoot,
  }, options.controllerDependencies);
  try {
    const outputRoot = await ensurePrivateDirectory(
      join(options.evidenceRoot, "playwright"),
    );
    const workspace = (await requestJson(controller.apiOrigin, "/api/workspace")).body;
    if (
      workspace?.initialized !== true ||
      !Number.isSafeInteger(workspace.plannerVersion) ||
      !Number.isSafeInteger(workspace.syncRevision) ||
      !Number.isSafeInteger(workspace.schemaVersion) ||
      typeof workspace.state?.activeWeekId !== "string"
    ) {
      throw new PlannerReleaseError(
        "Installed browser QA requires an initialized selected-data clone.",
      );
    }
    const baseEnvironment = {
      ...options.environment,
      PLANNER_E2E_WEB_MODE: "installed-production",
      PLANNER_E2E_EXTERNAL_SERVERS: "1",
      PLANNER_E2E_BASE_URL: controller.apiOrigin,
      PLANNER_E2E_CONTROL_ORIGIN: controller.controlOrigin,
      PLANNER_E2E_WEB_ORIGIN: options.webOrigin,
      PLANNER_E2E_WRANGLER_LOG_PATH: join(outputRoot, "wrangler.log"),
    };
    const playwrightCli = join(
      options.appRoot,
      "node_modules",
      "@playwright",
      "test",
      "cli.js",
    );
    await runLoggedCommand(options.nodeExecutable, [
      playwrightCli,
      "test",
      "tests/e2e/installed-selected-clone.spec.ts",
    ], {
      cwd: options.appRoot,
      env: {
        ...baseEnvironment,
        PLANNER_E2E_OUTPUT_DIR: join(outputRoot, "selected-clone-results"),
        PLANNER_E2E_SELECTED_CLONE_EXPECTED: JSON.stringify({
          activeWeekId: workspace.state.activeWeekId,
          plannerVersion: workspace.plannerVersion,
          schemaVersion: workspace.schemaVersion,
          syncRevision: workspace.syncRevision,
        }),
      },
      logPath: join(outputRoot, "selected-clone.log"),
      timeoutMs: 180_000,
    });
    await controller.close();
    controller = null;
    return Object.freeze({
      mode: "installed-production",
      frozenVinextStart: true,
      selectedCloneSha256: browserClone.sha256,
      selectedCloneBrowserReadback: true,
    });
  } finally {
    await controller?.close();
  }
}

function qaEnvironment(source, qaInvocationRoot) {
  const cacheRoot = join(qaInvocationRoot, "cache");
  const tempRoot = join(qaInvocationRoot, "tmp");
  const deterministicSource = { ...source };
  delete deterministicSource.FORCE_COLOR;
  delete deterministicSource.NO_COLOR;
  return {
    ...deterministicSource,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    XDG_CACHE_HOME: cacheRoot,
    WRANGLER_LOG_PATH: join(qaInvocationRoot, "wrangler.log"),
  };
}

export async function runInstalledPlannerQa(options, dependencies = {}) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Installed QA options are required.");
  }
  const canonicalAppRoot = await realpath(requireAbsolute(
    options.canonicalAppRoot,
    "canonicalAppRoot",
  ));
  if (canonicalAppRoot !== options.canonicalAppRoot) {
    throw new PlannerReleaseError("Installed QA requires the real canonical app path.");
  }
  const candidateDataPath = await realpath(requireAbsolute(
    options.candidateDataPath,
    "candidateDataPath",
  ));
  if (candidateDataPath !== options.candidateDataPath) {
    throw new PlannerReleaseError("Installed QA requires the real selected data path.");
  }
  const qaRoot = await ensurePrivateDirectory(requireAbsolute(options.qaRoot, "qaRoot"));
  const runtimeOwnershipSocketPath = requireAbsolute(
    options.runtimeOwnershipSocketPath,
    "runtimeOwnershipSocketPath",
  );
  if (options.runtimeOwnershipLease === null || typeof options.runtimeOwnershipLease !== "object") {
    throw new TypeError("Installed QA requires the activation's in-memory owner lease.");
  }
  if (
    options.expectedInstalledIdentity === null ||
    typeof options.expectedInstalledIdentity !== "object" ||
    !SHA256.test(options.expectedInstalledIdentity.sha256 ?? "")
  ) {
    throw new TypeError("Installed QA requires the exact installed app identity.");
  }
  if (
    options.releaseEvidenceBinding !== undefined &&
    options.releaseEvidenceBinding.releaseCandidateEvidenceSchemaVersion !==
      NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION
  ) {
    throw new TypeError("Installed QA requires native Codex release evidence schema version 2.");
  }

  const inspectIdentity = dependencies.inspectInstalledIdentity ?? inspectReleaseTreeIdentity;
  const before = await inspectIdentity(canonicalAppRoot);
  if (!same(before, options.expectedInstalledIdentity)) {
    throw new PlannerReleaseError("Installed QA app identity differs from installed.json.");
  }
  const assertAssets = dependencies.assertAssets ?? assertNoForbiddenInstalledAssetReferences;
  await assertAssets({
    canonicalAppRoot,
    forbiddenRoots: options.forbiddenAssetRoots ?? [],
  });

  const qaInvocationPath = join(
    qaRoot,
    options.releaseEvidenceBinding === undefined
      ? `installed-${randomUUID()}`
      : "installed-release",
  );
  if (options.releaseEvidenceBinding !== undefined) {
    await rm(qaInvocationPath, { recursive: true, force: true });
  }
  const qaInvocationRoot = await ensurePrivateDirectory(qaInvocationPath);
  await Promise.all([
    ensurePrivateDirectory(join(qaInvocationRoot, "tmp")),
    ensurePrivateDirectory(join(qaInvocationRoot, "cache")),
  ]);
  const evidenceRoot = await ensurePrivateDirectory(join(qaInvocationRoot, "evidence"));
  await ensurePrivateDirectory(join(evidenceRoot, "logs"));
  const environment = qaEnvironment(
    dependencies.environment ?? options.environment ?? process.env,
    qaInvocationRoot,
  );
  const requestedNodeExecutable = requireAbsolute(
    options.nodeExecutable ?? process.execPath,
    "nodeExecutable",
  );
  const nodeExecutable = await realpath(requestedNodeExecutable);
  if (nodeExecutable !== requestedNodeExecutable) {
    throw new PlannerReleaseError("Installed QA requires the canonical Node executable path.");
  }
  const cloneDataRoot = await ensurePrivateDirectory(join(qaInvocationRoot, "cloned-data"));
  const clone = await (dependencies.createCandidateClone ?? createCandidateClone)(
    canonicalAppRoot,
    candidateDataPath,
    join(cloneDataRoot, "planner.sqlite"),
    dependencies,
  );
  if (!SHA256.test(clone.sha256 ?? "") || clone.quickCheck !== "ok") {
    throw new PlannerReleaseError("Installed QA candidate clone failed SQLite verification.");
  }

  let web = null;
  let runtime;
  let boundarySuites;
  let browser;
  try {
    web = await (dependencies.startFrozenWeb ?? startFrozenWeb)({
      appRoot: canonicalAppRoot,
      nodeExecutable,
      environment,
      logPath: join(evidenceRoot, "logs", "vinext-start.log"),
    });
    const loadE2eRuntime = dependencies.loadE2eRuntime ?? importInstalledModule;
    const e2eRuntime = dependencies.e2eRuntime ?? await loadE2eRuntime(
      canonicalAppRoot,
      "tests/support/e2e-runtime.mjs",
    );
    if (typeof web.origin !== "string") {
      throw new PlannerReleaseError("Frozen Vinext did not expose its actual bound origin.");
    }
    const webOrigin = web.origin;
    const directMarkerRoot = await ensurePrivateDirectory(join(qaInvocationRoot, "direct-markers"));
    runtime = await (dependencies.proveBoundaries ?? proveInstalledBoundaries)({
      appRoot: canonicalAppRoot,
      dataDirectory: cloneDataRoot,
      webOrigin,
      publicPort: 0,
      runtimeOwnershipLease: options.runtimeOwnershipLease,
      runtimeOwnershipSocketPath,
      globalCodexParentDirectory: qaRoot,
      markerRoot: directMarkerRoot,
      e2eRuntime,
      controllerDependencies: dependencies.controllerDependencies,
    });
    boundarySuites = await (dependencies.runBoundarySuites ?? runBoundarySuites)({
      appRoot: canonicalAppRoot,
      qaInvocationRoot,
      nodeExecutable,
      environment,
      evidenceRoot,
    });
    browser = await (dependencies.runPlaywright ?? runInstalledPlaywright)({
      appRoot: canonicalAppRoot,
      qaInvocationRoot,
      nodeExecutable,
      environment,
      webOrigin,
      selectedCandidateDataPath: candidateDataPath,
      cloneDependencies: dependencies,
      runtimeOwnershipLease: options.runtimeOwnershipLease,
      runtimeOwnershipSocketPath,
      shortUdsParent: qaRoot,
      e2eRuntime,
      controllerDependencies: dependencies.controllerDependencies,
      evidenceRoot,
    });
  } finally {
    await web?.close();
  }

  await assertAssets({
    canonicalAppRoot,
    forbiddenRoots: options.forbiddenAssetRoots ?? [],
  });
  const after = await inspectIdentity(canonicalAppRoot);
  if (!same(before, after) || !same(after, options.expectedInstalledIdentity)) {
    throw new PlannerReleaseError("Installed QA changed the immutable canonical app identity.");
  }
  let releaseEvidence = null;
  if (options.releaseEvidenceBinding !== undefined) {
    const createdEvidence = await (
      dependencies.createEvidenceManifest ?? createQaEvidenceManifest
    )({
        evidenceRoot,
        appRoot: canonicalAppRoot,
        activationId: options.activationId,
        releaseBinding: options.releaseEvidenceBinding,
      });
    releaseEvidence = Object.freeze({
      relativePath: relative(qaRoot, createdEvidence.manifestPath).split(sep).join("/"),
      sha256: createdEvidence.sha256,
      files: createdEvidence.files,
      bytes: createdEvidence.bytes,
      scenarioIds: createdEvidence.scenarioIds,
      viewportIds: createdEvidence.viewportIds,
      browserVersions: createdEvidence.browserVersions,
      axeVersion: createdEvidence.axeVersion,
    });
  }
  return Object.freeze({
    installedBeforeSha256: before.sha256,
    installedAfterSha256: after.sha256,
    installedUnchanged: true,
    clonedDataSha256: clone.sha256,
    browserAssetsPathSafe: true,
    runtime,
    boundarySuites,
    browser,
    nativeCodexReleaseEvidenceSchemaVersion:
      options.releaseEvidenceBinding?.releaseCandidateEvidenceSchemaVersion ?? null,
    releaseEvidence,
  });
}

async function runStandalone() {
  const appRoot = await realpath(process.cwd());
  await access(join(appRoot, "dist"));
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-installed-qa-")));
  const qaRoot = await ensurePrivateDirectory(join(root, "qa"));
  const dataRoot = await ensurePrivateDirectory(join(root, "candidate-data"));
  const runRoot = await ensurePrivateDirectory(join(root, "run"));
  const candidateDataPath = join(dataRoot, "planner.sqlite");
  const storeModule = await importInstalledModule(appRoot, "server/store/sqlite-store.ts");
  const bootstrapModule = await importInstalledModule(appRoot, "lib/household-bootstrap.ts");
  const store = storeModule.openPlannerStore({ filename: candidateDataPath });
  let seedId = 0;
  const seededAt = Date.parse("2026-07-07T18:00:00-03:00");
  store.transaction((transaction) => store.insertWorkspace(
    transaction,
    bootstrapModule.createCanonicalSeed({
      now: seededAt,
      createId(prefix) {
        seedId += 1;
        return `installed-${prefix}-${seedId}`;
      },
    }),
    seededAt,
  ));
  store.close();
  const runtimeOwnershipSocketPath = join(runRoot, "runtime-owner.sock");
  const lease = await acquireRuntimeOwnershipLease({
    socketPath: runtimeOwnershipSocketPath,
  });
  try {
    const expectedInstalledIdentity = await inspectStandaloneTreeIdentity(appRoot);
    const projection = await runInstalledPlannerQa({
      canonicalAppRoot: appRoot,
      candidateDataPath,
      qaRoot,
      expectedInstalledIdentity,
      runtimeOwnershipLease: lease,
      runtimeOwnershipSocketPath,
      forbiddenAssetRoots: [],
      home: homedir(),
      nodeExecutable: process.execPath,
    }, {
      inspectInstalledIdentity: inspectStandaloneTreeIdentity,
    });
    process.stdout.write(`${JSON.stringify({ qaRoot, projection }, null, 2)}\n`);
  } finally {
    await lease.close();
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  if (process.argv.length !== 3 || process.argv[2] !== "--standalone") {
    throw new TypeError("Usage: planner-installed-qa.mjs --standalone");
  }
  await runStandalone().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
  });
}

#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { startConfiguredPlannerRuntime } from "../server/index.ts";
import {
  CODEX_THREAD_API_ROUTES,
  isCodexApiFailure,
  isCodexInteractionListResponse,
  isCodexInteractionMutationResponse,
  isCodexThreadListResponse,
  isCodexThreadMutationResponse,
  isCodexThreadReadResponse,
  isCodexTurnMutationResponse,
} from "../lib/codex-thread-contract.ts";
import {
  activationCoordinatesEqual,
  activationCoordinatesFromStatus,
  assertEligibleReleaseCandidateArtifact,
  createBoundReleaseCandidateArtifact,
  isReleaseCandidateBinding,
} from "./support/codex-release-candidate-contract.mjs";
import {
  collectCandidateSourceManifest,
  collectNativeReleaseRuntimeRetention,
  readIncompatibleEvidenceProjection,
  readObservedCapabilityProjection,
  createHostOnlyGlobalClientRunner,
} from "./support/codex-live-proof.mjs";
import { createCodexRuntimeFixture } from "./support/codex-runtime-fixture.mjs";
import {
  NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
} from "./support/planner-release-evidence-contract.mjs";

const ARTIFACT_BYTES_LIMIT = 64 * 1_024;
const READINESS_TIMEOUT_MS = 180_000;
const NATIVE_TURN_TIMEOUT_MS = 300_000;
const MACOS_UNIX_SOCKET_PATH_BYTES = 103;
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const QA_OUTPUT_ROOT = join(PACKAGE_ROOT, "outputs", "qa");

export async function createLiveSmokeRoot(environment = process.env) {
  const configuredTempRoot = environment.TMPDIR ?? tmpdir();
  if (!isAbsolute(configuredTempRoot) || configuredTempRoot.includes("\u0000")) {
    throw new TypeError("TMPDIR must be an absolute path.");
  }
  return realpath(await mkdtemp(join(configuredTempRoot, "weekly-planner-live-chat-")));
}

function isWithinQaOutputRoot(path) {
  const fromRoot = relative(QA_OUTPUT_ROOT, path);
  return fromRoot !== "" && fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

export function parseLiveChatSmokeArguments(argv, options = {}) {
  let authorized = false;
  let scenario = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--authorized") {
      if (authorized) throw new TypeError("--authorized may be supplied only once.");
      authorized = true;
      continue;
    }
    if (argument === "--scenario") {
      if (scenario !== null || !argv[index + 1]) {
        throw new TypeError("--scenario requires one value.");
      }
      scenario = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--output") {
      if (output !== null || !argv[index + 1]) {
        throw new TypeError("--output requires one path.");
      }
      output = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new TypeError(`Unsupported argument: ${argument}`);
  }
  if (!authorized) throw new TypeError("The native Codex smoke requires --authorized.");
  if (scenario !== "all") throw new TypeError("The native Codex smoke requires --scenario all.");
  if (!output) throw new TypeError("The native Codex smoke requires --output.");
  const isOutputAllowed = options.isOutputAllowed ?? isWithinQaOutputRoot;
  if (!output.endsWith(".json") || !isOutputAllowed(output)) {
    throw new TypeError(
      options.outputError ??
        "--output must be a JSON path beneath the package outputs/qa directory.",
    );
  }
  return Object.freeze({ authorized: true, scenario: "all", output });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function writePrivateLiveChatArtifact(path, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > ARTIFACT_BYTES_LIMIT) {
    throw new Error("The native Codex smoke artifact exceeded its closed byte limit.");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const written = await lstat(path);
  if ((written.mode & 0o777) !== 0o600) {
    throw new Error("The native Codex smoke artifact is not mode 0600.");
  }
}

export function liveChatFailureArtifactPath(outputPath) {
  if (!outputPath.endsWith(".json")) {
    throw new TypeError("The native Codex smoke failure receipt requires a JSON output path.");
  }
  return `${outputPath.slice(0, -".json".length)}.failure.json`;
}

export function createLiveChatFailureReceipt({ phase, error }) {
  if (typeof phase !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(phase)) {
    throw new TypeError("The native Codex smoke failure phase is invalid.");
  }
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    schemaVersion: 1,
    artifactType: "release-candidate-failure",
    failedAt: new Date().toISOString(),
    phase,
    // Do not retain exception text: it can include model output or environment values.
    errorFingerprintSha256: sha256(message),
  });
}

function listen(server, port = 0) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function serverPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("A disposable listener did not expose a TCP port.");
  }
  return address.port;
}

async function reservePort() {
  const server = createServer();
  await listen(server);
  const port = serverPort(server);
  await closeServer(server);
  return port;
}

async function startWebProbe() {
  const server = createServer((_request, response) => {
    response.writeHead(204).end();
  });
  await listen(server);
  return {
    origin: `http://127.0.0.1:${serverPort(server)}`,
    close: () => closeServer(server),
  };
}

export async function createLiveSmokeGlobalEndpoint(name, dependencies = {}) {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(name)) {
    throw new TypeError("The live smoke Global UDS endpoint name is invalid.");
  }
  const candidateTempRoots = [
    dependencies.tempDirectory ?? tmpdir(),
    dependencies.fallbackTempDirectory ?? "/tmp",
  ];
  let lastError = null;
  for (const requestedTempRoot of new Set(candidateTempRoots)) {
    let parentDirectory = null;
    try {
      if (!isAbsolute(requestedTempRoot) || requestedTempRoot.includes("\u0000")) {
        throw new TypeError("The live smoke Global UDS temp root must be absolute.");
      }
      const canonicalTempRoot = await realpath(requestedTempRoot);
      parentDirectory = await realpath(await mkdtemp(
        join(canonicalTempRoot, `wpr-uds-${name}-`),
      ));
      const socketPath = join(parentDirectory, "run", "global-codex.sock");
      const runtimeOwnerSocketPath = join(parentDirectory, "runtime-owner.sock");
      if (
        Math.max(
          Buffer.byteLength(socketPath, "utf8"),
          Buffer.byteLength(runtimeOwnerSocketPath, "utf8"),
        ) > MACOS_UNIX_SOCKET_PATH_BYTES
      ) {
        await rm(parentDirectory, { recursive: true, force: true });
        parentDirectory = null;
        continue;
      }
      let closed = false;
      return Object.freeze({
        parentDirectory,
        socketPath,
        runtimeOwnerSocketPath,
        runClient: createHostOnlyGlobalClientRunner(socketPath),
        async close() {
          if (closed) return;
          closed = true;
          await rm(parentDirectory, { recursive: true, force: true });
        },
      });
    } catch (error) {
      lastError = error;
      if (parentDirectory !== null) {
        await rm(parentDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
  throw new Error("Could not allocate a private Global UDS path within the macOS byte limit.", {
    cause: lastError,
  });
}

async function requestJson(baseUrl, origin, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.method === "POST" ? { Origin: origin } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned a non-JSON response with HTTP ${response.status}.`);
  }
  return { response, body };
}

function runtimeBaseUrl(runtime) {
  return `http://127.0.0.1:${serverPort(runtime.server)}`;
}

async function waitForCodex(runtime) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = runtime.readCodexStatus();
    if (status.state !== "checking") return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Timed out waiting for embedded Codex readiness.");
}

function configuredEnvironment(
  environment,
  dataDirectory,
  origin,
  port,
  runtimeOwnerSocketPath,
) {
  return {
    ...environment,
    PLANNER_MODE: "api",
    PLANNER_HOST: "127.0.0.1",
    PLANNER_PORT: String(port),
    PLANNER_DATA_DIR: dataDirectory,
    PLANNER_WEB_ORIGIN: origin,
    PLANNER_ALLOWED_ORIGINS: origin,
    PLANNER_RUNTIME_OWNER_SOCKET: runtimeOwnerSocketPath,
  };
}

async function bootstrap(baseUrl, origin) {
  const result = await requestJson(baseUrl, origin, "/api/bootstrap", {
    method: "POST",
    body: JSON.stringify({ requestId: randomUUID(), mode: "seed" }),
  });
  if (!result.response.ok || !result.body?.workspace?.initialized) {
    throw new Error(`Disposable bootstrap failed with HTTP ${result.response.status}.`);
  }
  return result.body.workspace;
}

function query(path, values) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix.length === 0 ? path : `${path}?${suffix}`;
}

function assertNativeResponse(result, expectedStatus, validator, label) {
  if (result.response.status !== expectedStatus || !validator(result.body)) {
    const code = result.body?.error?.code ?? "INVALID_RESPONSE";
    throw new Error(
      `${label} returned HTTP ${result.response.status} with ${code}.`,
    );
  }
  return result.body;
}

async function nativeGet(baseUrl, origin, path, validator, label) {
  return assertNativeResponse(
    await requestJson(baseUrl, origin, path),
    200,
    validator,
    label,
  );
}

async function nativePost(baseUrl, origin, route, body, expectedStatus, validator, label) {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  return assertNativeResponse(
    await requestJson(baseUrl, origin, route.path, {
      method: "POST",
      body: serialized,
    }),
    expectedStatus,
    validator,
    label,
  );
}

async function listNativeThreads(baseUrl, origin, options = {}) {
  return nativeGet(
    baseUrl,
    origin,
    query(CODEX_THREAD_API_ROUTES.threadsList.path, options),
    isCodexThreadListResponse,
    "Native thread list",
  );
}

async function readNativeThread(baseUrl, origin, threadId) {
  return nativeGet(
    baseUrl,
    origin,
    query(CODEX_THREAD_API_ROUTES.threadRead.path, { threadId }),
    isCodexThreadReadResponse,
    "Native thread read",
  );
}

async function waitForNativeThread(baseUrl, origin, threadId, predicate, label) {
  const deadline = Date.now() + NATIVE_TURN_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await readNativeThread(baseUrl, origin, threadId);
    if (predicate(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${label} did not become authoritative before timeout (${last?.thread?.status?.state ?? "unknown"}).`);
}

async function collectNativeThreadPages(baseUrl, origin, options = {}) {
  const threads = [];
  let cursor;
  let pageCount = 0;
  let last = null;
  do {
    last = await listNativeThreads(baseUrl, origin, { ...options, cursor });
    threads.push(...last.threads);
    cursor = last.nextCursor ?? undefined;
    pageCount += 1;
    if (pageCount > 1_000) throw new Error("Native thread pagination exceeded its proof bound.");
  } while (cursor !== undefined);
  return { threads, pageCount, coordinates: last };
}

function turnById(readback, turnId) {
  return readback.thread.turns.find((turn) => turn.id === turnId) ?? null;
}

function groceryIngredientName(week, grocery) {
  const meal = week.data.meals.find((candidate) => candidate.id === grocery.mealId);
  return meal?.ingredients.find((candidate) => candidate.id === grocery.ingredientId)
    ?.ingredient ?? null;
}

export function deriveNativeObservationEvidence({
  assistantMessage,
  workerSummary,
  workerReadback,
  parentThreadId,
}) {
  const assistantMessageObserved = assistantMessage?.kind === "message" &&
    assistantMessage.role === "assistant";
  const workerCompleted = workerSummary?.status === "completed";
  const childReadback = workerReadback?.thread?.threadKind === "worker" &&
    workerReadback.thread.parentThreadId === parentThreadId &&
    workerReadback.thread.id === workerSummary?.threadId;
  if (
    !assistantMessageObserved ||
    !workerCompleted ||
    !childReadback
  ) {
    throw new Error(
      "Unified native turn omitted its assistant response or completed worker readback.",
    );
  }
  return Object.freeze({
    assistantMessageObserved,
    worker: Object.freeze({
      childReadback,
      workerCompleted,
    }),
  });
}

async function proveGlobalUds(baseUrl, origin, runGlobalClient, weekId) {
  const globalHealth = await runGlobalClient("health", null);
  const globalWorkspace = await runGlobalClient("workspace", null);
  if (globalHealth.status !== "ready" || !globalWorkspace.planner?.initialized) {
    throw new Error("The supported Global UDS client did not read a ready planner.");
  }
  const globalLesson = `RC Global UDS ${randomUUID().slice(0, 8)}`;
  const globalBatch = {
    contractVersion: 1,
    requestId: randomUUID(),
    basePlannerVersion: globalWorkspace.planner.plannerVersion,
    operations: [{ command: {
      type: "captureWeekLesson",
      weekId,
      weekLesson: globalLesson,
    } }],
  };
  const serializedGlobalBatch = JSON.stringify(globalBatch);
  const globalApplied = await runGlobalClient("apply", serializedGlobalBatch);
  const globalReplayed = await runGlobalClient("apply", serializedGlobalBatch);
  const globalChanged = await runGlobalClient("apply", JSON.stringify({
    ...globalBatch,
    operations: [{ command: {
      ...globalBatch.operations[0].command,
      weekLesson: `${globalLesson} changed reuse`,
    } }],
  }));
  const browserReadback = await requestJson(baseUrl, origin, "/api/workspace");
  if (
    globalApplied.decision?.status !== "accepted" ||
    JSON.stringify(globalReplayed.decision) !== JSON.stringify(globalApplied.decision) ||
    globalChanged.error?.code !== "request_id_reuse" ||
    !browserReadback.response.ok ||
    browserReadback.body.state.weeks.find((candidate) => candidate.id === weekId)
      ?.data.weekLesson !== globalLesson
  ) {
    throw new Error("The supported Global UDS apply/replay/readback contract failed.");
  }
  return {
    supportedClient: true,
    applyAccepted: true,
    exactReplay: true,
    changedPayloadRejected: true,
    browserReadback: true,
  };
}

export async function runNativeReleaseScenarios({
  runtime,
  origin,
  runGlobalClient,
  restartRuntime,
}) {
  let currentRuntime = runtime;
  let baseUrl = runtimeBaseUrl(currentRuntime);
  const health = await requestJson(baseUrl, origin, "/api/health");
  if (
    !health.response.ok ||
    (health.body?.status ?? health.body?.application?.status) !== "ready" ||
    health.body?.codex?.status !== "ready" ||
    health.body?.globalCodex?.status !== "ready"
  ) {
    throw new Error("The final configured runtime did not expose ready planner, native Codex, and Global UDS health.");
  }
  let workspace = await bootstrap(baseUrl, origin);
  const week = workspace.state.weeks[0];
  if (!week) throw new Error("The disposable planner seed has no active week.");

  const initial = await listNativeThreads(baseUrl, origin, { limit: 1 });
  const primary = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.threadNew,
    { requestId: randomUUID(), expectedSelectionRevision: initial.selection.revision },
    201,
    isCodexThreadMutationResponse,
    "Native thread creation",
  );
  if (primary.thread === null || primary.selection.threadId !== primary.thread.id) {
    throw new Error("Native thread creation did not select its provider-owned root.");
  }
  const primaryThreadId = primary.thread.id;

  const questionAdmission = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.turnSend,
    {
      requestId: randomUUID(),
      threadId: primaryThreadId,
      expectedSelectionRevision: primary.selection.revision,
      clientUserMessageId: `native-question-${randomUUID()}`,
      message: "Before doing anything else, ask exactly one closed-choice question with options Tacos and Soup. After I answer, reply briefly without using planner or web tools.",
    },
    202,
    isCodexTurnMutationResponse,
    "Native question turn",
  );
  const pendingQuestion = await waitForNativeThread(
    baseUrl,
    origin,
    primaryThreadId,
    (readback) => readback.interactions.some((entry) =>
      entry.kind === "user_input" && entry.turnId === questionAdmission.turnId),
    "Native closed-choice question",
  );
  const interactionList = await nativeGet(
    baseUrl,
    origin,
    query(CODEX_THREAD_API_ROUTES.interactionsList.path, { threadId: primaryThreadId }),
    isCodexInteractionListResponse,
    "Native interaction list",
  );
  const question = interactionList.interactions.find((entry) =>
    entry.kind === "user_input" && entry.turnId === questionAdmission.turnId);
  const firstQuestion = question?.questions[0];
  const selectedOption = firstQuestion?.options[0]?.label;
  if (!question || !firstQuestion || !selectedOption) {
    throw new Error("Native interaction readback omitted its listed option contract.");
  }
  await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.interactionRespond,
    {
      requestId: randomUUID(),
      threadId: primaryThreadId,
      expectedSelectionRevision: pendingQuestion.selection.revision,
      interactionId: question.id,
      response: {
        kind: "answers",
        answers: [{ questionId: firstQuestion.id, answers: [selectedOption] }],
      },
    },
    200,
    isCodexInteractionMutationResponse,
    "Native interaction response",
  );
  await waitForNativeThread(
    baseUrl,
    origin,
    primaryThreadId,
    (readback) => turnById(readback, questionAdmission.turnId)?.status === "completed" &&
      !readback.interactions.some((entry) => entry.id === question.id),
    "Native question resolution",
  );

  workspace = (await requestJson(baseUrl, origin, "/api/workspace")).body;
  const plannerVersionBefore = workspace.plannerVersion;
  const proofIngredient = "Boneless chicken thighs";
  const requestId = randomUUID();
  const clientUserMessageId = `native-release-${randomUUID()}`;
  const admissionBody = JSON.stringify({
    requestId,
    threadId: primaryThreadId,
    expectedSelectionRevision: primary.selection.revision,
    clientUserMessageId,
    message: `Use planner.read to inspect the current workspace. Spawn one background worker to verify the intended grocery classification, then use one planner.apply call to move the existing recipe-derived grocery record for the canonical ingredient \"${proofIngredient}\" to Farm box. Do not add, edit, or remove grocery rows; groceries are recipe-derived classifications. Finish with a brief answer and do not ask a question.`,
  });
  const admitted = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.turnSend,
    admissionBody,
    202,
    isCodexTurnMutationResponse,
    "Unified native turn",
  );
  const replayed = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.turnSend,
    admissionBody,
    202,
    isCodexTurnMutationResponse,
    "Unified native turn replay",
  );
  if (replayed.threadId !== admitted.threadId || replayed.turnId !== admitted.turnId) {
    throw new Error("Byte-identical native turn replay changed provider identity.");
  }
  const changedReuse = await requestJson(baseUrl, origin, CODEX_THREAD_API_ROUTES.turnSend.path, {
    method: "POST",
    body: JSON.stringify({ ...JSON.parse(admissionBody), message: `${proofIngredient} changed reuse` }),
  });
  if (
    changedReuse.response.status !== 409 ||
    !isCodexApiFailure(changedReuse.body) ||
    changedReuse.body.error.code !== "REQUEST_ID_REUSE"
  ) {
    throw new Error("Changed-payload native request-ID reuse did not fail closed.");
  }

  const completed = await waitForNativeThread(
    baseUrl,
    origin,
    primaryThreadId,
    (readback) => turnById(readback, admitted.turnId)?.status === "completed" &&
      readback.thread.workers.length > 0,
    "Unified native thread",
  );
  const completedTurn = turnById(completed, admitted.turnId);
  const assistantMessage = completedTurn?.items.find((item) =>
    item.kind === "message" && item.role === "assistant");
  const workerSummary = completed.thread.workers.find((worker) => worker.status === "completed");
  if (!completedTurn || !assistantMessage || !workerSummary) {
    throw new Error("Unified native turn omitted its assistant response or completed worker.");
  }
  const workerReadback = await readNativeThread(baseUrl, origin, workerSummary.threadId);
  const observedNativeTurn = deriveNativeObservationEvidence({
    assistantMessage,
    workerSummary,
    workerReadback,
    parentThreadId: primaryThreadId,
  });

  const independentThreadRead = await readNativeThread(baseUrl, origin, primaryThreadId);
  if (turnById(independentThreadRead, admitted.turnId)?.status !== "completed") {
    throw new Error("An independent native client could not read back the completed turn.");
  }
  workspace = (await requestJson(baseUrl, origin, "/api/workspace")).body;
  const proofWeek = workspace.state.weeks[0];
  const matchingItems = proofWeek.data.groceries.filter((item) =>
    groceryIngredientName(proofWeek, item) === proofIngredient,
  );
  if (
    workspace.plannerVersion !== plannerVersionBefore + 1 ||
    matchingItems.length !== 1 ||
    matchingItems[0].source !== "farm_box" ||
    groceryIngredientName(proofWeek, matchingItems[0]) !== proofIngredient
  ) {
    throw new Error("The unified native turn did not move one authoritative recipe-derived grocery classification.");
  }

  const secondary = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.threadNew,
    { requestId: randomUUID(), expectedSelectionRevision: completed.selection.revision },
    201,
    isCodexThreadMutationResponse,
    "Second native thread creation",
  );
  if (secondary.thread === null) throw new Error("Second native thread creation omitted its root.");
  const secondaryThreadId = secondary.thread.id;
  const paged = await collectNativeThreadPages(baseUrl, origin, { limit: 1 });
  if (
    paged.pageCount < 2 ||
    ![primaryThreadId, secondaryThreadId].every((threadId) =>
      paged.threads.some((thread) => thread.id === threadId))
  ) {
    throw new Error("Native history pagination did not preserve both release roots.");
  }
  const interruptAdmission = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.turnSend,
    {
      requestId: randomUUID(),
      threadId: secondaryThreadId,
      expectedSelectionRevision: secondary.selection.revision,
      clientUserMessageId: `native-interrupt-${randomUUID()}`,
      message: "Start a background worker and a broad hosted web investigation, wait for the worker, and do not finish until every source has been compared.",
    },
    202,
    isCodexTurnMutationResponse,
    "Native interrupt turn",
  );
  await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.turnInterrupt,
    {
      requestId: randomUUID(),
      threadId: secondaryThreadId,
      expectedSelectionRevision: secondary.selection.revision,
      turnId: interruptAdmission.turnId,
    },
    200,
    isCodexTurnMutationResponse,
    "Native turn interrupt",
  );
  await waitForNativeThread(
    baseUrl,
    origin,
    secondaryThreadId,
    (readback) => turnById(readback, interruptAdmission.turnId)?.status === "interrupted",
    "Interrupted native turn readback",
  );
  const archivedSecondary = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.threadArchive,
    {
      requestId: randomUUID(),
      threadId: secondaryThreadId,
      expectedSelectionRevision: secondary.selection.revision,
    },
    200,
    isCodexThreadMutationResponse,
    "Native thread archive",
  );
  const selectedPrimary = await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.threadSelect,
    {
      requestId: randomUUID(),
      threadId: primaryThreadId,
      expectedSelectionRevision: archivedSecondary.selection.revision,
    },
    200,
    isCodexThreadMutationResponse,
    "Native thread selection",
  );

  for (const [path, options] of [
    ["/api/transcript", {}],
    ["/api/chat/submit", { method: "POST", body: "{}" }],
  ]) {
    const legacy = await requestJson(baseUrl, origin, path, options);
    if (legacy.response.status !== 404) {
      throw new Error(`Retired planner conversation route remained reachable: ${path}.`);
    }
  }

  currentRuntime = await restartRuntime(currentRuntime);
  baseUrl = runtimeBaseUrl(currentRuntime);
  const restartedStatus = await waitForCodex(currentRuntime);
  if (restartedStatus.state !== "compatible") {
    throw new Error("Native release restart did not recover a compatible Codex runtime.");
  }
  const restartedActive = await collectNativeThreadPages(baseUrl, origin, { limit: 50 });
  const restartedArchived = await collectNativeThreadPages(baseUrl, origin, {
    archived: true,
    limit: 50,
  });
  const restartedPrimary = await readNativeThread(baseUrl, origin, primaryThreadId);
  if (
    restartedActive.coordinates.selection.threadId !== primaryThreadId ||
    !restartedActive.threads.some((thread) => thread.id === primaryThreadId) ||
    restartedActive.threads.some((thread) => thread.id === secondaryThreadId) ||
    !restartedArchived.threads.some((thread) => thread.id === secondaryThreadId) ||
    turnById(restartedPrimary, admitted.turnId)?.status !== "completed" ||
    !restartedPrimary.thread.workers.some((worker) => worker.threadId === workerSummary.threadId)
  ) {
    throw new Error("Native history, selection, archive, or worker readback changed after restart.");
  }

  const globalUds = await proveGlobalUds(baseUrl, origin, runGlobalClient, week.id);
  await nativePost(
    baseUrl,
    origin,
    CODEX_THREAD_API_ROUTES.threadArchive,
    {
      requestId: randomUUID(),
      threadId: primaryThreadId,
      expectedSelectionRevision: selectedPrimary.selection.revision,
    },
    200,
    isCodexThreadMutationResponse,
    "Primary native thread archive",
  );
  const finalActive = await collectNativeThreadPages(baseUrl, origin, { limit: 50 });
  const finalArchived = await collectNativeThreadPages(baseUrl, origin, {
    archived: true,
    limit: 50,
  });
  if (
    [primaryThreadId, secondaryThreadId].some((threadId) =>
      finalActive.threads.some((thread) => thread.id === threadId)) ||
    ![primaryThreadId, secondaryThreadId].every((threadId) =>
      finalArchived.threads.some((thread) => thread.id === threadId))
  ) {
    throw new Error("Native release probe roots were not archived out of the default picker.");
  }

  return {
    runtime: currentRuntime,
    scenarios: {
      nativeHistory: {
        threadSource: "weekly_recipe_planner",
        createdTopLevelThreadCount: 2,
        primaryThreadIdSha256: sha256(primaryThreadId),
        archivedThreadIdSha256: sha256(secondaryThreadId),
        paginationObserved: true,
        selectionObserved: true,
        restartReadback: true,
        archivedAbsentFromActive: true,
        archivedPresentInHistory: true,
      },
      nativeTurn: {
        threadIdSha256: sha256(primaryThreadId),
        turnIdSha256: sha256(admitted.turnId),
        clientUserMessageIdSha256: sha256(clientUserMessageId),
        exactAdmissionReplay: true,
        changedPayloadRejected: true,
        secondClientReadback: true,
        plannerEffect: {
          operation: "move_grocery_items_to_source",
          plannerVersionDelta: 1,
          itemIdentitySha256: sha256(matchingItems[0].id),
          source: "farm_box",
          ingredientNameSha256: sha256(proofIngredient),
          authoritativeReadback: true,
        },
        assistantMessageObserved: observedNativeTurn.assistantMessageObserved,
        worker: {
          parentThreadIdSha256: sha256(primaryThreadId),
          workerThreadIdSha256: sha256(workerSummary.threadId),
          ...observedNativeTurn.worker,
        },
      },
      interactions: {
        question: {
          interactionIdSha256: sha256(question.id),
          threadIdSha256: sha256(primaryThreadId),
          turnIdSha256: sha256(questionAdmission.turnId),
          listedOptionRoundTrip: true,
          resolved: true,
        },
      },
      interrupt: {
        threadIdSha256: sha256(secondaryThreadId),
        turnIdSha256: sha256(interruptAdmission.turnId),
        readbackStatus: "interrupted",
      },
      legacyConversationAbsent: true,
      globalUds,
    },
  };
}

async function proveIncompatibleIndependence(
  origin,
  globalCodexEndpoint,
) {
  const fixture = await createCodexRuntimeFixture({
    authenticated: true,
    variant: "extra-tool",
  });
  let runtime = null;
  try {
    const port = await reservePort();
    runtime = await startConfiguredPlannerRuntime(
      {
        ...configuredEnvironment(
          fixture.environment,
          fixture.plannerDataDirectory,
          origin,
          port,
          globalCodexEndpoint.runtimeOwnerSocketPath,
        ),
      },
      { globalCodexParentDirectory: globalCodexEndpoint.parentDirectory },
    );
    const status = await waitForCodex(runtime);
    if (
      status.state !== "incompatible" ||
      status.protocolCompatible !== false ||
      !/Forbidden|tools changed/iu.test(status.detail)
    ) {
      throw new Error("The exact updater-path fixture did not become specifically incompatible.");
    }
    const baseUrl = runtimeBaseUrl(runtime);
    const workspace = await bootstrap(baseUrl, origin);
    const health = await requestJson(baseUrl, origin, "/api/health");
    if (
      !health.response.ok ||
      health.body?.application?.status !== "ready" ||
      health.body?.store?.status !== "ready" ||
      health.body?.codex?.status === "ready" ||
      health.body?.globalCodex?.status !== "ready"
    ) {
      throw new Error("Planner/store independence failed when embedded Codex was incompatible.");
    }
    const globalHealth = await globalCodexEndpoint.runClient("health", null);
    const globalWorkspace = await globalCodexEndpoint.runClient("workspace", null);
    const globalLesson = `RC incompatible UDS ${randomUUID().slice(0, 8)}`;
    const globalApplied = await globalCodexEndpoint.runClient("apply", JSON.stringify({
      contractVersion: 1,
      requestId: randomUUID(),
      basePlannerVersion: globalWorkspace.planner?.plannerVersion,
      operations: [{ command: {
        type: "captureWeekLesson",
        weekId: workspace.state.activeWeekId,
        weekLesson: globalLesson,
      } }],
    }));
    const browserReadback = await requestJson(baseUrl, origin, "/api/workspace");
    if (
      globalHealth.status !== "ready" ||
      !globalWorkspace.planner?.initialized ||
      globalApplied.decision?.status !== "accepted" ||
      !browserReadback.response.ok ||
      browserReadback.body.state.weeks.find(
        (candidate) => candidate.id === workspace.state.activeWeekId,
      )?.data.weekLesson !== globalLesson
    ) {
      throw new Error("Global UDS did not remain independently usable under incompatibility.");
    }
    const target = await readIncompatibleEvidenceProjection(fixture, status);
    return {
      codexState: "incompatible",
      plannerReady: true,
      storeReady: true,
      globalCodexReady: true,
      supportedGlobalClient: true,
      globalApplyAccepted: true,
      browserReadback: true,
      target,
    };
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function runNativeCodexReleaseSmoke(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
) {
  const home = environment.HOME ?? homedir();
  if (!home.startsWith("/")) throw new Error("HOME must be an absolute path.");
  const releaseBinding = dependencies.releaseBinding;
  if (releaseBinding !== undefined && !isReleaseCandidateBinding(releaseBinding)) {
    throw new TypeError("The native Codex smoke received a malformed stage/install/auth binding.");
  }
  const expectedReleaseOutput = releaseBinding === undefined
    ? null
    : join(
        home,
        "meal-planner",
        "releases",
        releaseBinding.activationId,
        "release-candidate.json",
      );
  const args = parseLiveChatSmokeArguments(argv, releaseBinding === undefined ? {} : {
    isOutputAllowed: (path) => path === expectedReleaseOutput,
    outputError: "--output must be the derived release-candidate receipt path.",
  });
  try {
    await lstat(args.output);
    throw new Error("Refusing to overwrite an existing native Codex smoke artifact.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const dedicatedHome = environment.PLANNER_CODEX_HOME ?? join(home, "meal-planner", "agent");
  const operatorSha256 = dependencies.operatorSha256;
  if (
    (releaseBinding === undefined) !== (operatorSha256 === undefined) ||
    (operatorSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(operatorSha256))
  ) {
    throw new TypeError("Release-bound live smoke requires the installed operator identity.");
  }
  const collectSourceManifest = dependencies.collectSourceManifest ??
    collectCandidateSourceManifest;
  const candidateSourceBefore = await collectSourceManifest();
  const root = await createLiveSmokeRoot(environment);
  const dataDirectory = join(root, "planner-data");
  const web = await startWebProbe();
  const globalCodexEndpoints = [];
  let runtime = null;
  let phase = "runtime_readiness";
  try {
    const globalCodexEndpoint = await createLiveSmokeGlobalEndpoint("live");
    globalCodexEndpoints.push(globalCodexEndpoint);
    const port = await reservePort();
    const sourceEnvironment = configuredEnvironment(
      environment,
      dataDirectory,
      web.origin,
      port,
      globalCodexEndpoint.runtimeOwnerSocketPath,
    );
    runtime = await startConfiguredPlannerRuntime(sourceEnvironment, {
      globalCodexParentDirectory: globalCodexEndpoint.parentDirectory,
    });
    const acceptedStatus = await waitForCodex(runtime);
    const activationCoordinates = activationCoordinatesFromStatus(acceptedStatus);
    phase = "native_release_scenarios";
    const nativeProof = await runNativeReleaseScenarios({
      runtime,
      origin: web.origin,
      runGlobalClient: globalCodexEndpoint.runClient,
      restartRuntime: async (current) => {
        await current.close();
        runtime = null;
        runtime = await startConfiguredPlannerRuntime(sourceEnvironment, {
          globalCodexParentDirectory: globalCodexEndpoint.parentDirectory,
        });
        return runtime;
      },
    });
    runtime = nativeProof.runtime;
    const scenarios = nativeProof.scenarios;
    const finalCoordinates = activationCoordinatesFromStatus(await runtime.evaluate());
    if (!activationCoordinatesEqual(finalCoordinates, activationCoordinates)) {
      throw new Error("Codex activation coordinates changed during the live release-candidate gate.");
    }
    phase = "capability_evidence";
    const capabilityEvidence = await readObservedCapabilityProjection(
      dedicatedHome,
      finalCoordinates,
    );
    await runtime.close();
    runtime = null;
    const dedicatedRuntimeRetention = await collectNativeReleaseRuntimeRetention(dedicatedHome);

    phase = "incompatible_independence";
    const incompatibleGlobalCodexEndpoint = await createLiveSmokeGlobalEndpoint("incompatible");
    globalCodexEndpoints.push(incompatibleGlobalCodexEndpoint);
    const incompatibleIndependence = await proveIncompatibleIndependence(
      web.origin,
      incompatibleGlobalCodexEndpoint,
    );
    const candidateSourceManifest = await collectSourceManifest();
    if (candidateSourceManifest.sha256 !== candidateSourceBefore.sha256) {
      throw new Error("The release-candidate source changed during the live gate.");
    }
    phase = "artifact_validation";
    const artifact = {
      schemaVersion: NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
      completedAt: new Date().toISOString(),
      disposition: "native_codex_authenticated_release_candidate",
      scenario: "native_threads",
      authenticationMutationPerformedByProbe: false,
      activationCoordinates,
      activationCoordinatesRecheckedEqual: true,
      candidateSourceManifest,
      ...(releaseBinding === undefined ? {} : { releaseBinding }),
      ...(operatorSha256 === undefined ? {} : { operatorSha256 }),
      capabilityEvidence,
      scenarios: {
        ...scenarios,
        incompatibleIndependence,
      },
      dedicatedRuntimeRetention,
    };
    assertEligibleReleaseCandidateArtifact(artifact);
    const outputArtifact = releaseBinding === undefined
      ? artifact
      : createBoundReleaseCandidateArtifact(artifact);
    phase = "artifact_write";
    await writePrivateLiveChatArtifact(args.output, outputArtifact);
    return outputArtifact;
  } catch (error) {
    const failureReceipt = createLiveChatFailureReceipt({ phase, error });
    await writePrivateLiveChatArtifact(
      liveChatFailureArtifactPath(args.output),
      failureReceipt,
    ).catch(() => undefined);
    throw error;
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await web.close().catch(() => undefined);
    for (const endpoint of globalCodexEndpoints.reverse()) {
      await endpoint.close().catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}

/** Compatibility export only; every invocation now emits the native schema-v2 contract. */
export const runLiveChatSmoke = runNativeCodexReleaseSmoke;

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await runNativeCodexReleaseSmoke().then(() => {
    console.log("Native Codex release-candidate smoke passed; secret-free evidence was written.");
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

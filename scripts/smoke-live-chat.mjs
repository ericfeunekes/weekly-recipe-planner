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
  activationCoordinatesEqual,
  activationCoordinatesFromStatus,
  assertEligibleReleaseCandidateArtifact,
  createBoundReleaseCandidateArtifact,
  isReleaseCandidateBinding,
} from "./support/codex-release-candidate-contract.mjs";
import {
  collectCandidateSourceManifest,
  collectDedicatedRuntimeRetention,
  readIncompatibleEvidenceProjection,
  readObservedCapabilityProjection,
  createHostOnlyGlobalClientRunner,
} from "./support/codex-live-proof.mjs";
import { createCodexRuntimeFixture } from "./support/codex-runtime-fixture.mjs";

const ARTIFACT_BYTES_LIMIT = 64 * 1_024;
const READINESS_TIMEOUT_MS = 180_000;
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
  if (!authorized) throw new TypeError("The live ChatGPT smoke requires --authorized.");
  if (scenario !== "all") throw new TypeError("The live ChatGPT smoke requires --scenario all.");
  if (!output) throw new TypeError("The live ChatGPT smoke requires --output.");
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
    throw new Error("The live ChatGPT smoke artifact exceeded its closed byte limit.");
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
    throw new Error("The live ChatGPT smoke artifact is not mode 0600.");
  }
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

function assertAccepted(result, label) {
  if (!result.response.ok || result.body?.decision?.status !== "accepted") {
    const decision = result.body?.decision?.status ?? result.body?.error?.code ?? "unknown";
    throw new Error(`${label} failed with HTTP ${result.response.status} (${decision}).`);
  }
  return result.body;
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

class ArmedFailureInjector {
  #point = null;
  #fired = false;

  arm(point) {
    if (this.#point !== null) throw new Error("A smoke failpoint is already armed.");
    this.#point = point;
    this.#fired = false;
  }

  hit(point) {
    if (point !== this.#point) return;
    this.#point = null;
    this.#fired = true;
    throw new Error(`Authorized live smoke failpoint: ${point}`);
  }

  get fired() {
    return this.#fired;
  }
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

async function submit(baseUrl, origin, workspace, message, context, intent) {
  return assertAccepted(await requestJson(baseUrl, origin, "/api/chat/submit", {
    method: "POST",
    body: JSON.stringify({
      requestId: randomUUID(),
      basePlannerVersion: workspace.plannerVersion,
      message,
      context,
      intent,
    }),
  }), "ChatGPT submission");
}

async function retry(baseUrl, origin, workspace, turnId) {
  return assertAccepted(await requestJson(baseUrl, origin, "/api/chat/retry", {
    method: "POST",
    body: JSON.stringify({
      requestId: randomUUID(),
      basePlannerVersion: workspace.plannerVersion,
      turnId,
    }),
  }), "ChatGPT recovery");
}

async function runLiveScenarios(
  runtime,
  origin,
  failureInjector,
  runGlobalClient,
  researchEvidenceObservations,
) {
  const baseUrl = runtimeBaseUrl(runtime);
  const health = await requestJson(baseUrl, origin, "/api/health");
  if (
    !health.response.ok ||
    health.body?.status !== "ready" ||
    health.body?.codex?.status !== "ready" ||
    health.body?.globalCodex?.status !== "ready"
  ) {
    throw new Error("The final configured runtime did not expose ready core, embedded, and Global UDS health.");
  }
  let workspace = await bootstrap(baseUrl, origin);
  const week = workspace.state.weeks[0];
  const meal = week?.data.meals[0];
  if (!week || !meal) throw new Error("The disposable planner seed has no meal context.");
  const originalRecipeStepIds = new Set(meal.instructions.map((step) => step.id));
  const context = { view: "week", weekId: week.id };
  const uniqueDependentItem = `RC dependent ${randomUUID().slice(0, 8)}`;
  const dependent = await submit(
    baseUrl,
    origin,
    workspace,
    `Use planner tools to add one Pantry grocery item named exactly \"${uniqueDependentItem}\" with detail \"first call\" and farmBox false. Do not batch the update with the add. After the add succeeds, use the authoritative server-assigned grocery item ID from that result in a second planner apply call to change its detail to exactly \"second dependent call\". Finish only after reading back the updated item.`,
    context,
    { kind: "planner", archiveContextWeek: false },
  );
  const dependentTurn = dependent.decision.turn;
  workspace = dependent.workspace;
  const dependentItems = workspace.state.weeks[0].data.groceries.filter(
    (item) => item.item === uniqueDependentItem,
  );
  if (
    dependentTurn.status !== "completed" ||
    dependentTurn.acceptedEffectCount < 2 ||
    dependentItems.length !== 1 ||
    dependentItems[0].detail !== "second dependent call"
  ) {
    throw new Error(
      "The real model did not complete two dependent durable planner effects " +
        `(status=${dependentTurn.status}, errorCode=${dependentTurn.errorCode ?? "none"}, ` +
        `terminalOutcome=${dependentTurn.terminalOutcome ?? "none"}, ` +
        `acceptedEffects=${dependentTurn.acceptedEffectCount}, ` +
        `matchingItems=${dependentItems.length}, detailMatched=${
          dependentItems[0]?.detail === "second dependent call"
        }, errorDetail=${JSON.stringify(
          (dependentTurn.errorDetail ?? "none").replace(/\s+/gu, " ").slice(0, 240),
        )}).`,
    );
  }

  const sourced = await submit(
    baseUrl,
    origin,
    workspace,
    "Use live web search to find a primary publisher recipe for a practical family dinner. Remove any prep references to the selected meal's old recipe steps in a separate earlier planner apply call if required, then replace the recipe snapshot with the validated sourced candidate. Keep the source visible and informational.",
    { view: "week", weekId: week.id, mealId: meal.id },
    { kind: "sourced_recipe" },
  );
  const sourcedTurn = sourced.decision.turn;
  workspace = sourced.workspace;
  const matchingResearchObservations = researchEvidenceObservations.filter(
    (observation) => observation.durableTurnId === sourcedTurn.turnId,
  );
  const sourcedMeal = workspace.state.weeks[0].data.meals.find((candidate) => candidate.id === meal.id);
  const stalePrepReferencePresent = workspace.state.weeks[0].data.prep.some(
    (reference) => originalRecipeStepIds.has(reference.stepId),
  );
  if (
    sourcedTurn.status !== "completed" ||
    sourcedTurn.researchKind !== "sourced_recipe" ||
    sourcedTurn.acceptedEffectCount < 2 ||
    !sourcedMeal?.sourceRecipe ||
    stalePrepReferencePresent ||
    matchingResearchObservations.length !== 1
  ) {
    throw new Error(
      "The real live-search recipe replacement was not durable " +
        `(status=${sourcedTurn.status}, researchKind=${sourcedTurn.researchKind}, ` +
        `errorCode=${sourcedTurn.errorCode ?? "none"}, ` +
        `terminalOutcome=${sourcedTurn.terminalOutcome ?? "none"}, ` +
        `acceptedEffects=${sourcedTurn.acceptedEffectCount}, ` +
        `sourceRecipePresent=${Boolean(sourcedMeal?.sourceRecipe)}, ` +
        `stalePrepReferencePresent=${stalePrepReferencePresent}, ` +
        `observedHostedSearches=${matchingResearchObservations.length}, errorDetail=${JSON.stringify(
          (sourcedTurn.errorDetail ?? "none").replace(/\s+/gu, " ").slice(0, 240),
        )}).`,
    );
  }
  const observedWebSearch = matchingResearchObservations[0];

  const failureItem = `RC recovery ${randomUUID().slice(0, 8)}`;
  const versionBeforeFailure = workspace.plannerVersion;
  failureInjector.arm("after_tool_effect_commit");
  const failed = await submit(
    baseUrl,
    origin,
    workspace,
    `Add one Pantry grocery item named exactly \"${failureItem}\" with detail \"reply-loss proof\" and farmBox false. Use one planner apply call, then report the result.`,
    context,
    { kind: "planner", archiveContextWeek: false },
  );
  const failedTurn = failed.decision.turn;
  workspace = failed.workspace;
  const failureItems = workspace.state.weeks[0].data.groceries.filter(
    (item) => item.item === failureItem,
  );
  if (
    !failureInjector.fired ||
    failedTurn.status !== "failed" ||
    failedTurn.terminalOutcome !== "failed_after_effect" ||
    failedTurn.acceptedEffectCount !== 1 ||
    workspace.plannerVersion !== versionBeforeFailure + 1 ||
    failureItems.length !== 1
  ) {
    throw new Error("The failure-after-effect state was not durably visible.");
  }

  const versionBeforeRecovery = workspace.plannerVersion;
  const recovered = await retry(baseUrl, origin, workspace, failedTurn.turnId);
  const recoveryTurn = recovered.decision.turn;
  workspace = recovered.workspace;
  const recoveredItems = workspace.state.weeks[0].data.groceries.filter(
    (item) => item.item === failureItem,
  );
  if (
    recoveryTurn.status !== "completed" ||
    recoveryTurn.mode !== "recovery" ||
    recoveryTurn.recoveryOfTurnId !== failedTurn.turnId ||
    recoveryTurn.acceptedEffectCount !== 0 ||
    workspace.plannerVersion !== versionBeforeRecovery ||
    recoveredItems.length !== 1
  ) {
    throw new Error("Recovery-only Retry repeated or lost a durable planner effect.");
  }

  const secondClient = await requestJson(baseUrl, origin, "/api/workspace");
  if (!secondClient.response.ok) {
    throw new Error(`Second-client workspace read failed with HTTP ${secondClient.response.status}.`);
  }
  const secondWorkspace = secondClient.body;
  const persistedTurns = new Map(secondWorkspace.chatTurns.map((turn) => [turn.turnId, turn]));
  if (
    persistedTurns.get(dependentTurn.turnId)?.acceptedEffectCount < 2 ||
    persistedTurns.get(sourcedTurn.turnId)?.researchKind !== "sourced_recipe" ||
    persistedTurns.get(failedTurn.turnId)?.terminalOutcome !== "failed_after_effect" ||
    persistedTurns.get(recoveryTurn.turnId)?.mode !== "recovery"
  ) {
    throw new Error("An independent client could not read back every live scenario outcome.");
  }

  const globalHealth = await runGlobalClient("health", null);
  const globalWorkspace = await runGlobalClient("workspace", null);
  if (
    globalHealth.status !== "ready" ||
    !globalWorkspace.planner?.initialized
  ) {
    throw new Error("The supported Global UDS client did not read a ready planner.");
  }
  const globalRequestId = randomUUID();
  const globalLesson = `RC Global UDS ${randomUUID().slice(0, 8)}`;
  const globalBatch = {
    contractVersion: 1,
    requestId: globalRequestId,
    basePlannerVersion: globalWorkspace.planner.plannerVersion,
    operations: [{ command: {
      type: "captureWeekLesson",
      weekId: week.id,
      weekLesson: globalLesson,
    } }],
  };
  const serializedGlobalBatch = JSON.stringify(globalBatch);
  const globalApplied = await runGlobalClient(
    "apply",
    serializedGlobalBatch,
  );
  const globalReplayed = await runGlobalClient(
    "apply",
    serializedGlobalBatch,
  );
  const globalChanged = await runGlobalClient("apply", JSON.stringify({
    ...globalBatch,
    operations: [{ command: {
      ...globalBatch.operations[0].command,
      weekLesson: `${globalLesson} changed reuse`,
    } }],
  }));
  const globalBrowserReadback = await requestJson(baseUrl, origin, "/api/workspace");
  if (
    globalApplied.decision?.status !== "accepted" ||
    JSON.stringify(globalReplayed.decision) !== JSON.stringify(globalApplied.decision) ||
    globalChanged.error?.code !== "request_id_reuse" ||
    !globalBrowserReadback.response.ok ||
    globalBrowserReadback.body.state.weeks.find((candidate) => candidate.id === week.id)
      ?.data.weekLesson !== globalLesson
  ) {
    throw new Error("The supported Global UDS apply/replay/readback contract failed.");
  }

  return {
    dependentPlanner: {
      turnIdSha256: sha256(dependentTurn.turnId),
      acceptedEffectCount: dependentTurn.acceptedEffectCount,
      outcome: dependentTurn.terminalOutcome,
    },
    sourcedRecipe: {
      turnIdSha256: sha256(sourcedTurn.turnId),
      acceptedEffectCount: sourcedTurn.acceptedEffectCount,
      outcome: sourcedTurn.terminalOutcome,
      sourceKind: sourcedMeal.sourceRecipe.kind,
      sourceUrlSha256: sha256(sourcedMeal.sourceRecipe.url),
      observedWebSearch: {
        operation: observedWebSearch.operation,
        status: observedWebSearch.status,
        durableTurnIdSha256: sha256(observedWebSearch.durableTurnId),
        researchThreadIdSha256: sha256(observedWebSearch.appServerThreadId),
        researchTurnIdSha256: sha256(observedWebSearch.appServerTurnId),
        operationIdSha256: sha256(observedWebSearch.appServerItemId),
      },
    },
    failureAfterEffect: {
      turnIdSha256: sha256(failedTurn.turnId),
      acceptedEffectCount: failedTurn.acceptedEffectCount,
      outcome: failedTurn.terminalOutcome,
    },
    recoveryOnly: {
      turnIdSha256: sha256(recoveryTurn.turnId),
      acceptedEffectCount: recoveryTurn.acceptedEffectCount,
      outcome: recoveryTurn.terminalOutcome,
      plannerVersionUnchanged: true,
    },
    secondClientReadback: true,
    globalUds: {
      supportedClient: true,
      applyAccepted: true,
      exactReplay: true,
      changedPayloadRejected: true,
      browserReadback: true,
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

export async function runLiveChatSmoke(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
) {
  const home = environment.HOME ?? homedir();
  if (!home.startsWith("/")) throw new Error("HOME must be an absolute path.");
  const releaseBinding = dependencies.releaseBinding;
  if (releaseBinding !== undefined && !isReleaseCandidateBinding(releaseBinding)) {
    throw new TypeError("The live smoke received a malformed stage/install/auth binding.");
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
    throw new Error("Refusing to overwrite an existing live ChatGPT smoke artifact.");
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
  const failureInjector = new ArmedFailureInjector();
  const researchEvidenceObservations = [];
  const web = await startWebProbe();
  const globalCodexEndpoints = [];
  let runtime = null;
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
      failureInjector,
      globalCodexParentDirectory: globalCodexEndpoint.parentDirectory,
      researchEvidenceObserver: (observation) => researchEvidenceObservations.push(observation),
    });
    const acceptedStatus = await waitForCodex(runtime);
    const activationCoordinates = activationCoordinatesFromStatus(acceptedStatus);
    const scenarios = await runLiveScenarios(
      runtime,
      web.origin,
      failureInjector,
      globalCodexEndpoint.runClient,
      researchEvidenceObservations,
    );
    const finalCoordinates = activationCoordinatesFromStatus(await runtime.evaluate());
    if (!activationCoordinatesEqual(finalCoordinates, activationCoordinates)) {
      throw new Error("Codex activation coordinates changed during the live release-candidate gate.");
    }
    const capabilityEvidence = await readObservedCapabilityProjection(
      dedicatedHome,
      finalCoordinates,
    );
    await runtime.close();
    runtime = null;
    const dedicatedRuntimeRetention = await collectDedicatedRuntimeRetention(dedicatedHome);

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
    const artifact = {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      disposition: "compatible_authenticated_release_candidate",
      scenario: args.scenario,
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
    await writePrivateLiveChatArtifact(args.output, outputArtifact);
    return outputArtifact;
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await web.close().catch(() => undefined);
    for (const endpoint of globalCodexEndpoints.reverse()) {
      await endpoint.close().catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await runLiveChatSmoke().then(() => {
    console.log("Live ChatGPT release-candidate smoke passed; secret-free evidence was written.");
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PlannerReleaseError,
  RELEASE_EXIT_CODES,
  parsePlannerReleaseArguments,
} from "./support/planner-release-contract.mjs";
import {
  COMPENSATED_ACTIVATION_FAILURE_CODES,
  activateReleaseTransaction,
  readReleaseTransactionStatus,
  recoverReleaseTransaction,
  rollbackReleaseTransaction,
  stageReleaseTransaction,
} from "./support/planner-release-transaction.mjs";
import {
  createPlannerReleaseCompositionDependencies,
} from "./support/planner-release-composition.mjs";

export { parsePlannerReleaseArguments };

const OPERATOR_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "PLANNER_LEGACY_HTTP_PORT",
]);

function sanitizedOperatorEnvironment(environment, home) {
  const result = { HOME: home };
  for (const key of OPERATOR_ENVIRONMENT_KEYS) {
    if (key === "HOME") continue;
    if (typeof environment[key] === "string") result[key] = environment[key];
  }
  return result;
}

function runBoundOperator(request, environment, home) {
  const { operatorPath, activationId } = request;
  const command = request.command ?? "activate";
  if (!["activate", "recover", "rollback"].includes(command)) {
    return Promise.reject(new PlannerReleaseError(
      "The installed release operator received an unsupported handoff command.",
    ));
  }
  const args = [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    join(operatorPath, "scripts", "planner-release.mjs"),
    command,
    "--transaction",
    activationId,
  ];
  if (command === "activate") args.push("--authorized");
  if (command === "activate" && request.supersedePending) {
    args.push("--supersede-pending", request.supersedePending);
  }
  if (command === "rollback" && request.authorizeDataLoss !== null &&
      request.authorizeDataLoss !== undefined) {
    args.push("--authorize-data-loss", request.authorizeDataLoss.value);
  }
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, args, {
      cwd: operatorPath,
      env: sanitizedOperatorEnvironment(environment, home),
      stdio: "inherit",
    });
    child.once("error", rejectChild);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectChild(new PlannerReleaseError(`The installed release operator exited via ${signal}.`));
        return;
      }
      resolveChild({ exitCode: code ?? 1 });
    });
  });
}

export async function createDefaultPlannerReleaseDependencies(
  environment = process.env,
  parsed = null,
) {
  const home = environment.HOME ?? homedir();
  const composition = createPlannerReleaseCompositionDependencies({
    environment: { ...environment, HOME: home },
    candidateSource: parsed?.command === "stage" ? parsed.candidateSource : null,
  });
  return {
    ...composition,
    reexecuteInstalledOperator: (request) => runBoundOperator(request, environment, home),
  };
}

const SAFE_ACTIVATION_FAILURE_EFFECT = /^[a-z][a-z0-9_]{0,63}$/u;
const SAFE_ACTIVATION_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_ACTIVATION_FAILURE_CODE_SET = new Set(
  COMPENSATED_ACTIVATION_FAILURE_CODES,
);

function activationFailureOutput(value) {
  if (value === undefined) return null;
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.effect !== "string" ||
    typeof value.code !== "string" ||
    !SAFE_ACTIVATION_FAILURE_EFFECT.test(value.effect) ||
    !SAFE_ACTIVATION_FAILURE_CODE.test(value.code) ||
    !SAFE_ACTIVATION_FAILURE_CODE_SET.has(value.code)
  ) {
    throw new PlannerReleaseError("The compensated activation failure projection is invalid.");
  }
  return Object.freeze({ effect: value.effect, code: value.code });
}

export function projectPlannerReleaseCommandOutput(parsed, result) {
  switch (parsed.command) {
    case "stage":
      return {
        activationId: result.activationId,
        stageReceipt: result.stagePath,
      };
    case "activate":
      if (result.handedOff === true) return null;
      return Object.freeze({
        activationId: result.activationId,
        state: result.state,
        ...(result.failure === undefined
          ? {}
          : { failure: activationFailureOutput(result.failure) }),
      });
    case "status":
      return result;
    case "recover":
      return {
        activationId: result.activationId,
        state: result.state,
        recovered: true,
      };
    case "rollback":
      return {
        activationId: result.activationId,
        state: result.state,
      };
    default:
      return null;
  }
}

export async function runPlannerRelease(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = undefined,
) {
  const parsed = parsePlannerReleaseArguments(argv);
  const ports = dependencies ?? await createDefaultPlannerReleaseDependencies(
    environment,
    parsed,
  );
  let result;
  switch (parsed.command) {
    case "stage":
      result = await stageReleaseTransaction(parsed, ports);
      break;
    case "activate":
      result = await activateReleaseTransaction(parsed, ports);
      break;
    case "status":
      result = await readReleaseTransactionStatus(parsed, ports);
      break;
    case "recover":
      result = await recoverReleaseTransaction(parsed, ports);
      break;
    case "rollback":
      result = await rollbackReleaseTransaction(parsed, ports);
      break;
    default:
      throw new PlannerReleaseError("The parsed release command is unsupported.");
  }
  if (result?.handedOff === true) {
    return Object.freeze({
      exitCode: result.result?.exitCode ?? RELEASE_EXIT_CODES.ok,
      output: null,
      handedOff: true,
    });
  }
  const safelyRolledBack = result?.state === "rolled_back";
  return Object.freeze({
    exitCode: safelyRolledBack ? RELEASE_EXIT_CODES.rolledBack : RELEASE_EXIT_CODES.ok,
    output: projectPlannerReleaseCommandOutput(parsed, result),
    handedOff: false,
  });
}

const isEntrypoint = typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    const result = await runPlannerRelease();
    if (result.output !== null) process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Planner release failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = Number.isSafeInteger(error?.exitCode)
      ? error.exitCode
      : RELEASE_EXIT_CODES.eligibility;
  }
}

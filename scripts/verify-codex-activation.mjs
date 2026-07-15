#!/usr/bin/env node

import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRuntimeConfig } from "../server/runtime/config.ts";
import { createFailSoftManagedCodexFollowUpRuntime } from "../server/runtime/codex-follow-up/readiness.ts";
import { readBoundedFile } from "../server/runtime/codex-follow-up/resource-policy.ts";
import { collectCandidateSourceManifest } from "./support/codex-live-proof.mjs";
import {
  ACTIVATION_COORDINATE_KEYS,
  RELEASE_CANDIDATE_BINDING_KEYS,
  activationCoordinatesEqual,
  activationCoordinatesFromStatus,
  isReleaseCandidateBinding,
  releaseCandidateProjectionFromArtifact,
} from "./support/codex-release-candidate-contract.mjs";

export {
  ACTIVATION_COORDINATE_KEYS,
  activationCoordinatesEqual,
  activationCoordinatesFromStatus,
};

const ARTIFACT_BYTES_LIMIT = 64 * 1_024;

export function parseActivationVerificationArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--artifact" || !argv[1]) {
    throw new TypeError("Usage: verify-codex-activation --artifact <release-candidate.json>");
  }
  return Object.freeze({ artifact: resolve(argv[1]) });
}

async function readReleaseCandidateCoordinates(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The release-candidate artifact must be a real regular file.");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("The release-candidate artifact must have mode 0600.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("The release-candidate artifact must be owned by the current user.");
  }
  let artifact;
  try {
    artifact = JSON.parse((await readBoundedFile(
      path,
      ARTIFACT_BYTES_LIMIT,
      "Codex release-candidate artifact",
    )).toString("utf8"));
  } catch (error) {
    throw new Error("The release-candidate artifact is not valid bounded JSON.", { cause: error });
  }
  return releaseCandidateProjectionFromArtifact(artifact);
}

function releaseBindingsEqual(left, right) {
  return isReleaseCandidateBinding(left) && isReleaseCandidateBinding(right) &&
    RELEASE_CANDIDATE_BINDING_KEYS.every((key) => left[key] === right[key]);
}

export async function verifyCodexActivation(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
) {
  const { artifact } = parseActivationVerificationArguments(argv);
  const acceptedArtifact = await readReleaseCandidateCoordinates(artifact);
  const expectedReleaseBinding = dependencies.releaseBinding;
  const expectedOperatorSha256 = dependencies.operatorSha256;
  if (
    (acceptedArtifact.releaseBinding === undefined) !==
      (expectedReleaseBinding === undefined) ||
    (
      acceptedArtifact.releaseBinding !== undefined &&
      !releaseBindingsEqual(acceptedArtifact.releaseBinding, expectedReleaseBinding)
    )
  ) {
    throw new Error(
      "The release-candidate stage/install/auth binding was not injected or changed before activation.",
    );
  }
  if (
    acceptedArtifact.releaseBinding !== undefined &&
    (
      !/^[a-f0-9]{64}$/u.test(expectedOperatorSha256 ?? "") ||
      acceptedArtifact.operatorSha256 !== expectedOperatorSha256
    )
  ) {
    throw new Error(
      "The release-candidate installed operator identity was not injected or changed before activation.",
    );
  }
  const runtimeEnvironment = { ...environment };
  let temporaryDataRoot = null;
  let runtime = null;
  try {
    if (runtimeEnvironment.PLANNER_DATA_DIR === undefined) {
      temporaryDataRoot = await realpath(await mkdtemp(
        join(tmpdir(), "weekly-planner-codex-verify-"),
      ));
      runtimeEnvironment.PLANNER_DATA_DIR = temporaryDataRoot;
    }
    const config = (dependencies.readConfig ?? readRuntimeConfig)(runtimeEnvironment);
    runtime = (dependencies.createRuntime ?? createFailSoftManagedCodexFollowUpRuntime)(
      config.codexFollowUp,
      { sourceEnvironment: runtimeEnvironment },
    );
    const freshCoordinates = activationCoordinatesFromStatus(await runtime.evaluate());
    if (!activationCoordinatesEqual(acceptedArtifact.activationCoordinates, freshCoordinates)) {
      throw new Error(
        "Codex activation coordinates changed after the release-candidate gate; rerun the live smoke.",
      );
    }
    const currentSourceManifest = await (dependencies.collectSourceManifest ??
      collectCandidateSourceManifest)();
    if (currentSourceManifest.sha256 !== acceptedArtifact.candidateSourceManifest.sha256) {
      throw new Error(
        "The release-candidate source changed after the live gate; rerun the live smoke.",
      );
    }
    return Object.freeze({ matched: true });
  } finally {
    await runtime?.close().catch(() => undefined);
    if (temporaryDataRoot !== null) {
      await rm(temporaryDataRoot, { recursive: true, force: true });
    }
  }
}

const isEntrypoint = typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await verifyCodexActivation().then(
    () => process.stdout.write(`${JSON.stringify({ ok: true, matched: true })}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Activation verification failed."}\n`);
      process.exitCode = 1;
    },
  );
}

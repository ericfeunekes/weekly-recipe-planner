import {
  runDisposableCapabilityProbe,
  readActualCodexDeployment,
  CodexCapabilityProbeError,
} from "./capability-probe.ts";
import {
  CodexCompatibilityError,
  CodexCompatibilityEvidenceStore,
  createCompatibilityEvidence,
  generateAndEvaluateCodexSchema,
  type CodexDeploymentReadbackEvidence,
  type GeneratedCodexSchema,
} from "./compatibility.ts";
import {
  buildCodexFollowUpChildEnvironment,
  validateCodexFollowUpDeployment,
  type FollowUpConfigResult,
  type ValidatedCodexFollowUpDeployment,
} from "./deployment.ts";
import {
  captureCodexExecutableIdentity,
  CodexLauncherError,
  createCompatibleCodexExecution,
  type CodexAppServerExecutionProvider,
  type CodexExecutableIdentity,
  type CompatibleCodexExecution,
  type CompatibleAppServerSpawnOptions,
} from "./launcher.ts";

export type CodexFollowUpEvidenceIdentity = {
  readonly canonicalPath: string;
  readonly version: string;
  readonly sha256: string;
  readonly schemaFingerprint: string;
  readonly userConfigSha256: string | null;
  readonly systemConfigSha256: string | null;
  readonly systemConfigPathCount: number | null;
  readonly instructionSha256: string | null;
  readonly accountKind: string | null;
};

export type CodexFollowUpStatus = {
  readonly state:
    | "checking"
    | "compatible"
    | "incompatible"
    | "unauthenticated"
    | "unavailable";
  readonly authenticated: boolean | null;
  readonly protocolCompatible: boolean | null;
  readonly cacheHit: boolean;
  readonly evidence: CodexFollowUpEvidenceIdentity | null;
  readonly detail: string;
};

export type CodexFollowUpRuntime = CodexAppServerExecutionProvider & {
  evaluate(): Promise<CodexFollowUpStatus>;
  readStatus(): CodexFollowUpStatus;
  close(): Promise<void>;
};

export class CodexFollowUpRuntimeError extends Error {
  readonly code: "RUNTIME_CLOSED" | "RUNTIME_NOT_READY";

  constructor(code: CodexFollowUpRuntimeError["code"], message: string) {
    super(message);
    this.name = "CodexFollowUpRuntimeError";
    this.code = code;
  }
}

type ReadinessDependencies = {
  readonly validateDeployment: typeof validateCodexFollowUpDeployment;
  readonly captureIdentity: typeof captureCodexExecutableIdentity;
  readonly generateSchema: typeof generateAndEvaluateCodexSchema;
  readonly runCapabilityProbe: typeof runDisposableCapabilityProbe;
  readonly readDeployment: typeof readActualCodexDeployment;
  readonly createEvidenceStore: (directory: string) => CodexCompatibilityEvidenceStore;
  readonly createExecution: typeof createCompatibleCodexExecution;
};

export type CodexFollowUpRuntimeOptions = {
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly evaluationTimeoutMs?: number;
  readonly maxIdentityRestarts?: number;
  readonly dependencies?: Partial<Omit<ReadinessDependencies, "validateDeployment">> & {
    readonly validateDeployment?: typeof validateCodexFollowUpDeployment;
  };
};

const CHECKING_STATUS: CodexFollowUpStatus = Object.freeze({
  state: "checking",
  authenticated: null,
  protocolCompatible: null,
  cacheHit: false,
  evidence: null,
  detail: "Codex follow-up compatibility is being evaluated.",
});

function unavailableStatus(detail: string): CodexFollowUpStatus {
  return Object.freeze({
    state: "unavailable",
    authenticated: null,
    protocolCompatible: null,
    cacheHit: false,
    evidence: null,
    detail,
  });
}

function isExecutionBoundaryChange(error: unknown): error is CodexLauncherError {
  return error instanceof CodexLauncherError &&
    (error.code === "IDENTITY_CHANGED" || error.code === "PROVENANCE_CHANGED");
}

function callerAbortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Codex app-server acquisition was cancelled.", "AbortError");
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(callerAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(callerAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function boundedDetail(error: unknown) {
  const text = error instanceof Error ? error.message : "Unknown Codex follow-up failure.";
  return text.replaceAll(/\s+/g, " ").slice(0, 512);
}

function evidenceIdentity(
  identity: CodexExecutableIdentity,
  schema: GeneratedCodexSchema,
  readback: CodexDeploymentReadbackEvidence | null = null,
): CodexFollowUpEvidenceIdentity {
  return Object.freeze({
    canonicalPath: identity.canonicalPath,
    version: identity.version,
    sha256: identity.sha256,
    schemaFingerprint: schema.fingerprint,
    userConfigSha256: readback
      ? requiredProvenanceHash(readback.configSourceHashes, "user:")
      : null,
    systemConfigSha256: readback
      ? requiredProvenanceHash(readback.configSourceHashes, "system:")
      : null,
    systemConfigPathCount: readback ? readback.systemConfigPaths.length : null,
    instructionSha256: readback
      ? requiredProvenanceHash(readback.instructionSourceHashes, "dedicated:")
      : null,
    accountKind: readback?.accountKind ?? null,
  });
}

function isCompatibilityFailure(error: unknown) {
  return (
    error instanceof CodexCapabilityProbeError &&
    (error.code === "PROBE_CAPABILITY" || error.code === "PROBE_PROTOCOL")
  ) || (
    error instanceof CodexCompatibilityError &&
    error.code === "SCHEMA_INCOMPATIBLE"
  );
}

function abortError(detail = "Codex follow-up evaluation was closed.") {
  return new CodexCapabilityProbeError("PROBE_TIMEOUT", detail);
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : abortError();
}

function requiredProvenanceHash(
  hashes: Readonly<Record<string, string>>,
  prefix: "user:" | "system:" | "dedicated:",
) {
  const matches = Object.entries(hashes).filter(([key]) => key.startsWith(prefix));
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/u.test(matches[0][1])) {
    throw new CodexCapabilityProbeError(
      "READBACK_PROVENANCE",
      `Codex deployment readback omitted its ${prefix.slice(0, -1)} provenance hash.`,
    );
  }
  return matches[0][1];
}

export class ManagedCodexFollowUpRuntime implements CodexFollowUpRuntime {
  readonly config: FollowUpConfigResult;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly evaluationTimeoutMs: number;
  readonly maxIdentityRestarts: number;

  #status: CodexFollowUpStatus = CHECKING_STATUS;
  #evaluation: Promise<CodexFollowUpStatus> | null = null;
  #closed = false;
  #abortController: AbortController | null = null;
  #execution: CompatibleCodexExecution | null = null;
  #replacementByExecution = new WeakMap<CompatibleCodexExecution, Promise<CompatibleCodexExecution>>();
  #dependencies: {
    readonly validateDeployment: typeof validateCodexFollowUpDeployment;
    readonly captureIdentity: typeof captureCodexExecutableIdentity;
    readonly generateSchema: typeof generateAndEvaluateCodexSchema;
    readonly runCapabilityProbe: typeof runDisposableCapabilityProbe;
    readonly readDeployment: typeof readActualCodexDeployment;
    readonly createEvidenceStore: (directory: string) => CodexCompatibilityEvidenceStore;
    readonly createExecution: typeof createCompatibleCodexExecution;
  };

  constructor(config: FollowUpConfigResult, options: CodexFollowUpRuntimeOptions = {}) {
    this.config = config;
    this.sourceEnvironment = options.sourceEnvironment ?? process.env;
    this.evaluationTimeoutMs = options.evaluationTimeoutMs ?? 45_000;
    this.maxIdentityRestarts = options.maxIdentityRestarts ?? 2;
    if (!Number.isFinite(this.evaluationTimeoutMs) || this.evaluationTimeoutMs <= 0) {
      throw new TypeError("Codex follow-up evaluationTimeoutMs must be positive and finite.");
    }
    if (!Number.isInteger(this.maxIdentityRestarts) || this.maxIdentityRestarts < 0) {
      throw new TypeError("Codex follow-up maxIdentityRestarts must be a non-negative integer.");
    }
    this.#dependencies = {
      validateDeployment: options.dependencies?.validateDeployment ?? validateCodexFollowUpDeployment,
      captureIdentity: options.dependencies?.captureIdentity ?? captureCodexExecutableIdentity,
      generateSchema: options.dependencies?.generateSchema ?? generateAndEvaluateCodexSchema,
      runCapabilityProbe: options.dependencies?.runCapabilityProbe ?? runDisposableCapabilityProbe,
      readDeployment: options.dependencies?.readDeployment ?? readActualCodexDeployment,
      createEvidenceStore:
        options.dependencies?.createEvidenceStore ??
        ((directory) => new CodexCompatibilityEvidenceStore(directory)),
      createExecution: options.dependencies?.createExecution ?? createCompatibleCodexExecution,
    };
  }

  evaluate() {
    if (this.#closed) return Promise.resolve(this.#status);
    if (this.#evaluation) return this.#evaluation;
    this.#execution = null;
    this.#status = CHECKING_STATUS;
    this.#abortController = new AbortController();
    const controller = this.#abortController;
    const deadline = setTimeout(() => {
      controller.abort(abortError("Codex follow-up evaluation timed out."));
    }, this.evaluationTimeoutMs);
    const evaluation = this.#evaluateFailSoft(controller.signal).finally(() => {
      clearTimeout(deadline);
    });
    this.#evaluation = evaluation;
    return evaluation.finally(() => {
      if (this.#evaluation === evaluation) this.#evaluation = null;
      this.#abortController = null;
    });
  }

  readStatus() {
    return this.#status;
  }

  async spawnAppServer(options: CompatibleAppServerSpawnOptions = {}) {
    const observed = await this.#acquireExecution(options.signal);
    try {
      return await observed.spawnAppServer(options);
    } catch (error) {
      if (!isExecutionBoundaryChange(error)) throw error;
    }

    const replacement = await this.#replaceChangedExecution(observed, options.signal);
    try {
      return await replacement.spawnAppServer(options);
    } catch (error) {
      if (isExecutionBoundaryChange(error)) {
        void this.#beginReplacement(replacement).catch(() => undefined);
      }
      throw error;
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#execution = null;
    this.#abortController?.abort(abortError());
    await this.#evaluation?.catch(() => undefined);
    if (this.#status.state === "checking") {
      this.#status = unavailableStatus("Codex follow-up evaluation was closed.");
    }
  }

  async #evaluateFailSoft(signal: AbortSignal) {
    try {
      const status = await this.#evaluate(signal);
      if (this.#closed) {
        this.#execution = null;
        return this.#status;
      }
      this.#status = status;
      return status;
    } catch (error) {
      this.#execution = null;
      if (this.#closed) return this.#status;
      const status = unavailableStatus(`Codex follow-up is unavailable: ${boundedDetail(error)}`);
      this.#status = status;
      return status;
    }
  }

  async #acquireExecution(signal?: AbortSignal) {
    if (this.#closed) {
      throw new CodexFollowUpRuntimeError(
        "RUNTIME_CLOSED",
        "The managed Codex runtime is closed.",
      );
    }
    if (signal?.aborted) throw callerAbortReason(signal);
    const current = this.#execution;
    if (current) return current;

    const status = await waitForCaller(this.evaluate(), signal);
    if (this.#closed) {
      throw new CodexFollowUpRuntimeError(
        "RUNTIME_CLOSED",
        "The managed Codex runtime closed during execution acquisition.",
      );
    }
    if (signal?.aborted) throw callerAbortReason(signal);
    const accepted = this.#execution;
    if (accepted) return accepted;
    throw new CodexFollowUpRuntimeError(
      "RUNTIME_NOT_READY",
      `The managed Codex runtime is ${status.state}: ${status.detail}`,
    );
  }

  #invalidateExactExecution(observed: CompatibleCodexExecution) {
    if (this.#execution !== observed) return false;
    this.#execution = null;
    if (!this.#closed) this.#status = CHECKING_STATUS;
    return true;
  }

  async #replaceChangedExecution(
    observed: CompatibleCodexExecution,
    signal?: AbortSignal,
  ) {
    return waitForCaller(this.#beginReplacement(observed), signal);
  }

  #beginReplacement(observed: CompatibleCodexExecution) {
    const existing = this.#replacementByExecution.get(observed);
    if (existing) return existing;
    if (this.#closed) {
      return Promise.reject(new CodexFollowUpRuntimeError(
        "RUNTIME_CLOSED",
        "The managed Codex runtime closed before reevaluation.",
      ));
    }
    const invalidated = this.#invalidateExactExecution(observed);
    const current = this.#execution;
    const replacement = current
      ? Promise.resolve(current)
      : this.#acquireExecution();
    if (invalidated || current) {
      this.#replacementByExecution.set(observed, replacement);
    }
    return replacement;
  }

  async #evaluate(signal: AbortSignal) {
    if (!this.config.ok) return unavailableStatus(this.config.status.detail);
    const validation = await this.#dependencies.validateDeployment(this.config.deployment);
    if (!validation.ok) return unavailableStatus(validation.detail);

    const deployment = validation.deployment;
    const childEnvironment = buildCodexFollowUpChildEnvironment(
      deployment,
      this.sourceEnvironment,
    );
    const evidenceStore = this.#dependencies.createEvidenceStore(deployment.evidenceDirectory);
    await evidenceStore.publishChecking(null, null, null);

    for (let attempt = 0; attempt <= this.maxIdentityRestarts; attempt += 1) {
      throwIfAborted(signal);
      let identity: CodexExecutableIdentity | null = null;
      let schema: GeneratedCodexSchema | null = null;
      try {
        identity = await this.#dependencies.captureIdentity(deployment.launcherPath, {
          cwd: deployment.appCwd,
          env: childEnvironment,
          signal,
          timeoutMs: Math.min(this.evaluationTimeoutMs, 30_000),
        });
        throwIfAborted(signal);
        schema = await this.#dependencies.generateSchema(
          identity,
          deployment,
          childEnvironment,
          { signal },
        );
        throwIfAborted(signal);
        await evidenceStore.publishChecking(
          identity,
          schema.fingerprint,
          schema.rawBundleSha256,
        );

        const cached = await evidenceStore.readReusablePositive(identity, schema.fingerprint);
        const capability = cached?.capability ?? await this.#dependencies.runCapabilityProbe(
          identity,
          deployment,
          {
            signal,
            timeoutMs: this.evaluationTimeoutMs,
            sourceEnvironment: this.sourceEnvironment,
          },
        );
        throwIfAborted(signal);
        if (!capability) {
          throw new CodexCapabilityProbeError(
            "PROBE_CAPABILITY",
            "Reusable compatibility evidence omitted capability proof.",
          );
        }
        const readback = await this.#dependencies.readDeployment(identity, deployment, {
          signal,
          timeoutMs: Math.min(this.evaluationTimeoutMs, 20_000),
          sourceEnvironment: this.sourceEnvironment,
        });
        throwIfAborted(signal);
        const compatibleEvidence = createCompatibilityEvidence({
          disposition: "compatible",
          executable: identity,
          schemaFingerprint: schema.fingerprint,
          rawSchemaBundleSha256: schema.rawBundleSha256,
          capability,
          deploymentReadback: readback,
          detail: readback.authenticated
            ? "Protocol, capabilities, deployment provenance, and dedicated authentication are compatible."
            : "Protocol, capabilities, and deployment provenance are compatible; the dedicated home is not authenticated.",
        });
        await evidenceStore.publishFinal(compatibleEvidence);
        throwIfAborted(signal);
        return this.#readyStatus(
          identity,
          schema,
          deployment,
          childEnvironment,
          readback,
          cached !== null,
        );
      } catch (error) {
        if (error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED") {
          if (attempt < this.maxIdentityRestarts) continue;
        }
        const disposition = isCompatibilityFailure(error) ? "incompatible" : "unavailable";
        const finalEvidence = createCompatibilityEvidence({
          disposition,
          executable: identity,
          schemaFingerprint: schema?.fingerprint ?? null,
          rawSchemaBundleSha256: schema?.rawBundleSha256 ?? null,
          capability: null,
          deploymentReadback: null,
          detail: boundedDetail(error),
        });
        await evidenceStore.publishFinal(finalEvidence).catch(() => undefined);
        return Object.freeze({
          state: disposition,
          authenticated: null,
          protocolCompatible: disposition === "incompatible" ? false : null,
          cacheHit: false,
          evidence: identity && schema ? evidenceIdentity(identity, schema) : null,
          detail: `Codex follow-up is ${disposition}: ${boundedDetail(error)}`,
        });
      }
    }
    return unavailableStatus("Codex follow-up executable identity did not stabilize.");
  }

  #readyStatus(
    identity: CodexExecutableIdentity,
    schema: GeneratedCodexSchema,
    deployment: ValidatedCodexFollowUpDeployment,
    childEnvironment: Readonly<Record<string, string | undefined>>,
    readback: CodexDeploymentReadbackEvidence,
    cacheHit: boolean,
  ): CodexFollowUpStatus {
    if (!readback.authenticated) {
      this.#execution = null;
      return Object.freeze({
        state: "unauthenticated",
        authenticated: false,
        protocolCompatible: true,
        cacheHit,
        evidence: evidenceIdentity(identity, schema, readback),
        detail: "Codex follow-up is compatible but the dedicated Codex home is not authenticated.",
      });
    }
    this.#execution = this.#dependencies.createExecution(
      identity,
      deployment,
      childEnvironment,
      Object.freeze({
        userConfigSha256: requiredProvenanceHash(readback.configSourceHashes, "user:"),
        instructionSha256: requiredProvenanceHash(readback.instructionSourceHashes, "dedicated:"),
        systemConfigPaths: Object.freeze([...readback.systemConfigPaths]),
      }),
    );
    return Object.freeze({
      state: "compatible",
      authenticated: true,
      protocolCompatible: true,
      cacheHit,
      evidence: evidenceIdentity(identity, schema, readback),
      detail: "Codex follow-up is compatible, authenticated, and ready.",
    });
  }
}

class UnavailableCodexFollowUpRuntime implements CodexFollowUpRuntime {
  readonly #status: CodexFollowUpStatus;

  constructor(detail: string) {
    this.#status = unavailableStatus(detail);
  }

  evaluate() {
    return Promise.resolve(this.#status);
  }

  readStatus() {
    return this.#status;
  }

  spawnAppServer() {
    return Promise.reject(new CodexFollowUpRuntimeError(
      "RUNTIME_NOT_READY",
      this.#status.detail,
    ));
  }

  close() {
    return Promise.resolve();
  }
}

export function createFailSoftManagedCodexFollowUpRuntime(
  config: FollowUpConfigResult,
  options: CodexFollowUpRuntimeOptions = {},
): CodexFollowUpRuntime {
  try {
    return new ManagedCodexFollowUpRuntime(config, options);
  } catch (error) {
    return new UnavailableCodexFollowUpRuntime(
      `Codex follow-up construction failed: ${boundedDetail(error)}`,
    );
  }
}

export async function startFailSoftManagedCodexFollowUpRuntime(
  config: FollowUpConfigResult,
  options: CodexFollowUpRuntimeOptions = {},
) {
  const runtime = createFailSoftManagedCodexFollowUpRuntime(config, options);
  try {
    await runtime.evaluate();
    return runtime;
  } catch (error) {
    await runtime.close().catch(() => undefined);
    return new UnavailableCodexFollowUpRuntime(
      `Codex follow-up startup failed: ${boundedDetail(error)}`,
    );
  }
}

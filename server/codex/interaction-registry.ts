import { randomUUID } from "node:crypto";

import type {
  AppServerRequestId,
  AppServerResponseError,
  AppServerServerRequest,
} from "./app-server-client.ts";

export const USER_INPUT_REQUEST_METHOD = "item/tool/requestUserInput";
export const FORBIDDEN_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

export type UserInputOption = {
  label: string;
  description: string;
};
export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
};
export type PendingUserInputInteraction = {
  id: string;
  kind: "user_input";
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  createdAtMs: number;
  expiresAtMs: number | null;
};
export type UserInputAnswers = Record<string, readonly string[]>;

export type InteractionResponsePort = {
  respond: (id: AppServerRequestId, result: unknown) => void;
  respondError: (id: AppServerRequestId, error: AppServerResponseError) => void;
};
export type InteractionRegistryOptions = InteractionResponsePort & {
  createOpaqueId?: () => string;
  now?: () => number;
  maxPending?: number;
  onChange?: () => void;
};

type PendingEntry = {
  protocolRequestId: AppServerRequestId;
  interaction: PendingUserInputInteraction;
  timer: ReturnType<typeof setTimeout> | null;
};

const MIN_AUTO_RESOLUTION_MS = 60_000;
const MAX_AUTO_RESOLUTION_MS = 240_000;
const DEFAULT_MAX_PENDING = 16;
const MAX_PENDING = 64;
const MAX_IDENTIFIER_BYTES = 200;
const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 3;
const MAX_HEADER_BYTES = 128;
const MAX_QUESTION_BYTES = 4_096;
const MAX_OPTION_LABEL_BYTES = 256;
const MAX_OPTION_DESCRIPTION_BYTES = 1_024;
const MAX_ANSWER_BYTES = 2_048;

export class InteractionRegistryError extends Error {
  readonly code:
    | "INVALID_INTERACTION"
    | "SECRET_INTERACTION"
    | "CAPACITY_EXCEEDED"
    | "INVALID_ANSWERS";

  constructor(code: InteractionRegistryError["code"], message: string) {
    super(message);
    this.name = "InteractionRegistryError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
      Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new InteractionRegistryError(
      "INVALID_INTERACTION",
      `${label} must be a non-empty bounded string.`,
    );
  }
  return value;
}

function parseOption(value: unknown): UserInputOption {
  if (!isRecord(value) || !hasOnlyKeys(value, ["label", "description"])) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid user-input option.");
  }
  return {
    label: boundedString(value.label, "Option label", MAX_OPTION_LABEL_BYTES),
    description: boundedString(
      value.description,
      "Option description",
      MAX_OPTION_DESCRIPTION_BYTES,
    ),
  };
}

function parseQuestion(value: unknown): UserInputQuestion {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id",
    "header",
    "question",
    "options",
    "isOther",
    "isSecret",
  ])) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid user-input question.");
  }
  if (value.isSecret === true) {
    throw new InteractionRegistryError(
      "SECRET_INTERACTION",
      "Secret user-input questions are not exposed by the planner.",
    );
  }
  if (value.isSecret !== false) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid isSecret value.");
  }
  if (typeof value.isOther !== "boolean") {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid isOther value.");
  }

  if (!Array.isArray(value.options) || value.options.length < MIN_OPTIONS ||
      value.options.length > MAX_OPTIONS) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid user-input options.");
  }
  const options = value.options.map(parseOption);
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Option labels must be unique.");
  }

  return {
    id: boundedString(value.id, "Question id", MAX_IDENTIFIER_BYTES),
    header: boundedString(value.header, "Question header", MAX_HEADER_BYTES),
    question: boundedString(value.question, "Question", MAX_QUESTION_BYTES),
    options,
  };
}

function parseRequestParams(value: unknown) {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "threadId",
    "turnId",
    "itemId",
    "questions",
    "autoResolutionMs",
  ])) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid user-input request.");
  }
  if (!Array.isArray(value.questions) || value.questions.length < 1 ||
      value.questions.length > MAX_QUESTIONS) {
    throw new InteractionRegistryError(
      "INVALID_INTERACTION",
      `User-input requests must contain between 1 and ${MAX_QUESTIONS} questions.`,
    );
  }
  const questions = value.questions.map(parseQuestion);
  const questionIds = new Set(questions.map((question) => question.id));
  if (questionIds.size !== questions.length) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Question ids must be unique.");
  }
  if (value.autoResolutionMs !== undefined && value.autoResolutionMs !== null &&
      (typeof value.autoResolutionMs !== "number" ||
        !Number.isSafeInteger(value.autoResolutionMs) ||
        value.autoResolutionMs < MIN_AUTO_RESOLUTION_MS ||
        value.autoResolutionMs > MAX_AUTO_RESOLUTION_MS)) {
    throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid auto-resolution timeout.");
  }
  return {
    threadId: boundedString(value.threadId, "Thread id", MAX_IDENTIFIER_BYTES),
    turnId: boundedString(value.turnId, "Turn id", MAX_IDENTIFIER_BYTES),
    itemId: boundedString(value.itemId, "Item id", MAX_IDENTIFIER_BYTES),
    questions,
    autoResolutionMs: typeof value.autoResolutionMs === "number"
      ? value.autoResolutionMs
      : null,
  };
}

function copyInteraction(interaction: PendingUserInputInteraction): PendingUserInputInteraction {
  return {
    ...interaction,
    questions: interaction.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}

export class InteractionRegistry {
  #entries = new Map<string, PendingEntry>();
  #respond: InteractionResponsePort["respond"];
  #respondError: InteractionResponsePort["respondError"];
  #createOpaqueId: () => string;
  #now: () => number;
  #maxPending: number;
  #onChange: () => void;
  #closed = false;

  constructor(options: InteractionRegistryOptions) {
    this.#respond = options.respond;
    this.#respondError = options.respondError;
    this.#createOpaqueId = options.createOpaqueId ?? (() => `interaction_${randomUUID()}`);
    this.#now = options.now ?? Date.now;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#onChange = options.onChange ?? (() => undefined);
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1 ||
        this.#maxPending > MAX_PENDING) {
      throw new InteractionRegistryError("INVALID_INTERACTION", "Invalid interaction capacity.");
    }
  }

  register(request: AppServerServerRequest): PendingUserInputInteraction | null {
    if (request.method !== USER_INPUT_REQUEST_METHOD) return null;
    if (this.#closed) {
      this.#respondError(request.id, {
        code: -32002,
        message: "The planner interaction host is closed.",
      });
      return null;
    }
    if (this.#entries.size >= this.#maxPending) {
      this.#respondError(request.id, {
        code: -32003,
        message: "The planner interaction queue is full.",
      });
      return null;
    }
    if ([...this.#entries.values()].some(
      (entry) => entry.protocolRequestId === request.id,
    )) {
      throw new InteractionRegistryError(
        "INVALID_INTERACTION",
        "Codex reused a pending protocol request identifier.",
      );
    }

    let params: ReturnType<typeof parseRequestParams>;
    try {
      params = parseRequestParams(request.params);
    } catch (error) {
      const secret = error instanceof InteractionRegistryError &&
        error.code === "SECRET_INTERACTION";
      this.#respondError(request.id, {
        code: secret ? -32001 : -32602,
        message: secret
          ? "Secret user input is not supported by the planner."
          : "Invalid planner user-input request.",
      });
      return null;
    }

    const id = this.#allocateOpaqueId(request.id);
    const createdAtMs = this.#now();
    const ttlMs = params.autoResolutionMs;
    const interaction: PendingUserInputInteraction = {
      id,
      kind: "user_input",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      questions: params.questions,
      createdAtMs,
      expiresAtMs: ttlMs === null ? null : createdAtMs + ttlMs,
    };
    const timer = ttlMs === null
      ? null
      : setTimeout(() => {
        try {
          this.expire(id);
        } catch {
          // The owning app-server process may have failed at the expiry boundary.
        }
      }, ttlMs);
    timer?.unref?.();
    this.#entries.set(id, {
      protocolRequestId: request.id,
      interaction,
      timer,
    });
    this.#notifyChange();
    return copyInteraction(interaction);
  }

  list() {
    return [...this.#entries.values()]
      .map((entry) => copyInteraction(entry.interaction))
      .sort((left, right) => left.createdAtMs - right.createdAtMs ||
        left.id.localeCompare(right.id));
  }

  get(id: string) {
    const entry = this.#entries.get(id);
    return entry ? copyInteraction(entry.interaction) : null;
  }

  resolveProtocolRequest(
    protocolRequestId: AppServerRequestId,
    threadId: string,
  ): "resolved" | "unknown" | "thread_mismatch" {
    for (const [id, entry] of this.#entries) {
      if (entry.protocolRequestId !== protocolRequestId) continue;
      if (entry.interaction.threadId !== threadId) return "thread_mismatch";
      this.#entries.delete(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.#notifyChange();
      return "resolved";
    }
    return "unknown";
  }

  answer(id: string, answers: UserInputAnswers) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    const response = this.#parseAnswers(entry.interaction.questions, answers);
    this.#entries.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.#respond(entry.protocolRequestId, { answers: response });
    this.#notifyChange();
    return true;
  }

  expire(id: string) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.#respond(entry.protocolRequestId, { answers: {} });
    this.#notifyChange();
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      try {
        this.#respondError(entry.protocolRequestId, {
          code: -32002,
          message: "The planner interaction host closed before receiving an answer.",
        });
      } catch {
        // Closing remains idempotent when the app-server transport already failed.
      }
    }
    if (entries.length > 0) this.#notifyChange();
  }

  #allocateOpaqueId(protocolRequestId: AppServerRequestId) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#createOpaqueId();
      if (typeof id === "string" && id.length > 0 &&
          Buffer.byteLength(id, "utf8") <= MAX_IDENTIFIER_BYTES &&
          !id.includes("\u0000") && id !== String(protocolRequestId) &&
          !this.#entries.has(id)) {
        return id;
      }
    }
    throw new InteractionRegistryError(
      "CAPACITY_EXCEEDED",
      "Could not allocate a unique interaction identifier.",
    );
  }

  #parseAnswers(questions: UserInputQuestion[], value: UserInputAnswers) {
    if (!isRecord(value)) {
      throw new InteractionRegistryError("INVALID_ANSWERS", "Answers must be an object.");
    }
    const expectedIds = new Set(questions.map((question) => question.id));
    const suppliedIds = Object.keys(value);
    if (suppliedIds.length !== expectedIds.size ||
        suppliedIds.some((id) => !expectedIds.has(id))) {
      throw new InteractionRegistryError(
        "INVALID_ANSWERS",
        "Answers must match every pending question exactly.",
      );
    }
    const responseEntries: Array<[string, { answers: string[] }]> = [];
    for (const question of questions) {
      const questionAnswers = value[question.id];
      const optionLabels = new Set(question.options.map((option) => option.label));
      if (!Array.isArray(questionAnswers) || questionAnswers.length !== 1 ||
          questionAnswers.some((answer) => typeof answer !== "string" ||
            answer.length === 0 || answer.includes("\u0000") ||
            Buffer.byteLength(answer, "utf8") > MAX_ANSWER_BYTES ||
            !optionLabels.has(answer))) {
        throw new InteractionRegistryError(
          "INVALID_ANSWERS",
          `Invalid answers for question ${question.id}.`,
        );
      }
      responseEntries.push([question.id, { answers: [...questionAnswers] }]);
    }
    return Object.fromEntries(responseEntries) as Record<string, { answers: string[] }>;
  }

  #notifyChange() {
    try {
      this.#onChange();
    } catch {
      // Settlement remains authoritative even if the invalidation signal fails.
    }
  }
}

export function handleForbiddenApprovalRequest(
  request: AppServerServerRequest,
  port: InteractionResponsePort,
) {
  if (request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval") {
    port.respond(request.id, { decision: "decline" });
    return true;
  }
  if (request.method === "mcpServer/elicitation/request") {
    port.respond(request.id, { action: "decline", content: null, _meta: null });
    return true;
  }
  if (request.method === "applyPatchApproval" || request.method === "execCommandApproval") {
    port.respond(request.id, { decision: "denied" });
    return true;
  }
  if ((FORBIDDEN_APPROVAL_METHODS as readonly string[]).includes(request.method)) {
    port.respondError(request.id, {
      code: -32001,
      message: `The planner does not permit ${request.method}.`,
    });
    return true;
  }
  return false;
}

export function rejectUnsupportedServerRequest(
  request: AppServerServerRequest,
  port: InteractionResponsePort,
) {
  port.respondError(request.id, {
    code: -32601,
    message: `Unsupported Codex app-server request ${request.method}.`,
  });
}

import type {
  CodexActivityItem,
  CodexActivityStatus,
  CodexMessageAttachment,
  CodexMessageItem,
  CodexReasoningItem,
  CodexThreadItemView,
  CodexThreadStatus,
  CodexThreadSummary,
  CodexThreadView,
  CodexTurnView,
  CodexWorkerActivityItem,
  CodexWorkerOperation,
  CodexWorkerState,
  CodexWorkerSummary,
} from "../../lib/codex-thread-contract.ts";

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_PREVIEW_LENGTH = 500;
const MAX_DISPLAY_TEXT_LENGTH = 32_000;
const MAX_ACTIVITY_DETAIL_LENGTH = 1_000;
const MAX_REASONING_SUMMARIES = 20;
const MAX_MESSAGE_ATTACHMENTS = 20;
const MAX_WORKERS_PER_ITEM = 20;
const MAX_TURNS = 200;
const MAX_ITEMS_PER_TURN = 1_000;

const FORBIDDEN_DISPLAY_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "imageView",
  "imageGeneration",
]);

export const CODEX_TOOL_ACTIVITY_LABELS = {
  "planner.read": "Reading the planner",
  "planner.preview": "Checking planner changes",
  "planner.apply": "Updating the planner",
} as const;

const COLLAB_TOOL_PROJECTION: Record<string, {
  operation: CodexWorkerOperation;
  label: string;
}> = {
  spawnAgent: { operation: "start", label: "Starting a background worker" },
  sendInput: { operation: "message", label: "Sending a message to a background worker" },
  resumeAgent: { operation: "resume", label: "Resuming a background worker" },
  wait: { operation: "wait", label: "Waiting for background workers" },
  closeAgent: { operation: "close", label: "Closing a background worker" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, maximum);
}

function boundedNonEmptyString(value: unknown, maximum: number): string | null {
  const bounded = boundedString(value, maximum);
  return bounded !== null && bounded.trim().length > 0 ? bounded : null;
}

function projectIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !value.includes("\0") &&
    value.trim().length > 0
    ? value
    : null;
}

function fallbackIdentifier(index: number): string {
  return `activity-${Math.max(0, index)}`;
}

function epochSecondsToMs(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return null;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function safeDuration(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function projectActivityStatus(value: unknown): CodexActivityStatus {
  switch (value) {
    case "pending":
    case "pendingInit":
      return "pending";
    case "inProgress":
    case "running":
      return "running";
    case "completed":
    case "shutdown":
      return "completed";
    case "failed":
    case "errored":
    case "notFound":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "unknown";
  }
}

export function projectCodexThreadStatus(value: unknown): CodexThreadStatus {
  if (!isRecord(value)) return { state: "unknown", waitingFor: null };
  if (value.type === "notLoaded") return { state: "not_loaded", waitingFor: null };
  if (value.type === "idle") return { state: "idle", waitingFor: null };
  if (value.type === "systemError") return { state: "error", waitingFor: null };
  if (value.type !== "active") return { state: "unknown", waitingFor: null };

  const flags = Array.isArray(value.activeFlags) ? value.activeFlags : [];
  if (flags.includes("waitingOnApproval")) {
    return { state: "active", waitingFor: "approval" };
  }
  if (flags.includes("waitingOnUserInput")) {
    return { state: "active", waitingFor: "user_input" };
  }
  return { state: "active", waitingFor: null };
}

function projectThreadTitle(value: Record<string, unknown>): string {
  const explicitName = boundedNonEmptyString(value.name, MAX_TITLE_LENGTH);
  if (explicitName !== null) return explicitName;
  const preview = boundedNonEmptyString(value.preview, MAX_TITLE_LENGTH);
  if (preview === null) return "New conversation";
  return preview.split(/\r?\n/u, 1)[0] || "New conversation";
}

export function projectCodexThreadSummary(value: unknown): CodexThreadSummary | null {
  if (!isRecord(value)) return null;
  const id = projectIdentifier(value.id);
  if (id === null) return null;
  return {
    id,
    title: projectThreadTitle(value),
    preview: boundedString(value.preview, MAX_PREVIEW_LENGTH) ?? "",
    status: projectCodexThreadStatus(value.status),
    createdAtMs: epochSecondsToMs(value.createdAt),
    updatedAtMs: epochSecondsToMs(value.updatedAt),
    recencyAtMs: epochSecondsToMs(value.recencyAt),
  };
}

function projectMessageContent(value: unknown): {
  text: string;
  attachments: CodexMessageAttachment[];
} {
  if (!Array.isArray(value)) return { text: "", attachments: [] };
  const text: string[] = [];
  const attachments: CodexMessageAttachment[] = [];
  for (const input of value) {
    if (!isRecord(input)) continue;
    if (input.type === "text") {
      const part = boundedString(input.text, MAX_DISPLAY_TEXT_LENGTH);
      if (part !== null) text.push(part);
      continue;
    }
    if (attachments.length >= MAX_MESSAGE_ATTACHMENTS) continue;
    if (input.type === "image" || input.type === "localImage") {
      attachments.push({ kind: "image", label: "Image" });
      continue;
    }
    if (input.type === "skill") {
      attachments.push({
        kind: "skill",
        label: boundedNonEmptyString(input.name, MAX_TITLE_LENGTH) ?? "Skill",
      });
      continue;
    }
    if (input.type === "mention") {
      attachments.push({
        kind: "mention",
        label: boundedNonEmptyString(input.name, MAX_TITLE_LENGTH) ?? "Mention",
      });
    }
  }
  return {
    text: text.join("\n").slice(0, MAX_DISPLAY_TEXT_LENGTH),
    attachments,
  };
}

function projectUserMessage(value: Record<string, unknown>, id: string): CodexMessageItem {
  const content = projectMessageContent(value.content);
  return {
    kind: "message",
    id,
    role: "user",
    phase: null,
    text: content.text,
    clientUserMessageId: projectIdentifier(value.clientId),
    attachments: content.attachments,
  };
}

function projectAgentMessage(value: Record<string, unknown>, id: string): CodexMessageItem {
  return {
    kind: "message",
    id,
    role: "assistant",
    phase: value.phase === "commentary"
      ? "commentary"
      : value.phase === "final_answer"
        ? "final"
        : null,
    text: boundedString(value.text, MAX_DISPLAY_TEXT_LENGTH) ?? "",
    clientUserMessageId: null,
    attachments: [],
  };
}

function projectReasoning(value: Record<string, unknown>, id: string): CodexReasoningItem {
  const summaries = Array.isArray(value.summary)
    ? value.summary
      .slice(0, MAX_REASONING_SUMMARIES)
      .map((summary) => boundedNonEmptyString(summary, MAX_ACTIVITY_DETAIL_LENGTH))
      .filter((summary): summary is string => summary !== null)
    : [];
  return { kind: "reasoning", id, label: "Thinking", summaries };
}

function activity(
  id: string,
  category: CodexActivityItem["category"],
  label: string,
  status: CodexActivityStatus,
  detail: string | null = null,
): CodexActivityItem {
  return { kind: "activity", id, category, label, detail, status };
}

export function getCodexToolActivityLabel(namespace: unknown, tool: unknown): string {
  const namespacePart = boundedNonEmptyString(namespace, 100);
  const toolPart = boundedNonEmptyString(tool, 100);
  const qualified = namespacePart === null || toolPart === null
    ? toolPart
    : `${namespacePart}.${toolPart}`;
  switch (qualified) {
    case "planner.read":
    case "planner.planner.read":
      return CODEX_TOOL_ACTIVITY_LABELS["planner.read"];
    case "planner.preview":
    case "planner.planner.preview":
      return CODEX_TOOL_ACTIVITY_LABELS["planner.preview"];
    case "planner.apply":
    case "planner.planner.apply":
      return CODEX_TOOL_ACTIVITY_LABELS["planner.apply"];
    default:
      return "Using an app tool";
  }
}

function projectDynamicTool(
  value: Record<string, unknown>,
  id: string,
): CodexActivityItem {
  return activity(
    id,
    "tool",
    getCodexToolActivityLabel(value.namespace, value.tool),
    projectActivityStatus(value.status),
  );
}

function projectWebSearch(value: Record<string, unknown>, id: string): CodexActivityItem {
  const action = isRecord(value.action) ? value.action.type : null;
  const label = action === "openPage"
    ? "Opening a source"
    : action === "findInPage"
      ? "Searching within a source"
      : "Searching the web";
  return activity(id, "web", label, "completed");
}

function projectWorkerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const candidate of value) {
    const id = projectIdentifier(candidate);
    if (id !== null) unique.add(id);
    if (unique.size >= MAX_WORKERS_PER_ITEM) break;
  }
  return [...unique];
}

function projectWorkerStates(
  workerThreadIds: string[],
  value: unknown,
): CodexWorkerState[] {
  const agentsStates = isRecord(value) ? value : null;
  return workerThreadIds.map((threadId) => {
    const agentState = agentsStates !== null && isRecord(agentsStates[threadId])
      ? agentsStates[threadId]
      : null;
    return {
      threadId,
      status: projectActivityStatus(agentState?.status),
    };
  });
}

function projectCollabTool(
  value: Record<string, unknown>,
  id: string,
): CodexWorkerActivityItem {
  const projection = typeof value.tool === "string"
    ? COLLAB_TOOL_PROJECTION[value.tool]
    : undefined;
  const workerThreadIds = projectWorkerIds(value.receiverThreadIds);
  return {
    kind: "worker",
    id,
    label: projection?.label ?? "Coordinating background work",
    operation: projection?.operation ?? "activity",
    workerThreadIds,
    workerStates: projectWorkerStates(workerThreadIds, value.agentsStates),
    status: projectActivityStatus(value.status),
  };
}

function projectSubAgentActivity(
  value: Record<string, unknown>,
  id: string,
): CodexWorkerActivityItem {
  const workerId = projectIdentifier(value.agentThreadId);
  const status = value.kind === "interrupted" ? "interrupted" : "running";
  const label = value.kind === "started"
    ? "Background worker started"
    : value.kind === "interacted"
      ? "Background worker updated"
      : value.kind === "interrupted"
        ? "Background worker interrupted"
        : "Background worker activity";
  const workerThreadIds = workerId === null ? [] : [workerId];
  return {
    kind: "worker",
    id,
    label,
    operation: "activity",
    workerThreadIds,
    workerStates: workerThreadIds.map((threadId) => ({ threadId, status })),
    status,
  };
}

/**
 * Projects one completed/native item into a bounded display DTO. Unknown items
 * remain visible as generic progress, while forbidden capability items expose
 * neither their type-specific data nor any path, argument, result, or output.
 */
export function projectCodexThreadItem(value: unknown, index = 0): CodexThreadItemView {
  if (!isRecord(value)) {
    return activity(fallbackIdentifier(index), "other", "Working", "unknown");
  }
  const id = projectIdentifier(value.id) ?? fallbackIdentifier(index);
  const type = typeof value.type === "string" ? value.type : null;

  if (type !== null && FORBIDDEN_DISPLAY_ITEM_TYPES.has(type)) {
    return activity(id, "restricted", "Restricted activity", projectActivityStatus(value.status));
  }
  switch (type) {
    case "userMessage":
      return projectUserMessage(value, id);
    case "agentMessage":
      return projectAgentMessage(value, id);
    case "reasoning":
      return projectReasoning(value, id);
    case "plan":
      return activity(
        id,
        "plan",
        "Making a plan",
        "completed",
        boundedNonEmptyString(value.text, MAX_DISPLAY_TEXT_LENGTH),
      );
    case "dynamicToolCall":
      return projectDynamicTool(value, id);
    case "collabAgentToolCall":
      return projectCollabTool(value, id);
    case "subAgentActivity":
      return projectSubAgentActivity(value, id);
    case "webSearch":
      return projectWebSearch(value, id);
    case "contextCompaction":
      return activity(id, "system", "Condensing conversation context", "completed");
    case "sleep":
      return activity(id, "system", "Waiting", "running");
    case "enteredReviewMode":
      return activity(id, "system", "Reviewing the work", "running");
    case "exitedReviewMode":
      return activity(id, "system", "Finished reviewing the work", "completed");
    case "hookPrompt":
      return activity(id, "system", "Preparing context", "completed");
    default:
      return activity(id, "other", "Working", "unknown");
  }
}

function projectTurnStatus(value: unknown): CodexTurnView["status"] {
  switch (value) {
    case "completed":
    case "interrupted":
    case "failed":
      return value;
    case "inProgress":
      return "in_progress";
    default:
      return "unknown";
  }
}

function projectItemsView(value: unknown): CodexTurnView["itemsView"] {
  switch (value) {
    case "full":
    case "summary":
      return value;
    case "notLoaded":
      return "not_loaded";
    default:
      return "unknown";
  }
}

export function projectCodexTurn(value: unknown, index = 0): CodexTurnView | null {
  if (!isRecord(value)) return null;
  const id = projectIdentifier(value.id);
  if (id === null) return null;
  const status = projectTurnStatus(value.status);
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
    .slice(Math.max(0, rawItems.length - MAX_ITEMS_PER_TURN))
    .map((item, itemIndex) => projectCodexThreadItem(item, index * MAX_ITEMS_PER_TURN + itemIndex));
  return {
    id,
    status,
    itemsView: projectItemsView(value.itemsView ?? "full"),
    startedAtMs: epochSecondsToMs(value.startedAt),
    completedAtMs: epochSecondsToMs(value.completedAt),
    durationMs: safeDuration(value.durationMs),
    errorMessage: status === "failed" ? "The response failed." : null,
    items,
  };
}

function collectWorkerSummaries(turns: CodexTurnView[]): CodexWorkerSummary[] {
  const summaries = new Map<string, CodexWorkerSummary>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind !== "worker") continue;
      for (const workerState of item.workerStates) {
        summaries.set(workerState.threadId, {
          threadId: workerState.threadId,
          label: "Background worker",
          status: workerState.status,
        });
      }
    }
  }
  return [...summaries.values()];
}

export function projectCodexThread(value: unknown): CodexThreadView | null {
  const summary = projectCodexThreadSummary(value);
  if (summary === null || !isRecord(value)) return null;
  const rawTurns = Array.isArray(value.turns) ? value.turns : [];
  const selectedTurns = rawTurns.slice(Math.max(0, rawTurns.length - MAX_TURNS));
  const turns = selectedTurns
    .map((turn, index) => projectCodexTurn(turn, index))
    .filter((turn): turn is CodexTurnView => turn !== null);
  return {
    ...summary,
    threadKind: projectIdentifier(value.parentThreadId) === null ? "conversation" : "worker",
    parentThreadId: projectIdentifier(value.parentThreadId),
    turns,
    workers: collectWorkerSummaries(turns),
    historyTruncated: rawTurns.length > MAX_TURNS ||
      selectedTurns.some((turn) =>
        isRecord(turn) && Array.isArray(turn.items) && turn.items.length > MAX_ITEMS_PER_TURN,
      ),
  };
}

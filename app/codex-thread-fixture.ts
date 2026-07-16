import type {
  CodexActivityStatus,
  CodexInteraction,
  CodexInteractionListRequest,
  CodexInteractionResponse,
  CodexThreadListRequest,
  CodexThreadListResponse,
  CodexThreadReadResponse,
  CodexThreadSummary,
  CodexThreadView,
} from "../lib/codex-thread-contract.ts";

import { CodexThreadClientError } from "./codex-thread-api.ts";
import type { CodexThreadSnapshot, CodexThreadSource } from "./codex-thread-source.ts";

export type PreviewScenario = "default" | "activity-burst";

function fixtureThread(options: {
  id: string;
  title: string;
  preview: string;
  activityLabel: string;
  activityStatus?: CodexActivityStatus;
  withInteraction?: boolean;
  recencyAtMs?: number;
  userMessage?: string;
}): CodexThreadView {
  const recencyAtMs = options.recencyAtMs ?? 1_784_001_200_000;
  return {
    id: options.id,
    title: options.title,
    preview: options.preview,
    status: { state: "active", waitingFor: options.withInteraction ? "user_input" : null },
    createdAtMs: 1_784_001_000_000,
    updatedAtMs: recencyAtMs,
    recencyAtMs,
    threadKind: "conversation",
    parentThreadId: null,
    historyTruncated: false,
    workers: [],
    turns: [{
      id: `${options.id}-turn`,
      status: "in_progress",
      itemsView: "full",
      startedAtMs: 1_784_001_000_000,
      completedAtMs: null,
      durationMs: null,
      errorMessage: null,
      items: [
        {
          kind: "message",
          id: `${options.id}-user`,
          role: "user",
          phase: "commentary",
          text: options.userMessage ?? "Can you help with Friday dinner?",
          clientUserMessageId: "fixture-user-message",
          attachments: [],
        },
        {
          kind: "reasoning",
          id: `${options.id}-thinking`,
          label: "Thinking",
          summaries: ["Checking the current plan before suggesting a change."],
        },
        {
          kind: "activity",
          id: `${options.id}-activity`,
          category: "plan",
          label: options.activityLabel,
          detail: "This detail is intentionally not shown in the rail.",
          status: options.activityStatus ?? "running",
        },
      ],
    }],
  };
}

function fixtureWorkerThread(): CodexThreadView {
  return {
    id: "worker-friday-options",
    title: "Friday options research",
    preview: "Compared Friday dinner constraints",
    status: { state: "idle", waitingFor: null },
    createdAtMs: 1_784_001_050_000,
    updatedAtMs: 1_784_001_180_000,
    recencyAtMs: 1_784_001_180_000,
    threadKind: "worker",
    parentThreadId: "week-planning",
    historyTruncated: false,
    workers: [],
    turns: [{
      id: "worker-friday-options-turn",
      status: "completed",
      itemsView: "full",
      startedAtMs: 1_784_001_050_000,
      completedAtMs: 1_784_001_180_000,
      durationMs: 130_000,
      errorMessage: null,
      items: [{
        kind: "message",
        id: "worker-friday-options-message",
        role: "assistant",
        phase: "commentary",
        text: "Compared the open Friday slot with the current prep and grocery constraints.",
        clientUserMessageId: null,
        attachments: [],
      }, {
        kind: "activity",
        id: "worker-friday-options-activity",
        category: "plan",
        label: "Friday options checked",
        detail: null,
        status: "completed",
      }],
    }],
  };
}

function threadSummary(thread: CodexThreadView): CodexThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    preview: thread.preview,
    status: thread.status,
    createdAtMs: thread.createdAtMs,
    updatedAtMs: thread.updatedAtMs,
    recencyAtMs: thread.recencyAtMs,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class PreviewCodexThreadSource implements CodexThreadSource {
  readonly mode = "preview" as const;
  private readonly threads = new Map<string, CodexThreadView>();
  private readonly archivedThreads = new Map<string, CodexThreadView>();
  private readonly scenario: PreviewScenario;
  private selectedId = "week-planning";
  private selectionRevision = 3;
  private activityRevision = 12;
  private reads = 0;
  private current: CodexThreadSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(scenario: PreviewScenario) {
    this.scenario = scenario;
    const weekPlanning = fixtureThread({
      id: "week-planning",
      title: "Friday dinner",
      preview: "Help with Friday dinner",
      activityLabel: "Checking Friday options",
      withInteraction: true,
      recencyAtMs: 1_784_001_400_000,
    });
    weekPlanning.workers = [{
      threadId: "worker-friday-options",
      label: "Friday options research",
      status: "completed",
    }];
    weekPlanning.turns[0]?.items.splice(2, 0, {
      kind: "worker",
      id: "week-planning-worker",
      label: "Friday options research",
      operation: "activity",
      workerThreadIds: ["worker-friday-options"],
      workerStates: [{ threadId: "worker-friday-options", status: "completed" }],
      status: "completed",
    });
    this.threads.set("week-planning", weekPlanning);
    this.threads.set("grocery-question", fixtureThread({
      id: "grocery-question",
      title: "Grocery list",
      preview: "Review this week’s grocery list",
      activityLabel: "Reviewing the grocery list",
      activityStatus: "completed",
      recencyAtMs: 1_784_001_300_000,
      userMessage: "Please review this week’s grocery list.",
    }));
    this.threads.set("weekend-prep", fixtureThread({
      id: "weekend-prep",
      title: "Weekend prep",
      preview: "Plan prep for Saturday and Sunday",
      activityLabel: "Reviewing weekend prep",
      activityStatus: "completed",
      recencyAtMs: 1_784_001_200_000,
      userMessage: "Help me plan prep for Saturday and Sunday.",
    }));
    this.threads.set("worker-friday-options", fixtureWorkerThread());
    this.archivedThreads.set("archived-meal-ideas", fixtureThread({
      id: "archived-meal-ideas",
      title: "Archived meal ideas",
      preview: "Earlier dinner ideas",
      activityLabel: "Meal ideas reviewed",
      activityStatus: "completed",
      recencyAtMs: 1_783_900_000_000,
    }));
  }

  private emit(): CodexThreadSnapshot {
    this.current = this.snapshot();
    for (const listener of this.listeners) listener();
    return this.current;
  }

  async start(): Promise<CodexThreadSnapshot> {
    return this.load();
  }

  stop(): void {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CodexThreadSnapshot {
    this.current ??= this.snapshot();
    return this.current;
  }

  private snapshot(): CodexThreadSnapshot {
    this.reads += 1;
    const source = this.threads.get(this.selectedId) ?? null;
    const thread = source ? clone(source) : null;
    if (thread && this.scenario === "activity-burst" && this.reads > 1) {
      const activity = thread.turns.flatMap((turn) => turn.items).find((item) => item.kind === "activity");
      if (activity?.kind === "activity") activity.label = "Reviewing Friday dinner";
    }
    const interactions: CodexInteraction[] = this.selectedId === "week-planning" ? [{
      id: "fixture-question",
      kind: "user_input" as const,
      threadId: this.selectedId,
      turnId: `${this.selectedId}-turn`,
      itemId: `${this.selectedId}-activity`,
      title: "Friday dinner choice",
      createdAtMs: 1_784_001_200_000,
      autoResolveAtMs: null,
      questions: [{
        id: "fixture-question-1",
        header: "Friday dinner",
        question: "Should Friday be meatless?",
        options: [
          { label: "Yes", description: "Keep Friday meatless." },
          { label: "No", description: "Include meat or fish." },
        ],
        allowOther: false as const,
        responseMode: "listed_option" as const,
      }],
    }, {
      id: "fixture-approval",
      kind: "approval",
      threadId: this.selectedId,
      turnId: `${this.selectedId}-turn`,
      itemId: "fixture-command-request",
      title: "Command approval",
      createdAtMs: 1_784_001_250_000,
      category: "command",
      summary: "Codex requested to run a command while checking the plan.",
      resolution: "rejected_by_policy",
    }] : [];
    return {
      mode: "preview",
      status: thread ? "ready" : "empty",
      threads: [...this.threads.values()]
        .filter((candidate) => candidate.threadKind === "conversation")
        .map(threadSummary)
        .sort((left, right) => (right.recencyAtMs ?? 0) - (left.recencyAtMs ?? 0)),
      selection: { threadId: thread?.id ?? null, revision: this.selectionRevision },
      thread,
      interactions,
      connectionEpoch: "preview-epoch",
      activityRevision: this.activityRevision,
      message: "Preview only — nothing here is shared or sent to Codex.",
    };
  }

  async load(): Promise<CodexThreadSnapshot> {
    return this.emit();
  }

  async list(request: CodexThreadListRequest = {}): Promise<CodexThreadListResponse> {
    const source = request.archived ? this.archivedThreads : this.threads;
    const search = request.search?.trim().toLocaleLowerCase("en-CA") ?? "";
    const candidates = [...source.values()]
      .filter((thread) => thread.threadKind === "conversation")
      .map(threadSummary)
      .filter((thread) => !search || `${thread.title}\n${thread.preview}`.toLocaleLowerCase("en-CA").includes(search))
      .sort((left, right) => (right.recencyAtMs ?? 0) - (left.recencyAtMs ?? 0));
    let offset = 0;
    if (request.cursor) {
      const match = /^preview:(\d+)$/.exec(request.cursor);
      if (!match) {
        throw new CodexThreadClientError({ status: 400, code: "INVALID_REQUEST", message: "Preview task cursor is invalid." });
      }
      offset = Number(match[1]);
    }
    const pageSize = Math.min(Math.max(request.limit ?? 50, 1), 2);
    const threads = candidates.slice(offset, offset + pageSize);
    const nextOffset = offset === 0 && candidates.length > threads.length
      ? Math.max(threads.length - 1, 1)
      : offset + threads.length;
    return {
      threads: clone(threads),
      nextCursor: nextOffset < candidates.length ? `preview:${nextOffset}` : null,
      selection: { threadId: this.selectedId || null, revision: this.selectionRevision },
      connectionEpoch: "preview-epoch",
      activityRevision: this.activityRevision,
    };
  }

  async select(threadId: string): Promise<CodexThreadSnapshot> {
    if (!this.threads.has(threadId) || this.threads.get(threadId)?.threadKind !== "conversation") {
      throw new CodexThreadClientError({ status: 404, code: "NOT_FOUND", message: "Preview task not found." });
    }
    this.selectedId = threadId;
    this.selectionRevision += 1;
    this.activityRevision += 1;
    return this.emit();
  }

  async newThread(): Promise<CodexThreadSnapshot> {
    const id = `preview-task-${this.selectionRevision + 1}`;
    this.threads.set(id, {
      ...fixtureThread({
        id,
        title: "New preview task",
        preview: "Preview task — no message has been sent",
        activityLabel: "Ready for a message",
        activityStatus: "pending",
      }),
      turns: [],
      workers: [],
      status: { state: "idle", waitingFor: null },
    });
    this.selectedId = id;
    this.selectionRevision += 1;
    this.activityRevision += 1;
    return this.emit();
  }

  async archive(threadId: string): Promise<CodexThreadSnapshot> {
    const thread = this.threads.get(threadId);
    if (!thread || thread.threadKind !== "conversation") {
      throw new CodexThreadClientError({ status: 404, code: "NOT_FOUND", message: "Preview task not found." });
    }
    this.threads.delete(threadId);
    this.archivedThreads.set(threadId, thread);
    if (this.selectedId === threadId) {
      this.selectedId = [...this.threads.values()]
        .filter((candidate) => candidate.threadKind === "conversation")
        .sort((left, right) => (right.recencyAtMs ?? 0) - (left.recencyAtMs ?? 0))[0]?.id ?? "";
    }
    this.selectionRevision += 1;
    this.activityRevision += 1;
    return this.emit();
  }

  async send(message: string): Promise<CodexThreadSnapshot> {
    void message;
    throw new CodexThreadClientError({
      status: 403,
      code: "CODEX_UNAVAILABLE",
      message: "Preview does not send messages.",
    });
  }

  async answer(interactionId: string, response: CodexInteractionResponse): Promise<CodexThreadSnapshot> {
    void interactionId;
    void response;
    throw new CodexThreadClientError({
      status: 403,
      code: "CODEX_UNAVAILABLE",
      message: "Preview does not submit answers.",
    });
  }

  async interrupt(turnId: string): Promise<CodexThreadSnapshot> {
    void turnId;
    throw new CodexThreadClientError({
      status: 403,
      code: "CODEX_UNAVAILABLE",
      message: "Preview does not interrupt turns.",
    });
  }

  async refreshInteractions(request: CodexInteractionListRequest = {}): Promise<CodexThreadSnapshot> {
    void request;
    return this.load();
  }

  async readWorker(workerThreadId: string): Promise<CodexThreadReadResponse> {
    const worker = this.threads.get(workerThreadId);
    if (!worker || worker.threadKind !== "worker") {
      throw new CodexThreadClientError({ status: 404, code: "NOT_FOUND", message: "Preview worker not found." });
    }
    return {
      thread: clone(worker),
      selection: { threadId: this.selectedId || null, revision: this.selectionRevision },
      interactions: [],
      connectionEpoch: "preview-epoch",
      activityRevision: this.activityRevision,
    };
  }

  async waitForChange(signal: AbortSignal): Promise<CodexThreadSnapshot | null> {
    void signal;
    return null;
  }
}

export function createPreviewCodexThreadSource(scenario: PreviewScenario): CodexThreadSource {
  return new PreviewCodexThreadSource(scenario);
}

"use client";

import {
  Archive,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Menu,
  Plus,
  Search,
  Send,
  Square,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";

import type {
  CodexInteractionResponse,
  CodexThreadItemView,
  CodexThreadReadResponse,
  CodexThreadSummary,
  CodexThreadView,
} from "../lib/codex-thread-contract.ts";

import { ACTIVITY_LABEL_DEBOUNCE_MS, selectVisibleCodexActivityLabel, shouldFlushCodexActivityLabel } from "./codex-thread-activity.ts";
import { mergeThreadPages } from "./codex-thread-history.ts";
import { CodexMarkdown } from "./codex-markdown.tsx";
import { nextCodexMessageScrollTop, shouldScrollToLatestCodexMessage } from "./codex-thread-scroll.ts";
import { createCodexThreadSource, type CodexThreadSnapshot, type CodexThreadSource } from "./codex-thread-source.ts";
import { selectInterruptibleTurnId } from "./codex-thread-turns.ts";
import { OfflineAuthorityNotice } from "./offline-authority-notice.tsx";
import styles from "./codex-thread-rail.module.css";

function flushActivityUpdate(snapshot: CodexThreadSnapshot): boolean {
  return shouldFlushCodexActivityLabel({
    waitingForUserInput: snapshot.interactions.some((interaction) => interaction.kind === "user_input"),
    thread: snapshot.thread,
  });
}

export function useDebouncedCodexActivityLabel(snapshot: CodexThreadSnapshot): string | null {
  const candidate = selectVisibleCodexActivityLabel(snapshot.thread);
  const [visible, setVisible] = useState<string | null>(candidate);
  const previous = useRef(candidate);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (previous.current === candidate) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    const commit = () => {
      previous.current = candidate;
      setVisible(candidate);
      timer.current = null;
    };
    if (previous.current === null || candidate === null || flushActivityUpdate(snapshot)) {
      commit();
      return;
    }
    timer.current = window.setTimeout(commit, ACTIVITY_LABEL_DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [candidate, snapshot]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return visible;
}

type CodexRailOperation = "select" | "new" | "send" | "interrupt" | "answer";

function useCodexThreadRailSource() {
  const [source] = useState<CodexThreadSource>(() => createCodexThreadSource());
  const [snapshot, setSnapshot] = useState<CodexThreadSnapshot>(() => source.getSnapshot());
  const [error, setError] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] = useState<CodexRailOperation | null>(null);

  useEffect(() => {
    let active = true;
    const sync = () => {
      if (active) setSnapshot(source.getSnapshot());
    };
    const unsubscribe = source.subscribe(sync);
    sync();
    void source.start().catch((cause: unknown) => {
      if (active && cause instanceof Error && cause.name !== "AbortError") setError(cause.message);
    });
    return () => {
      active = false;
      unsubscribe();
      source.stop();
    };
  }, [source]);

  const run = useCallback(async (
    operationName: CodexRailOperation,
    operation: () => Promise<CodexThreadSnapshot>,
  ) => {
    setPendingOperation(operationName);
    setError(null);
    try {
      const next = await operation();
      setSnapshot(next);
      return next;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Codex could not complete that action.";
      setError(message);
      return null;
    } finally {
      setPendingOperation(null);
    }
  }, []);

  return {
    source,
    snapshot,
    error,
    pending: pendingOperation !== null,
    pendingOperation,
    run,
  };
}

type CodexThreadRailProps = {
  draft: string;
  onDraftChange: Dispatch<SetStateAction<string>>;
  focusKey: number;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  offline?: boolean;
  onReconnect?: () => void;
  modal?: boolean;
  onClose?: () => void;
};

type WorkerPanel = {
  parentThreadId: string | null;
  selectionRevision: number | null;
  connectionEpoch: string | null;
  detail: CodexThreadReadResponse | null;
  loadingId: string | null;
  error: string | null;
};

const HISTORY_PAGE_SIZE = 25;
const HISTORY_REFRESH_DEBOUNCE_MS = 250;

function TaskHistory(props: {
  source: CodexThreadSource;
  snapshot: CodexThreadSnapshot;
  pending: boolean;
  offline: boolean;
  operationError: string | null;
  onChooseThread: (threadId: string) => Promise<void>;
  onCreateThread: () => Promise<void>;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [resultCoordinates, setResultCoordinates] = useState<{
    connectionEpoch: string;
    activityRevision: number;
    selectionRevision: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<{ key: string; message: string } | null>(null);
  const requestVersion = useRef(0);
  const resultKeyRef = useRef<string | null>(null);
  const latestSnapshot = useRef(props.snapshot);
  const queryKey = `${archived ? "archived" : "active"}:${submittedSearch}`;
  const latestQueryKey = useRef(queryKey);

  useEffect(() => {
    latestSnapshot.current = props.snapshot;
    latestQueryKey.current = queryKey;
  }, [props.snapshot, queryKey]);

  const loadPage = useCallback(async (cursor: string | null, append: boolean) => {
    const requestedKey = `${archived ? "archived" : "active"}:${submittedSearch}`;
    const version = ++requestVersion.current;
    setLoading(true);
    setHistoryError(null);
    if (!append) {
      if (resultKeyRef.current !== requestedKey) {
        resultKeyRef.current = requestedKey;
        setResultKey(requestedKey);
        setResultCoordinates(null);
        setThreads([]);
        setNextCursor(null);
      }
    }
    try {
      const response = await props.source.list({
        archived,
        cursor: cursor ?? undefined,
        limit: HISTORY_PAGE_SIZE,
        search: submittedSearch || undefined,
      });
      let snapshot = latestSnapshot.current;
      if (version !== requestVersion.current || latestQueryKey.current !== requestedKey) return;
      const matchesResponse = (candidate: CodexThreadSnapshot) =>
        candidate.connectionEpoch !== null &&
        response.connectionEpoch === candidate.connectionEpoch &&
        response.activityRevision === candidate.activityRevision &&
        response.selection.revision === candidate.selection.revision &&
        response.selection.threadId === candidate.selection.threadId;
      if (!matchesResponse(snapshot)) {
        snapshot = await props.source.load();
        if (version !== requestVersion.current || latestQueryKey.current !== requestedKey) return;
        if (!matchesResponse(snapshot)) {
          setHistoryError({
            key: requestedKey,
            message: "Task history changed while loading. Try again.",
          });
          return;
        }
      }
      const selectedId = snapshot.selection.threadId;
      const selected = !archived && !submittedSearch && cursor === null && selectedId !== null &&
        !response.threads.some((thread) => thread.id === selectedId)
        ? snapshot.threads.find((thread) => thread.id === selectedId) ?? null
        : null;
      const incoming = selected ? [selected, ...response.threads] : response.threads;
      setThreads((current) => append && resultKeyRef.current === requestedKey ? mergeThreadPages(current, incoming) : incoming);
      resultKeyRef.current = requestedKey;
      setResultKey(requestedKey);
      setResultCoordinates({
        connectionEpoch: response.connectionEpoch,
        activityRevision: response.activityRevision,
        selectionRevision: response.selection.revision,
      });
      setNextCursor(response.nextCursor);
    } catch (cause) {
      if (version !== requestVersion.current || latestQueryKey.current !== requestedKey) return;
      setHistoryError({
        key: requestedKey,
        message: cause instanceof Error ? cause.message : "Task history could not be loaded.",
      });
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [archived, props.source, submittedSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPage(null, false);
    }, HISTORY_REFRESH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      requestVersion.current += 1;
    };
  }, [loadPage, props.snapshot.activityRevision, props.snapshot.connectionEpoch, props.snapshot.selection.revision]);

  const searchHistory = (event: FormEvent) => {
    event.preventDefault();
    if (archiveId !== null || props.offline || props.snapshot.status === "runtime_unavailable") return;
    const search = searchInput.trim();
    if (search === submittedSearch) {
      void loadPage(null, false);
      return;
    }
    setSubmittedSearch(search);
  };

  const archiveThread = async (thread: CodexThreadSummary) => {
    setArchiveId(thread.id);
    setHistoryError(null);
    try {
      await props.source.archive(thread.id);
      setThreads((current) => current.filter((candidate) => candidate.id !== thread.id));
    } catch (cause) {
      setHistoryError({
        key: queryKey,
        message: cause instanceof Error ? cause.message : "The task could not be archived.",
      });
    } finally {
      setArchiveId(null);
    }
  };

  const coordinatesCurrent = resultCoordinates !== null &&
    resultCoordinates.connectionEpoch === props.snapshot.connectionEpoch &&
    resultCoordinates.activityRevision === props.snapshot.activityRevision &&
    resultCoordinates.selectionRevision === props.snapshot.selection.revision;
  const visibleHistoryError = historyError?.key === queryKey ? historyError.message : null;
  const viewLoading = loading || (!visibleHistoryError && (resultKey !== queryKey || !coordinatesCurrent));
  const controlsDisabled = props.pending || loading || archiveId !== null || props.offline || props.snapshot.status === "runtime_unavailable";
  const mutationDisabled = controlsDisabled || !coordinatesCurrent;
  const sameEpoch = resultCoordinates?.connectionEpoch === props.snapshot.connectionEpoch;
  const visibleThreads = resultKey === queryKey && sameEpoch ? threads : [];
  const visibleNextCursor = resultKey === queryKey && sameEpoch ? nextCursor : null;
  const emptyMessage = submittedSearch
    ? `No ${archived ? "archived " : ""}tasks match “${submittedSearch}”.`
    : archived
      ? "No archived tasks."
      : "No tasks yet. Your first message will create one.";

  return (
    <section className={styles.history} aria-label="Task history">
      <div className={styles.historyTitle}>
        <strong>Tasks</strong>
        <button type="button" className={styles.newThread} onClick={() => void props.onCreateThread()} disabled={controlsDisabled}><Plus size={15} /> New task</button>
      </div>
      <form className={styles.historySearch} role="search" aria-label="Task history search" onSubmit={searchHistory}>
        <label>
          <span className="sr-only">Search tasks</span>
          <Search size={15} aria-hidden="true" />
          <input aria-label="Search tasks" maxLength={200} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search task history" disabled={controlsDisabled} />
        </label>
        <button type="submit" disabled={controlsDisabled}>Search</button>
      </form>
      <div className={styles.historyViews} role="group" aria-label="Task history view">
        <button type="button" aria-label="Open tasks" aria-pressed={!archived} onClick={() => setArchived(false)} disabled={controlsDisabled}>Active</button>
        <button type="button" aria-label="Archived tasks" aria-pressed={archived} onClick={() => setArchived(true)} disabled={controlsDisabled}>Archived</button>
      </div>
      {props.operationError ? <p className={`${styles.banner} ${styles.historyBanner} ${styles.error}`} role="alert">{props.operationError}</p> : null}
      {visibleHistoryError ? <div className={`${styles.banner} ${styles.historyBanner} ${styles.error}`} role="alert"><span>{visibleHistoryError}</span><button type="button" onClick={() => void loadPage(null, false)} disabled={controlsDisabled}>Retry task history</button></div> : null}
      <ul className={styles.threadList} aria-label={archived ? "Archived tasks" : "Open tasks"} aria-busy={viewLoading}>
        {visibleThreads.map((thread) => (
          <li key={thread.id} className={styles.threadRow}>
            {archived ? (
              <article className={styles.archivedThread} aria-label={`Archived task: ${thread.title}`}>
                <strong>{thread.title}</strong><span>{thread.preview}</span><small>{thread.status.state.replaceAll("_", " ")}</small>
              </article>
            ) : (
              <>
                <button aria-label={`Open task: ${thread.title}`} aria-current={thread.id === props.snapshot.selection.threadId ? "true" : undefined} className={`${styles.threadChoice} ${thread.id === props.snapshot.selection.threadId ? styles.selected : ""}`} type="button" onClick={() => void props.onChooseThread(thread.id)} disabled={mutationDisabled}>
                  <strong>{thread.title}</strong><span>{thread.preview}</span><small>{thread.status.state.replaceAll("_", " ")}</small>
                </button>
                <button aria-label={`Archive task: ${thread.title}`} className={styles.archiveThread} type="button" onClick={() => void archiveThread(thread)} disabled={mutationDisabled}>
                  {archiveId === thread.id ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}<span>Archive</span>
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!viewLoading && !visibleHistoryError && !visibleThreads.length ? <p className={styles.emptyCopy}>{emptyMessage}</p> : null}
      {viewLoading && !visibleThreads.length ? <p className={styles.historyLoading}><LoaderCircle className="spin" size={14} /> Loading tasks</p> : null}
      {visibleNextCursor ? <button className={styles.loadMore} type="button" onClick={() => void loadPage(visibleNextCursor, true)} disabled={mutationDisabled}>{loading ? <LoaderCircle className="spin" size={14} /> : null} Load more tasks</button> : null}
    </section>
  );
}

export function CodexThreadRail({
  draft,
  onDraftChange,
  focusKey,
  collapsed,
  onCollapsedChange,
  offline = false,
  onReconnect,
  modal = false,
  onClose,
}: CodexThreadRailProps) {
  const { source, snapshot, error, pending, pendingOperation, run } = useCodexThreadRailSource();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [workerPanel, setWorkerPanel] = useState<WorkerPanel>({
    parentThreadId: null,
    selectionRevision: null,
    connectionEpoch: null,
    detail: null,
    loadingId: null,
    error: null,
  });
  const [workerReturnFocusId, setWorkerReturnFocusId] = useState<string | null>(null);
  const workerRequestVersion = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activity = useDebouncedCodexActivityLabel(snapshot);
  const isPreview = snapshot.mode === "preview";
  const hasUserInput = snapshot.interactions.some((interaction) => interaction.kind === "user_input");
  const interruptibleTurnId = snapshot.status === "ready"
    ? selectInterruptibleTurnId(snapshot.thread)
    : null;
  const canSend = !offline && !isPreview && !pending && !hasUserInput &&
    (snapshot.status === "ready" || snapshot.status === "empty" || snapshot.status === "selected_unmaterialized") && Boolean(draft.trim());
  const canInterrupt = !offline && !isPreview && !pending && interruptibleTurnId !== null;
  const visibleActivity = activity;
  const activeWorkerPanel = snapshot.status === "ready" &&
    snapshot.thread?.id === workerPanel.parentThreadId &&
    workerPanel.parentThreadId === snapshot.selection.threadId &&
    workerPanel.selectionRevision === snapshot.selection.revision &&
    workerPanel.connectionEpoch === snapshot.connectionEpoch
    ? workerPanel
    : null;

  useEffect(() => {
    if (focusKey > 0 && !collapsed) composerRef.current?.focus();
  }, [collapsed, focusKey]);

  const chooseThread = async (threadId: string) => {
    const next = await run("select", () => source.select(threadId));
    if (next) {
      setHistoryOpen(false);
    }
  };

  const createThread = async () => {
    const next = await run("new", () => source.newThread());
    if (next) {
      setHistoryOpen(false);
    }
  };

  const openWorker = async (workerThreadId: string) => {
    const parentThreadId = snapshot.thread?.id ?? null;
    const selectionRevision = snapshot.selection.revision;
    const connectionEpoch = snapshot.connectionEpoch;
    if (snapshot.status !== "ready" || parentThreadId === null || connectionEpoch === null) return;
    const version = ++workerRequestVersion.current;
    setWorkerReturnFocusId(workerThreadId);
    setWorkerPanel({
      parentThreadId,
      selectionRevision,
      connectionEpoch,
      detail: null,
      loadingId: workerThreadId,
      error: null,
    });
    try {
      const response = await source.readWorker(workerThreadId);
      if (version !== workerRequestVersion.current) return;
      if (response.thread.parentThreadId !== parentThreadId) {
        throw new Error("Codex returned a worker from a different task.");
      }
      if (
        response.connectionEpoch !== connectionEpoch ||
        response.selection.threadId !== parentThreadId ||
        response.selection.revision !== selectionRevision
      ) {
        throw new Error("Codex changed tasks while worker details were loading.");
      }
      setWorkerPanel({
        parentThreadId,
        selectionRevision,
        connectionEpoch,
        detail: response,
        loadingId: null,
        error: null,
      });
    } catch (cause) {
      if (version === workerRequestVersion.current) {
        setWorkerPanel({
          parentThreadId,
          selectionRevision,
          connectionEpoch,
          detail: null,
          loadingId: null,
          error: cause instanceof Error ? cause.message : "Worker details could not be loaded.",
        });
      }
    }
  };

  const closeWorker = () => {
    workerRequestVersion.current += 1;
    setWorkerPanel({
      parentThreadId: snapshot.selection.threadId,
      selectionRevision: snapshot.selection.revision,
      connectionEpoch: snapshot.connectionEpoch,
      detail: null,
      loadingId: null,
      error: null,
    });
    window.requestAnimationFrame(() => setWorkerReturnFocusId(null));
  };

  const sendDraft = () => {
    const message = draft.trim();
    if (!message || !canSend) return;
    void run("send", () => source.send(message)).then((next) => {
      if (next) onDraftChange((current) => current.trim() === message ? "" : current);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    sendDraft();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    sendDraft();
  };

  const interruptTurn = () => {
    if (!canInterrupt || interruptibleTurnId === null) return;
    void run("interrupt", () => source.interrupt(interruptibleTurnId)).then((next) => {
      if (next) window.requestAnimationFrame(() => composerRef.current?.focus());
    });
  };

  const respond = (interactionId: string, questions: Array<{ id: string }>) => {
    const response: CodexInteractionResponse = {
      kind: "answers",
      answers: questions
        .filter((question) => answers[question.id]?.trim())
        .map((question) => ({ questionId: question.id, answers: [answers[question.id].trim()] })),
    };
    if (!response.answers.length || isPreview) return;
    void run("answer", () => source.answer(interactionId, response)).then((next) => {
      if (next) setAnswers({});
    });
  };

  if (collapsed && !modal) {
    return (
      <button
        className={styles.edgeHandle}
        type="button"
        aria-label="Open Codex"
        title="Open Codex"
        onClick={() => onCollapsedChange(false)}
      ><ChevronLeft size={19} /></button>
    );
  }

  return (
    <aside className={`${styles.rail} ${modal ? styles.modal : ""}`} aria-label="Codex task">
      <div className={styles.header}>
        <button className={styles.iconButton} type="button" aria-label="Task history" title="Task history" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}><Menu size={19} /></button>
        <span className={styles.headerStatus} aria-live="polite">
          {isPreview ? "Preview only" : "Codex"}
        </span>
        {onClose ? <button className={styles.iconButton} type="button" aria-label="Close Codex" title="Close Codex" onClick={onClose}><ChevronRight size={19} /></button> : null}
      </div>

      {historyOpen ? (
        <TaskHistory
          source={source}
          snapshot={snapshot}
          pending={pending}
          offline={offline}
          operationError={error}
          onChooseThread={chooseThread}
          onCreateThread={createThread}
        />
      ) : (
        <>
          <div className={styles.body}>
            {snapshot.message ? <p className={`${styles.banner} ${isPreview ? styles.preview : ""}`}>{snapshot.message}</p> : null}
            {error ? <p className={`${styles.banner} ${styles.error}`} role="alert">{error}</p> : null}
            {modal && offline && onReconnect ? <OfflineAuthorityNotice onReconnect={onReconnect} /> : null}
            {snapshot.status === "runtime_unavailable" ? <p className={styles.emptyCopy}>Codex is unavailable. Your planner is still available.</p> : null}
            {snapshot.status === "selected_unavailable" ? <p className={styles.emptyCopy}>Choose a task from history or start a new one.</p> : null}
            {activeWorkerPanel?.detail ? <WorkerDetail response={activeWorkerPanel.detail} onClose={closeWorker} /> : <>
              {snapshot.thread ? <ThreadItems
                thread={snapshot.thread}
                activity={visibleActivity}
                workerError={activeWorkerPanel?.error ?? null}
                workerLoadingId={activeWorkerPanel?.loadingId ?? null}
                focusWorkerId={workerReturnFocusId}
                onOpenWorker={openWorker}
              /> : null}
              <Interactions
                interactions={snapshot.interactions}
                answers={answers}
                onAnswerChange={(questionId, answer) => setAnswers((current) => ({ ...current, [questionId]: answer }))}
                onRespond={respond}
                preview={isPreview}
                pending={pending}
              />
            </>}
          </div>
          {!activeWorkerPanel?.detail ? <form className={styles.composer} onSubmit={submit}>
            <div className={`${styles.composerField} ${interruptibleTurnId !== null ? styles.composerFieldInterruptible : ""}`}>
              <span className="sr-only">Message Codex</span>
              <textarea ref={composerRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={handleComposerKeyDown} maxLength={4_000} aria-label="Message Codex" placeholder="Ask Codex…" data-autofocus={modal || focusKey > 0 ? "true" : undefined} disabled={offline || snapshot.status === "runtime_unavailable" || hasUserInput} />
              <small>{hasUserInput ? "Answer the question above to continue." : `${draft.length.toLocaleString("en-CA")}/4,000`}</small>
              <div className={styles.composerActions}>
                {interruptibleTurnId !== null ? <button className={styles.stopButton} type="button" aria-label="Stop Codex" title={isPreview ? "Preview does not interrupt turns" : "Stop current Codex response"} onClick={interruptTurn} disabled={!canInterrupt}>{pendingOperation === "interrupt" ? <LoaderCircle className="spin" size={17} /> : <Square size={15} fill="currentColor" />}</button> : null}
                <button type="submit" aria-label="Send to Codex" title={isPreview ? "Preview does not send messages" : "Send to Codex"} disabled={!canSend}>{pendingOperation === "send" ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button>
              </div>
            </div>
          </form> : null}
        </>
      )}
    </aside>
  );
}

function ThreadItems(props: {
  thread: CodexThreadView;
  activity: string | null;
  workerError: string | null;
  workerLoadingId: string | null;
  focusWorkerId: string | null;
  onOpenWorker: (workerThreadId: string) => Promise<void>;
}) {
  const { thread } = props;
  const items = thread.turns.flatMap((turn) => turn.items);
  const latestMessage = items.reduce<Extract<CodexThreadItemView, { kind: "message" }> | null>((latest, item) => item.kind === "message" ? item : latest, null);
  const lastUserMessageId = items.reduce<string | null>((latest, item) => item.kind === "message" && item.role === "user" ? item.id : latest, null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const scrollCursor = useRef<{ threadId: string; latestMessageId: string | null } | null>(null);

  useLayoutEffect(() => {
    const nextCursor = { threadId: thread.id, latestMessageId: latestMessage?.id ?? null };
    const shouldScroll = shouldScrollToLatestCodexMessage(scrollCursor.current, nextCursor);
    scrollCursor.current = nextCursor;
    if (!shouldScroll) return;
    const viewport = messagesRef.current;
    const messages = viewport?.querySelectorAll<HTMLElement>("[data-codex-message]");
    const message = messages?.[messages.length - 1] ?? null;
    if (!viewport || !message) return;
    const viewportRect = viewport.getBoundingClientRect();
    const messageRect = message.getBoundingClientRect();
    viewport.scrollTo({
      top: nextCodexMessageScrollTop({
        currentScrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        viewportHeight: viewport.clientHeight,
        viewportTop: viewportRect.top,
        messageTop: messageRect.top,
      }),
      behavior: "auto",
    });
  }, [latestMessage?.id, thread.id]);

  const workers = new Map(thread.workers.map((worker) => [worker.threadId, worker]));
  for (const item of items) {
    if (item.kind !== "worker") continue;
    item.workerThreadIds.forEach((threadId, index) => {
      if (workers.has(threadId)) return;
      workers.set(threadId, {
        threadId,
        label: item.workerThreadIds.length === 1 ? item.label : `${item.label} ${index + 1}`,
        status: item.workerStates.find((state) => state.threadId === threadId)?.status ?? item.status,
      });
    });
  }
  const workerSummaries = [...workers.values()];
  return (
    <div className={styles.threadContent}>
      {workerSummaries.length ? <section className={styles.workers} aria-label="Background workers">
        <div className={styles.workersTitle}><strong>Background workers</strong><span>{workerSummaries.length}</span></div>
        <div className={styles.workerSummaries}>
          {workerSummaries.map((worker, index) => <button key={worker.threadId} type="button" aria-label={`View worker ${index + 1}: ${worker.label}`} autoFocus={props.focusWorkerId === worker.threadId} onClick={() => void props.onOpenWorker(worker.threadId)} disabled={props.workerLoadingId !== null}>
            <span><strong>{worker.label}</strong><small>{worker.status}</small></span>
            {props.workerLoadingId === worker.threadId ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}
          </button>)}
        </div>
      </section> : null}
      {props.workerError ? <p className={`${styles.banner} ${styles.workerBanner} ${styles.error}`} role="alert">{props.workerError}</p> : null}
      <div ref={messagesRef} className={styles.messages} role="log" aria-live="polite" aria-label="Codex conversation">
        {items.map((item) => <Fragment key={item.id}>
          <ThreadItem item={item} />
          {props.activity && item.id === lastUserMessageId ? <ActivityLine label={props.activity} /> : null}
        </Fragment>)}
        {props.activity && lastUserMessageId === null ? <ActivityLine label={props.activity} /> : null}
      </div>
    </div>
  );
}

function ActivityLine({ label }: { label: string }) {
  return <p className={styles.activity} role="status" aria-label="Codex activity"><LoaderCircle className="spin" size={14} /> {label}</p>;
}

function WorkerDetail({ response, onClose }: { response: CodexThreadReadResponse; onClose: () => void }) {
  const thread = response.thread;
  const items = thread.turns.flatMap((turn) => turn.items);
  return (
    <section className={styles.workerDetail} aria-label={`Worker details: ${thread.title}`}>
      <div className={styles.workerDetailHeader}>
        <span><small>Worker details</small><strong>{thread.title}</strong></span>
        <button type="button" autoFocus onClick={onClose}><ChevronLeft size={15} /> Back to task</button>
      </div>
      <p className={styles.workerMeta}>{thread.status.state.replaceAll("_", " ")}{thread.historyTruncated ? " · Earlier activity is not shown" : ""}</p>
      <div className={styles.workerTranscript} role="log" aria-label={`Worker conversation ${thread.title}`}>
        {items.map((item) => <ThreadItem key={item.id} item={item} showActivity />)}
      </div>
    </section>
  );
}

function ThreadItem(props: {
  item: CodexThreadItemView;
  showActivity?: boolean;
}) {
  const { item } = props;
  if (item.kind === "message") return item.role === "user"
    ? <p data-codex-message className={`${styles.message} ${styles.user}`}>{item.text}</p>
    : <div data-codex-message className={`${styles.message} ${styles.assistant}`}><CodexMarkdown text={item.text} /></div>;
  if (item.kind === "reasoning") return <details className={styles.reasoning}><summary>Thinking</summary>{item.summaries.map((summary, index) => <p key={`${item.id}-${index}`}>{summary}</p>)}</details>;
  if (item.kind === "activity") return props.showActivity ? <p className={styles.workerActivity}>{item.label}<span>{item.status}</span></p> : null;
  if (item.kind === "worker") return <article className={styles.workerEvent} aria-label="Worker activity">
    <div><strong>{item.label}</strong><span>{item.status}</span></div>
    <p>{item.operation.replaceAll("_", " ")}</p>
  </article>;
  return null;
}

function Interactions(props: {
  interactions: CodexThreadSnapshot["interactions"];
  answers: Record<string, string>;
  onAnswerChange: (questionId: string, answer: string) => void;
  onRespond: (interactionId: string, questions: Array<{ id: string }>) => void;
  preview: boolean;
  pending: boolean;
}) {
  return (
    <div className={styles.interactions}>
      {props.interactions.filter((interaction) => interaction.kind === "user_input").map((interaction) => (
        <section key={interaction.id} className={styles.question}>
          {interaction.questions.map((question) => (
            <fieldset key={question.id}><legend>{question.header}</legend><p>{question.question}</p>
              <div className={styles.options}>{question.options.map((option) => <button key={option.label} type="button" className={props.answers[question.id] === option.label ? styles.selectedOption : ""} onClick={() => props.onAnswerChange(question.id, option.label)}>{option.label}</button>)}</div>
            </fieldset>
          ))}
          <button type="button" className={styles.answer} disabled={props.preview || props.pending || !interaction.questions.every((question) => props.answers[question.id]?.trim())} onClick={() => props.onRespond(interaction.id, interaction.questions)}>{props.preview ? "Preview does not submit answers" : "Send answer"}</button>
        </section>
      ))}
      {props.interactions.filter((interaction) => interaction.kind === "approval").map((interaction) => (
        <section key={interaction.id} className={styles.approval} role="status" aria-label="Rejected approval">
          <div><CircleAlert size={15} /><strong>Approval rejected</strong></div>
          <p>{interaction.summary}</p>
          <small>{interaction.category.replaceAll("_", " ")} access is not available to this Codex task.</small>
        </section>
      ))}
    </div>
  );
}

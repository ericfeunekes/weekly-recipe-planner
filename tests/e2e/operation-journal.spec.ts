import {
  expect,
  test,
  type Page,
  type Route,
} from "@playwright/test";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ??
  "http://127.0.0.1:8878";
const fixture = process.env.PLANNER_E2E_FIXTURE_EXPECTED ??
  process.env.PLANNER_E2E_FIXTURE ??
  "D4";
const journalKey = "weekly-recipe-planner:authority-operations:v1";

type JournalOperation = {
  kind: "bootstrap" | "planner" | "undo" | "chat-submit" | "chat-retry";
  label: string;
  requestId: string;
  serializedBody: string;
  state: "prepared" | "ambiguous" | "resolved_conflict";
  submittedDraft: unknown;
  editableDraft: unknown;
};

type JournalEnvelope = {
  schemaVersion: 1;
  operations: JournalOperation[];
};

type Workspace = {
  plannerVersion: number;
  state: {
    weeks: Array<{
      data: {
        groceries: Array<{ checked: boolean; item: string }>;
        meals: Array<{ title: string }>;
      };
    }>;
  };
  events: Array<{
    command: Record<string, unknown> & { type: string };
    eventId: string;
    revertsEventId: string | null;
  }>;
  transcriptEntries: Array<{
    role: string;
    text: string;
    turnId: string | null;
  }>;
  chatTurns: Array<{
    requestId: string;
    retryOfTurnId: string | null;
    turnId: string;
  }>;
};

type ResponseLoss = {
  bodies: string[];
  handler: (route: Route) => Promise<void>;
  pattern: string;
};

function bodyJson(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

async function readJournal(page: Page): Promise<JournalEnvelope | null> {
  return page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) as JournalEnvelope;
  }, journalKey);
}

async function expectJournalKinds(
  page: Page,
  expectedKinds: JournalOperation["kind"][],
): Promise<JournalEnvelope> {
  await expect.poll(async () => {
    const journal = await readJournal(page);
    return journal?.operations.map((operation) => operation.kind).sort() ?? [];
  }).toEqual([...expectedKinds].sort());
  const journal = await readJournal(page);
  expect(journal).not.toBeNull();
  return journal!;
}

async function resetToSetup(page: Page): Promise<void> {
  const reset = await page.request.post(`${controlOrigin}/reset`);
  expect(reset.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up this planner once" }))
    .toBeVisible();
}

async function initializePlanner(page: Page): Promise<void> {
  await resetToSetup(page);
  await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(page.getByText("Family dinner planner", { exact: true })).toBeVisible();
  await expect(page.getByText("Shared plan current", { exact: true })).toBeVisible();
}

async function readWorkspace(page: Page): Promise<Workspace> {
  const response = await page.request.get("/api/workspace");
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Workspace>;
}

async function armCommittedResponseLoss(
  page: Page,
  pattern: string,
  matches: (body: Record<string, unknown>) => boolean = () => true,
  afterCommit?: () => Promise<void>,
): Promise<ResponseLoss> {
  const bodies: string[] = [];
  const handler = async (route: Route): Promise<void> => {
    const body = route.request().postData() ?? "";
    if (!matches(bodyJson(body))) {
      await route.continue();
      return;
    }
    bodies.push(body);
    if (bodies.length === 1) {
      const committedResponse = await route.fetch();
      await committedResponse.body();
      await afterCommit?.();
    }
    await route.abort("failed");
  };
  await page.route(pattern, handler);
  return { bodies, handler, pattern };
}

async function stopResponseLoss(page: Page, loss: ResponseLoss): Promise<void> {
  await page.unroute(loss.pattern, loss.handler);
}

async function captureAcceptedReplay(
  page: Page,
  pattern: string,
  action: () => Promise<void>,
): Promise<string> {
  const bodies: string[] = [];
  const handler = async (route: Route): Promise<void> => {
    bodies.push(route.request().postData() ?? "");
    await route.continue();
  };
  await page.route(pattern, handler);
  try {
    await action();
    await expect.poll(() => bodies.length).toBe(1);
    return bodies[0];
  } finally {
    await page.unroute(pattern, handler);
  }
}

async function waitForAmbiguity(
  page: Page,
  loss: ResponseLoss,
  kind: JournalOperation["kind"],
): Promise<JournalOperation> {
  await expect.poll(() => loss.bodies.length).toBe(2);
  const journal = await expectJournalKinds(page, [kind]);
  const operation = journal.operations[0];
  expect(operation.state).toBe("ambiguous");
  expect(loss.bodies).toEqual([operation.serializedBody, operation.serializedBody]);
  return operation;
}

async function reloadPlanner(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Family dinner planner", { exact: true })).toBeVisible();
  await expect(page.getByText(/was interrupted\. Reconnect, then resolve that exact request\./))
    .toBeVisible();
}

function mainRetry(page: Page, label: string) {
  return page.locator(".app-main").getByRole("button", { name: `Retry ${label}` });
}

function chatPanel(page: Page) {
  return page.locator('aside[aria-label="ChatGPT household chat"]');
}

test.describe.configure({ mode: "serial" });

test.describe("reload-safe authority operation journal", () => {
  test.skip(fixture !== "D4", "D4 supplies the populated mutation surfaces.");

  test("bootstrap persists, hydrates, and replays one exact setup envelope", async ({ page }) => {
    test.setTimeout(120_000);
    await resetToSetup(page);
    const loss = await armCommittedResponseLoss(page, "**/api/bootstrap");

    await page.getByRole("button", { name: "Start Fresh" }).click();
    const operation = await waitForAmbiguity(page, loss, "bootstrap");
    expect(operation.submittedDraft).toEqual(bodyJson(operation.serializedBody));
    expect(bodyJson(operation.serializedBody)).toMatchObject({ mode: "seed" });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Family dinner planner", { exact: true })).toBeVisible();
    const retry = mainRetry(page, "Set up shared planner");
    await expect(retry).toBeVisible();
    const hydrated = await expectJournalKinds(page, ["bootstrap"]);
    expect(hydrated.operations[0].serializedBody).toBe(operation.serializedBody);

    await stopResponseLoss(page, loss);
    const replayBody = await captureAcceptedReplay(page, "**/api/bootstrap", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    expect(workspace.state.weeks).toHaveLength(1);
    expect(workspace.plannerVersion).toBe(0);
  });

  test("planner recipe edits restore their submitted draft and settle once", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".meal-card:not(.empty-meal)").first().click();
    const drawer = page.locator(".meal-drawer");
    const title = "Journal recovery traybake";
    const finalTitle = "Journal recovery traybake final";
    const recoveryVenue = "Patio kitchen after loss";
    const loss = await armCommittedResponseLoss(
      page,
      "**/api/commands",
      (body) => {
        const command = body.command as Record<string, unknown> | undefined;
        const changes = command?.changes as Record<string, unknown> | undefined;
        return command?.type === "updateMealSnapshot" && changes?.title === title;
      },
    );

    await drawer.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await drawer.getByRole("button", { name: "Save recipe details" }).click();
    const operation = await waitForAmbiguity(page, loss, "planner");
    expect(operation.submittedDraft).toMatchObject({
      type: "updateMealSnapshot",
      changes: { title },
    });
    await drawer.getByRole("textbox", { name: "Title", exact: true }).fill("");
    await drawer.getByRole("textbox", { name: "Venue", exact: true }).fill(recoveryVenue);
    const editedJournal = await expectJournalKinds(page, ["planner"]);
    expect(editedJournal.operations[0].serializedBody).toBe(operation.serializedBody);
    expect(editedJournal.operations[0].editableDraft).toMatchObject({
      type: "updateMealSnapshot",
      changes: { title: "", venue: recoveryVenue },
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    const hydratedDrawer = page.locator(".meal-drawer");
    await expect(hydratedDrawer).toBeVisible();
    await expect(hydratedDrawer.getByRole("textbox", { name: "Title", exact: true }))
      .toHaveValue("");
    await expect(hydratedDrawer.getByRole("textbox", { name: "Venue", exact: true }))
      .toHaveValue(recoveryVenue);
    const retry = hydratedDrawer.getByRole("button", { name: "Retry Save recipe details" });
    await expect(retry).toBeVisible();

    await stopResponseLoss(page, loss);
    const replayBody = await captureAcceptedReplay(page, "**/api/commands", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();
    await expect(hydratedDrawer.getByRole("textbox", { name: "Title", exact: true }))
      .toHaveValue("");
    await expect(hydratedDrawer.getByRole("textbox", { name: "Venue", exact: true }))
      .toHaveValue(recoveryVenue);
    await hydratedDrawer.getByRole("textbox", { name: "Title", exact: true }).fill(finalTitle);
    await hydratedDrawer.getByRole("button", { name: "Save recipe details" }).click();

    const workspace = await readWorkspace(page);
    expect(workspace.state.weeks.flatMap((week) => week.data.meals)
      .filter((meal) => meal.title === finalTitle)).toHaveLength(1);
    expect(workspace.events.filter((event) => {
      const changes = event.command.changes as Record<string, unknown> | undefined;
      return event.command.type === "updateMealSnapshot" && changes?.title === title;
    })).toHaveLength(1);
    expect(workspace.events.filter((event) => {
      const changes = event.command.changes as Record<string, unknown> | undefined;
      return event.command.type === "updateMealSnapshot" &&
        changes?.title === finalTitle && changes?.venue === recoveryVenue;
    })).toHaveLength(1);
  });

  test("cross-site renderer replacement preserves an ambiguous request for exact replay", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    const grocery = "Renderer recovery parsley";
    const loss = await armCommittedResponseLoss(
      page,
      "**/api/commands",
      (body) => {
        const command = body.command as Record<string, unknown> | undefined;
        const item = command?.item as Record<string, unknown> | undefined;
        return command?.type === "addGroceryItem" && item?.item === grocery;
      },
    );
    await page.getByLabel("New grocery item").fill(grocery);
    await page.getByLabel("Grocery detail").fill("1 bunch");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const operation = await waitForAmbiguity(page, loss, "planner");
    await stopResponseLoss(page, loss);

    await page.goto("data:text/html,<title>Renderer replacement</title>");
    await expect(page).toHaveTitle("Renderer replacement");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const retry = mainRetry(page, "Add grocery item");
    await expect(retry).toBeVisible();
    const replayBody = await captureAcceptedReplay(page, "**/api/commands", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    expect(workspace.state.weeks.flatMap((week) => week.data.groceries)
      .filter((item) => item.item === grocery)).toHaveLength(1);
    expect(workspace.events.filter((event) => {
      const item = event.command.item as Record<string, unknown> | undefined;
      return event.command.type === "addGroceryItem" && item?.item === grocery;
    })).toHaveLength(1);
  });

  test("undo hydrates its exact request and reverses the latest event only once", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    const chicken = page.getByRole("checkbox", { name: "Check Boneless chicken thighs" });
    await chicken.click();
    await expect(chicken).toBeChecked();
    const beforeUndo = await readWorkspace(page);
    const targetEvent = beforeUndo.events.at(-1);
    expect(targetEvent).toBeDefined();

    await page.getByTitle("Change history").click();
    const history = page.getByRole("dialog", { name: "Recent changes" });
    const loss = await armCommittedResponseLoss(page, "**/api/undo");
    await history.getByRole("button", { name: "Undo latest change" }).click();
    const operation = await waitForAmbiguity(page, loss, "undo");
    expect(operation.submittedDraft).toEqual(bodyJson(operation.serializedBody));
    expect(bodyJson(operation.serializedBody)).toMatchObject({
      targetEventId: targetEvent!.eventId,
    });

    await reloadPlanner(page);
    const retry = mainRetry(page, "Undo latest change");
    await expect(retry).toBeVisible();
    await stopResponseLoss(page, loss);
    const replayBody = await captureAcceptedReplay(page, "**/api/undo", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    expect(workspace.state.weeks.flatMap((week) => week.data.groceries)
      .find((item) => item.item === "Boneless chicken thighs")?.checked).toBe(false);
    expect(workspace.events.filter((event) =>
      event.command.type === "undoLatest" && event.revertsEventId === targetEvent!.eventId,
    )).toHaveLength(1);
  });

  test("chat submit restores its composer draft and one durable turn", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    const message = "Journal chat submit proof.";
    const loss = await armCommittedResponseLoss(
      page,
      "**/api/chat/submit",
      (body) => body.message === message,
    );
    const composer = chatPanel(page).getByRole("textbox", { name: "Message ChatGPT" });
    await composer.fill(message);
    await chatPanel(page).getByTitle("Send to ChatGPT").click();
    const operation = await waitForAmbiguity(page, loss, "chat-submit");
    expect(operation.submittedDraft).toBe(message);

    await reloadPlanner(page);
    await expect(chatPanel(page).getByRole("textbox", { name: "Message ChatGPT" }))
      .toHaveValue(message);
    const retry = mainRetry(page, "Send ChatGPT message");
    await expect(retry).toBeVisible();
    await stopResponseLoss(page, loss);
    const replayBody = await captureAcceptedReplay(page, "**/api/chat/submit", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);
    await expect(chatPanel(page).getByRole("textbox", { name: "Message ChatGPT" }))
      .toHaveValue("");
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    const userEntries = workspace.transcriptEntries.filter((entry) =>
      entry.role === "user" && entry.text === message,
    );
    expect(userEntries).toHaveLength(1);
    expect(workspace.chatTurns.filter((turn) =>
      turn.requestId === operation.requestId,
    )).toHaveLength(1);
  });

  test("a resolved chat conflict durably retries the edited current intent", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    const peer = await page.context().newPage();
    await peer.goto("/");
    await expect(peer.getByText("Family dinner planner", { exact: true })).toBeVisible();

    let releaseOriginal!: () => void;
    let markOriginalStarted!: () => void;
    const originalRelease = new Promise<void>((resolve) => { releaseOriginal = resolve; });
    const originalStarted = new Promise<void>((resolve) => { markOriginalStarted = resolve; });
    const originalMessage = "Conflict-bound original chat draft.";
    const bodies: string[] = [];
    await page.route("**/api/chat/submit", async (route) => {
      const body = route.request().postData() ?? "";
      bodies.push(body);
      if ((bodyJson(body).message as string) === originalMessage) {
        markOriginalStarted();
        await originalRelease;
      }
      await route.continue();
    });

    const composer = chatPanel(page).getByRole("textbox", { name: "Message ChatGPT" });
    await composer.fill(originalMessage);
    await chatPanel(page).getByTitle("Send to ChatGPT").click();
    await originalStarted;

    await peer.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    const chicken = peer.getByRole("checkbox", { name: "Check Boneless chicken thighs" });
    await chicken.click();
    await expect(chicken).toBeChecked();
    releaseOriginal();

    const retry = mainRetry(page, "Send ChatGPT message");
    await expect(retry).toBeVisible();
    const resolved = await expectJournalKinds(page, ["chat-submit"]);
    expect(resolved.operations[0].state).toBe("resolved_conflict");
    const originalBody = bodyJson(resolved.operations[0].serializedBody);

    const editedMessage = "Conflict-bound edited chat draft.";
    await composer.fill(editedMessage);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(chatPanel(page).getByRole("textbox", { name: "Message ChatGPT" }))
      .toHaveValue(editedMessage);
    const hydratedRetry = mainRetry(page, "Send ChatGPT message");
    await expect(hydratedRetry).toBeVisible();
    await hydratedRetry.click();
    await expect(hydratedRetry).toHaveCount(0);
    await expect(chatPanel(page).getByText("I can see the shared household plan.", { exact: true }))
      .toBeVisible();

    expect(bodies).toHaveLength(2);
    const retryBody = bodyJson(bodies[1]);
    expect(retryBody.message).toBe(editedMessage);
    expect(retryBody.requestId).not.toBe(originalBody.requestId);
    expect(Number(retryBody.basePlannerVersion)).toBeGreaterThan(
      Number(originalBody.basePlannerVersion),
    );
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    expect(workspace.transcriptEntries.filter((entry) =>
      entry.role === "user" && entry.text === originalMessage,
    )).toHaveLength(0);
    expect(workspace.transcriptEntries.filter((entry) =>
      entry.role === "user" && entry.text === editedMessage,
    )).toHaveLength(1);
    await page.unroute("**/api/chat/submit");
    await peer.close();
  });

  test("chat retry hydrates and replays one recovery turn without repeating its effect", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    const chat = chatPanel(page);
    const composer = chat.getByRole("textbox", { name: "Message ChatGPT" });
    await composer.fill("Save one planner change then interrupt the reply.");
    await chat.getByTitle("Send to ChatGPT").click();
    await expect(chat.getByText("Planner changes saved · reply interrupted", { exact: true }))
      .toBeVisible();
    const beforeRetry = await readWorkspace(page);
    const originalEntry = beforeRetry.transcriptEntries.find((entry) =>
      entry.role === "user" && entry.text === "Save one planner change then interrupt the reply.",
    );
    expect(originalEntry?.turnId).toBeTruthy();

    const loss = await armCommittedResponseLoss(page, "**/api/chat/retry");
    await chat.getByRole("button", {
      name: "Recover the reply (planner changes will not run again)",
    }).click();
    const operation = await waitForAmbiguity(page, loss, "chat-retry");
    expect(operation.submittedDraft).toEqual(bodyJson(operation.serializedBody));
    expect(bodyJson(operation.serializedBody)).toMatchObject({
      turnId: originalEntry!.turnId,
    });

    await reloadPlanner(page);
    const retry = mainRetry(page, "Retry ChatGPT request");
    await expect(retry).toBeVisible();
    await stopResponseLoss(page, loss);
    const replayBody = await captureAcceptedReplay(page, "**/api/chat/retry", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    expect(workspace.chatTurns.filter((turn) =>
      turn.retryOfTurnId === originalEntry!.turnId,
    )).toHaveLength(1);
    expect(workspace.transcriptEntries.filter((entry) =>
      entry.role === "assistant" && entry.text === "I recovered the interrupted household request.",
    )).toHaveLength(1);
    expect(workspace.state.weeks.flatMap((week) => week.data.groceries)
      .filter((item) => item.item === "Recovery proof parsley")).toHaveLength(1);
  });

  test("simultaneous planner and chat ambiguity retain both exact records", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();

    let releaseChat!: () => void;
    let markChatCommitted!: () => void;
    const chatRelease = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    const chatCommitted = new Promise<void>((resolve) => {
      markChatCommitted = resolve;
    });
    const message = "Simultaneous journal chat proof.";
    const chatLoss = await armCommittedResponseLoss(
      page,
      "**/api/chat/submit",
      (body) => body.message === message,
      async () => {
        markChatCommitted();
        await chatRelease;
      },
    );
    const composer = chatPanel(page).getByRole("textbox", { name: "Message ChatGPT" });
    await composer.fill(message);
    await chatPanel(page).getByTitle("Send to ChatGPT").click();
    await chatCommitted;

    const grocery = "Simultaneous journal basil";
    const plannerLoss = await armCommittedResponseLoss(
      page,
      "**/api/commands",
      (body) => {
        const command = body.command as Record<string, unknown> | undefined;
        const item = command?.item as Record<string, unknown> | undefined;
        return command?.type === "addGroceryItem" && item?.item === grocery;
      },
    );
    await page.getByLabel("New grocery item").fill(grocery);
    await page.getByLabel("Grocery detail").fill("1 bunch");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => plannerLoss.bodies.length).toBe(2);
    releaseChat();
    await expect.poll(() => chatLoss.bodies.length).toBe(2);

    const journal = await expectJournalKinds(page, ["planner", "chat-submit"]);
    expect(journal.operations.every((operation) => operation.state === "ambiguous")).toBe(true);
    const plannerOperation = journal.operations.find((operation) => operation.kind === "planner")!;
    const chatOperation = journal.operations.find((operation) => operation.kind === "chat-submit")!;
    expect(plannerLoss.bodies).toEqual([
      plannerOperation.serializedBody,
      plannerOperation.serializedBody,
    ]);
    expect(chatLoss.bodies).toEqual([
      chatOperation.serializedBody,
      chatOperation.serializedBody,
    ]);

    await stopResponseLoss(page, plannerLoss);
    await stopResponseLoss(page, chatLoss);
    await reloadPlanner(page);
    await expect(chatPanel(page).getByRole("textbox", { name: "Message ChatGPT" }))
      .toHaveValue(message);

    const plannerReplay = await captureAcceptedReplay(page, "**/api/commands", async () => {
      const retry = mainRetry(page, "Add grocery item");
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(plannerReplay).toBe(plannerOperation.serializedBody);
    await expectJournalKinds(page, ["chat-submit"]);

    const chatReplay = await captureAcceptedReplay(page, "**/api/chat/submit", async () => {
      const retry = mainRetry(page, "Send ChatGPT message");
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(chatReplay).toBe(chatOperation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    expect(workspace.state.weeks.flatMap((week) => week.data.groceries)
      .filter((item) => item.item === grocery)).toHaveLength(1);
    expect(workspace.transcriptEntries.filter((entry) =>
      entry.role === "user" && entry.text === message,
    )).toHaveLength(1);
  });

  test("a copied auxiliary tab can replay the same envelope without a second effect", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    const grocery = "Copied journal mint";
    const loss = await armCommittedResponseLoss(
      page,
      "**/api/commands",
      (body) => {
        const command = body.command as Record<string, unknown> | undefined;
        const item = command?.item as Record<string, unknown> | undefined;
        return command?.type === "addGroceryItem" && item?.item === grocery;
      },
    );
    await page.getByLabel("New grocery item").fill(grocery);
    await page.getByLabel("Grocery detail").fill("1 bunch");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const operation = await waitForAmbiguity(page, loss, "planner");

    const popupPromise = page.context().waitForEvent("page");
    await page.evaluate(() => {
      window.open("/", "_blank");
    });
    const auxiliary = await popupPromise;
    await auxiliary.waitForLoadState("domcontentloaded");
    await expect(auxiliary.getByText("Family dinner planner", { exact: true })).toBeVisible();
    const copiedJournal = await expectJournalKinds(auxiliary, ["planner"]);
    expect(copiedJournal.operations[0].serializedBody).toBe(operation.serializedBody);

    const auxiliaryReplay = await captureAcceptedReplay(
      auxiliary,
      "**/api/commands",
      async () => {
        const retry = mainRetry(auxiliary, "Add grocery item");
        await expect(retry).toBeVisible();
        await retry.click();
        await expect(retry).toHaveCount(0);
      },
    );
    expect(auxiliaryReplay).toBe(operation.serializedBody);
    expect(await readJournal(auxiliary)).toBeNull();

    await stopResponseLoss(page, loss);
    await reloadPlanner(page);
    const primaryReplay = await captureAcceptedReplay(page, "**/api/commands", async () => {
      const retry = mainRetry(page, "Add grocery item");
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(primaryReplay).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    expect(workspace.state.weeks.flatMap((week) => week.data.groceries)
      .filter((item) => item.item === grocery)).toHaveLength(1);
    expect(workspace.events.filter((event) => {
      const item = event.command.item as Record<string, unknown> | undefined;
      return event.command.type === "addGroceryItem" && item?.item === grocery;
    })).toHaveLength(1);
    await auxiliary.close();
  });

  test("journal storage failure blocks bootstrap before network dispatch", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript((key) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(storageKey, value) {
        if (storageKey === key) {
          throw new DOMException("Injected journal quota failure.", "QuotaExceededError");
        }
        return original.call(this, storageKey, value);
      };
    }, journalKey);
    await resetToSetup(page);

    let bootstrapRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/bootstrap") bootstrapRequests += 1;
    });
    await page.getByRole("button", { name: "Start Fresh" }).click();
    await expect(page.getByText(
      "The pending-operation recovery store could not be updated. No new shared request was sent.",
      { exact: true },
    )).toBeVisible();
    await expect.poll(() => bootstrapRequests).toBe(0);
    await expect(page.getByRole("heading", { name: "Set up this planner once" })).toBeVisible();

    const workspace = await readWorkspace(page);
    expect((workspace as unknown as { initialized: boolean }).initialized).toBe(false);
  });

  test("a full journal sends no new request and evicts no unresolved record", async ({ page }) => {
    test.setTimeout(120_000);
    await resetToSetup(page);
    await page.evaluate((key) => {
      const operations = Array.from({ length: 16 }, (_, index) => {
        const body = {
          requestId: `capacity-chat-${index}`,
          basePlannerVersion: 0,
          message: `Capacity message ${index}`,
          context: { view: "week" },
          intent: { kind: "planner", archiveContextWeek: false },
        };
        return {
          schemaVersion: 1,
          kind: "chat-submit",
          path: "/api/chat/submit",
          requestId: body.requestId,
          serializedBody: JSON.stringify(body),
          state: "resolved_conflict",
          createdAt: index + 1,
          label: `Capacity chat ${index}`,
          submittedDraft: body.message,
          editableDraft: body.message,
          resolution: { code: "context_stale", message: "Review the latest shared plan." },
        };
      });
      window.sessionStorage.setItem(key, JSON.stringify({ schemaVersion: 1, operations }));
    }, journalKey);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Set up this planner once" })).toBeVisible();

    let bootstrapRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/bootstrap") bootstrapRequests += 1;
    });
    await page.getByRole("button", { name: "Start Fresh" }).click();
    await expect(page.getByText(
      "Resolve pending shared changes before starting another change.",
      { exact: true },
    )).toBeVisible();
    await expect.poll(() => bootstrapRequests).toBe(0);
    const journal = await readJournal(page);
    expect(journal?.operations).toHaveLength(16);
    expect(journal?.operations.map((operation) => operation.requestId)).toEqual(
      Array.from({ length: 16 }, (_, index) => `capacity-chat-${index}`),
    );
  });

  test("corrupt journal data stays blocked until an explicit authoritative readback clears it", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.evaluate((key) => {
      window.sessionStorage.setItem(key, JSON.stringify({ schemaVersion: 2, operations: [] }));
    }, journalKey);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByText(
      "The pending-operation recovery store is damaged. Review the shared plan before clearing local recovery data.",
      { exact: true },
    )).toBeVisible();
    const clearRecovery = page.getByRole("button", {
      name: "Review latest plan and clear local recovery",
      exact: true,
    });
    await expect(clearRecovery).toBeVisible();

    let forcedReadbacks = 0;
    const readbackHandler = async (route: Route): Promise<void> => {
      forcedReadbacks += 1;
      await route.continue();
    };
    await page.route("**/api/workspace", readbackHandler);
    await clearRecovery.click();
    await expect(page.getByText(
      "Latest shared plan reviewed. Damaged local recovery data was cleared.",
      { exact: true },
    )).toBeVisible();
    await expect.poll(() => forcedReadbacks).toBeGreaterThan(0);
    await page.unroute("**/api/workspace", readbackHandler);
    expect(await readJournal(page)).toBeNull();

    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    const chicken = page.getByRole("checkbox", { name: "Check Boneless chicken thighs" });
    await chicken.click();
    await expect(chicken).toBeChecked();
  });
});

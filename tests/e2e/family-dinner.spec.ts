import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

type ExpectedFailurePhase = "normal" | "recipe-loss" | "offline" | "restart";
const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";
const sameProcessAuthority = process.env.PLANNER_E2E_EXTERNAL_SERVERS === "1";

function isRestartTransportError(errorText: string) {
  return /ERR_(FAILED|EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_REFUSED)/.test(errorText) ||
    /WebKit encountered an internal error/.test(errorText);
}

function isRestartResponseError(errorText: string) {
  return isRestartTransportError(errorText) ||
    /(?:500 \(Internal Server Error\)|502 \(Bad Gateway\))/.test(errorText);
}

function isRestartReadPath(path: string) {
  return path === "/api/workspace" ||
    path === "/api/health" ||
    path === "/api/codex/events" ||
    path === "/api/codex/thread" ||
    path === "/api/codex/threads";
}

function isOfflineTransportError(errorText: string) {
  return /ERR_INTERNET_DISCONNECTED/.test(errorText) ||
    /WebKit encountered an internal error/.test(errorText);
}

function isInjectedAbortError(errorText: string) {
  return /ERR_FAILED/.test(errorText) ||
    /WebKit encountered an internal error/.test(errorText) ||
    /Blocked by Web Inspector/.test(errorText);
}

function requestFailureLabel(request: Request, errorText: string, phase: ExpectedFailurePhase) {
  const path = apiPath(request.url());
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = request.postDataJSON();
    body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    body = null;
  }
  const command = body?.command && typeof body.command === "object"
    ? body.command as Record<string, unknown>
    : null;
  if (path === "/api/workspace" && /ERR_ABORTED/.test(errorText)) {
    return "conditional-read-abort";
  }
  if (path === "/api/codex/events" && /ERR_ABORTED/.test(errorText)) {
    return "codex-event-read-abort";
  }
  if ((path === "/api/codex/thread" || path === "/api/codex/threads") && /ERR_ABORTED/.test(errorText)) {
    return "codex-thread-read-abort";
  }
  if (
    phase === "recipe-loss" &&
    path === "/api/commands" &&
    command?.type === "updateMealSnapshot"
  ) {
    return "injected-recipe-response-loss";
  }
  if (
    phase === "offline" &&
    (path === "/api/workspace" || path === "/api/health") &&
    isOfflineTransportError(errorText)
  ) {
    return "injected-offline-read";
  }
  if (
    phase === "restart" &&
    isRestartReadPath(path) &&
    isRestartTransportError(errorText)
  ) {
    return "authority-restart-read";
  }
  return "unexpected";
}

function watchRuntime(page: Page) {
  const pageErrors: string[] = [];
  const injectedPageErrors: Array<{ phase: ExpectedFailurePhase; text: string }> = [];
  const consoleErrors: Array<{ phase: ExpectedFailurePhase; text: string; url: string }> = [];
  const failedResponses: Array<{
    phase: ExpectedFailurePhase;
    requestMessage: string | null;
    status: number;
    url: string;
  }> = [];
  const requestFailures: Array<{ errorText: string; label: string; phase: ExpectedFailurePhase; url: string }> = [];
  let expectedFailurePhase: ExpectedFailurePhase = "normal";
  let restartTransportGraceUntil = 0;
  page.on("pageerror", (error) => {
    if (
      expectedFailurePhase === "offline" &&
      /api\/(workspace|health).*due to access control checks/.test(error.message)
    ) {
      injectedPageErrors.push({ phase: expectedFailurePhase, text: error.message });
      return;
    }
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      const url = message.location().url;
      const path = apiPath(url);
      const phase = expectedFailurePhase === "normal" &&
          Date.now() <= restartTransportGraceUntil &&
          isRestartReadPath(path) &&
          isRestartTransportError(text)
        ? "restart"
        : expectedFailurePhase;
      consoleErrors.push({ phase, text, url });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      let requestMessage: string | null = null;
      try {
        const body = response.request().postDataJSON() as { message?: unknown } | null;
        requestMessage = typeof body?.message === "string" ? body.message : null;
      } catch {
        requestMessage = null;
      }
      failedResponses.push({
        phase: expectedFailurePhase,
        requestMessage,
        status: response.status(),
        url: response.url(),
      });
    }
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "unknown";
    const path = apiPath(request.url());
    const phase = expectedFailurePhase === "normal" &&
        Date.now() <= restartTransportGraceUntil &&
        isRestartReadPath(path) &&
        isRestartTransportError(errorText)
      ? "restart"
      : expectedFailurePhase;
    requestFailures.push({
      errorText,
      label: requestFailureLabel(request, errorText, phase),
      phase,
      url: request.url(),
    });
  });
  return {
    pageErrors,
    injectedPageErrors,
    consoleErrors,
    failedResponses,
    requestFailures,
    setExpectedFailurePhase(phase: ExpectedFailurePhase) {
      if (expectedFailurePhase === "restart" && phase === "normal") {
        restartTransportGraceUntil = Date.now() + 2_000;
      }
      expectedFailurePhase = phase;
    },
  };
}

async function openView(page: Page, name: string) {
  await page.locator(".view-nav").getByRole("button", { name, exact: true }).click();
}

async function setPlannerClock(page: Page, peers: Page[], now: number) {
  const response = await page.request.post(`${controlOrigin}/clock?now=${now}`);
  expect(response.ok()).toBe(true);
  await Promise.all(
    peers.map((peer) =>
      peer.evaluate(() => window.dispatchEvent(new Event("focus"))),
    ),
  );
}

function prepStep(page: Page, instruction: string) {
  return page.getByTestId("prep-session-step").filter({ hasText: instruction });
}

async function openPrepRecipeSummary(step: Locator) {
  await step.getByRole("button", { name: /More options for step / }).click();
  await step.getByRole("menuitem", { name: "Harissa chicken traybake", exact: true }).click();
}

async function openRecipeEditor(page: Page, title: string) {
  await openView(page, "Week");
  await page.getByRole("article", { name: new RegExp(`^${title} dinner on `) }).getByRole("button", { name: "Edit meal" }).click();
}

function apiPath(url: string) {
  return new URL(url).pathname;
}

function codexConversation(page: Page) {
  return page.getByRole("log", { name: "Codex conversation" });
}

function codexComposer(page: Page) {
  return page.getByRole("textbox", { name: "Message Codex" });
}

async function sendCodexMessage(page: Page, message: string) {
  await codexComposer(page).fill(message);
  await page.getByRole("button", { name: "Send to Codex" }).click();
}

async function sendPreparedCodexDraft(page: Page, message: string) {
  await expect(codexComposer(page)).toHaveValue(message);
  await page.getByRole("button", { name: "Send to Codex" }).click();
}

async function selectedCodexThreadId(page: Page) {
  const response = await page.request.get("/api/codex/threads");
  expect(response.ok()).toBe(true);
  const payload = await response.json() as {
    selection: { threadId: string | null };
    threads: Array<{ id: string }>;
  };
  expect(payload.selection.threadId).toBeTruthy();
  expect(payload.threads.some((thread) => thread.id === payload.selection.threadId)).toBe(true);
  return payload.selection.threadId!;
}

async function expectSelectedCodexThread(page: Page, threadId: string, timeout = 8_000) {
  await expect.poll(async () => {
    const response = await page.request.get("/api/codex/threads");
    if (!response.ok()) return null;
    const payload = await response.json() as { selection: { threadId: string | null } };
    return payload.selection.threadId;
  }, { timeout }).toBe(threadId);
}

function expectInjectedTransportNoise(
  runtimeA: ReturnType<typeof watchRuntime>,
  runtimeB: ReturnType<typeof watchRuntime>,
) {
  const clientBConflicts = runtimeB.consoleErrors.filter(
    (error) => error.phase === "normal" && apiPath(error.url) === "/api/commands" && /409 \(Conflict\)/.test(error.text),
  );
  const clientBRestartErrors = runtimeB.consoleErrors.filter(
    (error) =>
      error.phase === "restart" &&
      isRestartReadPath(apiPath(error.url)) &&
      isRestartResponseError(error.text),
  );
  const clientBRestartServerFailures = runtimeB.failedResponses.filter(
    (response) =>
      response.phase === "restart" &&
      (response.status === 500 || response.status === 502) &&
      isRestartReadPath(apiPath(response.url)),
  );
  expect(clientBConflicts).toHaveLength(1);
  expect(runtimeA.injectedPageErrors.length).toBeLessThanOrEqual(3);
  expect(runtimeB.injectedPageErrors.length).toBeLessThanOrEqual(3);
  expect(runtimeB.consoleErrors).toHaveLength(clientBConflicts.length + clientBRestartErrors.length);
  expect(runtimeB.failedResponses).toEqual(clientBRestartServerFailures);
  expect(
    runtimeB.requestFailures.every((failure) =>
      failure.label === "authority-restart-read" ||
      failure.label === "conditional-read-abort" ||
      failure.label === "codex-event-read-abort" ||
      failure.label === "codex-thread-read-abort"),
    JSON.stringify(runtimeB.requestFailures),
  ).toBe(true);

  const clientAConflicts = runtimeA.consoleErrors.filter(
    (error) => error.phase === "normal" && apiPath(error.url) === "/api/commands" && /409 \(Conflict\)/.test(error.text),
  );
  expect(clientAConflicts).toHaveLength(1);

  for (const error of runtimeA.consoleErrors) {
    const path = apiPath(error.url);
    const expectedConflict =
      error.phase === "normal" && path === "/api/commands" && /409 \(Conflict\)/.test(error.text);
    const injectedAbort =
      error.phase === "recipe-loss" &&
      path === "/api/commands" &&
      isInjectedAbortError(error.text);
    const injectedOffline =
      error.phase === "offline" &&
      (path === "/api/workspace" || path === "/api/health") &&
      isOfflineTransportError(error.text);
    const injectedRestartRead =
      error.phase === "restart" &&
      isRestartReadPath(path) &&
      isRestartResponseError(error.text);
    expect(
      expectedConflict || injectedAbort || injectedOffline || injectedRestartRead,
      `${error.phase}: ${error.text} at ${error.url}`,
    ).toBe(true);
  }

  const recipeFailures = runtimeA.requestFailures.filter((failure) => failure.label === "injected-recipe-response-loss");
  const offlineFailures = runtimeA.requestFailures.filter((failure) => failure.label === "injected-offline-read");
  const restartReadFailures = runtimeA.requestFailures.filter((failure) => failure.label === "authority-restart-read");
  const conditionalReadAborts = runtimeA.requestFailures.filter((failure) => failure.label === "conditional-read-abort");
  const codexEventReadAborts = runtimeA.requestFailures.filter((failure) => failure.label === "codex-event-read-abort");
  const codexThreadReadAborts = runtimeA.requestFailures.filter((failure) => failure.label === "codex-thread-read-abort");
  const unexpectedFailures = runtimeA.requestFailures.filter((failure) => failure.label === "unexpected");
  const restartReadServerFailures = runtimeA.failedResponses.filter((response) =>
    response.phase === "restart" && (response.status === 500 || response.status === 502) &&
    isRestartReadPath(apiPath(response.url)));
  expect(recipeFailures).toHaveLength(2);
  expect(recipeFailures.every((failure) => isInjectedAbortError(failure.errorText))).toBe(true);
  expect(offlineFailures.length).toBeLessThanOrEqual(3);
  expect(offlineFailures.every((failure) => isOfflineTransportError(failure.errorText))).toBe(true);
  expect(restartReadFailures.every((failure) => isRestartTransportError(failure.errorText))).toBe(true);
  expect(conditionalReadAborts.every((failure) =>
    apiPath(failure.url) === "/api/workspace" && /ERR_ABORTED/.test(failure.errorText))).toBe(true);
  expect(codexEventReadAborts.every((failure) =>
    apiPath(failure.url) === "/api/codex/events" && /ERR_ABORTED/.test(failure.errorText))).toBe(true);
  expect(codexThreadReadAborts.every((failure) =>
    ["/api/codex/thread", "/api/codex/threads"].includes(apiPath(failure.url)) &&
    /ERR_ABORTED/.test(failure.errorText))).toBe(true);
  expect(
    runtimeA.failedResponses.every((response) =>
      restartReadServerFailures.includes(response)),
    JSON.stringify(runtimeA.failedResponses),
  ).toBe(true);
  expect(unexpectedFailures).toEqual([]);
}

test.describe.serial("family dinner authority", () => {
  test("two clients complete the exact dinner workflow through graceful restart and transport loss", async ({ browser }) => {
    test.setTimeout(300_000);
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 700 } });
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const runtimeA = watchRuntime(pageA);
    const runtimeB = watchRuntime(pageB);

    await pageA.goto("/");
    await expect(pageA.getByRole("heading", { name: "Set up this planner once" })).toBeVisible({ timeout: 20_000 });
    await pageA.getByRole("button", { name: "Start Fresh" }).click();
    await expect(pageA.getByText("Family dinner planner")).toBeVisible();

    await pageB.goto("/");
    await expect(pageB.getByText("Family dinner planner")).toBeVisible();
    await openView(pageA, "Prep");
    await openView(pageB, "Prep");
    await pageA.getByLabel("Jump to prep date").fill("2026-07-05");
    await pageB.getByLabel("Jump to prep date").fill("2026-07-05");
    const prepTabsA = pageA.getByRole("tablist", { name: "Prep dates" });
    const prepTabsB = pageB.getByRole("tablist", { name: "Prep dates" });
    const firstTabA = prepTabsA.getByRole("tab", { name: /Sun, Jul 5/ });
    const firstTabB = prepTabsB.getByRole("tab", { name: /Sun, Jul 5/ });
    const secondTabA = prepTabsA.getByRole("tab", { name: /Wed, Jul 8/ });
    const secondTabB = prepTabsB.getByRole("tab", { name: /Wed, Jul 8/ });
    const firstA = pageA.getByTestId("prep-session-step").first();
    const firstB = pageB.getByTestId("prep-session-step").first();
    await expect(firstA.getByRole("checkbox")).not.toBeChecked();
    await expect(firstB.getByRole("checkbox")).not.toBeChecked();

    let releaseConflict!: () => void;
    let markConflictSeen!: () => void;
    const conflictGate = new Promise<void>((resolve) => {
      releaseConflict = resolve;
    });
    const conflictSeen = new Promise<void>((resolve) => {
      markConflictSeen = resolve;
    });
    const conflictRequests: Array<Record<string, unknown>> = [];
    await pageB.route("**/api/commands", async (route) => {
      conflictRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      if (conflictRequests.length === 1) {
        markConflictSeen();
        await conflictGate;
      }
      await route.continue();
    });
    await firstB.getByRole("checkbox").click();
    await conflictSeen;
    await secondTabA.click();
    const secondA = pageA.getByTestId("prep-session-step").first();
    await secondA.getByRole("checkbox").click();
    await expect(secondA.getByRole("checkbox")).toBeChecked();
    releaseConflict();
    await expect(pageB.getByText(/Someone else changed the plan/)).toBeVisible();
    await expect(firstB.getByRole("checkbox")).not.toBeChecked();
    await secondTabB.click();
    const secondB = pageB.getByTestId("prep-session-step").first();
    await expect(secondB.getByRole("checkbox")).toBeChecked();
    const retryConflict = pageB.getByRole("button", { name: /Retry Mark recipe step done: step .*:/ });
    await expect(retryConflict).toBeVisible();
    await retryConflict.click();
    await firstTabB.click();
    await expect(firstB.getByRole("checkbox")).toBeChecked();
    await firstTabA.click();
    await expect(firstA.getByRole("checkbox")).toBeChecked();
    await expect.poll(() => conflictRequests.length).toBe(2);
    const firstConflictRequest = conflictRequests[0] as {
      requestId: string;
      basePlannerVersion: number;
      command: unknown;
    };
    const retryConflictRequest = conflictRequests[1] as {
      requestId: string;
      basePlannerVersion: number;
      command: unknown;
    };
    expect(retryConflictRequest.command).toEqual(firstConflictRequest.command);
    expect(retryConflictRequest.requestId).not.toBe(firstConflictRequest.requestId);
    expect(retryConflictRequest.basePlannerVersion).toBeGreaterThan(firstConflictRequest.basePlannerVersion);
    await pageB.unroute("**/api/commands");

    const harissaPrepA = prepStep(pageA, "Coat the chicken with harissa");
    await openPrepRecipeSummary(harissaPrepA);
    const prepRecipeSummary = pageA.getByRole("dialog", { name: "Harissa chicken traybake" });
    await expect(prepRecipeSummary.getByText("Recipe summary", { exact: true })).toBeVisible();
    await prepRecipeSummary.getByTitle("Close", { exact: true }).click();

    await openRecipeEditor(pageA, "Harissa chicken traybake");
    const mealDrawer = pageA.getByRole("dialog", { name: "Harissa chicken traybake" });
    await mealDrawer.getByRole("textbox", { name: "Title", exact: true }).fill("");
    await mealDrawer.getByRole("button", { name: "Save recipe details" }).click();
    await expect(mealDrawer.getByText("Enter a meal title.")).toBeVisible();
    await mealDrawer.getByRole("textbox", { name: "Title", exact: true }).fill("Harissa chicken traybake");
    const roastInDrawer = mealDrawer.locator(".instruction-step").filter({ hasText: "Roast the chicken" });
    await roastInDrawer.getByText("Edit instruction").click();
    await roastInDrawer.getByRole("spinbutton").fill("0.5");
    await roastInDrawer.getByRole("button", { name: /Save step .*Roast the chicken/ }).click();
    await mealDrawer.locator(".drawer-footer").getByRole("button", { name: "Close" }).click();

    await openRecipeEditor(pageA, "Harissa chicken traybake");
    const ambiguousMealDrawer = pageA.locator(".meal-drawer");
    let lostRecipeResponses = 0;
    runtimeA.setExpectedFailurePhase("recipe-loss");
    await pageA.route("**/api/commands", async (route) => {
      const body = route.request().postDataJSON();
      if (
        body?.command?.type !== "updateMealSnapshot" ||
        body.command.changes.title !== "Ambiguous recipe title"
      ) {
        await route.continue();
        return;
      }
      lostRecipeResponses += 1;
      if (lostRecipeResponses === 1) await route.fetch();
      await route.abort("failed");
    });
    await ambiguousMealDrawer.getByRole("textbox", { name: "Title", exact: true }).fill("Ambiguous recipe title");
    await ambiguousMealDrawer.getByRole("button", { name: "Save recipe details" }).click();
    const retryAmbiguousRecipe = ambiguousMealDrawer.getByRole("button", { name: "Retry Save recipe details" });
    await expect(retryAmbiguousRecipe).toBeVisible();
    expect(lostRecipeResponses).toBe(2);

    await openRecipeEditor(pageB, "Ambiguous recipe title");
    const ambiguousRemoteDrawer = pageB.locator(".meal-drawer");
    await expect(ambiguousRemoteDrawer.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Ambiguous recipe title");
    await ambiguousRemoteDrawer.getByRole("textbox", { name: "Title", exact: true }).fill("Harissa chicken traybake");
    await ambiguousRemoteDrawer.getByRole("button", { name: "Save recipe details" }).click();
    await ambiguousMealDrawer.getByRole("textbox", { name: "Venue", exact: true }).fill("Patio kitchen");
    await pageA.unroute("**/api/commands");
    await pageA.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(retryAmbiguousRecipe).toBeEnabled();
    await retryAmbiguousRecipe.click();
    await expect(ambiguousMealDrawer.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Harissa chicken traybake");
    await expect(ambiguousMealDrawer.getByRole("textbox", { name: "Venue", exact: true })).toHaveValue("Patio kitchen");
    await ambiguousMealDrawer.getByRole("button", { name: "Save recipe details" }).click();
    await expect(ambiguousRemoteDrawer.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Harissa chicken traybake");
    await expect(ambiguousRemoteDrawer.getByRole("textbox", { name: "Venue", exact: true })).toHaveValue("Patio kitchen");
    runtimeA.setExpectedFailurePhase("normal");
    await ambiguousMealDrawer.locator(".drawer-footer").getByRole("button", { name: "Close" }).click();
    await ambiguousRemoteDrawer.locator(".drawer-footer").getByRole("button", { name: "Close" }).click();

    await openRecipeEditor(pageA, "Harissa chicken traybake");
    const staleMealDrawer = pageA.locator(".meal-drawer");
    const staleTitle = staleMealDrawer.getByRole("textbox", { name: "Title", exact: true });
    await staleTitle.fill("Stale local dinner title");
    await openRecipeEditor(pageB, "Harissa chicken traybake");
    const remoteMealDrawer = pageB.locator(".meal-drawer");
    await remoteMealDrawer.getByRole("textbox", { name: "Title", exact: true }).fill("Remote accepted dinner title");
    await remoteMealDrawer.getByRole("textbox", { name: "Venue", exact: true }).fill("Neighbourhood kitchen");
    await remoteMealDrawer.getByRole("button", { name: "Save recipe details" }).click();
    await expect(pageA.getByRole("dialog", { name: "Remote accepted dinner title" })).toBeVisible({ timeout: 8_000 });
    await expect(staleTitle).toHaveValue("Stale local dinner title");
    await expect(staleMealDrawer.getByRole("textbox", { name: "Venue", exact: true })).toHaveValue("Neighbourhood kitchen");
    await staleMealDrawer.getByRole("button", { name: "Save recipe details" }).click();
    await expect(staleMealDrawer.getByText(/Someone else changed the plan/)).toBeVisible();
    await expect(remoteMealDrawer.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Remote accepted dinner title");
    await staleTitle.fill("Harissa chicken traybake");
    const retryEditedRecipe = staleMealDrawer.getByRole("button", { name: "Retry Save recipe details" });
    await expect(retryEditedRecipe).toBeVisible();
    await retryEditedRecipe.click();
    await expect(pageB.getByRole("dialog", { name: "Harissa chicken traybake" })).toBeVisible({ timeout: 8_000 });
    await expect(remoteMealDrawer.getByRole("textbox", { name: "Venue", exact: true })).toHaveValue("Neighbourhood kitchen");
    await staleMealDrawer.locator(".drawer-footer").getByRole("button", { name: "Close" }).click();
    await remoteMealDrawer.locator(".drawer-footer").getByRole("button", { name: "Close" }).click();

    await openView(pageA, "Prep");
    await pageA.getByRole("button", { name: /Add recipe steps to/ }).click();
    const recipeSteps = pageA.getByRole("dialog", { name: "Recipe instructions" });
    const roastSource = recipeSteps.getByRole("button", {
      name: /Drag step 2 for Harissa chicken traybake: Roast the chicken, peppers, and chickpeas until cooked through. onto a prep date/,
    });
    await roastSource.dragTo(secondTabA);
    await expect(secondTabA).toHaveAttribute("aria-selected", "true");
    await expect(prepStep(pageA, "Roast the chicken")).toHaveCount(1);
    await firstTabA.click();
    await roastSource.dragTo(harissaPrepA);
    const roastPrepA = prepStep(pageA, "Roast the chicken");
    await expect(roastPrepA.getByRole("checkbox", { name: /Complete step .*Roast the chicken/ })).toHaveCount(1);
    await expect(roastPrepA.getByRole("button", { name: /Start timer for step .*Roast the chicken/ })).toHaveCount(1);
    await expect(roastPrepA.getByRole("combobox", { name: /Prep date/ })).toHaveCount(0);
    await expect(roastPrepA.getByTitle(/Move step .*Roast the chicken/)).toHaveCount(0);
    const roastMenuButton = roastPrepA.getByRole("button", { name: /More options for step .*Roast the chicken/ });
    await roastMenuButton.click();
    const roastMenu = roastPrepA.getByRole("menu", { name: /Options for step .*Roast the chicken/ });
    await expect(roastMenu.getByRole("menuitem", { name: "Harissa chicken traybake" })).toHaveCount(1);
    await expect(roastMenu.getByRole("menuitem", { name: "Add comment" })).toHaveCount(1);
    await expect(roastMenu.getByRole("menuitem", { name: "Remove from prep" })).toHaveCount(1);
    const roastTimerMinutes = roastPrepA.getByRole("textbox", { name: /Timer minutes for step .*Roast the chicken/ });
    const roastTimerSeconds = roastPrepA.getByRole("textbox", { name: /Timer seconds for step .*Roast the chicken/ });
    await roastTimerMinutes.fill("18");
    await roastTimerSeconds.fill("30");
    await roastTimerSeconds.press("Enter");
    await expect(roastTimerMinutes).toHaveValue("18");
    await expect(roastTimerSeconds).toHaveValue("30");
    await roastPrepA.getByRole("button", { name: /Start timer for step .*Roast the chicken/ }).click();
    await expect(roastPrepA.getByRole("button", { name: /Pause timer for step .*Roast the chicken/ })).toHaveCount(1);
    const activeTimersButton = pageA.getByRole("button", { name: "Active timers: 1" });
    await expect(activeTimersButton).toHaveCount(1);
    await activeTimersButton.click();
    const activeTimersMenu = pageA.getByRole("dialog", { name: "Active timers" });
    await expect(activeTimersMenu).toContainText("Harissa chicken traybake");
    await expect(activeTimersMenu).toContainText("Roast the chicken");
    await expect(activeTimersMenu.getByRole("button", { name: /Pause timer for Harissa chicken traybake: Roast the chicken/ })).toHaveCount(1);
    await activeTimersMenu.getByRole("button", { name: "Close active timers" }).click();
    await roastMenu.getByRole("menuitem", { name: "Add comment" }).click();
    await roastPrepA.getByRole("textbox", { name: /Note or Codex request for step .*Roast the chicken/ }).fill("Timer started before removing this from prep.");
    await roastPrepA.getByRole("button", { name: /Save comment/ }).click();
    await roastMenuButton.click();
    await roastPrepA.getByRole("menuitem", { name: "Remove from prep" }).click();
    await expect(prepStep(pageA, "Roast the chicken")).toHaveCount(0);

    await pageA.reload();
    await openView(pageA, "Prep");
    const reloadedHarissa = prepStep(pageA, "Coat the chicken with harissa");
    await expect(reloadedHarissa.getByRole("checkbox")).toBeChecked();
    const globalDraftB = pageB.getByRole("textbox", { name: "Message Codex" });
    await globalDraftB.fill("Keep this separate household draft.");
    await reloadedHarissa.getByRole("button", { name: /More options for step .*Coat the chicken/ }).click();
    await reloadedHarissa.getByRole("menuitem", { name: "Add comment" }).click();
    await reloadedHarissa.getByRole("textbox", { name: /Note or Codex request for step .*Coat the chicken/ }).fill("Marinated on Sunday.");
    await reloadedHarissa.getByRole("button", { name: /Save comment/ }).click();
    await openView(pageB, "Prep");
    const harissaPrepB = prepStep(pageB, "Coat the chicken with harissa");
    await harissaPrepB.getByRole("button", { name: /More options for step .*Coat the chicken/ }).click();
    await expect(harissaPrepB.getByRole("menuitem", { name: "Edit comment" })).toBeVisible();
    await harissaPrepB.getByRole("menuitem", { name: "Edit comment" }).click();
    await expect(harissaPrepB.getByRole("textbox", { name: /Note or Codex request for step .*Coat the chicken/ })).toHaveValue("Marinated on Sunday.");
    await expect(globalDraftB).toHaveValue("Keep this separate household draft.");

    await secondTabA.click();
    const reloadedRice = prepStep(pageA, "Rinse the rice");
    await reloadedRice.getByRole("checkbox").click();
    await expect(reloadedRice.getByRole("checkbox")).not.toBeChecked();
    await reloadedRice.getByRole("button", { name: /More options for step .*Rinse the rice/ }).click();
    await reloadedRice.getByRole("menuitem", { name: "Add comment" }).click();
    await reloadedRice.getByRole("textbox", { name: /Note or Codex request for step .*Rinse the rice/ }).fill("Please complete this shared step.");
    await reloadedRice.getByRole("button", { name: "Ask Codex" }).click();
    await sendPreparedCodexDraft(pageA, "Please complete this shared step.");
    await expect(codexConversation(pageA).getByText("Please complete this shared step.", { exact: true })).toBeVisible();
    await expect(codexConversation(pageA).getByText("I marked that shared recipe step complete.", { exact: true })).toBeVisible();
    const sharedCodexThreadId = await selectedCodexThreadId(pageA);
    await expectSelectedCodexThread(pageB, sharedCodexThreadId);
    await expect(pageB.getByText("Please complete this shared step.")).toBeVisible();
    await expect(codexConversation(pageB).getByText("I marked that shared recipe step complete.", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(globalDraftB).toHaveValue("Keep this separate household draft.");

    await setPlannerClock(
      pageA,
      [pageA, pageB],
      Date.parse("2026-07-07T18:00:00-03:00"),
    );
    await openView(pageB, "Tonight");
    await expect(pageB.getByRole("heading", { name: "Harissa chicken traybake" })).toBeVisible();
    const tonightSteps = pageB.locator(".tonight-main .instruction-step");
    await expect(tonightSteps.locator(".step-instruction")).toHaveText([
      "Coat the chicken with harissa and refrigerate.",
      "Roast the chicken, peppers, and chickpeas until cooked through.",
    ]);
    await expect(tonightSteps.first().getByRole("checkbox")).toBeChecked();
    await expect(tonightSteps.first().locator(".step-inputs")).toContainText("900 g");
    const roastTonightB = tonightSteps.nth(1);
    await roastTonightB.getByRole("button", { name: /Edit comment for step .*Roast the chicken/ }).click();
    await expect(roastTonightB.getByRole("textbox", { name: /Note or Codex request for step .*Roast the chicken/ }))
      .toHaveValue("Timer started before removing this from prep.");
    await roastTonightB.getByRole("button", { name: "Cancel" }).click();
    await expect(roastTonightB.getByRole("checkbox")).not.toBeChecked();
    await expect(roastTonightB.locator(".step-timer")).toContainText("elapsed", { timeout: 40_000 });
    expect(await pageB.evaluate(() => Notification.permission)).not.toBe("granted");
    await roastTonightB.getByTitle("Reset timer").click();
    await expect(roastTonightB.locator(".step-timer")).toContainText("timer");
    await expect(roastTonightB.getByRole("checkbox")).not.toBeChecked();

    await sendCodexMessage(pageB, "Which dinner is in the Tonight context?");
    await expect(codexConversation(pageB).getByText("Tonight is Harissa chicken traybake.", { exact: true })).toBeVisible();

    await pageA.reload();
    await openView(pageA, "Groceries");
    await sendCodexMessage(pageB, "Propose conflicting meal change after a pause.");
    try {
      await expect.poll(async () => {
        const status = await pageA.request.get(`${controlOrigin}/status`);
        return (await status.json() as { conflictTurnStarted: boolean }).conflictTurnStarted;
      }).toBe(true);
      const chickenGrocerySource = pageA.getByRole("combobox", { name: "Source for Boneless chicken thighs" });
      await chickenGrocerySource.selectOption("Farm box");
      await expect(chickenGrocerySource).toHaveCount(0);
    } finally {
      const releaseHeldConflictResponse = await pageA.request.post(`${controlOrigin}/release-conflict`);
      expect(releaseHeldConflictResponse.ok()).toBe(true);
    }
    await expect(codexConversation(pageB).getByText(/The shared plan changed first\. Review it, then ask Codex again\./)).toBeVisible({ timeout: 8_000 });
    await expect(codexConversation(pageB).getByText(/Codex replied, but its planner change was not applied/)).toBeVisible();
    await expect(pageB.locator(".tonight-hero .status-badge")).toHaveText("planned");

    await openView(pageB, "Groceries");
    await pageB.getByRole("button", { name: "All", exact: true }).click();
    await expect(pageB.getByRole("combobox", { name: "Source for Boneless chicken thighs" })).toHaveValue("farm_box");

    const offlineGrocerySource = pageA.getByRole("combobox", { name: "Source for salmon" });
    runtimeA.setExpectedFailurePhase("offline");
    await contextA.setOffline(true);
    await expect(pageA.getByText(/Offline · read-only/)).toBeVisible({ timeout: 8_000 });
    await expect(offlineGrocerySource).toBeDisabled();
    await contextA.setOffline(false);
    await pageA.getByRole("button", { name: "Reconnect" }).click();
    await expect(offlineGrocerySource).toBeEnabled();
    runtimeA.setExpectedFailurePhase("normal");

    await openView(pageA, "Tonight");
    await openView(pageB, "Tonight");
    await pageA.getByRole("button", { name: "Mark cooked" }).click();
    await expect(pageB.locator(".tonight-hero .status-badge")).toHaveText("cooked");
    await openView(pageB, "Close out");
    await expect(pageB.getByText(/Harissa chicken traybake · 2 portions/)).toBeVisible();
    const repeatHarissa = pageB.getByRole("button", { name: "Rate Harissa chicken traybake repeat" });
    await repeatHarissa.click();
    await expect(repeatHarissa).toHaveAttribute("aria-pressed", "true");
    const goodHarissaLeftovers = pageB.getByRole("button", { name: "Rate Harissa chicken traybake leftovers good" });
    await goodHarissaLeftovers.click();
    await expect(goodHarissaLeftovers).toHaveAttribute("aria-pressed", "true");
    const workspaceBeforeAssignment = await (await pageB.request.get("/api/workspace")).json();
    const occupiedDinnerDate = workspaceBeforeAssignment.state.weeks[0].data.meals.find(
      (meal: { title: string }) => meal.title === "Miso salmon rice bowls",
    )?.date;
    expect(occupiedDinnerDate).toBeTruthy();
    await pageB.locator(".leftover-feedback select").selectOption(occupiedDinnerDate);
    await pageB.getByRole("button", { name: /Assign Harissa chicken traybake leftovers/ }).click();
    await openView(pageB, "Week");
    await expect(pageB.locator(".leftover-meal").filter({ hasText: "Harissa chicken traybake" })).toBeVisible();
    await openView(pageA, "Week");
    await expect(pageA.locator(".leftover-meal").filter({ hasText: "Harissa chicken traybake" })).toBeVisible();
    await setPlannerClock(
      pageA,
      [pageA, pageB],
      Date.parse(`${occupiedDinnerDate}T18:00:00-03:00`),
    );
    await openView(pageB, "Tonight");
    await expect(pageB.locator(".assigned-leftover").getByRole("heading", { name: "Harissa chicken traybake" })).toBeVisible();
    await sendCodexMessage(pageB, "Which dinner is in the Tonight context?");
    await expect(codexConversation(pageB).getByText("Tonight is Harissa chicken traybake leftovers.", { exact: true })).toBeVisible();

    const statusBefore = await pageA.request.get(`${controlOrigin}/status`);
    expect(statusBefore.ok()).toBe(true);
    const authorityBefore = await statusBefore.json() as {
      authorityGeneration?: number;
      authorityPid: number;
      ready: boolean;
    };
    expect(authorityBefore.ready).toBe(true);
    runtimeA.setExpectedFailurePhase("restart");
    runtimeB.setExpectedFailurePhase("restart");
    const restart = await pageA.request.post(`${controlOrigin}/restart`);
    expect(restart.ok()).toBe(true);
    const statusAfter = await pageA.request.get(`${controlOrigin}/status`);
    const authorityAfter = await statusAfter.json() as {
      authorityGeneration?: number;
      authorityPid: number;
      ready: boolean;
    };
    expect(authorityAfter.ready).toBe(true);
    if (sameProcessAuthority) {
      expect(authorityAfter.authorityPid).toBe(authorityBefore.authorityPid);
      expect(authorityAfter.authorityGeneration).toBeGreaterThan(
        authorityBefore.authorityGeneration ?? 0,
      );
    } else {
      expect(authorityAfter.authorityPid).not.toBe(authorityBefore.authorityPid);
    }
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await pageB.reload({ waitUntil: "domcontentloaded" });
    await expect(pageA.getByText("Family dinner planner")).toBeVisible({ timeout: 20_000 });
    await expectSelectedCodexThread(pageA, sharedCodexThreadId, 20_000);
    await expectSelectedCodexThread(pageB, sharedCodexThreadId, 20_000);
    runtimeA.setExpectedFailurePhase("normal");
    runtimeB.setExpectedFailurePhase("normal");
    await expect(codexConversation(pageB).getByText("I marked that shared recipe step complete.", { exact: true })).toBeVisible();
    await openView(pageA, "Groceries");
    await pageA.getByRole("button", { name: "All", exact: true }).click();
    await expect(pageA.getByRole("combobox", { name: "Source for Boneless chicken thighs" })).toHaveValue("farm_box");
    await openView(pageA, "Tonight");
    await expect(pageA.locator(".assigned-leftover").getByRole("heading", { name: "Harissa chicken traybake" })).toBeVisible();
    await openView(pageA, "Week");
    await expect(pageA.locator(".leftover-meal").filter({ hasText: "Harissa chicken traybake" })).toBeVisible();
    await openView(pageA, "Close out");
    await pageA.getByRole("button", { name: /Mark Harissa chicken traybake leftovers eaten/ }).click();
    await openView(pageA, "Week");
    const consumedLeftoverA = pageA.locator(".meal-card").filter({ hasText: "2 portions from Harissa chicken traybake" });
    await expect(consumedLeftoverA).toBeVisible();
    await expect(consumedLeftoverA.locator(".status-badge")).toHaveText("cooked");
    await expect(pageA.getByText("Miso salmon rice bowls", { exact: true })).toHaveCount(0);
    await openView(pageB, "Week");
    const consumedLeftoverB = pageB.locator(".meal-card").filter({ hasText: "2 portions from Harissa chicken traybake" });
    await expect(consumedLeftoverB).toBeVisible();
    await expect(pageB.getByText("Miso salmon rice bowls", { exact: true })).toHaveCount(0);

    await openView(pageA, "Groceries");
    await expect(pageA.getByRole("heading", { level: 1, name: "Groceries", exact: true })).toBeFocused();

    const oldWeekId = await pageA.locator(".week-select select").inputValue();
    await sendCodexMessage(pageA, "Create next week");
    await expect(codexConversation(pageA).getByText("I created a planned week for the next Monday.", { exact: true })).toBeVisible();
    await expect(pageA.locator(".week-select option")).toHaveCount(2);
    const weekIds = await pageA.locator(".week-select option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const nextWeekId = weekIds.find((value) => value !== oldWeekId);
    expect(nextWeekId).toBeTruthy();
    await pageA.locator(".week-select select").selectOption(nextWeekId!);
    await pageA.getByRole("button", { name: "Make active" }).click();
    await expect(pageA.locator(".content-heading .eyebrow")).toContainText("active");
    await pageA.locator(".week-select select").selectOption(oldWeekId);
    await openView(pageA, "Close out");
    await expect(pageA.getByRole("heading", { name: "Week archived" })).toBeVisible();

    expect(runtimeA.pageErrors).toEqual([]);
    expect(runtimeB.pageErrors).toEqual([]);
    expectInjectedTransportNoise(runtimeA, runtimeB);
    await contextA.close();
    await contextB.close();
  });

  test("phone and iPad share a planner change while the mobile Codex task traps focus", async ({ browser }) => {
    test.setTimeout(120_000);
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phonePage = await phone.newPage();
    const phoneRuntime = watchRuntime(phonePage);
    await phonePage.goto("/");
    const setup = phonePage.getByRole("heading", { name: "Set up this planner once" });
    const plannerBrand = phonePage.getByText("Family dinner planner");
    await expect(setup.or(plannerBrand)).toBeVisible({ timeout: 20_000 });
    if (await setup.isVisible()) {
      await phonePage.getByRole("button", { name: "Start Fresh" }).click();
      await expect(plannerBrand).toBeVisible();
    }
    const trigger = phonePage.getByRole("button", { name: "Open Codex" }).first();
    await trigger.click();
    const dialog = phonePage.getByRole("dialog", { name: "Codex task" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => phonePage.locator("body").evaluate((body) => body.style.overflow)).toBe("hidden");
    const phoneComposer = dialog.getByRole("textbox", { name: "Message Codex" });
    await expect(phoneComposer).toBeFocused();
    await phoneComposer.fill("Keep this family Codex draft.");
    await expect(phonePage.locator(".app-shell > div").first()).toHaveJSProperty("inert", true);
    await phonePage.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    for (let index = 0; index < 8; index += 1) await phonePage.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    await phonePage.setViewportSize({ width: 1024, height: 844 });
    const resizedRail = phonePage.getByRole("complementary", { name: "Codex task" });
    await expect(resizedRail).toBeVisible();
    await expect(resizedRail.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep this family Codex draft.");
    await phonePage.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep this family Codex draft.");
    await phonePage.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect.poll(() => phonePage.locator("body").evaluate((body) => body.style.overflow)).toBe("");

    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep this family Codex draft.");
    phoneRuntime.setExpectedFailurePhase("offline");
    await phone.setOffline(true);
    const dialogReconnect = dialog.getByRole("button", { name: "Reconnect" });
    await expect(dialogReconnect).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByText("Editing is paused until the server reconnects.", { exact: false })).toBeVisible();
    await expect(phonePage.locator(".app-shell > div").first()).toHaveJSProperty("inert", true);
    await phone.setOffline(false);
    await dialogReconnect.click();
    await expect(dialogReconnect).toHaveCount(0);
    phoneRuntime.setExpectedFailurePhase("normal");
    await expect(dialog.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep this family Codex draft.");
    await dialog.getByRole("textbox", { name: "Message Codex" }).fill("");
    await phonePage.getByRole("banner").getByRole("button", { name: "Close Codex" }).evaluate((element) => element.remove());
    await phonePage.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(phonePage.getByTitle("Change history")).toBeFocused();
    await expect(phonePage.locator(".app-shell > div").first()).toHaveJSProperty("inert", false);

    await phonePage.reload();
    await expect(phonePage.getByText("Family dinner planner")).toBeVisible();
    const phoneWeekSelect = phonePage.locator(".week-select select");
    const archivedWeekValue = await phoneWeekSelect.locator("option").evaluateAll((options) =>
      options.find((option) => option.textContent?.includes("archived"))?.getAttribute("value") ?? null,
    );
    const activeWeekValue = await phoneWeekSelect.locator("option").evaluateAll((options) =>
      options.find((option) => option.textContent?.includes("active"))?.getAttribute("value") ?? null,
    );
    if (archivedWeekValue) await phoneWeekSelect.selectOption(archivedWeekValue);
    await phonePage.locator(".mobile-nav").getByRole("button", { name: "Prep" }).click();
    const mobileOverflow = phonePage.getByTestId("prep-session-step").first().getByRole("button", { name: /More options for step / });
    await expect(mobileOverflow).toBeVisible();
    const mobileOverflowBox = await mobileOverflow.boundingBox();
    expect(mobileOverflowBox).not.toBeNull();
    expect(mobileOverflowBox!.height).toBeGreaterThanOrEqual(44);
    const prepCanScroll = await phonePage.evaluate(() =>
      document.documentElement.scrollHeight > window.innerHeight,
    );
    if (prepCanScroll) {
      await phonePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      expect(await phonePage.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    }

    await phonePage.locator(".mobile-nav").getByRole("button", { name: "Groceries" }).click();
    await expect(phonePage.getByRole("heading", { level: 1, name: "Groceries", exact: true })).toBeFocused();
    expect(await phonePage.evaluate(() => window.scrollY)).toBe(0);
    if (activeWeekValue) await phoneWeekSelect.selectOption(activeWeekValue);

    const tablet = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const tabletPage = await tablet.newPage();
    const tabletRuntime = watchRuntime(tabletPage);
    await tabletPage.goto("/");
    await expect(tabletPage.getByRole("complementary", { name: "Codex task" })).toBeVisible({ timeout: 20_000 });
    await expect(tabletPage.getByRole("dialog", { name: "Codex task" })).toHaveCount(0);
    const tabletCodex = tabletPage.getByRole("complementary", { name: "Codex task" });
    await tabletCodex.getByRole("textbox", { name: "Message Codex" }).fill("Tablet shared Codex check.");
    await tabletCodex.getByRole("button", { name: "Send to Codex" }).click();
    await expect(tabletCodex.getByText("I can see the shared household plan.", { exact: true })).toBeVisible();
    const restoredPhoneTrigger = phonePage.getByRole("button", { name: "Open Codex" }).first();
    await restoredPhoneTrigger.click();
    const restoredPhoneDialog = phonePage.getByRole("dialog", { name: "Codex task" });
    await expect(restoredPhoneDialog.getByText("Tablet shared Codex check.", { exact: true })).toBeVisible();
    await expect(restoredPhoneDialog.getByRole("log", { name: "Codex conversation" })
      .getByText("I can see the shared household plan.", { exact: true }).last()).toBeVisible();
    await phonePage.keyboard.press("Escape");

    expect(phoneRuntime.pageErrors).toEqual([]);
    for (const error of phoneRuntime.consoleErrors) {
      expect(error.phase).toBe("offline");
      expect(["/api/workspace", "/api/health"]).toContain(apiPath(error.url));
      expect(isOfflineTransportError(error.text)).toBe(true);
    }
    expect(phoneRuntime.failedResponses).toEqual([]);
    expect(
      phoneRuntime.requestFailures.every((failure) =>
        failure.label === "injected-offline-read" ||
        failure.label === "conditional-read-abort" ||
        failure.label === "codex-event-read-abort"),
      JSON.stringify(phoneRuntime.requestFailures),
    ).toBe(true);
    expect(phoneRuntime.requestFailures.some((failure) => failure.label === "injected-offline-read")).toBe(true);
    expect(tabletRuntime.pageErrors).toEqual([]);
    expect(tabletRuntime.consoleErrors).toEqual([]);
    expect(tabletRuntime.failedResponses).toEqual([]);
    expect(
      tabletRuntime.requestFailures.every((failure) =>
        failure.label === "conditional-read-abort" || failure.label === "codex-event-read-abort"),
      JSON.stringify(tabletRuntime.requestFailures),
    ).toBe(true);
    await phone.close();
    await tablet.close();
  });
});

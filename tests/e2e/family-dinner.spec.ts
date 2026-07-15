import { expect, test, type Page, type Request } from "@playwright/test";

type ExpectedFailurePhase = "normal" | "recipe-loss" | "dual-loss" | "offline" | "restart";
const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";
const sameProcessAuthority = process.env.PLANNER_E2E_EXTERNAL_SERVERS === "1";

function isRestartTransportError(errorText: string) {
  return /ERR_(FAILED|EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_REFUSED)/.test(errorText) ||
    /WebKit encountered an internal error/.test(errorText);
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
  const item = command?.item && typeof command.item === "object"
    ? command.item as Record<string, unknown>
    : null;
  if (path === "/api/workspace" && /ERR_ABORTED/.test(errorText)) {
    return "conditional-read-abort";
  }
  if (phase === "dual-loss" && path === "/api/commands" && item?.item === "Transport parsley") {
    return "injected-command-response-loss";
  }
  if (
    phase === "recipe-loss" &&
    path === "/api/commands" &&
    command?.type === "updateMealSnapshot"
  ) {
    return "injected-recipe-response-loss";
  }
  if (
    phase === "dual-loss" &&
    path === "/api/chat/submit" &&
    body?.message === "Propose conflicting meal change during retry isolation."
  ) {
    return "injected-overlap-chat-response-loss";
  }
  if (phase === "restart" && path === "/api/chat/submit" && body?.message === "Wait through restart once.") {
    return "authority-crash-chat";
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
    (path === "/api/workspace" || path === "/api/health") &&
    isRestartTransportError(errorText)
  ) {
    return "authority-crash-read";
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
          (path === "/api/workspace" || path === "/api/health") &&
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
        (path === "/api/workspace" || path === "/api/health") &&
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
  return page.locator(".prep-day-group .instruction-step").filter({ hasText: instruction });
}

function apiPath(url: string) {
  return new URL(url).pathname;
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
      (apiPath(error.url) === "/api/workspace" || apiPath(error.url) === "/api/health") &&
      (isRestartTransportError(error.text) ||
        (!sameProcessAuthority && /502 \(Bad Gateway\)/.test(error.text))),
  );
  const clientBRestartServerFailures = runtimeB.failedResponses.filter(
    (response) =>
      !sameProcessAuthority &&
      response.phase === "restart" &&
      response.status === 502 &&
      (apiPath(response.url) === "/api/workspace" || apiPath(response.url) === "/api/health"),
  );
  expect(clientBConflicts).toHaveLength(1);
  expect(runtimeA.injectedPageErrors.length).toBeLessThanOrEqual(3);
  expect(runtimeB.injectedPageErrors.length).toBeLessThanOrEqual(3);
  expect(runtimeB.consoleErrors).toHaveLength(clientBConflicts.length + clientBRestartErrors.length);
  expect(clientBRestartServerFailures.length).toBeLessThanOrEqual(3);
  expect(runtimeB.failedResponses).toEqual(clientBRestartServerFailures);
  expect(
    runtimeB.requestFailures.every((failure) =>
      failure.label === "authority-crash-read" || failure.label === "conditional-read-abort"),
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
      (error.phase === "recipe-loss" || error.phase === "dual-loss") &&
      path === "/api/commands" &&
      isInjectedAbortError(error.text);
    const injectedChatInterruption =
      (error.phase === "dual-loss" || error.phase === "restart") &&
      path === "/api/chat/submit" &&
      (isRestartTransportError(error.text) ||
        (error.phase === "restart" && /502 \(Bad Gateway\)/.test(error.text)) ||
        (sameProcessAuthority && error.phase === "restart" &&
          /500 \(Internal Server Error\)/.test(error.text)));
    const injectedOffline =
      error.phase === "offline" &&
      (path === "/api/workspace" || path === "/api/health") &&
      isOfflineTransportError(error.text);
    const injectedRestartRead =
      error.phase === "restart" &&
      (path === "/api/workspace" || path === "/api/health") &&
      (isRestartTransportError(error.text) ||
        (!sameProcessAuthority && /502 \(Bad Gateway\)/.test(error.text)));
    expect(
      expectedConflict || injectedAbort || injectedChatInterruption || injectedOffline || injectedRestartRead,
      `${error.phase}: ${error.text} at ${error.url}`,
    ).toBe(true);
  }

  const commandFailures = runtimeA.requestFailures.filter((failure) => failure.label === "injected-command-response-loss");
  const recipeFailures = runtimeA.requestFailures.filter((failure) => failure.label === "injected-recipe-response-loss");
  const chatFailures = runtimeA.requestFailures.filter((failure) => failure.label === "injected-overlap-chat-response-loss");
  const crashFailures = runtimeA.requestFailures.filter((failure) => failure.label === "authority-crash-chat");
  const offlineFailures = runtimeA.requestFailures.filter((failure) => failure.label === "injected-offline-read");
  const restartReadFailures = runtimeA.requestFailures.filter((failure) => failure.label === "authority-crash-read");
  const conditionalReadAborts = runtimeA.requestFailures.filter((failure) => failure.label === "conditional-read-abort");
  const unexpectedFailures = runtimeA.requestFailures.filter((failure) => failure.label === "unexpected");
  const installedRestartInternalErrors = runtimeA.failedResponses.filter((response) =>
    sameProcessAuthority && response.phase === "restart" && response.status === 500 &&
    apiPath(response.url) === "/api/chat/submit" &&
    response.requestMessage === "Wait through restart once.");
  const restartChatServerFailures = runtimeA.failedResponses.filter((response) =>
    response.phase === "restart" && apiPath(response.url) === "/api/chat/submit" &&
    response.requestMessage === "Wait through restart once." &&
    (response.status === 502 || (sameProcessAuthority && response.status === 500)));
  const restartReadServerFailures = runtimeA.failedResponses.filter((response) =>
    !sameProcessAuthority && response.phase === "restart" && response.status === 502 &&
    (apiPath(response.url) === "/api/workspace" || apiPath(response.url) === "/api/health"));
  expect(commandFailures).toHaveLength(2);
  expect(commandFailures.every((failure) => isInjectedAbortError(failure.errorText))).toBe(true);
  expect(recipeFailures).toHaveLength(2);
  expect(recipeFailures.every((failure) => isInjectedAbortError(failure.errorText))).toBe(true);
  expect(chatFailures).toHaveLength(2);
  expect(chatFailures.every((failure) => isInjectedAbortError(failure.errorText))).toBe(true);
  expect(installedRestartInternalErrors).toHaveLength(sameProcessAuthority ? 1 : 0);
  expect(crashFailures.length + restartChatServerFailures.length).toBeGreaterThanOrEqual(1);
  expect(restartReadServerFailures.length).toBeLessThanOrEqual(3);
  expect(crashFailures.every((failure) => isRestartTransportError(failure.errorText))).toBe(true);
  expect(offlineFailures.length).toBeLessThanOrEqual(3);
  expect(offlineFailures.every((failure) => isOfflineTransportError(failure.errorText))).toBe(true);
  expect(restartReadFailures.every((failure) => isRestartTransportError(failure.errorText))).toBe(true);
  expect(conditionalReadAborts.every((failure) =>
    apiPath(failure.url) === "/api/workspace" && /ERR_ABORTED/.test(failure.errorText))).toBe(true);
  expect(
    runtimeA.failedResponses.every((response) =>
      restartChatServerFailures.includes(response) || restartReadServerFailures.includes(response)),
    JSON.stringify(runtimeA.failedResponses),
  ).toBe(true);
  expect(unexpectedFailures).toEqual([]);
}

test.describe.serial("family dinner authority", () => {
  test("two clients complete the exact dinner workflow through restart and transport loss", async ({ browser }) => {
    test.setTimeout(300_000);
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 700 } });
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const runtimeA = watchRuntime(pageA);
    const runtimeB = watchRuntime(pageB);

    await pageA.goto("/");
    await expect(pageA.getByRole("heading", { name: "Set up this planner once" })).toBeVisible();
    await pageA.getByRole("button", { name: "Start Fresh" }).click();
    await expect(pageA.getByText("Family dinner planner")).toBeVisible();

    await pageB.goto("/");
    await expect(pageB.getByText("Family dinner planner")).toBeVisible();
    await openView(pageA, "Prep");
    await openView(pageB, "Prep");
    const firstA = pageA.locator(".prep-day-group .instruction-step").first();
    const firstB = pageB.locator(".prep-day-group .instruction-step").first();
    const secondA = pageA.locator(".prep-day-group .instruction-step").nth(1);
    const secondB = pageB.locator(".prep-day-group .instruction-step").nth(1);
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
    await secondA.getByRole("checkbox").click();
    await expect(secondA.getByRole("checkbox")).toBeChecked();
    releaseConflict();
    await expect(pageB.getByText(/Someone else changed the plan/)).toBeVisible();
    await expect(firstB.getByRole("checkbox")).not.toBeChecked();
    await expect(secondB.getByRole("checkbox")).toBeChecked();
    const retryConflict = pageB.getByRole("button", { name: /Retry Mark recipe step done: step .*:/ });
    await expect(retryConflict).toBeVisible();
    await retryConflict.click();
    await expect(firstB.getByRole("checkbox")).toBeChecked();
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
    await harissaPrepA.locator(".step-meal-link").click();
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

    await harissaPrepA.locator(".step-meal-link").click();
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

    const harissaPrepB = prepStep(pageB, "Coat the chicken with harissa");
    await harissaPrepB.locator(".step-meal-link").click();
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

    await harissaPrepA.locator(".step-meal-link").click();
    const staleMealDrawer = pageA.locator(".meal-drawer");
    const staleTitle = staleMealDrawer.getByRole("textbox", { name: "Title", exact: true });
    await staleTitle.fill("Stale local dinner title");
    await harissaPrepB.locator(".step-meal-link").click();
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

    const sharedPrepDate = await harissaPrepA.getByLabel(/Prep date for step .*Coat the chicken/).inputValue();
    const ricePrepA = prepStep(pageA, "Rinse the rice");
    await ricePrepA.getByLabel(/Prep date for step .*Rinse the rice/).selectOption(sharedPrepDate);
    await ricePrepA.getByTitle(/Move step .*Rinse the rice.* up/).click();
    const sharedDay = pageA.locator(".prep-day-group")
      .filter({ hasText: "Rinse the rice" })
      .filter({ hasText: "Coat the chicken with harissa" });
    await expect(sharedDay.locator(".step-instruction")).toHaveText([
      "Rinse the rice and cook until tender.",
      "Coat the chicken with harissa and refrigerate.",
    ]);

    const prepChoice = pageA.getByLabel("Instruction to add to prep");
    const roastOption = prepChoice.locator("option").filter({ hasText: "Roast the chicken" });
    const roastStepId = await roastOption.getAttribute("value");
    expect(roastStepId).toBeTruthy();
    await prepChoice.selectOption(roastStepId!);
    await pageA.getByLabel("Prep date", { exact: true }).selectOption(sharedPrepDate);
    await pageA.getByRole("button", { name: "Add to prep" }).click();
    const roastPrepA = prepStep(pageA, "Roast the chicken");
    await expect(roastPrepA.getByRole("checkbox", { name: /Complete step .*Roast the chicken/ })).toHaveCount(1);
    await expect(roastPrepA.getByRole("button", { name: /Start timer for step .*Roast the chicken/ })).toHaveCount(1);
    await expect(roastPrepA.getByRole("combobox", { name: /Prep date for step .*Roast the chicken/ })).toHaveCount(1);
    await expect(roastPrepA.getByRole("button", { name: /Move step .*Roast the chicken.* up/ })).toHaveCount(1);
    await expect(roastPrepA.getByRole("button", { name: /Move step .*Roast the chicken.* down/ })).toHaveCount(1);
    await expect(roastPrepA.getByRole("button", { name: /Remove step .*Roast the chicken.* from prep/ })).toHaveCount(1);
    const roastRecipeLink = roastPrepA.getByRole("button", { name: /Open recipe for step .*Roast the chicken/ });
    await expect(roastRecipeLink).toHaveCount(1);
    const roastRecipeBox = await roastRecipeLink.boundingBox();
    expect(roastRecipeBox).not.toBeNull();
    expect(roastRecipeBox!.height).toBeGreaterThanOrEqual(44);
    await roastPrepA.getByRole("button", { name: /Start timer for step .*Roast the chicken/ }).click();
    await roastPrepA.getByText("Add note or ask ChatGPT").click();
    await roastPrepA.locator(".step-comment").last().getByRole("textbox").fill("Timer started before removing this from prep.");
    await roastPrepA.getByRole("button", { name: /Add note for step .*Roast the chicken/ }).click();
    await roastPrepA.getByTitle(/Remove step .*Roast the chicken.* from prep/).click();
    await expect(prepStep(pageA, "Roast the chicken")).toHaveCount(0);

    await pageA.reload();
    await openView(pageA, "Prep");
    const reloadedHarissa = prepStep(pageA, "Coat the chicken with harissa");
    await expect(reloadedHarissa.getByRole("checkbox")).toBeChecked();
    const globalDraftB = pageB.getByRole("textbox", { name: "Message ChatGPT" });
    await globalDraftB.fill("Keep this separate household draft.");
    await reloadedHarissa.getByText("Add note or ask ChatGPT").click();
    await reloadedHarissa.locator(".step-comment").last().getByRole("textbox").fill("Marinated on Sunday.");
    await reloadedHarissa.getByRole("button", { name: /Add note for step .*Coat the chicken/ }).click();
    await expect(pageB.getByText("Marinated on Sunday.")).toBeVisible();
    await expect(globalDraftB).toHaveValue("Keep this separate household draft.");
    await expect(pageB.getByText("Ask about this week or request a planner change.")).toBeVisible();

    const reloadedRice = prepStep(pageA, "Rinse the rice");
    await reloadedRice.getByRole("checkbox").click();
    await expect(reloadedRice.getByRole("checkbox")).not.toBeChecked();
    await reloadedRice.getByText("Add note or ask ChatGPT").click();
    await reloadedRice.locator(".step-comment").last().getByRole("textbox").fill("Please complete this shared step.");
    await reloadedRice.getByRole("button", { name: /Send step .*Rinse the rice.* to ChatGPT/ }).click();
    await expect(pageA.getByText("I marked that shared recipe step complete.")).toBeVisible();
    await expect(pageB.getByText("Please complete this shared step.")).toBeVisible();
    await expect(pageB.getByText("I marked that shared recipe step complete.")).toBeVisible();
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
    await expect(roastTonightB.getByText("Timer started before removing this from prep.")).toBeVisible();
    await expect(roastTonightB.getByRole("checkbox")).not.toBeChecked();
    await expect(roastTonightB.locator(".step-timer")).toContainText("elapsed", { timeout: 40_000 });
    expect(await pageB.evaluate(() => Notification.permission)).not.toBe("granted");
    await roastTonightB.getByTitle("Reset timer").click();
    await expect(roastTonightB.locator(".step-timer")).toContainText("timer");
    await expect(roastTonightB.getByRole("checkbox")).not.toBeChecked();

    await globalDraftB.fill("Which dinner is in the Tonight context?");
    await pageB.getByTitle("Send to ChatGPT").click();
    await expect(pageB.getByText("Tonight is Harissa chicken traybake.")).toBeVisible();

    await pageA.reload();
    await openView(pageA, "Groceries");
    await globalDraftB.fill("Propose conflicting meal change after a pause.");
    await pageB.getByTitle("Send to ChatGPT").click();
    try {
      await expect.poll(async () => {
        const status = await pageA.request.get(`${controlOrigin}/status`);
        return (await status.json() as { conflictTurnStarted: boolean }).conflictTurnStarted;
      }).toBe(true);
      await expect(pageB.getByText("ChatGPT is updating the shared plan…")).toBeVisible();
      const chickenGroceryCheckbox = pageA.getByRole("checkbox", { name: "Check Boneless chicken thighs" });
      await chickenGroceryCheckbox.click();
      await expect(chickenGroceryCheckbox).toBeChecked();
    } finally {
      const releaseHeldConflictResponse = await pageA.request.post(`${controlOrigin}/release-conflict`);
      expect(releaseHeldConflictResponse.ok()).toBe(true);
    }
    await expect(pageB.getByText("The shared plan changed first. Review it, then ask ChatGPT again.")).toBeVisible({ timeout: 8_000 });
    await expect(pageB.getByText(/ChatGPT replied, but its planner change was not applied/)).toBeVisible();
    await expect(pageB.locator(".tonight-hero .status-badge")).toHaveText("planned");

    await openView(pageB, "Groceries");
    await pageA.getByRole("button", { name: "Add", exact: true }).click();
    await expect(pageA.getByText("Enter a grocery item.")).toBeVisible();
    await expect(pageB.getByRole("checkbox", { name: "Check Boneless chicken thighs" })).toBeChecked();

    const overlapChatInputA = pageA.getByRole("textbox", { name: "Message ChatGPT" });
    let lostOverlapChatResponses = 0;
    runtimeA.setExpectedFailurePhase("dual-loss");
    await pageA.route("**/api/chat/submit", async (route) => {
      const body = route.request().postDataJSON();
      if (body?.message !== "Propose conflicting meal change during retry isolation.") {
        await route.continue();
        return;
      }
      lostOverlapChatResponses += 1;
      if (lostOverlapChatResponses === 1) await route.fetch();
      await route.abort("failed");
    });
    await overlapChatInputA.fill("Propose conflicting meal change during retry isolation.");
    await pageA.getByTitle("Send to ChatGPT").click();

    let lostResponses = 0;
    await pageA.route("**/api/commands", async (route) => {
      const body = route.request().postDataJSON();
      if (body?.command?.type !== "addGroceryItem" || body.command.item.item !== "Transport parsley") {
        await route.continue();
        return;
      }
      lostResponses += 1;
      if (lostResponses === 1) await route.fetch();
      await route.abort("failed");
    });
    try {
      await expect.poll(async () => {
        const status = await pageA.request.get(`${controlOrigin}/status`);
        return (await status.json() as { overlapTurnStarted: boolean }).overlapTurnStarted;
      }).toBe(true);
      await expect(pageA.getByText("ChatGPT is updating the shared plan…")).toBeVisible();
      await pageA.getByLabel("New grocery item").fill("Transport parsley");
      await pageA.getByLabel("Grocery detail").fill("1 bunch");
      await pageA.getByRole("button", { name: "Add", exact: true }).click();
      await expect(pageA.getByText(/Offline · read-only/)).toBeVisible();
      await expect(pageA.getByLabel("New grocery item")).toHaveValue("Transport parsley");
      expect(lostResponses).toBe(2);
    } finally {
      const releaseOverlapResponse = await pageA.request.post(`${controlOrigin}/release-overlap`);
      expect(releaseOverlapResponse.ok()).toBe(true);
    }
    const retryLostGrocery = pageA.getByRole("button", { name: "Retry Add grocery item" });
    await expect(retryLostGrocery).toBeVisible();
    await expect(pageA.getByText("ChatGPT is updating the shared plan…")).toHaveCount(0, { timeout: 8_000 });
    expect(lostOverlapChatResponses).toBe(2);
    await expect(retryLostGrocery).toBeVisible();
    await pageA.unroute("**/api/commands");
    await pageA.unroute("**/api/chat/submit");
    await expect(pageA.getByText("Shared plan current", { exact: true })).toBeVisible();
    await expect(pageA.getByText("Transport parsley", { exact: true })).toHaveCount(1);
    await expect(pageA.getByLabel("New grocery item")).toHaveValue("Transport parsley");
    const overlapTranscriptMessages = pageA.locator(".chat-messages .chat-message.user")
      .getByText("Propose conflicting meal change during retry isolation.", { exact: true });
    await expect(overlapTranscriptMessages).toHaveCount(1);
    const sharedPlanReplies = pageA.getByText("I can see the shared household plan.", { exact: true });
    await expect(sharedPlanReplies.last()).toBeVisible();
    const sharedPlanReplyCount = await sharedPlanReplies.count();
    await pageA.getByLabel("New grocery item").fill("Next cilantro");
    await overlapChatInputA.fill("Next family chat draft.");
    await retryLostGrocery.click();
    await expect(pageA.getByLabel("New grocery item")).toHaveValue("Next cilantro");
    await expect(pageB.getByText("Transport parsley", { exact: true })).toHaveCount(1);
    const retryLostChat = pageA.getByRole("button", { name: "Retry Send ChatGPT message" });
    await expect(retryLostChat).toBeVisible();
    await retryLostChat.click();
    await expect(overlapChatInputA).toHaveValue("Next family chat draft.");
    await expect(overlapTranscriptMessages).toHaveCount(1);
    await expect(sharedPlanReplies).toHaveCount(sharedPlanReplyCount);
    runtimeA.setExpectedFailurePhase("normal");

    await pageA.getByLabel("New grocery item").fill("Offline dill");
    runtimeA.setExpectedFailurePhase("offline");
    await contextA.setOffline(true);
    await expect(pageA.getByText(/Offline · read-only/)).toBeVisible({ timeout: 8_000 });
    await expect(pageA.getByLabel("New grocery item")).toHaveValue("Offline dill");
    await expect(pageA.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await expect(pageB.getByText("Offline dill", { exact: true })).toHaveCount(0);
    await contextA.setOffline(false);
    await pageA.getByRole("button", { name: "Reconnect" }).click();
    await expect(pageA.getByLabel("New grocery item")).toHaveValue("Offline dill");
    await expect(pageB.getByText("Offline dill", { exact: true })).toHaveCount(0);
    await pageA.getByLabel("New grocery item").fill("");
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
    await globalDraftB.fill("Which dinner is in the Tonight context?");
    await pageB.getByTitle("Send to ChatGPT").click();
    await expect(pageB.getByText("Tonight is Harissa chicken traybake leftovers.")).toBeVisible();

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
    await overlapChatInputA.fill("Wait through restart once.");
    await pageA.getByTitle("Send to ChatGPT").click();
    await expect.poll(async () => {
      const status = await pageA.request.get(`${controlOrigin}/status`);
      return (await status.json() as { hangMarkerExists: boolean }).hangMarkerExists;
    }, { timeout: 8_000 }).toBe(true);
    const restart = await pageA.request.post(`${controlOrigin}/restart`);
    expect(restart.ok()).toBe(true);
    const statusAfter = await pageA.request.get(`${controlOrigin}/status`);
    const authorityAfter = await statusAfter.json() as {
      authorityGeneration?: number;
      authorityPid: number;
      lastRestartProof?: {
        authorityGenerationAdvanced: boolean;
        durableRunningBeforeStartup: boolean;
        listenerClosed: boolean;
        mode: string;
        sameProcessLeaseRetained: boolean;
        startupInterrupted: boolean;
        storeClosed: boolean;
        terminalRollbackCount: number;
      };
      ready: boolean;
    };
    expect(authorityAfter.ready).toBe(true);
    if (sameProcessAuthority) {
      expect(authorityAfter.authorityPid).toBe(authorityBefore.authorityPid);
      expect(authorityAfter.authorityGeneration).toBeGreaterThan(
        authorityBefore.authorityGeneration ?? 0,
      );
      expect(authorityAfter.lastRestartProof).toEqual({
        mode: "crash",
        authorityGenerationAdvanced: true,
        sameProcessLeaseRetained: true,
        listenerClosed: true,
        storeClosed: true,
        terminalRollbackCount: 1,
        durableRunningBeforeStartup: true,
        startupInterrupted: true,
      });
    } else {
      expect(authorityAfter.authorityPid).not.toBe(authorityBefore.authorityPid);
    }
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await pageB.reload({ waitUntil: "domcontentloaded" });
    await expect(pageA.getByText("Family dinner planner")).toBeVisible({ timeout: 20_000 });
    const resolveInterruptedSubmit = pageA.getByRole("button", { name: "Retry Send ChatGPT message" });
    const retryInterrupted = pageA.getByRole("button", { name: "Retry the interrupted ChatGPT request" });
    await expect(resolveInterruptedSubmit.or(retryInterrupted).first()).toBeVisible({ timeout: 20_000 });
    if (await resolveInterruptedSubmit.isVisible()) {
      await resolveInterruptedSubmit.click();
      await expect(resolveInterruptedSubmit).toHaveCount(0);
    }
    await expect(retryInterrupted).toBeEnabled({ timeout: 20_000 });
    await retryInterrupted.click();
    await expect(pageA.getByText("I recovered the interrupted household request.")).toBeVisible({ timeout: 20_000 });
    const workspaceAfterRetry = await (await pageA.request.get("/api/workspace")).json();
    const restartUserEntries = workspaceAfterRetry.transcriptEntries.filter(
      (entry: { role: string; text: string }) => entry.role === "user" && entry.text === "Wait through restart once.",
    );
    const restartReplies = workspaceAfterRetry.transcriptEntries.filter(
      (entry: { role: string; text: string }) => entry.role === "assistant" && entry.text === "I recovered the interrupted household request.",
    );
    expect(restartUserEntries).toHaveLength(1);
    expect(restartReplies).toHaveLength(1);
    const interruptedTurn = workspaceAfterRetry.chatTurns.find(
      (turn: { turnId: string }) => turn.turnId === restartUserEntries[0].turnId,
    );
    const recoveredTurn = workspaceAfterRetry.chatTurns.find(
      (turn: { retryOfTurnId: string | null }) => turn.retryOfTurnId === interruptedTurn?.turnId,
    );
    expect(interruptedTurn?.status).toBe("interrupted");
    expect(recoveredTurn?.status).toBe("completed");
    expect(recoveredTurn?.userEntryId).toBe(interruptedTurn?.userEntryId);
    runtimeA.setExpectedFailurePhase("normal");
    runtimeB.setExpectedFailurePhase("normal");
    await expect(pageB.getByText("I marked that shared recipe step complete.")).toBeVisible();
    await openView(pageA, "Groceries");
    await expect(pageA.getByRole("checkbox", { name: "Check Boneless chicken thighs" })).toBeChecked();
    await expect(pageA.getByText("Transport parsley", { exact: true })).toHaveCount(1);
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

    await pageA.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect(await pageA.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await openView(pageA, "Groceries");
    await expect(pageA.getByRole("heading", { level: 1, name: "Groceries", exact: true })).toBeFocused();
    expect(await pageA.evaluate(() => window.scrollY)).toBe(0);

    const oldWeekId = await pageA.locator(".week-select select").inputValue();
    const chatA = pageA.getByRole("textbox", { name: "Message ChatGPT" });
    await chatA.fill("Create next week");
    await pageA.getByTitle("Send to ChatGPT").click();
    await expect(pageA.getByText("I created a planned week for the next Monday.")).toBeVisible();
    await expect(pageA.locator(".week-select option")).toHaveCount(2);
    const weekIds = await pageA.locator(".week-select option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const nextWeekId = weekIds.find((value) => value !== oldWeekId);
    expect(nextWeekId).toBeTruthy();
    await pageA.getByLabel("New grocery item").fill("Old-week-only draft");
    await pageA.getByLabel("Grocery detail").fill("Must not cross weeks");
    await pageA.locator(".week-select select").selectOption(nextWeekId!);
    await expect(pageA.getByLabel("New grocery item")).toHaveValue("");
    await expect(pageA.getByLabel("Grocery detail")).toHaveValue("");
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

  test("phone and iPad share a planner change while mobile chat traps focus", async ({ browser }) => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phonePage = await phone.newPage();
    const phoneRuntime = watchRuntime(phonePage);
    await phonePage.goto("/");
    const setup = phonePage.getByRole("heading", { name: "Set up this planner once" });
    const plannerBrand = phonePage.getByText("Family dinner planner");
    await expect(setup.or(plannerBrand)).toBeVisible();
    if (await setup.isVisible()) {
      await phonePage.getByRole("button", { name: "Start Fresh" }).click();
      await expect(plannerBrand).toBeVisible();
    }
    const trigger = phonePage.getByRole("button", { name: "ChatGPT" }).first();
    await trigger.click();
    const dialog = phonePage.getByRole("dialog", { name: "ChatGPT household chat" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => phonePage.locator("body").evaluate((body) => body.style.overflow)).toBe("hidden");
    const phoneComposer = dialog.getByRole("textbox", { name: "Message ChatGPT" });
    await expect(phoneComposer).toBeFocused();
    await phoneComposer.fill("Keep this family chat draft.");
    await expect(phonePage.locator(".app-shell > div").first()).toHaveJSProperty("inert", true);
    await phonePage.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    for (let index = 0; index < 8; index += 1) await phonePage.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    await phonePage.setViewportSize({ width: 768, height: 844 });
    const resizedRail = phonePage.locator('aside[aria-label="ChatGPT household chat"]');
    await expect(resizedRail).toBeVisible();
    await expect(resizedRail.getByRole("textbox", { name: "Message ChatGPT" })).toHaveValue("Keep this family chat draft.");
    await phonePage.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Message ChatGPT" })).toHaveValue("Keep this family chat draft.");
    await phonePage.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect.poll(() => phonePage.locator("body").evaluate((body) => body.style.overflow)).toBe("");

    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Message ChatGPT" })).toHaveValue("Keep this family chat draft.");
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
    await expect(dialog.getByRole("textbox", { name: "Message ChatGPT" })).toHaveValue("Keep this family chat draft.");
    await dialog.getByRole("textbox", { name: "Message ChatGPT" }).fill("");
    await trigger.evaluate((element) => element.remove());
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
    const mobileRecipeLink = phonePage.locator(".step-meal-link").first();
    await expect(mobileRecipeLink).toBeVisible();
    await expect(mobileRecipeLink).toHaveAttribute("aria-label", /Open recipe for step .*:/);
    const mobileRecipeBox = await mobileRecipeLink.boundingBox();
    expect(mobileRecipeBox).not.toBeNull();
    expect(mobileRecipeBox!.height).toBeGreaterThanOrEqual(44);
    await phonePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect(await phonePage.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await phonePage.locator(".mobile-nav").getByRole("button", { name: "Groceries" }).click();
    await expect(phonePage.getByRole("heading", { level: 1, name: "Groceries", exact: true })).toBeFocused();
    expect(await phonePage.evaluate(() => window.scrollY)).toBe(0);
    if (activeWeekValue) await phoneWeekSelect.selectOption(activeWeekValue);
    await phonePage.getByLabel("New grocery item").fill("Phone basil");
    await phonePage.getByLabel("Grocery detail").fill("1 bunch");
    await phonePage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(phonePage.getByText("Phone basil", { exact: true })).toHaveCount(1);

    const tablet = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const tabletPage = await tablet.newPage();
    const tabletRuntime = watchRuntime(tabletPage);
    await tabletPage.goto("/");
    await expect(tabletPage.getByRole("button", { name: "Focus ChatGPT chat" })).toBeVisible();
    await expect(tabletPage.locator('aside[aria-label="ChatGPT household chat"]')).toBeVisible();
    await expect(tabletPage.getByRole("dialog", { name: "ChatGPT household chat" })).toHaveCount(0);
    const tabletChat = tabletPage.locator('aside[aria-label="ChatGPT household chat"]');
    await tabletChat.getByRole("textbox", { name: "Message ChatGPT" }).fill("Tablet shared chat check.");
    await tabletChat.getByTitle("Send to ChatGPT").click();
    await expect(tabletChat.getByText("I can see the shared household plan.", { exact: true })).toBeVisible();
    await tabletPage.locator(".mobile-nav").getByRole("button", { name: "Groceries" }).click();
    const tabletBasil = tabletPage.getByRole("checkbox", { name: "Check Phone basil" });
    await expect(tabletBasil).not.toBeChecked();
    await tabletBasil.click();
    await expect(phonePage.getByRole("checkbox", { name: "Check Phone basil" })).toBeChecked({ timeout: 8_000 });
    const restoredPhoneTrigger = phonePage.getByRole("button", { name: "ChatGPT" }).first();
    await restoredPhoneTrigger.click();
    const restoredPhoneDialog = phonePage.getByRole("dialog", { name: "ChatGPT household chat" });
    await expect(restoredPhoneDialog.getByText("Tablet shared chat check.", { exact: true })).toBeVisible();
    await expect(restoredPhoneDialog.locator(".chat-message.assistant")
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
        failure.label === "injected-offline-read" || failure.label === "conditional-read-abort"),
      JSON.stringify(phoneRuntime.requestFailures),
    ).toBe(true);
    expect(phoneRuntime.requestFailures.some((failure) => failure.label === "injected-offline-read")).toBe(true);
    expect(tabletRuntime.pageErrors).toEqual([]);
    expect(tabletRuntime.consoleErrors).toEqual([]);
    expect(tabletRuntime.failedResponses).toEqual([]);
    expect(
      tabletRuntime.requestFailures.every((failure) => failure.label === "conditional-read-abort"),
      JSON.stringify(tabletRuntime.requestFailures),
    ).toBe(true);
    await phone.close();
    await tablet.close();
  });
});

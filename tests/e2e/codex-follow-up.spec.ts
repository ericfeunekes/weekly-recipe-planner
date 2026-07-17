import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";

async function resetPlanner(request: APIRequestContext) {
  const response = await request.post(`${controlOrigin}/reset`);
  expect(response.ok()).toBe(true);
}

async function openPreview(page: Page, path = "/?codexPreview=1") {
  await page.goto(path);
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const planner = page.getByText("Family dinner planner");
  await expect(setup.or(planner)).toBeVisible();
  if (await setup.isVisible()) await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(planner).toBeVisible();
}

async function openNative(page: Page) {
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const planner = page.getByText("Family dinner planner");
  await expect(setup.or(planner)).toBeVisible();
  if (await setup.isVisible()) await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(planner).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Codex task" }).getByText("Codex", { exact: true })).toBeVisible();
}

async function expectComposerActionTargets(rail: Locator) {
  const stop = rail.getByRole("button", { name: "Stop Codex" });
  const send = rail.getByRole("button", { name: "Send to Codex" });
  const [stopBox, sendBox] = await Promise.all([stop.boundingBox(), send.boundingBox()]);
  expect(stopBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  expect(stopBox?.width).toBeGreaterThanOrEqual(44);
  expect(stopBox?.height).toBeGreaterThanOrEqual(44);
  expect(sendBox?.width).toBeGreaterThanOrEqual(44);
  expect(sendBox?.height).toBeGreaterThanOrEqual(44);
  expect((stopBox?.x ?? 0) + (stopBox?.width ?? 0)).toBeLessThanOrEqual(sendBox?.x ?? 0);
}

test.describe("native Codex thread rail", () => {
  test.beforeEach(async ({ request }) => {
    await resetPlanner(request);
  });

  test.afterEach(async ({ request }) => {
    await request.post(`${controlOrigin}/reset`).catch(() => undefined);
  });

  test("the explicit development preview exposes native task history, conversation, and policy states", async ({ page }) => {
    await openPreview(page);

    const rail = page.getByRole("complementary", { name: "Codex task" });
    await expect(rail).toBeVisible();
    await expect(rail.getByText("Preview only", { exact: true })).toBeVisible();
    await expect(rail.getByText("Preview only — nothing here is shared or sent to Codex.", { exact: true })).toBeVisible();

    const conversation = rail.getByRole("log", { name: "Codex conversation" });
    await expect(conversation).toContainText("Can you help with Friday dinner?");
    await expect(rail.getByText("Checking Friday options", { exact: true })).toBeVisible();
    await expect(rail.getByRole("status", { name: "Codex activity" })).toHaveText("Checking Friday options");
    await expect(rail.getByText("Approval rejected", { exact: true })).toBeVisible();
    await expect(rail.getByText("Codex requested to run a command while checking the plan.", { exact: true })).toBeVisible();
    const workerActivity = conversation.getByRole("article", { name: "Worker activity" });
    await expect(workerActivity).toContainText("Friday options research");
    await expect(workerActivity).toContainText("activity");
    await expect(workerActivity).toContainText("completed");

    const workers = rail.getByRole("region", { name: "Background workers" });
    await expect(workers).toContainText("Friday options research");
    const workerButton = workers.getByRole("button", { name: "View worker 1: Friday options research" });
    await workerButton.click();
    const workerDetails = rail.getByRole("region", { name: "Worker details: Friday options research" });
    await expect(workerDetails).toContainText("Compared the open Friday slot");
    await expect(rail.getByRole("textbox", { name: "Message Codex" })).toHaveCount(0);
    const backToTask = workerDetails.getByRole("button", { name: "Back to task" });
    await expect(backToTask).toBeFocused();
    await backToTask.click();
    await expect(workerButton).toBeFocused();
    await expect(rail.getByRole("log", { name: "Codex conversation" })).toContainText("Can you help with Friday dinner?");

    await rail.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(rail.getByRole("button", { name: "Preview does not submit answers" })).toBeDisabled();

    const composer = rail.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeDisabled();
    await expect(rail.getByRole("button", { name: "Send to Codex" })).toBeDisabled();
    await expect(rail.getByRole("button", { name: "Stop Codex" })).toBeDisabled();
    await expectComposerActionTargets(rail);
    await expect(rail.getByTitle("Preview does not interrupt turns")).toBeVisible();
    await expect(rail.getByTitle("Preview does not send messages")).toBeVisible();

    await rail.getByRole("button", { name: "Task history" }).click();
    const history = rail.getByRole("region", { name: "Task history" });
    await expect(history.getByRole("button", { name: "Open task: Friday dinner" })).toBeVisible();
    await history.getByRole("button", { name: "Load more tasks" }).click();
    await expect(history.getByRole("button", { name: "Open task: Weekend prep" })).toBeVisible();
    await expect(history.getByRole("button", { name: /^Open task:/ })).toHaveCount(3);
    await history.getByRole("textbox", { name: "Search tasks" }).fill("grocery");
    await history.getByRole("button", { name: "Search", exact: true }).click();
    await expect(history.getByRole("button", { name: "Open task: Grocery list" })).toBeVisible();
    await history.getByRole("button", { name: "Archive task: Grocery list" }).click();
    await expect(history.getByText("No tasks match “grocery”.", { exact: true })).toBeVisible();
    await history.getByRole("button", { name: "Archived tasks" }).click();
    await expect(history.getByRole("article", { name: "Archived task: Grocery list" })).toBeVisible();
    await history.getByRole("textbox", { name: "Search tasks" }).fill("");
    await history.getByRole("button", { name: "Search", exact: true }).click();
    await history.getByRole("button", { name: "Open tasks" }).click();
    await history.getByRole("button", { name: "Open task: Weekend prep" }).click();
    await expect(rail.getByRole("log", { name: "Codex conversation" })).toContainText("Help me plan prep for Saturday and Sunday.");
    await expect(rail.getByRole("log", { name: "Codex conversation" })).not.toContainText("Can you help with Friday dinner?");

    await rail.getByRole("button", { name: "Task history" }).click();
    await history.getByRole("button", { name: "New task" }).click();
    await rail.getByRole("button", { name: "Task history" }).click();
    const blankTask = history.getByRole("button", { name: "Open task: New preview task" });
    await expect(blankTask).toBeVisible();
    await expect(blankTask).toHaveAttribute("aria-current", "true");
  });

  test("activity updates do not re-scroll an already hydrated conversation", async ({ page }) => {
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      const scope = window as Window & { __codexConversationScrollCalls?: unknown[] };
      Object.defineProperty(scope, "__codexConversationScrollCalls", { value: calls });
      const original = HTMLElement.prototype.scrollTo;
      HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, ...arguments_: unknown[]) {
        if (this.getAttribute("aria-label") === "Codex conversation") calls.push(arguments_[0]);
        return (original as (...values: unknown[]) => void).apply(this, arguments_);
      } as unknown as typeof HTMLElement.prototype.scrollTo;
    });
    await openPreview(page, "/?codexPreview=activity-burst");
    await expect(page.getByRole("status", { name: "Codex activity" })).toHaveText("Reviewing Friday dinner");
    await expect.poll(() => page.evaluate(() => (window as Window & { __codexConversationScrollCalls?: unknown[] }).__codexConversationScrollCalls)).toEqual([]);
  });

  test("a completed Codex planner apply forces an authoritative workspace readback", async ({ page }) => {
    await openNative(page);
    const freshWorkspaceReads: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/workspace") return;
      const etag = request.headers()["if-none-match"];
      if (!etag) freshWorkspaceReads.push(request.url());
    });

    const rail = page.getByRole("complementary", { name: "Codex task" });
    await rail.getByRole("textbox", { name: "Message Codex" }).fill("Please complete this shared step.");
    await rail.getByRole("button", { name: "Send to Codex" }).click();
    await expect(rail.getByRole("log", { name: "Codex conversation" }))
      .toContainText("I marked that shared recipe step complete.");
    await expect.poll(() => freshWorkspaceReads.length).toBeGreaterThan(0);
  });

  test("task history exposes an enabled retry and recovers after a list failure", async ({ page }) => {
    await openNative(page);
    let injected = false;
    await page.route("**/api/codex/threads?*", async (route) => {
      const url = new URL(route.request().url());
      if (!injected && url.searchParams.has("limit")) {
        injected = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "CODEX_UNAVAILABLE", message: "Injected task history failure." },
          }),
        });
        return;
      }
      await route.continue();
    });

    const rail = page.getByRole("complementary", { name: "Codex task" });
    await rail.getByRole("button", { name: "Task history" }).click();
    const history = rail.getByRole("region", { name: "Task history" });
    await expect(history.getByRole("alert")).toContainText("Injected task history failure.");
    const retry = history.getByRole("button", { name: "Retry task history" });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(history.getByRole("alert")).toHaveCount(0);
    await expect(history.getByRole("list", { name: "Open tasks" })).toHaveAttribute("aria-busy", "false");
  });

  test("an active native turn can be stopped with its exact turn identity", async ({ page }) => {
    await openNative(page);
    const rail = page.getByRole("complementary", { name: "Codex task" });
    const composer = rail.getByRole("textbox", { name: "Message Codex" });
    await composer.fill("Show tonight context.");
    const completedSendPromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/codex/turns/send") && response.request().method() === "POST"
    );
    await rail.getByRole("button", { name: "Send to Codex" }).click();
    expect((await completedSendPromise).status()).toBe(202);
    await expect(rail.getByRole("log", { name: "Codex conversation" })).toContainText("Tonight is");
    await expect(rail.getByRole("button", { name: "Stop Codex" })).toHaveCount(0);

    const prompt = "Installed QA native interrupt proof.";
    await composer.fill(prompt);
    const sendResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/codex/turns/send") && response.request().method() === "POST"
    );
    await rail.getByRole("button", { name: "Send to Codex" }).click();
    const sendResponse = await sendResponsePromise;
    expect(sendResponse.status()).toBe(202);
    const admission = await sendResponse.json() as { threadId: string; turnId: string };
    await expect(rail.getByRole("log", { name: "Codex conversation" })).toContainText(prompt);

    const stop = rail.getByRole("button", { name: "Stop Codex" });
    await expect(stop).toBeEnabled();
    const activeReadResponse = await page.request.get(`/api/codex/thread?threadId=${encodeURIComponent(admission.threadId)}`);
    expect(activeReadResponse.status()).toBe(200);
    const activeRead = await activeReadResponse.json() as {
      selection: { revision: number };
      thread: { turns: Array<{ id: string; status: string }> };
    };
    expect(activeRead.thread.turns.filter((turn) => turn.status === "in_progress").map((turn) => turn.id)).toEqual([admission.turnId]);

    let releaseSteer!: () => void;
    let captureSteer!: () => void;
    const steerRelease = new Promise<void>((resolve) => { releaseSteer = resolve; });
    const steerCaptured = new Promise<void>((resolve) => { captureSteer = resolve; });
    await page.route("**/api/codex/turns/send", async (route) => {
      captureSteer();
      await steerRelease;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "TURN_CONFLICT", message: "Injected steer conflict." } }),
      });
    });
    await composer.fill("Keep checking while the current response is active.");
    const send = rail.getByRole("button", { name: "Send to Codex" });
    await send.click();
    await steerCaptured;
    try {
      await expect(send).toBeDisabled();
      await expect(stop).toBeDisabled();
      await expect(send.locator(".spin")).toHaveCount(1);
      await expect(stop.locator(".spin")).toHaveCount(0);
    } finally {
      releaseSteer();
    }
    await expect(rail.getByRole("alert")).toContainText("Injected steer conflict.");
    await page.unroute("**/api/codex/turns/send");

    let interruptRequests = 0;
    let firstInterruptBody: string | null = null;
    let secondInterruptBody: string | null = null;
    let releaseFirstInterrupt!: () => void;
    let captureFirstInterrupt!: () => void;
    const firstInterruptRelease = new Promise<void>((resolve) => { releaseFirstInterrupt = resolve; });
    const firstInterruptCaptured = new Promise<void>((resolve) => { captureFirstInterrupt = resolve; });
    await page.route("**/api/codex/turns/interrupt", async (route) => {
      interruptRequests += 1;
      if (interruptRequests > 1) {
        secondInterruptBody = route.request().postData();
        await route.continue();
        return;
      }
      firstInterruptBody = route.request().postData();
      captureFirstInterrupt();
      await firstInterruptRelease;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "CODEX_UNAVAILABLE", message: "Injected ambiguous stop failure." } }),
      });
    });
    await stop.click();
    await firstInterruptCaptured;
    try {
      await expect(stop).toBeDisabled();
      await expect(stop.locator(".spin")).toHaveCount(1);
      await expect(send.locator(".spin")).toHaveCount(0);
      expect(interruptRequests).toBe(1);
    } finally {
      releaseFirstInterrupt();
    }
    await expect(rail.getByRole("alert")).toContainText("Injected ambiguous stop failure.");
    await expect(stop).toBeEnabled();

    const interruptResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/codex/turns/interrupt") && response.request().method() === "POST"
    );
    await stop.click();
    const interruptResponse = await interruptResponsePromise;
    expect(interruptResponse.status()).toBe(200);
    expect(secondInterruptBody).toBe(firstInterruptBody);
    expect(interruptResponse.request().postDataJSON()).toEqual({
      requestId: expect.any(String),
      threadId: admission.threadId,
      expectedSelectionRevision: activeRead.selection.revision,
      turnId: admission.turnId,
    });
    await page.unroute("**/api/codex/turns/interrupt");
    await expect.poll(async () => {
      const response = await page.request.get(`/api/codex/thread?threadId=${encodeURIComponent(admission.threadId)}`);
      if (!response.ok()) return null;
      const read = await response.json() as { thread: { turns: Array<{ id: string; status: string }> } };
      return read.thread.turns.find((turn) => turn.id === admission.turnId)?.status ?? null;
    }).toBe("interrupted");
    await expect(stop).toHaveCount(0);
    await expect(rail.getByRole("alert")).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(rail.getByRole("button", { name: "Send to Codex" })).toBeVisible();
  });

  test("the same native rail opens in the mobile dialog without legacy chat controls", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPreview(page);

    const trigger = page.getByRole("button", { name: "Open Codex" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Codex task" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Task history" })).toBeVisible();
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expectComposerActionTargets(dialog);

    await dialog.getByRole("button", { name: "Close Codex" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

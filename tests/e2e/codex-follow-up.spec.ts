import { expect, test, type APIRequestContext } from "@playwright/test";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";
const dinnerNow = Date.parse("2026-07-07T18:00:00-03:00");

async function resetPlanner(request: APIRequestContext) {
  const response = await request.post(`${controlOrigin}/reset`);
  expect(response.ok()).toBe(true);
}

async function setCodexState(request: APIRequestContext, state: string) {
  const response = await request.post(`${controlOrigin}/codex-state?state=${state}`);
  expect(response.ok()).toBe(true);
}

test.describe("Codex follow-up cutover", () => {
  test.beforeEach(async ({ request }) => {
    await resetPlanner(request);
  });

  test.afterEach(async ({ request }) => {
    await request.post(`${controlOrigin}/reset`).catch(() => undefined);
  });

  test("intent controls, sourced recipes, and effect-safe recovery use the managed runtime", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Set up this planner once" })).toBeVisible();
    await page.getByRole("button", { name: "Start Fresh" }).click();
    await expect(page.getByText("Family dinner planner")).toBeVisible();

    const chat = page.locator('aside[aria-label="ChatGPT household chat"]');
    await expect(chat.getByText("ChatGPT ready", { exact: true })).toBeVisible();
    const intentGroup = chat.getByRole("group", { name: "ChatGPT task" });
    const planIntent = intentGroup.getByRole("radio", { name: "Plan", exact: true });
    const researchIntent = intentGroup.getByRole("radio", { name: "Research recipe" });
    const composer = chat.getByRole("textbox", { name: "Message ChatGPT" });
    await expect(planIntent).toBeChecked();
    await expect(researchIntent).not.toBeChecked();

    const archiveGrant = chat.getByRole("checkbox", { name: /Allow archiving week/ });
    await expect(archiveGrant).not.toBeChecked();
    await composer.fill("Keep this exact planner draft while I choose a task.");
    await researchIntent.check();
    await expect(researchIntent).toBeChecked();
    await expect(composer).toHaveValue("Keep this exact planner draft while I choose a task.");
    await expect(archiveGrant).toHaveCount(0);
    await expect(chat.getByText("Search the web, then replace one meal only after the source is validated.")).toBeVisible();
    await planIntent.check();
    await expect(composer).toHaveValue("Keep this exact planner draft while I choose a task.");
    const restoredArchiveGrant = chat.getByRole("checkbox", { name: /Allow archiving week/ });
    await expect(restoredArchiveGrant).not.toBeChecked();
    await restoredArchiveGrant.check();
    await chat.getByTitle("Send to ChatGPT").click();
    await expect(chat.getByText("I can see the shared household plan.", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(planIntent).toBeChecked();
    await expect(restoredArchiveGrant).not.toBeChecked();

    await page.locator(".view-nav").getByRole("button", { name: "Prep", exact: true }).click();
    const protectedPrepStep = page.locator(".instruction-step")
      .filter({ hasText: "Coat the chicken with harissa" });
    await protectedPrepStep.getByRole("button", {
      name: /Remove step .*Coat the chicken with harissa.* from prep/,
    }).click();
    await expect(protectedPrepStep).toHaveCount(0);

    const clock = await page.request.post(`${controlOrigin}/clock?now=${dinnerNow}`);
    expect(clock.ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator(".view-nav").getByRole("button", { name: "Tonight", exact: true }).click();
    await expect(page.locator(".tonight-main")).toBeVisible();

    await researchIntent.check();
    await composer.fill("Find and use a sourced lentil recipe for this dinner.");
    await chat.getByTitle("Send to ChatGPT").click();
    try {
      await expect.poll(async () => {
        const status = await page.request.get(`${controlOrigin}/status`);
        return (await status.json() as { researchTurnStarted: boolean }).researchTurnStarted;
      }).toBe(true);
      await expect(chat.getByText("ChatGPT is researching a recipe…", { exact: true })).toBeVisible();
    } finally {
      const release = await page.request.post(`${controlOrigin}/release-research`);
      expect(release.ok()).toBe(true);
    }
    await expect(chat.getByText("I replaced this dinner with a sourced recipe.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lemon lentil soup" })).toBeVisible();
    await expect(page.getByText("Yield: 4 bowls", { exact: true })).toBeVisible();
    const source = page.getByRole("link", { name: "Deterministic Test Kitchen" });
    await expect(source).toHaveAttribute("href", "https://example.com/recipes/lemon-lentil-soup");
    await expect(source.locator("xpath=..").getByText("Informational recipe source")).toBeVisible();

    await expect(planIntent).toBeChecked();
    await composer.fill("Save one planner change then interrupt the reply.");
    await chat.getByTitle("Send to ChatGPT").click();
    await expect(chat.getByText("Planner changes saved · reply interrupted", { exact: true })).toBeVisible();
    await expect(chat.getByText(
      "The accepted planner changes are already durable. Recovery reconstructs the reply without running them again.",
      { exact: true },
    )).toBeVisible();
    const recover = chat.getByRole("button", {
      name: "Recover the reply (planner changes will not run again)",
    });
    await expect(recover).toBeVisible();

    const beforeRecovery = await (await page.request.get("/api/workspace")).json() as {
      state: { weeks: Array<{ data: { groceries: Array<{ item: string }> } }> };
    };
    expect(beforeRecovery.state.weeks.flatMap((week) => week.data.groceries)
      .filter((item) => item.item === "Recovery proof parsley")).toHaveLength(1);
    await recover.click();
    await expect(chat.getByText("I recovered the interrupted household request.", { exact: true })).toBeVisible();
    const afterRecovery = await (await page.request.get("/api/workspace")).json() as typeof beforeRecovery;
    expect(afterRecovery.state.weeks.flatMap((week) => week.data.groceries)
      .filter((item) => item.item === "Recovery proof parsley")).toHaveLength(1);
  });

  test("the mobile chat drawer exposes the same non-sticky intent contract", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Set up this planner once" })).toBeVisible();
    await page.getByRole("button", { name: "Start Fresh" }).click();
    await page.getByRole("button", { name: "ChatGPT" }).first().click();

    const dialog = page.getByRole("dialog", { name: "ChatGPT household chat" });
    await expect(dialog).toBeVisible();
    const group = dialog.getByRole("group", { name: "ChatGPT task" });
    const plan = group.getByRole("radio", { name: "Plan", exact: true });
    const research = group.getByRole("radio", { name: "Research recipe" });
    const composer = dialog.getByRole("textbox", { name: "Message ChatGPT" });
    await expect(plan).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Allow archiving week/ })).not.toBeChecked();
    await composer.fill("Preserve this mobile draft.");
    await research.check();
    await expect(research).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Allow archiving week/ })).toHaveCount(0);
    await expect(composer).toHaveValue("Preserve this mobile draft.");
    await plan.check();
    await expect(dialog.getByRole("checkbox", { name: /Allow archiving week/ })).not.toBeChecked();
    await expect(composer).toHaveValue("Preserve this mobile draft.");
  });

  test("a rejected submission preserves its draft and selected intent", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Start Fresh" }).click();
    const workspace = await (await page.request.get("/api/workspace")).json();
    await page.route("**/api/chat/submit", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          decision: {
            status: "codex_unavailable",
            message: "Embedded Codex is unavailable.",
          },
          workspace,
        }),
      });
    });

    const chat = page.locator('aside[aria-label="ChatGPT household chat"]');
    const group = chat.getByRole("group", { name: "ChatGPT task" });
    const research = group.getByRole("radio", { name: "Research recipe" });
    const composer = chat.getByRole("textbox", { name: "Message ChatGPT" });
    await research.check();
    await composer.fill("Keep this rejected research draft.");
    await chat.getByTitle("Send to ChatGPT").click();
    await expect(page.getByText("Embedded Codex is unavailable.", { exact: true })).toBeVisible();
    await expect(research).toBeChecked();
    await expect(composer).toHaveValue("Keep this rejected research draft.");
  });

  test("readiness states keep the planner usable and gate only ChatGPT", async ({ page, request }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Start Fresh" }).click();
    const states = [
      ["checking", "Checking ChatGPT"],
      ["unauthenticated", "Planner ready · ChatGPT needs sign-in"],
      ["incompatible", "Planner ready · ChatGPT runtime incompatible"],
      ["unavailable", "Planner ready · ChatGPT unavailable"],
      ["compatible", "ChatGPT ready"],
    ] as const;

    for (const [state, label] of states) {
      await setCodexState(request, state);
      await page.reload();
      await expect(page.getByText("Family dinner planner")).toBeVisible();
      const chat = page.locator('aside[aria-label="ChatGPT household chat"]');
      await expect(chat.getByText(label, { exact: true })).toBeVisible();
      const composer = chat.getByRole("textbox", { name: "Message ChatGPT" });
      await composer.fill(`Draft preserved while ${state}.`);
      const send = chat.getByTitle("Send to ChatGPT");
      if (state === "compatible") {
        await expect(send).toBeEnabled();
      } else {
        await expect(send).toBeDisabled();
      }
      await expect(page.getByRole("button", { name: "Tonight", exact: true })).toBeEnabled();
    }
  });
});

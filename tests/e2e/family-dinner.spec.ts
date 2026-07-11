import { expect, test, type Page } from "@playwright/test";

function watchRuntime(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  return { pageErrors, consoleErrors, failedResponses };
}

async function openView(page: Page, name: string) {
  await page.locator(".view-nav").getByRole("button", { name, exact: true }).click();
}

test.describe.serial("family dinner authority", () => {
  test("two clients share prep, conflict recovery, timers, notes, chat, and offline read-only", async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
    await pageB.route("**/api/commands", async (route) => {
      markConflictSeen();
      await conflictGate;
      await route.continue();
    });
    await firstB.getByRole("checkbox").click();
    await conflictSeen;
    await firstA.getByRole("checkbox").click();
    await expect(firstA.getByRole("checkbox")).toBeChecked();
    releaseConflict();
    await expect(pageB.getByText(/Someone else changed the plan/)).toBeVisible();
    await expect(firstB.getByRole("checkbox")).toBeChecked();
    await pageB.unroute("**/api/commands");

    await firstA.getByText("Add note or ask ChatGPT").click();
    await firstA.locator(".step-comment-body textarea").fill("Marinated on Sunday.");
    await firstA.getByRole("button", { name: "Add note" }).click();
    await expect(firstB.getByText("Marinated on Sunday.")).toBeVisible();

    const secondA = pageA.locator(".prep-day-group .instruction-step").nth(1);
    const secondB = pageB.locator(".prep-day-group .instruction-step").nth(1);
    await secondA.getByTitle("Start timer").click();
    await expect(secondB.locator(".step-timer.running")).toBeVisible();
    await pageA.reload();
    await openView(pageA, "Prep");
    await expect(pageA.locator(".prep-day-group .instruction-step").nth(1).locator(".step-timer.running")).toBeVisible();

    const reloadedSecond = pageA.locator(".prep-day-group .instruction-step").nth(1);
    await reloadedSecond.getByText("Add note or ask ChatGPT").click();
    await reloadedSecond.locator(".step-comment-body textarea").fill("Please complete this shared step.");
    await reloadedSecond.getByRole("button", { name: "Send to ChatGPT" }).click();
    await expect(pageA.getByText("I marked that shared recipe step complete.")).toBeVisible();
    await expect(secondB.getByRole("checkbox")).toBeChecked();
    await expect(secondB.locator(".step-timer.running")).toHaveCount(0);

    await contextA.setOffline(true);
    await expect(pageA.getByText(/Offline · read-only/)).toBeVisible({ timeout: 8_000 });
    await expect(pageA.locator(".prep-day-group .instruction-step").first().getByRole("checkbox")).toBeDisabled();
    await contextA.setOffline(false);
    await pageA.getByRole("button", { name: "Reconnect" }).click();
    await expect(pageA.getByText("Shared plan current")).toBeVisible();

    expect(runtimeA.pageErrors).toEqual([]);
    expect(runtimeB.pageErrors).toEqual([]);
    expect(runtimeA.consoleErrors).toEqual([]);
    expect(runtimeB.consoleErrors).toEqual([]);
    expect(runtimeA.failedResponses).toEqual([]);
    expect(runtimeB.failedResponses).toEqual([]);
    await contextA.close();
    await contextB.close();
  });

  test("mobile chat traps focus while iPad keeps the shared side panel", async ({ browser }) => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phonePage = await phone.newPage();
    const phoneRuntime = watchRuntime(phonePage);
    await phonePage.goto("/");
    const trigger = phonePage.getByRole("button", { name: "ChatGPT" }).first();
    await trigger.click();
    const dialog = phonePage.getByRole("dialog", { name: "ChatGPT household chat" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Message ChatGPT" })).toBeFocused();
    await expect(phonePage.locator(".app-shell > div").first()).toHaveJSProperty("inert", true);
    for (let index = 0; index < 8; index += 1) await phonePage.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await phonePage.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(phoneRuntime.pageErrors).toEqual([]);
    expect(phoneRuntime.consoleErrors).toEqual([]);
    await phone.close();

    const tablet = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const tabletPage = await tablet.newPage();
    await tabletPage.goto("/");
    await expect(tabletPage.locator('aside[aria-label="ChatGPT household chat"]')).toBeVisible();
    await expect(tabletPage.getByRole("dialog", { name: "ChatGPT household chat" })).toHaveCount(0);
    await tablet.close();
  });
});

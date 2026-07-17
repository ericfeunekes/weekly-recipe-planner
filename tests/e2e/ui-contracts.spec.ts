import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";

import {
  assertViewportContained,
  captureAccessibleQaEvidence,
  QA_VIEWPORTS,
} from "../support/playwright-qa";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";
const fixture = process.env.PLANNER_E2E_FIXTURE_EXPECTED ??
  process.env.PLANNER_E2E_FIXTURE ??
  "D4";
const fixtureId = fixture.toLowerCase();
const evidenceDirectory = process.env.PLANNER_E2E_EVIDENCE_DIR;

const VIEWS = [
  { id: "week", label: "Week", heading: "Week" },
  { id: "tonight", label: "Tonight", heading: "Tonight" },
  { id: "prep", label: "Prep", heading: "Prep" },
  { id: "groceries", label: "Groceries", heading: "Groceries" },
  { id: "closeout", label: "Close out", heading: "Close out" },
] as const;

async function resetPlanner(page: Page): Promise<void> {
  const reset = await page.request.post(`${controlOrigin}/reset`);
  expect(reset.ok()).toBe(true);
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const brand = page.getByText("Family dinner planner");
  await expect(setup.or(brand)).toBeVisible();
  if (await setup.isVisible()) {
    await page.getByRole("button", { name: "Start Fresh" }).click();
  }
  await expect(brand).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
}

async function openView(page: Page, label: string): Promise<void> {
  const mobileNav = page.locator(".mobile-nav");
  const navigation = await mobileNav.isVisible()
    ? mobileNav
    : page.locator(".view-nav");
  await navigation.getByRole("button", { name: label, exact: true }).click();
}

async function assertAccessible(
  page: Page,
  scenarioId: string,
  viewportId: string,
): Promise<void> {
  if (evidenceDirectory) {
    await captureAccessibleQaEvidence({
      page,
      evidenceDirectory,
      scenarioId,
      viewportId,
    });
    return;
  }
  await assertViewportContained(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations,
    result.violations.map((violation) =>
      `${violation.id}: ${violation.nodes.length} node(s)`).join("\n"),
  ).toEqual([]);
}

async function expectInsideViewport(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectActionGroupContained(page: Page, selector: string): Promise<void> {
  const group = page.locator(selector).first();
  if (!await group.isVisible().catch(() => false)) return;
  const result = await group.evaluate((element) => {
    const groupBox = element.getBoundingClientRect();
    const children = [...element.children]
      .filter((child) => {
        const style = window.getComputedStyle(child);
        const box = child.getBoundingClientRect();
        return style.display !== "none" && box.width > 0 && box.height > 0;
      })
      .map((child) => {
        const box = child.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        };
      });
    return {
      group: {
        left: groupBox.left,
        right: groupBox.right,
        top: groupBox.top,
        bottom: groupBox.bottom,
      },
      children,
      viewportWidth: window.innerWidth,
    };
  });
  expect(result.children.length).toBeGreaterThan(0);
  for (const child of result.children) {
    expect(child.left).toBeGreaterThanOrEqual(result.group.left - 1);
    expect(child.right).toBeLessThanOrEqual(result.group.right + 1);
    expect(child.right).toBeLessThanOrEqual(result.viewportWidth + 1);
  }
}

async function expectNoHorizontalContentEscape(
  page: Page,
  element: ReturnType<Page["locator"]>,
): Promise<void> {
  const geometry = await element.evaluate((node) => {
    const elementBox = node.getBoundingClientRect();
    const descendants = [...node.querySelectorAll("*")]
      .filter((child) => {
        const style = window.getComputedStyle(child);
        const box = child.getBoundingClientRect();
        return style.display !== "none" && box.width > 0 && box.height > 0;
      })
      .map((child) => {
        const box = child.getBoundingClientRect();
        return { left: box.left, right: box.right };
      });
    return {
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      left: elementBox.left,
      right: elementBox.right,
      viewportWidth: window.innerWidth,
      descendants,
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  for (const child of geometry.descendants) {
    expect(child.left).toBeGreaterThanOrEqual(geometry.left - 1);
    expect(child.right).toBeLessThanOrEqual(geometry.right + 1);
  }
}

async function expectAffectedTextContrast(page: Page): Promise<void> {
  const ratios = await page.evaluate(() => {
    const parseColor = (value: string): [number, number, number] => {
      const trimmed = value.trim();
      if (/^#[0-9a-f]{6}$/iu.test(trimmed)) {
        return [
          Number.parseInt(trimmed.slice(1, 3), 16),
          Number.parseInt(trimmed.slice(3, 5), 16),
          Number.parseInt(trimmed.slice(5, 7), 16),
        ];
      }
      const channels = trimmed.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${value}`);
      return channels as [number, number, number];
    };
    const luminance = (color: [number, number, number]): number => {
      const linear = color.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const contrast = (foreground: string, background: string): number => {
      const lighter = Math.max(luminance(parseColor(foreground)), luminance(parseColor(background)));
      const darker = Math.min(luminance(parseColor(foreground)), luminance(parseColor(background)));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const root = window.getComputedStyle(document.documentElement);
    return {
      mutedOnCanvas: contrast(
        root.getPropertyValue("--muted"),
        root.getPropertyValue("--canvas"),
      ),
      mutedOnSlate: contrast(
        root.getPropertyValue("--muted"),
        root.getPropertyValue("--slate-soft"),
      ),
    };
  });
  expect(ratios.mutedOnCanvas).toBeGreaterThanOrEqual(4.5);
  expect(ratios.mutedOnSlate).toBeGreaterThanOrEqual(4.5);
}

async function expectDialogFocusCycle(
  page: Page,
  dialog: ReturnType<Page["locator"]>,
): Promise<void> {
  const focusable = dialog.locator(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ).filter({ visible: true });
  const count = await focusable.count();
  expect(count).toBeGreaterThan(1);
  await focusable.nth(count - 1).focus();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await focusable.first().focus();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
}

test.describe.configure({ mode: "serial" });

test("all primary views and chat remain contained and accessible", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: QA_VIEWPORTS[0].width, height: QA_VIEWPORTS[0].height });
  await resetPlanner(page);
  await expectAffectedTextContrast(page);

  for (const viewport of QA_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const mobile = viewport.width <= 840;
    await expect(mobile
      ? page.getByRole("button", { name: "Open Codex" })
      : page.getByRole("complementary", { name: "Codex task" }))
      .toBeVisible();
    for (const view of VIEWS) {
      await openView(page, view.label);
      await expect(page.getByRole("heading", { level: 1, name: view.heading, exact: true })).toBeVisible();

      if (fixture === "D4" && view.id === "week") {
        const day = page.locator(".day-column").first();
        const dayBox = await day.boundingBox();
        expect(dayBox).not.toBeNull();
        expect(dayBox!.width).toBeGreaterThanOrEqual(
          await page.locator(".week-grid").evaluate((element) =>
            window.getComputedStyle(element).display === "block" ? 240 : 110),
        );
      }
      if (fixture === "D4" && view.id === "prep") {
        await expectActionGroupContained(page, "[data-testid=prep-session-step]");
      }
      if (fixture === "D4" && view.id === "groceries") {
        await expectActionGroupContained(page, ".grocery-row");
      }

      await assertAccessible(page, `${fixtureId}-${view.id}`, viewport.id);
    }

    if (mobile) {
      await page.getByRole("button", { name: "Open Codex" }).click();
    }
    const chat = mobile
      ? page.getByRole("dialog", { name: "Codex task" })
      : page.getByRole("complementary", { name: "Codex task" });
    await expect(chat).toBeVisible();
    const composer = chat.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeVisible();
    await expectInsideViewport(page, composer);
    if (!mobile) {
      const geometry = await chat.evaluate((chatElement) => {
        const primary = document.querySelector<HTMLElement>(".primary-workspace");
        const chatBox = chatElement?.getBoundingClientRect();
        return {
          chatBottom: chatBox?.bottom ?? null,
          chatPosition: chatElement ? window.getComputedStyle(chatElement).position : null,
          chatRight: chatBox?.right ?? null,
          documentScrollHeight: document.documentElement.scrollHeight,
          primaryOverflowY: primary ? window.getComputedStyle(primary).overflowY : null,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.primaryOverflowY).toBe("auto");
      expect(geometry.chatBottom).not.toBeNull();
      expect(geometry.chatPosition).toBe("fixed");
      expect(Math.abs(geometry.chatBottom! - geometry.viewportHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.chatRight! - geometry.viewportWidth)).toBeLessThanOrEqual(1);
      expect(geometry.documentScrollHeight).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    }
    await assertAccessible(page, `${fixtureId}-chat`, viewport.id);
    if (mobile) {
      await page.keyboard.press("Escape");
      await expect(chat).toHaveCount(0);
    }
  }
});

test("meal, history, and Codex share one short-viewport modal owner", async ({ page }) => {
  test.skip(fixture !== "D4", "D4 supplies meal and history content.");
  await page.setViewportSize({ width: 375, height: 400 });
  await resetPlanner(page);
  const background = page.locator(".app-shell > div").first();

  const mealTrigger = page.locator(".meal-card-editor").first();
  await mealTrigger.click();
  const mealDialog = page.getByRole("dialog").filter({ has: page.getByLabel("Title") });
  await expect(mealDialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(background).toHaveJSProperty("inert", true);
  await expect.poll(() => page.locator("body").evaluate((body) => body.style.overflow)).toBe("hidden");
  expect(await mealDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expectDialogFocusCycle(page, mealDialog);
  await expect(mealDialog.getByLabel(/Meal date for /)).toBeVisible();
  await assertAccessible(page, `${fixtureId}-meal-dialog`, "short-375x400");
  await page.keyboard.press("Escape");
  await expect(mealDialog).toHaveCount(0);
  await expect(mealTrigger).toBeFocused();

  const historyTrigger = page.getByTitle("Change history");
  await historyTrigger.click();
  const historyDialog = page.getByRole("dialog", { name: "Recent changes" });
  await expect(historyDialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(background).toHaveJSProperty("inert", true);
  expect(await historyDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expectDialogFocusCycle(page, historyDialog);
  await assertAccessible(page, `${fixtureId}-history-dialog`, "short-375x400");
  await page.keyboard.press("Escape");
  await expect(historyDialog).toHaveCount(0);
  await expect(historyTrigger).toBeFocused();

  const chatTrigger = page.getByRole("button", { name: "Open Codex" });
  await chatTrigger.click();
  const chatDialog = page.getByRole("dialog", { name: "Codex task" });
  await expect(chatDialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(background).toHaveJSProperty("inert", true);
  const composer = chatDialog.getByRole("textbox", { name: "Message Codex" });
  await expect(composer).toBeFocused();
  await expectDialogFocusCycle(page, chatDialog);
  await expectInsideViewport(page, composer);
  await assertAccessible(page, `${fixtureId}-chat-dialog`, "short-375x400");
  await page.keyboard.press("Escape");
  await expect(chatDialog).toHaveCount(0);
  await expect(chatTrigger).toBeFocused();
  await expect(background).toHaveJSProperty("inert", false);
  await expect.poll(() => page.locator("body").evaluate((body) => body.style.overflow)).toBe("");
});

test("archived weeks expose no editable recipe, prep, or grocery drafts", async ({ page }) => {
  test.skip(fixture !== "D4", "D4 supplies an active week to archive.");
  await page.setViewportSize({ width: 1280, height: 900 });
  await resetPlanner(page);
  await openView(page, "Close out");
  await page.getByRole("button", { name: "Archive active week" }).click();
  await expect(page.getByRole("heading", { name: "Week archived" })).toBeVisible();

  await openView(page, "Week");
  await page.locator(".meal-card-editor").first().click();
  const mealDialog = page.getByRole("dialog").filter({ has: page.getByLabel("Title") });
  await expect(mealDialog).toBeVisible();
  const recipeDrafts = mealDialog.locator("input:not([type=checkbox]), textarea");
  expect(await recipeDrafts.count()).toBeGreaterThan(0);
  expect(await recipeDrafts.evaluateAll((controls) =>
    controls.every((control) => (control as HTMLInputElement | HTMLTextAreaElement).disabled),
  )).toBe(true);
  await expect(mealDialog.getByLabel(/Meal date for /)).toBeDisabled();
  await expect(mealDialog.getByText("Add note or ask Codex")).toHaveCount(0);
  await expect(mealDialog.getByRole("button", { name: "Add instruction" })).toHaveCount(0);
  await assertAccessible(page, `${fixtureId}-archived-meal`, "desktop-1280x900");
  await page.keyboard.press("Escape");

  await openView(page, "Prep");
  await expect(page.getByRole("button", { name: "Add to prep" })).toHaveCount(0);
  await expect(page.getByText("Add note or ask Codex")).toHaveCount(0);
  const prepMutations = page.getByTestId("prep-session-step").locator("input, button");
  expect(await prepMutations.count()).toBeGreaterThan(0);
  expect(await prepMutations.evaluateAll((controls) =>
    controls.every((control) => (control as HTMLButtonElement | HTMLSelectElement).disabled),
  )).toBe(true);
  await assertAccessible(page, `${fixtureId}-archived-prep`, "desktop-1280x900");

  await openView(page, "Groceries");
  await expect(page.getByLabel("New grocery item")).toHaveCount(0);
  const groceryChecks = page.locator(".grocery-row input[type=checkbox]");
  expect(await groceryChecks.count()).toBeGreaterThan(0);
  expect(await groceryChecks.evaluateAll((controls) =>
    controls.every((control) => (control as HTMLInputElement).disabled),
  )).toBe(true);
  await assertAccessible(page, `${fixtureId}-archived-groceries`, "desktop-1280x900");
});

test("recipe-derived groceries and read-only prep recipe summaries keep their actions contained", async ({ page }) => {
  test.skip(fixture !== "D4", "D4 supplies populated prep and grocery surfaces.");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 701, height: 840 });
  await resetPlanner(page);

  await openView(page, "Groceries");
  const groceryRow = page.locator(".grocery-row").first();
  await expect(groceryRow).toBeVisible();
  await expectNoHorizontalContentEscape(page, groceryRow);
  await expectInsideViewport(page, groceryRow.locator(":scope > .grocery-check"));
  await expectInsideViewport(page, groceryRow.locator(".grocery-source-select"));
  await assertAccessible(page, `${fixtureId}-long-grocery`, "boundary-701x840");

  await openView(page, "Prep");
  const firstPrepStep = page.getByTestId("prep-session-step").first();
  await firstPrepStep.getByRole("button", { name: /More options for step / }).click();
  await firstPrepStep.getByRole("menuitem").first().click();
  const recipeSummary = page.getByRole("dialog", { name: "Harissa chicken traybake" });
  await expect(recipeSummary.getByText("Recipe summary", { exact: true })).toBeVisible();
  await expect(recipeSummary.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
  await expect(recipeSummary.getByRole("button", { name: "Save recipe details" })).toHaveCount(0);
  await expectNoHorizontalContentEscape(page, recipeSummary);
  await recipeSummary.getByTitle("Close").click();
  const prepRow = page.getByTestId("prep-session-step").filter({ hasText: "Coat the chicken with harissa" }).first();
  await expect(prepRow).toBeVisible();
  await expectNoHorizontalContentEscape(page, prepRow);
  await prepRow.getByRole("button", { name: /More options for step / }).click();
  const prepMenu = prepRow.getByRole("menu");
  await expect(prepMenu.getByRole("menuitem").first()).toContainText("Harissa chicken traybake");
  await expectNoHorizontalContentEscape(page, prepMenu);
  await assertAccessible(page, `${fixtureId}-long-prep`, "boundary-701x840");
});

test("grocery source filters and dinner links remain compact and actionable on phone", async ({ page }) => {
  test.skip(fixture !== "D4", "D4 supplies populated grocery and dinner data.");
  await page.setViewportSize({ width: 390, height: 844 });
  await resetPlanner(page);
  await openView(page, "Groceries");

  await expect(page.getByRole("button", { name: "Reconcile current list", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("New grocery item", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Recipe for grocery", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Farm box", exact: true }).click();
  const groceryRow = page.locator(".grocery-row").filter({ hasText: /red peppers/i });
  await expect(groceryRow).toBeVisible();
  await expect(groceryRow.getByRole("button", { name: "Harissa chicken traybake", exact: true })).toBeVisible();
  await expectNoHorizontalContentEscape(page, groceryRow);
  await expectInsideViewport(page, groceryRow.locator(".grocery-check"));
  await expectInsideViewport(page, groceryRow.locator(".grocery-source-select"));
  expect(await groceryRow.locator(".grocery-check").boundingBox()).toMatchObject({ width: 44, height: 44 });

  await groceryRow.getByRole("button", { name: "Harissa chicken traybake", exact: true }).click();
  const recipeSummary = page.getByRole("dialog", { name: "Harissa chicken traybake" });
  await expect(recipeSummary).toBeVisible();
  await expect(recipeSummary.getByText("Recipe summary", { exact: true })).toBeVisible();
  await expect(recipeSummary.getByRole("textbox")).toHaveCount(0);
  await expect(recipeSummary.getByRole("button", { name: "Save recipe details", exact: true })).toHaveCount(0);
  await expectNoHorizontalContentEscape(page, recipeSummary);
  await recipeSummary.getByTitle("Close").click();
  await expect(groceryRow.getByRole("button", { name: "Harissa chicken traybake", exact: true })).toBeFocused();

  await groceryRow.getByLabel(/Source for red peppers/i).selectOption("on_hand");
  await expect(page.getByTestId("grocery-bulk-actions")).toHaveCount(0);
  await expect(page.getByTestId("grocery-move-notice")).toContainText("Moved 1 ingredient to On hand.");
  await page.getByLabel("Grocery filter").getByRole("button", { name: "On hand", exact: true }).click();
  await expect(page.locator(".grocery-row").filter({ hasText: /red peppers/i })).toBeVisible();
  await assertAccessible(page, `${fixtureId}-grocery-source-provenance`, "mobile-390x844");
});

test("selected groceries move atomically by dropdown and drag target without expanding rows", async ({ page }) => {
  test.skip(fixture !== "D4", "D4 supplies populated grocery data.");
  await page.setViewportSize({ width: 390, height: 844 });
  await resetPlanner(page);
  await openView(page, "Groceries");
  await expect(page.getByLabel("New grocery item", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Recipe for grocery", { exact: true })).toHaveCount(0);

  const chicken = page.locator(".grocery-row").filter({ hasText: /boneless chicken thighs/i });
  const salmon = page.locator(".grocery-row", {
    has: page.locator(".grocery-select-target strong", { hasText: /^salmon$/i }),
  });
  const whiteMiso = page.locator(".grocery-row").filter({ hasText: /white miso/i });
  const selectedItemIds = await Promise.all([chicken, whiteMiso].map(async (row) => {
    const id = await row.getAttribute("data-grocery-id");
    expect(id).toBeTruthy();
    return id!;
  }));
  const bulkActions = page.getByTestId("grocery-bulk-actions");
  const clickGroceryCard = (row: typeof chicken, modifiers?: Array<"Control" | "Meta" | "Shift">) =>
    row.locator(".grocery-item-copy").click({ position: { x: 1, y: 1 }, modifiers });
  await chicken.getByLabel("Check Boneless chicken thighs").click();
  await expect(chicken).toHaveCount(0);
  await expect(bulkActions).toHaveCount(0);
  await resetPlanner(page);
  await openView(page, "Groceries");
  await clickGroceryCard(chicken);
  await expect(bulkActions.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(chicken.locator("input[type=checkbox]")).toHaveCount(1);
  await clickGroceryCard(whiteMiso);
  await expect(bulkActions.getByText("1 selected", { exact: true })).toBeVisible();
  await clickGroceryCard(chicken);
  await clickGroceryCard(whiteMiso, ["Shift"]);
  expect(await page.locator(".grocery-row.selected").count()).toBeGreaterThan(2);
  await clickGroceryCard(chicken);
  await clickGroceryCard(whiteMiso, ["Control"]);
  await expect(bulkActions.getByText("2 selected", { exact: true })).toBeVisible();
  await clickGroceryCard(salmon, ["Meta"]);
  await expect(bulkActions.getByText("3 selected", { exact: true })).toBeVisible();
  await clickGroceryCard(salmon, ["Meta"]);
  await expect(bulkActions.getByText("2 selected", { exact: true })).toBeVisible();
  await resetPlanner(page);
  await openView(page, "Groceries");
  await clickGroceryCard(chicken);
  await clickGroceryCard(salmon, ["Control"]);
  await clickGroceryCard(whiteMiso, ["Control", "Shift"]);
  await expect(chicken).toHaveClass(/selected/);
  await expect(salmon).toHaveClass(/selected/);
  await expect(whiteMiso).toHaveClass(/selected/);
  await resetPlanner(page);
  await openView(page, "Groceries");
  await clickGroceryCard(chicken);
  await clickGroceryCard(salmon, ["Meta"]);
  await clickGroceryCard(whiteMiso, ["Meta", "Shift"]);
  await expect(chicken).toHaveClass(/selected/);
  await expect(salmon).toHaveClass(/selected/);
  await expect(whiteMiso).toHaveClass(/selected/);
  await resetPlanner(page);
  await openView(page, "Groceries");
  await clickGroceryCard(chicken);
  await clickGroceryCard(whiteMiso, ["Control"]);
  await expect(bulkActions.getByText("2 selected", { exact: true })).toBeVisible();
  await bulkActions.getByLabel("Move selected groceries to source", { exact: true }).selectOption("on_hand");
  const dropdownCommandBodies: Array<{ command?: { itemIds?: string[]; source?: string; type?: string } }> = [];
  const captureDropdownCommand = (request: Request) => {
    if (new URL(request.url()).pathname === "/api/commands" && request.method() === "POST") {
      dropdownCommandBodies.push(request.postDataJSON() as { command?: { itemIds?: string[]; source?: string; type?: string } });
    }
  };
  page.on("request", captureDropdownCommand);
  await bulkActions.getByRole("button", { name: "Move", exact: true }).click();
  await expect.poll(() => dropdownCommandBodies.length).toBe(1);
  page.off("request", captureDropdownCommand);
  expect(dropdownCommandBodies).toHaveLength(1);
  expect(dropdownCommandBodies[0].command).toMatchObject({
    type: "moveGroceryItemsToSource",
    source: "on_hand",
  });
  expect([...dropdownCommandBodies[0].command!.itemIds!].sort()).toEqual([...selectedItemIds].sort());
  await expect(page.getByTestId("grocery-move-notice")).toContainText("Moved 2 ingredients to On hand.");

  await page.getByLabel("Grocery filter").getByRole("button", { name: "On hand", exact: true }).click();
  await expect(chicken).toBeVisible();
  await expect(whiteMiso).toBeVisible();
  await expectNoHorizontalContentEscape(page, chicken);
  const compactLine = await chicken.locator(".grocery-primary-line").evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    whiteSpace: window.getComputedStyle(element).whiteSpace,
  }));
  expect(compactLine.height).toBeLessThanOrEqual(24);
  expect(compactLine.whiteSpace).toBe("nowrap");

  await chicken.locator(".grocery-select-target").click();
  await whiteMiso.locator(".grocery-select-target").click({ modifiers: ["Control"] });
  await expect(bulkActions.getByText("2 selected", { exact: true })).toBeVisible();
  const dragHandle = chicken.getByRole("button", { name: "Drag 2 selected groceries to a source tab", exact: true });
  const farmBoxTarget = bulkActions.getByTestId("grocery-source-target-farm_box");
  await dragHandle.dragTo(farmBoxTarget);
  await page.getByLabel("Grocery filter").getByRole("button", { name: "Farm box", exact: true }).click();
  await expect(page.locator(".grocery-row").filter({ hasText: /boneless chicken thighs/i })).toBeVisible();
  await expect(page.locator(".grocery-row").filter({ hasText: /white miso/i })).toBeVisible();
  await assertAccessible(page, `${fixtureId}-grocery-bulk-source-moves`, "mobile-390x844");
});

test("an initialized zero-week workspace can create its first week through Codex", async ({ page }) => {
  test.skip(fixture !== "D7", "D7 is the initialized zero-week fixture.");
  await page.setViewportSize({ width: 390, height: 844 });
  await resetPlanner(page);
  await expect(page.getByRole("heading", { name: "No weeks yet" })).toBeVisible();
  await page.getByRole("button", { name: "Open Codex" }).click();
  const dialog = page.getByRole("dialog", { name: "Codex task" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Codex", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await assertAccessible(page, `${fixtureId}-zero-week-chat`, "mobile-390x844");

  const requestPromise = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/codex/turns/send" && request.method() === "POST");
  await dialog.getByRole("textbox", { name: "Message Codex" }).fill("Create the first shared week");
  await dialog.getByRole("button", { name: "Send to Codex" }).click();
  const body = requestPromise.then((request) => request.postDataJSON() as {
    requestId: string;
    threadId: string;
    message: string;
  });
  await expect(dialog.getByRole("log", { name: "Codex conversation" })).toContainText("I created the first shared week.");
  await expect(body).resolves.toMatchObject({
    requestId: expect.any(String),
    threadId: expect.any(String),
    message: "Create the first shared week",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "No weeks yet" })).toHaveCount(0);
  await expect(page.locator(".week-select option")).toHaveCount(1);
});

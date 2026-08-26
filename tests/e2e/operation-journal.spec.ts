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
  kind: "bootstrap" | "planner" | "undo";
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
        groceries: Array<{
          id: string;
          mealId: string;
          ingredientId: string;
          checked: boolean;
          coverage: "needs_source" | "shop" | "farm_box" | "on_hand";
        }>;
        meals: Array<{
          id: string;
          title: string;
          ingredients: Array<{ id: string; ingredient: string }>;
        }>;
      };
    }>;
  };
  events: Array<{
    command: Record<string, unknown> & { type: string };
    eventId: string;
    revertsEventId: string | null;
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

function groceryIngredient(
  workspace: Workspace,
  itemId: string,
): { ingredient: string; coverage: "needs_source" | "shop" | "farm_box" | "on_hand"; checked: boolean } | undefined {
  for (const week of workspace.state.weeks) {
    const grocery = week.data.groceries.find((item) => item.id === itemId);
    if (!grocery) continue;
    const meal = week.data.meals.find((candidate) => candidate.id === grocery.mealId);
    const ingredient = meal?.ingredients.find((candidate) => candidate.id === grocery.ingredientId);
    if (ingredient) {
      return { ingredient: ingredient.ingredient, coverage: grocery.coverage, checked: grocery.checked };
    }
  }
  return undefined;
}

function groceryIdForIngredient(workspace: Workspace, ingredientName: string): string {
  const normalizedIngredientName = ingredientName.toLocaleLowerCase("en-CA");
  for (const week of workspace.state.weeks) {
    for (const grocery of week.data.groceries) {
      const meal = week.data.meals.find((candidate) => candidate.id === grocery.mealId);
      if (meal?.ingredients.some((ingredient) =>
        ingredient.id === grocery.ingredientId &&
        ingredient.ingredient.toLocaleLowerCase("en-CA") === normalizedIngredientName,
      )) {
        return grocery.id;
      }
    }
  }
  throw new Error(`No projected grocery record exists for ${ingredientName}.`);
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
  await expect(page.getByText(/was interrupted\. Reconnect, then resolve that exact request\./).first())
    .toBeVisible();
}

function mainRetry(page: Page, label: string) {
  return page.locator(".app-main").getByRole("button", { name: `Retry ${label}` });
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
    await page.locator(".week-view .meal-card-primary").first().click();
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
        return command?.type === "editMealRecipe" && changes?.title === title;
      },
    );

    await drawer.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await drawer.getByRole("button", { name: "Save recipe details" }).click();
    const operation = await waitForAmbiguity(page, loss, "planner");
    expect(operation.submittedDraft).toMatchObject({
      type: "editMealRecipe",
      changes: { title },
    });
    await drawer.getByRole("textbox", { name: "Title", exact: true }).fill("");
    await drawer.getByRole("textbox", { name: "Venue", exact: true }).fill(recoveryVenue);
    const editedJournal = await expectJournalKinds(page, ["planner"]);
    expect(editedJournal.operations[0].serializedBody).toBe(operation.serializedBody);
    expect(editedJournal.operations[0].editableDraft).toMatchObject({
      type: "editMealRecipe",
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
    const replayedWorkspace = await readWorkspace(page);
    await hydratedDrawer.getByRole("textbox", { name: "Title", exact: true }).fill(finalTitle);
    const continuation = await captureAcceptedReplay(page, "**/api/commands", async () => {
      await hydratedDrawer.getByRole("button", { name: "Save recipe details" }).click();
    });
    expect(bodyJson(continuation).basePlannerVersion).toBe(replayedWorkspace.plannerVersion);

    const workspace = await readWorkspace(page);
    expect(workspace.state.weeks.flatMap((week) => week.data.meals)
      .filter((meal) => meal.title === finalTitle)).toHaveLength(1);
    expect(workspace.events.filter((event) => {
      const changes = event.command.changes as Record<string, unknown> | undefined;
      return event.command.type === "editMealRecipe" && changes?.title === title;
    })).toHaveLength(1);
    expect(workspace.events.filter((event) => {
      const changes = event.command.changes as Record<string, unknown> | undefined;
      return event.command.type === "editMealRecipe" &&
        changes?.title === finalTitle && changes?.venue === recoveryVenue;
    })).toHaveLength(1);
  });

  test("an interrupted created occurrence replays exactly, opens review for its returned ID, and continues at the current version", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".week-view .meal-card-primary").first().click();
    const drawer = page.locator(".meal-drawer");
    const literal = "journal replay lake herb";
    await drawer.getByRole("button", { name: "Add ingredient" }).click();
    await drawer.getByLabel(/Ingredient \d+ core/u).last().fill(literal);
    const loss = await armCommittedResponseLoss(
      page,
      "**/api/commands",
      (body) => {
        const command = body.command as Record<string, unknown> | undefined;
        const occurrences = command?.occurrences;
        return command?.type === "editMealRecipe" && Array.isArray(occurrences) && occurrences.some((occurrence) =>
          typeof occurrence === "object" && occurrence !== null &&
          (occurrence as Record<string, unknown>).kind === "create" &&
          (occurrence as Record<string, unknown>).ingredient === literal,
        );
      },
    );
    await drawer.getByRole("button", { name: "Save recipe details" }).click();
    const operation = await waitForAmbiguity(page, loss, "planner");
    const submitted = bodyJson(operation.serializedBody).command as Record<string, unknown>;
    const created = (submitted.occurrences as Array<Record<string, unknown>>).find((occurrence) => occurrence.ingredient === literal)!;
    expect(created.correlationId).toEqual(expect.any(String));

    await reloadPlanner(page);
    const retry = page.locator(".meal-drawer").getByRole("button", { name: "Retry Save recipe details" });
    await expect(retry).toBeVisible();
    await stopResponseLoss(page, loss);
    const replayBody = await captureAcceptedReplay(page, "**/api/commands", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);

    const replayedWorkspace = await readWorkspace(page);
    const replayedIngredient = replayedWorkspace.state.weeks
      .flatMap((week) => week.data.meals)
      .flatMap((meal) => meal.ingredients)
      .find((ingredient) => ingredient.ingredient === literal);
    expect(replayedIngredient?.id).toEqual(expect.any(String));
    const hydratedDrawer = page.locator(".meal-drawer");
    await expect(hydratedDrawer.getByText("Reviewing 1 occurrence.")).toBeVisible();

    const reviewed = page.waitForRequest((request) =>
      request.url().endsWith("/api/commands") &&
      (request.postDataJSON() as { command?: { type?: string } }).command?.type === "applyIngredientResolutionBatch",
    );
    await hydratedDrawer.getByRole("button", { name: "Apply choices" }).click();
    const reviewedBody = (await reviewed).postDataJSON() as {
      command: { decisions: Array<{ occurrenceId: string }> };
    };
    expect(reviewedBody.command.decisions.map((decision) => decision.occurrenceId)).toEqual([replayedIngredient!.id]);
    await expect(hydratedDrawer.getByText("Reviewing 1 occurrence.")).toHaveCount(0);

    const currentWorkspace = await readWorkspace(page);
    await hydratedDrawer.getByLabel("Venue").fill("Journal replay continuation");
    const continuation = await captureAcceptedReplay(page, "**/api/commands", async () => {
      await hydratedDrawer.getByRole("button", { name: "Save recipe details" }).click();
    });
    expect(bodyJson(continuation).basePlannerVersion).toBe(currentWorkspace.plannerVersion);
  });

  test("cross-site renderer replacement preserves a needs-source coverage change for exact replay", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    const ingredient = "Boneless chicken thighs";
    const initialWorkspace = await readWorkspace(page);
    const initialItemId = groceryIdForIngredient(initialWorkspace, ingredient);
    expect(groceryIngredient(initialWorkspace, initialItemId)).toEqual({
      ingredient: ingredient.toLocaleLowerCase("en-CA"), coverage: "needs_source", checked: false,
    });
    await page.getByRole("radio", { name: "All", exact: true }).click();
    const loss = await armCommittedResponseLoss(
      page,
      "**/api/commands",
      (body) => {
        const command = body.command as Record<string, unknown> | undefined;
        return command?.type === "setGroceryItemsCoverage" &&
          command?.coverage === "farm_box" &&
          Array.isArray(command.itemIds) && command.itemIds.length === 1;
      },
    );
    const groceryRow = page.locator(".grocery-row").filter({ hasText: ingredient });
    await groceryRow.locator(".grocery-item-copy").click({ position: { x: 1, y: 1 } });
    await page.getByLabel("Set selected grocery coverage", { exact: true }).selectOption("farm_box");
    await page.getByRole("button", { name: "Set coverage", exact: true }).click();
    const operation = await waitForAmbiguity(page, loss, "planner");
    expect(operation.submittedDraft).toMatchObject({
      type: "setGroceryItemsCoverage",
      coverage: "farm_box",
      itemIds: [expect.any(String)],
    });
    await stopResponseLoss(page, loss);

    await page.goto("data:text/html,<title>Renderer replacement</title>");
    await expect(page).toHaveTitle("Renderer replacement");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const retry = mainRetry(page, "Set grocery coverage");
    await expect(retry).toBeVisible();
    const replayBody = await captureAcceptedReplay(page, "**/api/commands", async () => {
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(replayBody).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    const replayedCommand = bodyJson(operation.serializedBody).command as Record<string, unknown>;
    const movedItemId = (replayedCommand.itemIds as unknown[])[0];
    expect(typeof movedItemId).toBe("string");
    expect(groceryIngredient(workspace, movedItemId as string)).toEqual({
      ingredient: ingredient.toLocaleLowerCase("en-CA"),
      coverage: "farm_box",
      checked: false,
    });
    expect(workspace.events.filter((event) => {
      const itemIds = event.command.itemIds;
      return event.command.type === "setGroceryItemsCoverage" &&
        event.command.coverage === "farm_box" &&
        Array.isArray(itemIds) && itemIds.includes(movedItemId);
    })).toHaveLength(1);
  });

  test("undo hydrates its exact request and reverses the latest event only once", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    await page.getByRole("radio", { name: "All", exact: true }).click();
    const chicken = page.getByRole("checkbox", { name: "Check Boneless chicken thighs" });
    await chicken.click();
    await expect(chicken).toBeChecked();
    const beforeUndo = await readWorkspace(page);
    const checkedChickenId = groceryIdForIngredient(beforeUndo, "Boneless chicken thighs");
    expect(groceryIngredient(beforeUndo, checkedChickenId)?.checked).toBe(true);
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
    const chickenId = groceryIdForIngredient(workspace, "Boneless chicken thighs");
    expect(groceryIngredient(workspace, chickenId)?.checked).toBe(false);
    expect(workspace.events.filter((event) =>
      event.command.type === "undoLatest" && event.revertsEventId === targetEvent!.eventId,
    )).toHaveLength(1);
  });

  test("a copied auxiliary tab can replay the same envelope without a second effect", async ({ page }) => {
    test.setTimeout(120_000);
    await initializePlanner(page);
    await page.locator(".view-nav").getByRole("button", { name: "Groceries", exact: true }).click();
    const ingredient = "Boneless chicken thighs";
    const initialWorkspace = await readWorkspace(page);
    const initialItemId = groceryIdForIngredient(initialWorkspace, ingredient);
    expect(groceryIngredient(initialWorkspace, initialItemId)).toEqual({
      ingredient: ingredient.toLocaleLowerCase("en-CA"), coverage: "needs_source", checked: false,
    });
    await page.getByRole("radio", { name: "All", exact: true }).click();
    const loss = await armCommittedResponseLoss(
      page,
      "**/api/commands",
      (body) => {
        const command = body.command as Record<string, unknown> | undefined;
        return command?.type === "setGroceryItemsCoverage" &&
          command?.coverage === "farm_box" &&
          Array.isArray(command.itemIds) && command.itemIds.length === 1;
      },
    );
    const groceryRow = page.locator(".grocery-row").filter({ hasText: ingredient });
    await groceryRow.locator(".grocery-item-copy").click({ position: { x: 1, y: 1 } });
    await page.getByLabel("Set selected grocery coverage", { exact: true }).selectOption("farm_box");
    await page.getByRole("button", { name: "Set coverage", exact: true }).click();
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
        const retry = mainRetry(auxiliary, "Set grocery coverage");
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
      const retry = mainRetry(page, "Set grocery coverage");
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
    });
    expect(primaryReplay).toBe(operation.serializedBody);
    expect(await readJournal(page)).toBeNull();

    const workspace = await readWorkspace(page);
    const replayedCommand = bodyJson(operation.serializedBody).command as Record<string, unknown>;
    const movedItemId = (replayedCommand.itemIds as unknown[])[0];
    expect(typeof movedItemId).toBe("string");
    expect(groceryIngredient(workspace, movedItemId as string)).toEqual({
      ingredient: ingredient.toLocaleLowerCase("en-CA"),
      coverage: "farm_box",
      checked: false,
    });
    expect(workspace.events.filter((event) => {
      const itemIds = event.command.itemIds;
      return event.command.type === "setGroceryItemsCoverage" &&
        event.command.coverage === "farm_box" &&
        Array.isArray(itemIds) && itemIds.includes(movedItemId);
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
          requestId: `capacity-planner-${index}`,
          basePlannerVersion: 0,
          command: {
            type: "setGroceryItemChecked",
            weekId: "2026-07-06",
            itemId: `grocery-capacity-${index}`,
            checked: true,
          },
        };
        return {
          schemaVersion: 1,
          kind: "planner",
          path: "/api/commands",
          requestId: body.requestId,
          serializedBody: JSON.stringify(body),
          state: "resolved_conflict",
          createdAt: index + 1,
          label: `Capacity planner ${index}`,
          submittedDraft: body,
          editableDraft: body,
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
    await expect(page.getByRole("status")).toContainText(
      /Resolve .* before starting another shared change\./,
    );
    await expect.poll(() => bootstrapRequests).toBe(0);
    const journal = await readJournal(page);
    expect(journal?.operations).toHaveLength(16);
    expect(journal?.operations.map((operation) => operation.requestId)).toEqual(
      Array.from({ length: 16 }, (_, index) => `capacity-planner-${index}`),
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
    await page.getByRole("radio", { name: "All", exact: true }).click();
    const chicken = page.getByRole("checkbox", { name: "Check Boneless chicken thighs" });
    await chicken.click();
    await expect(chicken).toBeChecked();
    const workspace = await readWorkspace(page);
    const chickenId = groceryIdForIngredient(workspace, "Boneless chicken thighs");
    expect(groceryIngredient(workspace, chickenId)?.checked).toBe(true);
  });
});

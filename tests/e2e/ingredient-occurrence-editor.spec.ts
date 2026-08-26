import { expect, test } from "@playwright/test";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";

async function resetPlanner(page: import("@playwright/test").Page): Promise<void> {
  const reset = await page.request.post(`${controlOrigin}/reset`);
  expect(reset.ok()).toBe(true);
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const planner = page.getByText("Family dinner planner");
  await expect(setup.or(planner)).toBeVisible();
  if (await setup.isVisible()) await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
}

test("Duplicate keeps the source occurrence and creates a distinct copied occurrence", async ({ page }) => {
  await resetPlanner(page);
  const before = await (await page.request.get("/api/workspace")).json() as {
    state: {
      activeWeekId: string;
      weeks: Array<{ id: string; data: { meals: Array<{
        id: string;
        ingredients: Array<{ id: string; source: string | null; amount: string; unit: string | null; ingredient: string; qualifier: string | null }>;
      }> } }>;
    };
  };
  const meal = before.state.weeks.find(({ id }) => id === before.state.activeWeekId)!.data.meals[0]!;
  const source = meal.ingredients[0]!;

  await page.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
  const drawer = page.locator(".meal-drawer");
  await drawer.getByRole("button", { name: "Duplicate ingredient 1 as a new occurrence" }).click();
  await expect(drawer.locator(".occurrence-editor-row")).toHaveCount(meal.ingredients.length + 1);

  const request = page.waitForRequest((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.method() !== "POST") return false;
    return (candidate.postDataJSON() as { command?: { type?: string } }).command?.type === "editMealRecipe";
  });
  const response = page.waitForResponse((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.request().method() !== "POST") return false;
    return (candidate.request().postDataJSON() as { command?: { type?: string } }).command?.type === "editMealRecipe";
  });
  await drawer.getByRole("button", { name: "Save recipe details" }).click();
  const body = (await request).postDataJSON() as {
    command: { occurrences: Array<Record<string, unknown>> };
  };
  expect(body.command.occurrences[0]).toMatchObject({ kind: "retain", occurrenceId: source.id });
  expect(body.command.occurrences[1]).toMatchObject({
    kind: "create",
    source: source.source,
    amount: source.amount,
    unit: source.unit,
    ingredient: source.ingredient,
    qualifier: source.qualifier,
  });
  const correlationId = body.command.occurrences[1]!.correlationId;
  expect(correlationId).toEqual(expect.any(String));
  const accepted = await response;
  expect(accepted.status()).toBe(200);
  const decision = await accepted.json() as {
    decision: { occurrenceResults: Array<{ occurrences: Array<{ correlationId: string; occurrenceId: string }> }> };
  };
  const copiedId = decision.decision.occurrenceResults
    .flatMap(({ occurrences }) => occurrences)
    .find((result) => result.correlationId === correlationId)?.occurrenceId;
  expect(copiedId).toEqual(expect.any(String));
  expect(copiedId).not.toBe(source.id);

  const after = await (await page.request.get("/api/workspace")).json() as typeof before;
  const saved = after.state.weeks.find(({ id }) => id === before.state.activeWeekId)!.data.meals
    .find(({ id }) => id === meal.id)!;
  expect(saved.ingredients.slice(0, 2).map(({ id }) => id)).toEqual([source.id, copiedId]);
  expect(saved.ingredients[1]).toMatchObject({
    source: source.source,
    amount: source.amount,
    unit: source.unit,
    ingredient: source.ingredient,
    qualifier: source.qualifier,
  });
});

test("Split keeps the labeled row's identity while both resulting literals can diverge", async ({ page }) => {
  await resetPlanner(page);
  const before = await (await page.request.get("/api/workspace")).json() as {
    state: {
      activeWeekId: string;
      weeks: Array<{ id: string; data: { meals: Array<{ id: string; ingredients: Array<{ id: string; ingredient: string }> }> } }>;
    };
  };
  const meal = before.state.weeks.find(({ id }) => id === before.state.activeWeekId)!.data.meals[0]!;
  const sourceId = meal.ingredients[0]!.id;

  await page.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
  const drawer = page.locator(".meal-drawer");
  await drawer.getByRole("button", { name: "Split ingredient 1; this row keeps its identity" }).click();
  await drawer.getByLabel("Ingredient 1 core").fill("split survivor literal");
  await drawer.getByLabel("Ingredient 2 core").fill("split created literal");

  const request = page.waitForRequest((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.method() !== "POST") return false;
    return (candidate.postDataJSON() as { command?: { type?: string } }).command?.type === "editMealRecipe";
  });
  const response = page.waitForResponse((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.request().method() !== "POST") return false;
    return (candidate.request().postDataJSON() as { command?: { type?: string } }).command?.type === "editMealRecipe";
  });
  await drawer.getByRole("button", { name: "Save recipe details" }).click();
  const body = (await request).postDataJSON() as {
    command: { occurrences: Array<Record<string, unknown>> };
  };
  expect(body.command.occurrences[0]).toMatchObject({
    kind: "retain",
    occurrenceId: sourceId,
    ingredient: "split survivor literal",
  });
  expect(body.command.occurrences[1]).toMatchObject({
    kind: "create",
    ingredient: "split created literal",
  });
  const correlationId = body.command.occurrences[1]!.correlationId;
  const accepted = await response;
  expect(accepted.status()).toBe(200);
  const decision = await accepted.json() as {
    decision: { occurrenceResults: Array<{ occurrences: Array<{ correlationId: string; occurrenceId: string }> }> };
  };
  const splitId = decision.decision.occurrenceResults
    .flatMap(({ occurrences }) => occurrences)
    .find((result) => result.correlationId === correlationId)?.occurrenceId;
  expect(splitId).toEqual(expect.any(String));
  expect(splitId).not.toBe(sourceId);

  const after = await (await page.request.get("/api/workspace")).json() as typeof before;
  const saved = after.state.weeks.find(({ id }) => id === before.state.activeWeekId)!.data.meals
    .find(({ id }) => id === meal.id)!;
  expect(saved.ingredients.slice(0, 2).map(({ id, ingredient }) => ({ id, ingredient }))).toEqual([
    { id: sourceId, ingredient: "split survivor literal" },
    { id: splitId, ingredient: "split created literal" },
  ]);
});

test("Split identity follows the survivor when the created result moves before it", async ({ page }) => {
  await resetPlanner(page);
  const before = await (await page.request.get("/api/workspace")).json() as {
    state: {
      activeWeekId: string;
      weeks: Array<{ id: string; data: { meals: Array<{ id: string; ingredients: Array<{ id: string }> }> } }>;
    };
  };
  const meal = before.state.weeks.find(({ id }) => id === before.state.activeWeekId)!.data.meals[0]!;
  const sourceId = meal.ingredients[0]!.id;

  await page.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
  const drawer = page.locator(".meal-drawer");
  await drawer.getByRole("button", { name: "Split ingredient 1; this row keeps its identity" }).click();
  await drawer.getByRole("button", { name: "Move ingredient 2 up" }).click();
  await drawer.getByLabel("Ingredient 1 core").fill("created result first");
  await drawer.getByLabel("Ingredient 2 core").fill("survivor result second");

  const request = page.waitForRequest((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.method() !== "POST") return false;
    return (candidate.postDataJSON() as { command?: { type?: string } }).command?.type === "editMealRecipe";
  });
  const response = page.waitForResponse((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.request().method() !== "POST") return false;
    return (candidate.request().postDataJSON() as { command?: { type?: string } }).command?.type === "editMealRecipe";
  });
  await drawer.getByRole("button", { name: "Save recipe details" }).click();
  const body = (await request).postDataJSON() as {
    command: { occurrences: Array<Record<string, unknown>> };
  };
  expect(body.command.occurrences[0]).toMatchObject({ kind: "create", ingredient: "created result first" });
  expect(body.command.occurrences[1]).toMatchObject({
    kind: "retain",
    occurrenceId: sourceId,
    ingredient: "survivor result second",
  });
  const correlationId = body.command.occurrences[0]!.correlationId;
  const accepted = await response;
  expect(accepted.status()).toBe(200);
  const decision = await accepted.json() as {
    decision: { occurrenceResults: Array<{ occurrences: Array<{ correlationId: string; occurrenceId: string }> }> };
  };
  const splitId = decision.decision.occurrenceResults
    .flatMap(({ occurrences }) => occurrences)
    .find((result) => result.correlationId === correlationId)?.occurrenceId;
  expect(splitId).toEqual(expect.any(String));
  expect(splitId).not.toBe(sourceId);

  const after = await (await page.request.get("/api/workspace")).json() as {
    state: {
      weeks: Array<{ id: string; data: { meals: Array<{
        id: string;
        ingredients: Array<{ id: string; ingredient: string }>;
      }> } }>;
    };
  };
  const saved = after.state.weeks.find(({ id }) => id === before.state.activeWeekId)!.data.meals
    .find(({ id }) => id === meal.id)!;
  expect(saved.ingredients.slice(0, 2).map(({ id, ingredient }) => ({ id, ingredient }))).toEqual([
    { id: splitId, ingredient: "created result first" },
    { id: sourceId, ingredient: "survivor result second" },
  ]);
});

test("recipe editor sends retained IDs, creation correlations, and explicit removal intent", async ({ page }) => {
  await resetPlanner(page);
  const workspaceResponse = await page.request.get("/api/workspace");
  expect(workspaceResponse.ok()).toBe(true);
  const workspace = await workspaceResponse.json() as {
    plannerVersion: number;
    state: {
      activeWeekId: string;
      weeks: Array<{
        id: string;
        data: { meals: Array<{
          id: string;
          ingredients: Array<{ id: string; ingredient: string }>;
          instructions: Array<{ id: string; inputs: Array<{ occurrenceId: string; amount: string; ingredient: string }>; timerDurationSeconds?: number }>;
        }> };
      }>;
    };
  };
  const activeWeek = workspace.state.weeks.find((week) => week.id === workspace.state.activeWeekId);
  const originalMeal = activeWeek?.data.meals[0];
  const originalOccurrences = originalMeal?.ingredients ?? [];
  const originalIds = originalOccurrences.map(({ id }) => id);
  expect(originalIds.length).toBeGreaterThan(2);
  await page.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
  const drawer = page.locator(".meal-drawer");
  await expect(drawer.getByText("Ingredients", { exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: "Move ingredient 1 down" }).click();
  await drawer.getByLabel("Ingredient 2 core").fill("red onions");
  await drawer.getByRole("button", { name: `Remove ingredient ${originalIds.length} and linked instruction inputs` }).click();
  await drawer.getByRole("button", { name: "Add ingredient" }).click();
  await drawer.getByLabel(/Ingredient \d+ core/).last().fill("red onions");

  const request = page.waitForRequest((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.method() !== "POST") return false;
    const body = candidate.postDataJSON() as { command?: { type?: string } };
    return body.command?.type === "editMealRecipe";
  });
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/commands") && candidate.request().method() === "POST",
  );
  await drawer.getByRole("button", { name: "Save recipe details" }).click();
  const body = (await request).postDataJSON() as {
    command: { occurrences: Array<Record<string, unknown>>; removedOccurrenceIds: string[] };
  };
  expect(body.command.occurrences[0]).toMatchObject({ kind: "retain", occurrenceId: originalIds[1] });
  expect(body.command.occurrences[1]).toMatchObject({ kind: "retain", occurrenceId: originalIds[0], ingredient: "red onions" });
  expect(body.command.occurrences.at(-1)).toMatchObject({ kind: "create", ingredient: "red onions" });
  expect(body.command.removedOccurrenceIds).toEqual([originalIds.at(-1)]);

  const acceptedResponse = await response;
  expect(acceptedResponse.status()).toBe(200);
  const accepted = await acceptedResponse.json() as {
    decision: {
      status: string;
      plannerVersion: number;
      occurrenceResults: Array<{ occurrences: Array<{ correlationId: string; occurrenceId: string }> }>;
    };
  };
  expect(accepted.decision.status).toBe("accepted");
  expect(accepted.decision.plannerVersion).toBeGreaterThan(workspace.plannerVersion);
  const createdOccurrenceId = accepted.decision.occurrenceResults
    .flatMap((result) => result.occurrences)
    .find(({ correlationId }) => correlationId === body.command.occurrences.at(-1)?.correlationId)
    ?.occurrenceId;
  expect(createdOccurrenceId).toBeTruthy();

  const firstStep = drawer.locator(".instruction-step").first();
  await firstStep.getByText("Edit instruction", { exact: true }).click();
  const firstInputOccurrenceId = originalMeal?.instructions[0]?.inputs[0]?.occurrenceId;
  expect(firstInputOccurrenceId).toBeTruthy();
  await firstStep.locator(".instruction-input-row").first().getByRole("textbox").first().fill("9");
  await firstStep.getByRole("button", { name: "Add amount" }).click();
  const addedInput = firstStep.locator(".instruction-input-row").last();
  await addedInput.getByRole("textbox").first().fill("1");
  await addedInput.getByRole("textbox").last().fill("red onions");
  await firstStep.getByLabel(/Timer minutes for/u).fill("2.5");
  const instructionRequest = page.waitForRequest((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.method() !== "POST") return false;
    const candidateBody = candidate.postDataJSON() as { command?: { type?: string } };
    return candidateBody.command?.type === "editInstructionStep";
  });
  const instructionResponse = page.waitForResponse((candidate) => {
    if (!candidate.url().endsWith("/api/commands") || candidate.request().method() !== "POST") return false;
    const candidateBody = candidate.request().postDataJSON() as { command?: { type?: string } };
    return candidateBody.command?.type === "editInstructionStep";
  });
  await firstStep.getByRole("button", { name: /Save step/u }).click();
  const instructionBody = (await instructionRequest).postDataJSON() as {
    command: { changes: { inputs: Array<Record<string, unknown>>; timerDurationSeconds: number } };
  };
  expect(instructionBody.command.changes.inputs[0]).toMatchObject({
    kind: "retain",
    occurrenceId: firstInputOccurrenceId,
    amount: "9",
  });
  expect(instructionBody.command.changes.inputs.at(-1)).toMatchObject({
    kind: "create",
    amount: "1",
    ingredient: "red onions",
  });
  expect(instructionBody.command.changes.timerDurationSeconds).toBe(150);
  const instructionAccepted = await instructionResponse;
  expect(instructionAccepted.status()).toBe(200);
  const instructionDecision = await instructionAccepted.json() as {
    decision: { occurrenceResults: Array<{ occurrences: Array<{ correlationId: string; occurrenceId: string }> }> };
  };
  const instructionCreatedOccurrenceId = instructionDecision.decision.occurrenceResults
    .flatMap((result) => result.occurrences)
    .find(({ correlationId }) => correlationId === instructionBody.command.changes.inputs.at(-1)?.correlationId)
    ?.occurrenceId;
  expect(instructionCreatedOccurrenceId).toBeTruthy();

  const savedWorkspaceResponse = await page.request.get("/api/workspace");
  expect(savedWorkspaceResponse.ok()).toBe(true);
  const savedWorkspace = await savedWorkspaceResponse.json() as typeof workspace;
  const savedMeal = savedWorkspace.state.weeks
    .find((week) => week.id === savedWorkspace.state.activeWeekId)
    ?.data.meals.find((meal) => meal.id === originalMeal?.id);
  expect(savedMeal?.ingredients.map(({ id }) => id)).toEqual([
    originalIds[1],
    originalIds[0],
    ...originalIds.slice(2, -1),
    createdOccurrenceId,
    instructionCreatedOccurrenceId,
  ]);
  expect(savedMeal?.ingredients.find(({ id }) => id === originalIds[0])?.ingredient).toBe("red onions");
  expect(savedMeal?.ingredients.filter(({ ingredient }) => ingredient === "red onions").map(({ id }) => id)).toEqual([
    originalIds[0],
    createdOccurrenceId,
    instructionCreatedOccurrenceId,
  ]);
  expect(savedMeal?.ingredients.some(({ id }) => id === originalIds.at(-1))).toBe(false);
  expect(savedMeal?.instructions.flatMap(({ inputs }) => inputs).some(({ occurrenceId }) => occurrenceId === originalIds.at(-1))).toBe(false);
  expect(savedMeal?.instructions[0]?.inputs[0]).toMatchObject({ occurrenceId: firstInputOccurrenceId, amount: "9" });
  expect(savedMeal?.instructions[0]?.inputs.at(-1)).toMatchObject({ occurrenceId: instructionCreatedOccurrenceId, amount: "1", ingredient: "red onions" });
  expect(savedMeal?.instructions[0]?.timerDurationSeconds).toBe(150);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  const reloadedWorkspaceResponse = await page.request.get("/api/workspace");
  expect(reloadedWorkspaceResponse.ok()).toBe(true);
  const reloadedWorkspace = await reloadedWorkspaceResponse.json() as typeof workspace;
  const reloadedMeal = reloadedWorkspace.state.weeks
    .find((week) => week.id === reloadedWorkspace.state.activeWeekId)
    ?.data.meals.find((meal) => meal.id === originalMeal?.id);
  expect(reloadedMeal?.ingredients).toEqual(savedMeal?.ingredients);

  await page.getByTitle("Change history").click();
  const history = page.getByRole("dialog", { name: "Recent changes" });
  const undoInstructionResponse = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/undo") && candidate.request().method() === "POST",
  );
  await history.getByRole("button", { name: "Undo latest change" }).click();
  expect((await undoInstructionResponse).status()).toBe(200);

  const undoneWorkspaceResponse = await page.request.get("/api/workspace");
  expect(undoneWorkspaceResponse.ok()).toBe(true);
  const undoneWorkspace = await undoneWorkspaceResponse.json() as typeof workspace;
  const undoneMeal = undoneWorkspace.state.weeks
    .find((week) => week.id === undoneWorkspace.state.activeWeekId)
    ?.data.meals.find((meal) => meal.id === originalMeal?.id);
  expect(undoneMeal?.ingredients.map(({ id }) => id)).toEqual([
    originalIds[1],
    originalIds[0],
    ...originalIds.slice(2, -1),
    createdOccurrenceId,
  ]);
  expect(undoneMeal?.instructions[0]?.inputs[0]).toEqual(originalMeal?.instructions[0]?.inputs[0]);
  expect(undoneMeal?.instructions.flatMap(({ inputs }) => inputs).some(({ occurrenceId }) => occurrenceId === instructionCreatedOccurrenceId)).toBe(false);
});

test("known two-client conflicts recompose into an editable occurrence draft without retry mode", async ({ browser, page }) => {
  await resetPlanner(page);
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();

  const before = await (await page.request.get("/api/workspace")).json() as {
    state: { activeWeekId: string; weeks: Array<{ id: string; data: { meals: Array<{ id: string; ingredients: Array<{ id: string; ingredient: string }> }> } }> };
  };
  const meal = before.state.weeks.find(({ id }) => id === before.state.activeWeekId)?.data.meals[0];
  expect(meal?.ingredients.length).toBeGreaterThan(1);
  const originalIds = meal!.ingredients.map(({ id }) => id);

  for (const candidate of [page, peer]) {
    await candidate.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
  }
  const localDrawer = page.locator(".meal-drawer");
  const remoteDrawer = peer.locator(".meal-drawer");
  await localDrawer.getByRole("button", { name: "Move ingredient 1 down" }).click();
  await remoteDrawer.getByLabel("Ingredient 2 core").fill("remote renamed ingredient");
  const remoteAccepted = peer.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST",
  );
  await remoteDrawer.getByRole("button", { name: "Save recipe details" }).click();
  expect((await remoteAccepted).status()).toBe(200);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(localDrawer.getByLabel("Ingredient 1 core")).toHaveValue("remote renamed ingredient");
  await localDrawer.getByRole("button", { name: "Save recipe details" }).click();
  await expect(localDrawer.getByText(/Someone else changed the plan/u)).toBeVisible();
  await expect(localDrawer.getByRole("button", { name: "Retry action" })).toHaveCount(0);
  await expect(localDrawer.getByLabel("Ingredient 1 core")).toBeEditable();

  await localDrawer.getByRole("textbox", { name: "Title", exact: true }).fill("Conflict-safe occurrence dinner");
  const localAccepted = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST",
  );
  await localDrawer.getByRole("button", { name: "Save recipe details" }).click();
  expect((await localAccepted).status()).toBe(200);

  const after = await (await page.request.get("/api/workspace")).json() as typeof before;
  const saved = after.state.weeks.find(({ id }) => id === after.state.activeWeekId)?.data.meals
    .find(({ id }) => id === meal?.id);
  expect(saved?.ingredients.map(({ id }) => id)).toEqual([originalIds[1], originalIds[0], ...originalIds.slice(2)]);
  expect(saved?.ingredients[0].ingredient).toBe("remote renamed ingredient");
  await peerContext.close();
});

test("two-client conflict preserves separate edits to repeated uses of one occurrence", async ({ browser, page }) => {
  await resetPlanner(page);
  const before = await (await page.request.get("/api/workspace")).json() as {
    plannerVersion: number;
    state: {
      activeWeekId: string;
      weeks: Array<{ id: string; data: { meals: Array<{
        id: string;
        instructions: Array<{
          id: string;
          inputs: Array<{ occurrenceId: string; amount: string; ingredient: string }>;
          instruction: string;
          timerDurationSeconds?: number;
        }>;
      }> } }>;
    };
  };
  const week = before.state.weeks.find(({ id }) => id === before.state.activeWeekId)!;
  const step = week.data.meals[0]!.instructions[0]!;
  const sourceInput = step.inputs[0]!;
  const seeded = await page.request.post("/api/commands", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      requestId: crypto.randomUUID(),
      basePlannerVersion: before.plannerVersion,
      command: {
        type: "editInstructionStep",
        weekId: week.id,
        stepId: step.id,
        changes: {
          inputs: [
            { kind: "retain", occurrenceId: sourceInput.occurrenceId, amount: "1", ingredient: sourceInput.ingredient },
            { kind: "retain", occurrenceId: sourceInput.occurrenceId, amount: "2", ingredient: sourceInput.ingredient },
          ],
          instruction: step.instruction,
          timerDurationSeconds: step.timerDurationSeconds ?? null,
        },
      },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();

  for (const candidate of [page, peer]) {
    await candidate.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
    await candidate.locator(".meal-drawer").getByLabel(/^Edit step 1 /u).click();
  }
  const localStep = page.locator(".meal-drawer").getByRole("article", { name: /^step 1 for /u });
  const remoteStep = peer.locator(".meal-drawer").getByRole("article", { name: /^step 1 for /u });
  const remoteAmounts = remoteStep.locator(".instruction-input-row input[aria-label^='Amount']");
  await expect(localStep.locator(".instruction-input-row")).toHaveCount(2);
  await localStep.locator(".instruction-input-row").nth(0).getByRole("textbox").first().fill("2");
  await remoteAmounts.nth(1).fill("3");
  const remoteAccepted = peer.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST",
  );
  await remoteStep.getByRole("button", { name: /Save step/u }).click();
  expect((await remoteAccepted).status()).toBe(200);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(localStep.locator(".instruction-input-row").nth(0).getByRole("textbox").first()).toHaveValue("2");
  await expect(localStep.locator(".instruction-input-row").nth(1).getByRole("textbox").first()).toHaveValue("3");
  const localConflict = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST",
  );
  await localStep.getByRole("button", { name: /Save step/u }).click();
  expect((await localConflict).status()).toBe(409);
  await expect(page.locator(".meal-drawer").getByText(/Someone else changed the plan/u)).toBeVisible();
  await expect(localStep.locator(".instruction-input-row").nth(0).getByRole("textbox").first()).toHaveValue("2");
  await expect(localStep.locator(".instruction-input-row").nth(1).getByRole("textbox").first()).toHaveValue("3");

  const localAccepted = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST",
  );
  await localStep.getByRole("button", { name: /Save step/u }).click();
  expect((await localAccepted).status()).toBe(200);
  const after = await (await page.request.get("/api/workspace")).json() as typeof before;
  const savedStep = after.state.weeks.find(({ id }) => id === before.state.activeWeekId)?.data.meals[0]?.instructions[0];
  expect(savedStep?.inputs).toEqual([
    { occurrenceId: sourceInput.occurrenceId, amount: "2", ingredient: sourceInput.ingredient },
    { occurrenceId: sourceInput.occurrenceId, amount: "3", ingredient: sourceInput.ingredient },
  ]);
  await peerContext.close();
});

test("two-client conflict preserves a local edit when identical repeated uses make peer deletion ambiguous", async ({ browser, page }) => {
  await resetPlanner(page);
  const before = await (await page.request.get("/api/workspace")).json() as {
    plannerVersion: number;
    state: {
      activeWeekId: string;
      weeks: Array<{ id: string; data: { meals: Array<{
        id: string;
        instructions: Array<{
          id: string;
          inputs: Array<{ occurrenceId: string; amount: string; ingredient: string }>;
          instruction: string;
          timerDurationSeconds?: number;
        }>;
      }> } }>;
    };
  };
  const week = before.state.weeks.find(({ id }) => id === before.state.activeWeekId)!;
  const step = week.data.meals[0]!.instructions[0]!;
  const sourceInput = step.inputs[0]!;
  const seeded = await page.request.post("/api/commands", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      requestId: crypto.randomUUID(),
      basePlannerVersion: before.plannerVersion,
      command: {
        type: "editInstructionStep",
        weekId: week.id,
        stepId: step.id,
        changes: {
          inputs: [
            { kind: "retain", occurrenceId: sourceInput.occurrenceId, amount: "1", ingredient: sourceInput.ingredient },
            { kind: "retain", occurrenceId: sourceInput.occurrenceId, amount: "1", ingredient: sourceInput.ingredient },
          ],
          instruction: step.instruction,
          timerDurationSeconds: step.timerDurationSeconds ?? null,
        },
      },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  for (const candidate of [page, peer]) {
    await candidate.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
    await candidate.locator(".meal-drawer").getByLabel(/^Edit step 1 /u).click();
  }
  const localStep = page.locator(".meal-drawer").getByRole("article", { name: /^step 1 for /u });
  const remoteStep = peer.locator(".meal-drawer").getByRole("article", { name: /^step 1 for /u });
  await localStep.locator(".instruction-input-row").nth(1).getByRole("textbox").first().fill("5");
  await remoteStep.getByRole("button", { name: "Remove ingredient input 1" }).click();
  const remoteAccepted = peer.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST");
  await remoteStep.getByRole("button", { name: /Save step/u }).click();
  expect((await remoteAccepted).status()).toBe(200);

  const localConflict = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST");
  await localStep.getByRole("button", { name: /Save step/u }).click();
  expect((await localConflict).status()).toBe(409);
  await expect(page.locator(".meal-drawer").getByText(/Someone else changed the plan/u)).toBeVisible();
  await expect(localStep.locator(".instruction-input-row")).toHaveCount(2);
  await expect(localStep.locator(".instruction-input-row").nth(0).getByRole("textbox").first()).toHaveValue("1");
  await expect(localStep.locator(".instruction-input-row").nth(1).getByRole("textbox").first()).toHaveValue("5");

  const localAccepted = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST");
  await localStep.getByRole("button", { name: /Save step/u }).click();
  expect((await localAccepted).status()).toBe(200);
  const after = await (await page.request.get("/api/workspace")).json() as typeof before;
  const savedStep = after.state.weeks.find(({ id }) => id === before.state.activeWeekId)?.data.meals[0]?.instructions[0];
  expect(savedStep?.inputs).toEqual([
    { occurrenceId: sourceInput.occurrenceId, amount: "1", ingredient: sourceInput.ingredient },
    { occurrenceId: sourceInput.occurrenceId, amount: "5", ingredient: sourceInput.ingredient },
  ]);
  await peerContext.close();
});

test("two-client conflict preserves edited peer multiplicity beside an ambiguous local edit", async ({ browser, page }) => {
  await resetPlanner(page);
  const before = await (await page.request.get("/api/workspace")).json() as {
    plannerVersion: number;
    state: {
      activeWeekId: string;
      weeks: Array<{ id: string; data: { meals: Array<{
        instructions: Array<{
          id: string;
          inputs: Array<{ occurrenceId: string; amount: string; ingredient: string }>;
          instruction: string;
          timerDurationSeconds?: number;
        }>;
      }> } }>;
    };
  };
  const week = before.state.weeks.find(({ id }) => id === before.state.activeWeekId)!;
  const step = week.data.meals[0]!.instructions[0]!;
  const sourceInput = step.inputs[0]!;
  const retainedInput = (amount: string) => ({
    kind: "retain" as const,
    occurrenceId: sourceInput.occurrenceId,
    amount,
    ingredient: sourceInput.ingredient,
  });
  const seeded = await page.request.post("/api/commands", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      requestId: crypto.randomUUID(),
      basePlannerVersion: before.plannerVersion,
      command: {
        type: "editInstructionStep",
        weekId: week.id,
        stepId: step.id,
        changes: {
          inputs: [retainedInput("1"), retainedInput("1"), retainedInput("1")],
          instruction: step.instruction,
          timerDurationSeconds: step.timerDurationSeconds ?? null,
        },
      },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  for (const candidate of [page, peer]) {
    await candidate.getByRole("button", { name: /^Open .* recipe$/u }).first().click();
    await candidate.locator(".meal-drawer").getByLabel(/^Edit step 1 /u).click();
  }
  const localStep = page.locator(".meal-drawer").getByRole("article", { name: /^step 1 for /u });
  const remoteStep = peer.locator(".meal-drawer").getByRole("article", { name: /^step 1 for /u });
  await localStep.locator(".instruction-input-row").nth(2).getByRole("textbox").first().fill("5");
  await remoteStep.getByRole("button", { name: "Remove ingredient input 1" }).click();
  for (const row of await remoteStep.locator(".instruction-input-row").all()) {
    await row.getByRole("textbox").first().fill("2");
  }
  const remoteAccepted = peer.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST");
  await remoteStep.getByRole("button", { name: /Save step/u }).click();
  expect((await remoteAccepted).status()).toBe(200);

  const localConflict = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST");
  await localStep.getByRole("button", { name: /Save step/u }).click();
  expect((await localConflict).status()).toBe(409);
  await expect(localStep.locator(".instruction-input-row")).toHaveCount(3);
  await expect(localStep.locator(".instruction-input-row").nth(0).getByRole("textbox").first()).toHaveValue("2");
  await expect(localStep.locator(".instruction-input-row").nth(1).getByRole("textbox").first()).toHaveValue("2");
  await expect(localStep.locator(".instruction-input-row").nth(2).getByRole("textbox").first()).toHaveValue("5");

  const localAccepted = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands") && response.request().method() === "POST");
  await localStep.getByRole("button", { name: /Save step/u }).click();
  expect((await localAccepted).status()).toBe(200);
  const after = await (await page.request.get("/api/workspace")).json() as typeof before;
  const savedInputs = after.state.weeks.find(({ id }) => id === before.state.activeWeekId)?.data.meals[0]?.instructions[0]?.inputs;
  expect(savedInputs?.map(({ amount }) => amount)).toEqual(["2", "2", "5"]);
  await peerContext.close();
});

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { selectTestConcurrency } from "../scripts/run-node-tests.mjs";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://private-web-origin.invalid/", {
      headers: {
        accept: "text/html",
        "x-forwarded-host": "planner.example.test",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("fresh build renders configured public-origin metadata and the shared planner loading surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Weekly Recipe Planner<\/title>/i);
  assert.match(html, /Opening the shared planner/);
  assert.match(html, /Reading the latest household workspace/);
  const configuredBasePath = process.env.PLANNER_PUBLIC_BASE_PATH ?? "/";
  const publicPrefix = configuredBasePath === "/" ? "" : configuredBasePath.slice(0, -1);
  assert.ok(html.includes(`href="${publicPrefix}/favicon.svg"`));
  assert.ok(html.includes(`https://planner.example.test${publicPrefix}/og.png`));
  assert.doesNotMatch(html, /private-web-origin\.invalid|localhost:3001/);
  assert.doesNotMatch(
    html,
    /Harissa chicken traybake|Miso salmon rice bowls|codex-preview|Your site is taking shape|react-loading-skeleton/i,
  );
});

test("keeps the locked product requirements represented in source", async () => {
  const [planner, prepView, recipeContent, rail, sourceAdapter, api, styles, domain, contract, page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/planner-ui/prep-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/planner-ui/recipe-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/codex-thread-rail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/codex-thread-source.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/planner-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/household-domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/household-contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const plannerUi = `${planner}\n${prepView}`;

  for (const command of [
    "moveMeal",
    "swapMealDays",
    "editMealRecipe",
    "setInstructionStepComplete",
    "updateInstructionStepNote",
    "startInstructionTimer",
    "pauseInstructionTimer",
    "resetInstructionTimer",
    "setInstructionTimerRemaining",
    "addPrepStepsToDate",
    "combinePrepStepsOnDate",
    "updateCombinedPrepStep",
    "setCombinedPrepStepComplete",
    "expandCombinedPrepStep",
    "movePrepStepsToDate",
    "removePrepStepsFromDate",
    "clearPrepDate",
    "captureFeedback",
    "archiveWeek",
  ]) {
    assert.match(domain, new RegExp(command));
  }

  for (const view of ["Week", "Prep", "Groceries", "Close out"]) {
    assert.match(planner, new RegExp(`label: "${view}"`));
  }

  assert.match(planner, /localStorage\.setItem\(LAST_VALID_WEEK_STORAGE_KEY, resolved\.week\.id\)/);
  assert.doesNotMatch(planner, /localStorage\.setItem\((?!LAST_VALID_WEEK_STORAGE_KEY)|executeDomainCommand|CODEX_BRIDGE_URL/);
  assert.match(api, /PLANNER_API_ROUTES\.workspace\.path/);
  assert.match(api, /PLANNER_API_ROUTES\.commands\.path/);
  assert.doesNotMatch(api, /PLANNER_API_ROUTES\.chat(?:Submit|Retry)\.path/);
  assert.match(api, /If-None-Match/);
  assert.match(contract, /type InstructionStep/);
  assert.match(contract, /type RecipeIngredient/);
  assert.match(contract, /type IngredientUse/);
  assert.match(contract, /type PrepSession/);
  assert.match(planner, /findStep/);
  assert.match(planner, /CodexThreadRail/);
  assert.doesNotMatch(planner, /<ChatPanel/);
  assert.match(planner, /Add Prep note/);
  assert.match(planner, /Prep note/);
  assert.doesNotMatch(prepView, /Add comment/);
  assert.match(planner, /Ask Codex/);
  assert.match(planner, /RecipeInstructionContent/);
  assert.match(recipeContent, /export function RecipeInstructionContent/);
  assert.match(planner, /function RecipeSummaryLink/);
  assert.match(planner, /function MealEditorTrigger/);
  assert.match(plannerUi, /Add recipe steps to/);
  assert.match(plannerUi, /aria-label="Prep dates"/);
  assert.match(plannerUi, /Other dates/);
  assert.match(plannerUi, /Jump to prep date/);
  assert.doesNotMatch(plannerUi, /Batch prep planned days|Prep sessions/);
  assert.match(plannerUi, /role="tabpanel"/);
  assert.match(plannerUi, /onDragEnter/);
  assert.match(plannerUi, /receivePrepDrop/);
  assert.match(styles, /instruction-step-line/);
  assert.match(styles, /prep-session-tab/);
  assert.match(styles, /prep-session-drop-hint/);
  assert.match(styles, /prep-insertion-indicator/);
  assert.match(rail, /Task history/);
  assert.doesNotMatch(rail, /Blocked capability/);
  assert.match(rail, /Message Codex/);
  assert.doesNotMatch(rail, /Research recipe|ChatGPT task|microphone/i);
  assert.match(sourceAdapter, /isDevelopmentCodexPreview/);
  assert.match(sourceAdapter, /runtime_unavailable/);
  assert.match(planner, /Open \{meal\.sourceRecipe\.identity\}/);
  assert.match(planner, /target="_blank" rel="noopener noreferrer"/);
  assert.match(planner, /timerStartedAt/);
  assert.match(planner, /function Timer/);
  assert.match(planner, /className="week-select"/);
  assert.match(planner, /refetchInterval:\s*2_000/);
  assert.match(planner, /Offline . read-only/);
  assert.match(planner, /leftover\.state === "assigned"/);
  assert.match(planner, /Save recipe details/);
  assert.match(plannerUi, /<Dialog open=/);
  assert.match(plannerUi, /<DialogContent[^>]+aria-label=/);
  assert.doesNotMatch(planner, /weekPickerOpen|chat-visible/);
  assert.match(page, /<PlannerApp \/>/);
  assert.match(layout, /title: "Weekly Recipe Planner"/);
  assert.match(layout, /shared household planner/i);
  assert.match(layout, /images: \[imageUrl\]/);
  assert.match(layout, /requestHeaders\.get\("x-forwarded-host"\)/);
  assert.match(layout, /resolvePublicPath\("\/favicon\.svg", publicBasePath\)/);
  assert.match(layout, /resolvePublicPath\("\/og\.png", publicBasePath\)/);
  assert.doesNotMatch(layout, /next\/font|Geist|antialiased/);
  assert.match(styles, /--muted: #52605d/);
  assert.match(styles, /@import "tailwindcss\/theme\.css" layer\(theme\)/);
  assert.match(styles, /@import "tailwindcss\/utilities\.css" layer\(utilities\)/);
  assert.match(styles, /--color-primary: var\(--primary\)/);
  assert.doesNotMatch(styles, /font-geist/);
  assert.match(packageJson, /"@tailwindcss\/vite"/);
  assert.match(packageJson, /"tailwindcss"/);
  assert.match(packageJson, /"lucide-react"/);
  assert.match(packageJson, /--experimental-strip-types/);
  const testScript = JSON.parse(packageJson).scripts.test;
  assert.match(testScript, /PLANNER_PUBLIC_BASE_PATH=\/recipe-planner\/ npm run build/);
  assert.match(testScript, /node scripts\/run-node-tests\.mjs/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(planner, /completePrepTask|reschedulePrepTask/);
  assert.doesNotMatch(planner, /Local command preview|highlighted move command only/);

  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});

test("full-suite concurrency never exceeds four or the available CPUs", () => {
  assert.equal(selectTestConcurrency(12), 4);
  assert.equal(selectTestConcurrency(5), 4);
  assert.equal(selectTestConcurrency(4), 3);
  assert.equal(selectTestConcurrency(3), 2);
  assert.equal(selectTestConcurrency(2), 1);
  assert.equal(selectTestConcurrency(1), 1);
  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => selectTestConcurrency(invalid), /positive integer/u);
  }
});

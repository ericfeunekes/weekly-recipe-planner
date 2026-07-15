import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
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

test("server-renders the shared planner loading surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Weekly Recipe Planner<\/title>/i);
  assert.match(html, /Opening the shared planner/);
  assert.match(html, /Reading the latest household workspace/);
  assert.match(html, /http:\/\/localhost:3001\/og\.png/);
  assert.doesNotMatch(
    html,
    /Harissa chicken traybake|Miso salmon rice bowls|codex-preview|Your site is taking shape|react-loading-skeleton/i,
  );
});

test("keeps the locked product requirements represented in source", async () => {
  const [planner, api, styles, domain, contract, page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/planner-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/household-domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/household-contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  for (const command of [
    "moveMeal",
    "updateMealSnapshot",
    "setInstructionStepComplete",
    "updateInstructionStepNote",
    "startInstructionTimer",
    "resetInstructionTimer",
    "setPrepPlan",
    "movePrepReference",
    "reschedulePrepReference",
    "removePrepReference",
    "reconcileGroceries",
    "captureFeedback",
    "archiveWeek",
  ]) {
    assert.match(domain, new RegExp(command));
  }

  for (const view of ["Week", "Tonight", "Prep", "Groceries", "Close out"]) {
    assert.match(planner, new RegExp(`label: "${view}"`));
  }

  assert.doesNotMatch(planner, /localStorage\.setItem|executeDomainCommand|CODEX_BRIDGE_URL/);
  assert.match(api, /PLANNER_API_ROUTES\.workspace\.path/);
  assert.match(api, /PLANNER_API_ROUTES\.commands\.path/);
  assert.match(api, /PLANNER_API_ROUTES\.chatSubmit\.path/);
  assert.match(api, /If-None-Match/);
  assert.match(contract, /type InstructionStep/);
  assert.match(contract, /type PrepReference/);
  assert.match(planner, /findStep/);
  assert.match(planner, /transcriptEntries/);
  assert.match(planner, /Add note/);
  assert.match(planner, /Send to ChatGPT/);
  assert.match(planner, /ChatGPT task/);
  assert.match(planner, /Research recipe/);
  assert.match(planner, /archiveContextWeek: false/);
  assert.match(planner, /Allow archiving week \{week\.id\} for this message/);
  assert.match(planner, /onIntentChange\(DEFAULT_CHAT_INTENT\)/);
  assert.match(planner, /Informational recipe source/);
  assert.match(planner, /target="_blank" rel="noopener noreferrer"/);
  assert.match(planner, /planner changes will not run again/);
  assert.match(planner, /ChatGPT needs sign-in/);
  assert.match(planner, /ChatGPT runtime incompatible/);
  assert.match(planner, /timerStartedAt/);
  assert.match(planner, /function Timer/);
  assert.match(planner, /className="week-select"/);
  assert.match(planner, /setInterval\([^]*2_000/);
  assert.match(planner, /Offline . read-only/);
  assert.match(planner, /leftover\.state === "assigned"/);
  assert.match(planner, /Save recipe details/);
  assert.match(planner, /role="dialog"/);
  assert.match(planner, /aria-modal="true"/);
  assert.doesNotMatch(planner, /weekPickerOpen|chat-visible/);
  assert.match(page, /<PlannerApp \/>/);
  assert.match(layout, /title: "Weekly Recipe Planner"/);
  assert.match(layout, /shared household planner/i);
  assert.match(layout, /images: \[imageUrl\]/);
  assert.match(layout, /requestHeaders\.get\("x-forwarded-host"\)/);
  assert.doesNotMatch(layout, /next\/font|Geist|antialiased/);
  assert.match(styles, /--muted: #52605d/);
  assert.doesNotMatch(styles, /@import "tailwindcss"|font-geist/);
  assert.match(packageJson, /"lucide-react"/);
  assert.match(packageJson, /--experimental-strip-types/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(planner, /completePrepTask|reschedulePrepTask/);
  assert.doesNotMatch(planner, /Local command preview|highlighted move command only/);

  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});

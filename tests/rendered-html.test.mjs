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

test("server-renders the weekly operations surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Weekly Recipe Planner<\/title>/i);
  assert.match(html, /Week overview/);
  assert.match(html, /Harissa chicken traybake/);
  assert.match(html, /Miso salmon rice bowls/);
  assert.match(html, /ChatGPT/);
  assert.match(html, /Groceries/);
  assert.match(html, /Closeout/);
  assert.match(html, /<select/);
  assert.match(html, /http:\/\/localhost:3001\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the locked product requirements represented in source", async () => {
  const [planner, styles, domain, history, page, layout, packageJson, devScript] = await Promise.all([
    readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/planner-domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/planner-history.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8"),
  ]);

  for (const command of [
    "moveMeal",
    "updateMealSnapshot",
    "toggleInstructionStep",
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

  for (const view of ["Week", "Tonight", "Prep", "Groceries", "Closeout"]) {
    assert.match(planner, new RegExp(`label: \"${view}\"`));
  }

  assert.match(planner, /localStorage/);
  assert.match(planner, /executeDomainCommand/);
  assert.match(planner, /CODEX_BRIDGE_URL/);
  assert.match(planner, /\/health/);
  assert.match(planner, /\/chat/);
  assert.match(planner, /isDomainCommand/);
  assert.match(planner, /requestStateFingerprint/);
  assert.match(domain, /type InstructionStep/);
  assert.match(domain, /type PrepReference/);
  assert.match(planner, /resolveInstructionStep/);
  assert.match(planner, /chatMessages/);
  assert.match(planner, /Add note/);
  assert.match(planner, /Send to ChatGPT/);
  assert.match(planner, /timerStartedAt/);
  assert.match(planner, /function InstructionTimerReadout/);
  assert.match(planner, /className="week-select"/);
  assert.match(planner, /messages: chatMessages\.slice\(-12\)/);
  assert.match(planner, /response\.status === 401/);
  assert.match(planner, /error instanceof TypeError/);
  assert.match(planner, /leftover\.state === "assigned"/);
  assert.match(planner, /Save meal details/);
  assert.match(planner, /disabled=\{!snapshotValid\}/);
  assert.match(planner, /snapshotUnchanged \|\| onSave\(snapshot\)/);
  assert.doesNotMatch(planner, /weekPickerOpen|ChevronDown|chat-visible/);
  assert.match(history, /PlannerActor = \"Household\" \| \"Codex\"/);
  assert.match(planner, /migrateEventHistory/);
  assert.match(planner, /DAYS\.map/);
  assert.match(page, /<PlannerApp \/>/);
  assert.match(layout, /title: \"Weekly Recipe Planner\"/);
  assert.match(layout, /images: \[imageUrl\]/);
  assert.match(layout, /requestHeaders\.get\(\"x-forwarded-host\"\)/);
  assert.doesNotMatch(layout, /next\/font|Geist|antialiased/);
  assert.match(styles, /--muted: #62716d/);
  assert.doesNotMatch(styles, /@import "tailwindcss"|font-geist/);
  assert.match(packageJson, /"lucide-react"/);
  assert.match(packageJson, /--experimental-strip-types/);
  assert.match(packageJson, /vinext dev --port 3001/);
  assert.match(devScript, /--experimental-strip-types/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(planner, /completePrepTask|reschedulePrepTask/);
  assert.doesNotMatch(`${planner}\n${history}`, /Actor = \"You\" \| \"Codex\"/);
  assert.doesNotMatch(planner, /Local command preview|highlighted move command only/);

  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});

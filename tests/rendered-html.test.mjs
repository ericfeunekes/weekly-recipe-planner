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
  assert.match(html, /Ask Codex/);
  assert.match(html, /Groceries/);
  assert.match(html, /Closeout/);
  assert.match(html, /http:\/\/localhost(?::3000)?\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the locked product requirements represented in source", async () => {
  const [planner, page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  for (const command of [
    "moveMeal",
    "updateMealSnapshot",
    "reschedulePrepTask",
    "reconcileGroceries",
    "captureFeedback",
    "archiveWeek",
  ]) {
    assert.match(planner, new RegExp(command));
  }

  for (const view of ["Week", "Tonight", "Prep", "Groceries", "Closeout"]) {
    assert.match(planner, new RegExp(`label: \"${view}\"`));
  }

  assert.match(planner, /localStorage/);
  assert.match(planner, /executeDomainCommand/);
  assert.match(planner, /Actor = \"You\" \| \"Codex\"/);
  assert.match(planner, /DAYS\.map/);
  assert.match(page, /<PlannerApp \/>/);
  assert.match(layout, /title: \"Weekly Recipe Planner\"/);
  assert.match(layout, /images: \[imageUrl\]/);
  assert.match(layout, /requestHeaders\.get\(\"x-forwarded-host\"\)/);
  assert.match(packageJson, /"lucide-react"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});

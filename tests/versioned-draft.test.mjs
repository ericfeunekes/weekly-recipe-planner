import assert from "node:assert/strict";
import test from "node:test";

import {
  composeCompositeDraft,
  editCompositeDraft,
  settleCompositeDraft,
} from "../app/versioned-draft.ts";

test("a composite draft snapshots its baseline and overlays only edited fields", () => {
  const canonicalAtEdit = {
    title: "Original dinner",
    venue: "Home",
    notes: "Original note",
  };

  const draft = editCompositeDraft(
    null,
    canonicalAtEdit,
    "title",
    "Locally edited dinner",
  );
  canonicalAtEdit.venue = "Stale object mutation";

  assert.deepEqual(draft.baseline, {
    title: "Original dinner",
    venue: "Home",
    notes: "Original note",
  });
  assert.deepEqual(draft.dirtyValues, { title: "Locally edited dinner" });
});

test("conflict composition keeps dirty values and rebases pristine siblings", () => {
  const draft = editCompositeDraft(
    null,
    { title: "Original dinner", venue: "Home", notes: "Original note" },
    "title",
    "Locally edited dinner",
  );
  const latestCanonical = {
    title: "Remote dinner",
    venue: "Community centre",
    notes: "Remote note",
  };

  assert.deepEqual(composeCompositeDraft(latestCanonical, draft), {
    title: "Locally edited dinner",
    venue: "Community centre",
    notes: "Remote note",
  });
});

test("an edited field can deliberately restore its baseline value after conflict", () => {
  const baseline = { title: "Original dinner", venue: "Home" };
  const edited = editCompositeDraft(null, baseline, "title", "Local dinner");
  const deliberateRetry = editCompositeDraft(edited, baseline, "title", "Original dinner");

  assert.deepEqual(deliberateRetry.dirtyValues, { title: "Original dinner" });
  assert.deepEqual(
    composeCompositeDraft({ title: "Remote dinner", venue: "Cottage" }, deliberateRetry),
    { title: "Original dinner", venue: "Cottage" },
  );
});

test("accepted composite fields settle without clearing newer sibling edits", () => {
  const baseline = { title: "Original dinner", venue: "Home", notes: "" };
  const submitted = editCompositeDraft(null, baseline, "title", "Submitted dinner");
  const current = editCompositeDraft(
    submitted,
    baseline,
    "venue",
    "New family venue",
  );

  assert.deepEqual(settleCompositeDraft(current, submitted), {
    baseline,
    dirtyValues: { venue: "New family venue" },
  });
});

test("a post-submit edit to the same field survives settlement", () => {
  const baseline = { title: "Original dinner", venue: "Home" };
  const submitted = editCompositeDraft(null, baseline, "title", "Submitted dinner");
  const current = editCompositeDraft(
    submitted,
    baseline,
    "title",
    "Newer local dinner",
  );

  assert.deepEqual(settleCompositeDraft(current, submitted), {
    baseline,
    dirtyValues: { title: "Newer local dinner" },
  });
  assert.equal(settleCompositeDraft(submitted, submitted), null);
});

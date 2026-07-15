import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_OPERATION_JOURNAL_KEY,
  AuthorityOperationJournalError,
  clearAuthorityOperationJournalAfterReadback,
  discardAuthorityOperation,
  markAuthorityOperationAmbiguous,
  prepareAuthorityOperation,
  readAuthorityOperations,
  replaceResolvedAuthorityOperation,
  resolveAuthorityOperation,
  settleAuthorityOperation,
  updateAuthorityOperationDraft,
} from "../app/authority-operation-journal.ts";

class MemoryStorage {
  values = new Map();
  failReads = false;
  failWrites = false;

  getItem(key) {
    if (this.failReads) throw new Error("read failed");
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error("write failed");
    this.values.set(key, value);
  }

  removeItem(key) {
    if (this.failWrites) throw new Error("remove failed");
    this.values.delete(key);
  }
}

function input(requestId = "request-1", instruction = "Keep the exact body") {
  return {
    kind: "planner",
    path: "/api/commands",
    body: {
      requestId,
      basePlannerVersion: 1,
      command: { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: instruction },
    },
    label: "Save week lesson",
    submittedDraft: { weekLesson: instruction },
    createdAt: 123,
  };
}

test("the default journal uses per-tab session storage only", () => {
  const previousWindow = globalThis.window;
  const localStorage = new MemoryStorage();
  const firstSessionStorage = new MemoryStorage();
  try {
    globalThis.window = { localStorage, sessionStorage: firstSessionStorage, dispatchEvent() {} };
    const prepared = prepareAuthorityOperation(input("request-lifecycle"));
    markAuthorityOperationAmbiguous(prepared);

    assert.equal(localStorage.getItem(AUTHORITY_OPERATION_JOURNAL_KEY), null);
    assert.notEqual(firstSessionStorage.getItem(AUTHORITY_OPERATION_JOURNAL_KEY), null);

    const recovered = readAuthorityOperations();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].requestId, "request-lifecycle");
    assert.equal(recovered[0].state, "ambiguous");
    assert.equal(recovered[0].serializedBody, JSON.stringify(input("request-lifecycle").body));

    globalThis.window = {
      localStorage,
      sessionStorage: new MemoryStorage(),
      dispatchEvent() {},
    };
    assert.deepEqual(readAuthorityOperations(), []);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("default session-storage access failures still fail closed", () => {
  const previousWindow = globalThis.window;
  try {
    globalThis.window = {
      get sessionStorage() {
        throw new Error("session storage denied");
      },
      dispatchEvent() {},
    };
    assert.throws(
      () => prepareAuthorityOperation(input("request-denied")),
      (error) => error instanceof AuthorityOperationJournalError &&
        error.code === "STORAGE_UNAVAILABLE",
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("the journal persists exact immutable envelopes before replay", () => {
  const storage = new MemoryStorage();
  const prepared = prepareAuthorityOperation(input(), storage);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.serializedBody, JSON.stringify(input().body));
  assert.deepEqual(readAuthorityOperations(storage), [prepared]);

  const duplicate = prepareAuthorityOperation(input(), storage);
  assert.deepEqual(duplicate, prepared);
  assert.throws(
    () => prepareAuthorityOperation(input("request-1", "Changed body"), storage),
    (error) => error instanceof AuthorityOperationJournalError && error.code === "REQUEST_ID_REUSE",
  );
});

test("ambiguous operations cannot be discarded before a definitive resolution", () => {
  const storage = new MemoryStorage();
  const prepared = prepareAuthorityOperation(input(), storage);
  const ambiguous = markAuthorityOperationAmbiguous(prepared, storage);
  assert.equal(ambiguous.state, "ambiguous");
  assert.throws(
    () => discardAuthorityOperation(ambiguous, storage),
    (error) => error instanceof AuthorityOperationJournalError && error.code === "INVALID_OPERATION",
  );

  const resolved = resolveAuthorityOperation(ambiguous, {
    code: "version_conflict",
    message: "The plan changed.",
  }, storage);
  assert.equal(resolved.state, "resolved_conflict");
  updateAuthorityOperationDraft(resolved, { weekLesson: "Edited after conflict" }, storage);
  assert.deepEqual(readAuthorityOperations(storage)[0].editableDraft, {
    weekLesson: "Edited after conflict",
  });
  const replacementInput = input("request-2", "Edited after conflict");
  const replacement = replaceResolvedAuthorityOperation(resolved, replacementInput, storage);
  assert.equal(replacement.state, "prepared");
  assert.equal(readAuthorityOperations(storage).length, 1);
  assert.equal(readAuthorityOperations(storage)[0].requestId, "request-2");
  resolveAuthorityOperation(replacement, { code: "domain_rejected", message: "Try again." }, storage);
  discardAuthorityOperation(replacement, storage);
  assert.deepEqual(readAuthorityOperations(storage), []);
});

test("capacity and storage failures fail closed without evicting pending work", () => {
  const storage = new MemoryStorage();
  const first = prepareAuthorityOperation(input("request-0"), storage);
  for (let index = 1; index < 16; index += 1) {
    prepareAuthorityOperation(input(`request-${index}`), storage);
  }
  assert.throws(
    () => prepareAuthorityOperation(input("request-overflow"), storage),
    (error) => error instanceof AuthorityOperationJournalError && error.code === "JOURNAL_CAPACITY",
  );
  assert.equal(readAuthorityOperations(storage).length, 16);
  assert.equal(readAuthorityOperations(storage)[0].requestId, first.requestId);

  storage.failWrites = true;
  assert.throws(
    () => settleAuthorityOperation(first, storage),
    (error) => error instanceof AuthorityOperationJournalError && error.code === "STORAGE_UNAVAILABLE",
  );
  storage.failWrites = false;
  assert.equal(readAuthorityOperations(storage).length, 16);
});

test("corrupt or unknown journal records block recovery instead of being dropped", () => {
  const storage = new MemoryStorage();
  storage.values.set(AUTHORITY_OPERATION_JOURNAL_KEY, JSON.stringify({
    schemaVersion: 2,
    operations: [],
  }));
  assert.throws(
    () => readAuthorityOperations(storage),
    (error) => error instanceof AuthorityOperationJournalError && error.code === "STORAGE_CORRUPT",
  );
  assert.notEqual(storage.getItem(AUTHORITY_OPERATION_JOURNAL_KEY), null);
  assert.throws(
    () => clearAuthorityOperationJournalAfterReadback(Number.NaN, storage),
    (error) => error instanceof AuthorityOperationJournalError && error.code === "INVALID_OPERATION",
  );
  assert.notEqual(storage.getItem(AUTHORITY_OPERATION_JOURNAL_KEY), null);
  clearAuthorityOperationJournalAfterReadback(5, storage);
  assert.equal(storage.getItem(AUTHORITY_OPERATION_JOURNAL_KEY), null);
});

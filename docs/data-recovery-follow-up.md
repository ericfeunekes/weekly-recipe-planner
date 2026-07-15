# Data Recovery Follow-Up

## Current Contract

`GET /api/export` produces a diagnostic support projection. The response is
machine-marked `restorable: false`, names itself as a diagnostic export, and
warns that it is not a database backup. Bootstrap accepts only a canonical seed
request or an exact legacy-v2 import. It must reject diagnostic JSON without
creating or changing planner authority.

Three existing mechanisms remain deliberately separate:

- Diagnostic JSON supports inspection and troubleshooting only.
- A pre-migration copy protects one database migration attempt.
- Release rollback restores the app/data pair recorded by one activation.

None of them is a general disaster-recovery operator. Family-readiness signoff
must not describe the diagnostic JSON as a backup or a restorable export.

## Future Host-Only Operator

A later deployment/recovery lane should add a host-only whole-store backup and
restore operator. It must not be exposed through the browser API, bootstrap,
ChatGPT, embedded tools, or global Codex tools.

The operator contract is frozen as follows:

1. Create a transactionally consistent SQLite image with `VACUUM INTO`.
2. Record and verify SHA-256, byte length, schema version, creation time, and a
   successful `PRAGMA quick_check` in a closed manifest.
3. Prove full-table identity, including planner state, events and undo bodies,
   command receipts, transcript and chat rows, research references, tool-call
   ledgers, and accepted-effect ledgers.
4. Restore only while the planner authority is exclusively stopped and locked.
   Refuse a live writer instead of racing it.
5. Preserve an existing target before replacement and use compare-and-swap
   identity checks so a changed target is never overwritten silently.
6. Preserve the source backup. Restore through a staged temporary database,
   run `quick_check`, migrate only explicitly supported older schemas, verify
   the resulting manifest, and atomically publish the target.
7. Journal interrupted restore steps so recovery can distinguish an untouched
   target, a staged candidate, and a published replacement.

This operator must not modify release `current.json`, select an app build,
change Codex configuration or authentication state, or rewrite release rollback
history. Those remain owned by the release transaction.

## Required Proof

The follow-up is complete only when real-file integration tests cover backup of
every durable table, database loss, restore into an absent target, refusal to
overwrite a changed target, tampered/truncated backup rejection, failed
`quick_check`, supported-schema migration, crash recovery at each publish
boundary, restart readback, and preservation of release/Codex state.

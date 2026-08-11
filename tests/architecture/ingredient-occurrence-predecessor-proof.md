# Ingredient occurrence predecessor compatibility proof

This records the destructive-compatibility probe for the schema-10 ingredient-occurrence change.
It is deliberately separate from the application QA guide: it is release evidence for this migration only.

- Predecessor commit: `7209a334ef5803396605e6042676f4a2d354fa90`
- Predecessor command: `npm run planner:migrate-v8-v9 -- --database ../predecessor-schema10.sqlite --backup ../predecessor-backup.sqlite`
- Input: a closed schema-10 SQLite store created by the Issue 13 candidate migration
- Exit status: `1`
- Error: `The SQLite store must have the contiguous v1 through v8 migration ledger.`
- SHA-256 before: `6f32a0d813beb92691398f37d32c05b1318268eb319b5a8e9198ebb63b18925a`
- SHA-256 after: `6f32a0d813beb92691398f37d32c05b1318268eb319b5a8e9198ebb63b18925a`
- Artifact inventory before and after: only `predecessor-schema10.sqlite`; no backup, WAL, or SHM file was created

The probe was run from a detached worktree of the exact predecessor commit, not from the candidate runtime. It proves that the immediately preceding shipped migrator rejects a schema-10 file before mutation rather than attempting to interpret or downgrade it.

To reproduce, create the candidate schema-10 fixture, add a detached worktree at the commit above, run the recorded predecessor command from that worktree, and compare the source hash and containing-directory inventory before and after.

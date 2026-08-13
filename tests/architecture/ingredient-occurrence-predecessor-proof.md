# Ingredient occurrence predecessor compatibility proof

The executable authority for this destructive-compatibility proof is
`scripts/probe-ingredient-occurrence-predecessor.mjs`, exercised by
`tests/ingredient-occurrence-predecessor.test.mjs` in the normal test gate.

- Predecessor commit: `7209a334ef5803396605e6042676f4a2d354fa90`
- Predecessor command: `npm run planner:migrate-v8-v9 -- --database ../predecessor-schema10.sqlite --backup ../predecessor-backup.sqlite`
- Input: a closed schema-10 SQLite store created by the Issue 13 candidate migration
- Exit status: `1`
- Error: `The SQLite store must have the contiguous v1 through v8 migration ledger.`
- SHA-256 before and after: calculated and compared by the executable probe
- Artifact inventory before and after: exactly the candidate database; no backup, WAL, or SHM file is created

The probe exports the exact commit into an isolated temporary tree, links the
current dependency installation, creates a closed schema-10 fixture with the
candidate store, runs the predecessor command, and compares the source hash and
containing-directory inventory before and after. Run it directly with
`node --experimental-strip-types scripts/probe-ingredient-occurrence-predecessor.mjs`.

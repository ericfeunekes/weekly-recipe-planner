# Planner QA Contract

QA is visible, real-system exploration after deterministic proof is green. It
does not replace the merge or release-candidate cells in `docs/TESTING.md`, and
a root-mode development page does not prove the mounted production app.

## Evidence Classes

| Class | Use when | Required evidence |
|---|---|---|
| Representative household journey | Planner behavior or layout changes | Visible browser run against disposable data, relevant viewport, screenshot or trace, console/network outcome, and authoritative API readback when state changes. |
| Production-profile candidate | Build, front controller, base path, metadata, or deployment changes | Disposable installed candidate reached at `/recipe-planner/`; health, workspace, assets, favicon, social preview, and one representative planner journey. |
| Installed runtime | LaunchAgent, native Codex, Global UDS, startup, restart, or recovery changes | Disposable installed-layout proof first; authorized host observation only when the claim requires real launchd, authenticated Codex, Tailscale, or the canonical UDS. |
| Household production observation | Authorized release | Read-only visible load of the mounted household URL, health/workspace readiness, and confirmation that the immediately previous app remains recoverable. Do not use production data for destructive or synthetic scenarios. |

## When QA Is Required

- UI behavior or responsive layout: representative household journey.
- Public routing, base path, static metadata, build, or release wiring:
  production-profile candidate.
- Startup, shutdown, supervision, rollback, or retained-data behavior:
  production-profile candidate plus installed runtime.
- Native Codex capability or authenticated behavior: installed runtime with
  credentials and thread content excluded from captured evidence.
- Production release: household production observation after all earlier cells
  pass.

For a schema-changing feature, default-branch merge does not authorize
production activation. When the household database is still on the previous
schema, do not run `make promote` or start the newer app against it. Keep the
previous production app/schema selected until the explicit migration release
action and the release-safety cells in `docs/TESTING.md` are complete. Migration
proof uses disposable data; household migration requires separate release
authorization and readback.

The detailed reusable product-story inventory remains in
`docs/qa/family-planner-signoff-checklist.md`. Select only the stories touched by
the change plus one representative dinner journey; do not rerun the entire
inventory for a small release-script correction.

## Evidence Shape

Write evidence under `outputs/qa/<run-id>/`. A run summary records the commit,
runtime versions, data profile, exact origin and base path, scenarios selected,
result, and links to screenshots, traces, console/network logs, and readbacks.
Use `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, or `NOT APPLICABLE`. Never capture
credentials, raw authentication material, unrestricted recipe-page content,
native provider content, or the family database.

QA is current only for the exact candidate it exercised. A source, dependency,
build, release-script, or deployment-config change invalidates candidate QA.

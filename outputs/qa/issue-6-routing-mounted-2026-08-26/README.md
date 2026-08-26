# Mounted routing QA

- Candidate: `cbeedcf` plus the uncommitted mounted-harness bootstrap adjustment
- Origin: `http://issue-6-routing-delivery.weekly-recipe-planner-qa.localhost:1355`
- Public base path: `/recipe-planner/`
- Snapshot: QA manager's isolated, initially uninitialized SQLite copy; the test chose **Start Fresh**.
- Checks: unmounted `/` returned 404; `/recipe-planner/` and `/recipe-planner/api/health` returned 200; mounted phone `320x844` and desktop `1280x900` accessibility/containment captures passed.

The paired `*.axe.json`, `*.geometry.json`, `*.viewport.png`, and `*.full.png`
files are the browser evidence from that run. The QA deployment was stopped after
capture.

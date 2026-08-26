# Mounted Groceries routing QA

- Candidate: `05a4e3dd3f0f43d3568ab6e474ca69b6425f8e33`
- Origin: `http://issue-8-groceries-routing-delivery.weekly-recipe-planner-dev.localhost:1355`
- Public base path: `/recipe-planner/`
- Data: isolated QA SQLite snapshot, initialized with **Start Fresh**.
- Browser: headless Chromium `151.0.7922.174` on the mounted runtime.
- Route checks: mounted health and base returned 200; unmounted root returned 404. Direct `/recipe-planner/weeks/2026-08-24/groceries`, reload, and navigation to Week then browser Back each retained the selected week's Groceries URL and heading. An unavailable Groceries week fell back to the selected Week.
- Responsive checks: the direct Groceries route passed at desktop `1280x900` and phone `320x844`, with zero axe violations and no horizontal overflow.
- Runtime checks: no browser console errors or failed HTTP responses were observed.

`run-summary.json` is the concise result record. The paired `d8-*.axe.json`,
`d8-*.geometry.json`, `d8-*.viewport.png`, and `d8-*.full.png` files are the
visible, accessible-browser evidence. The disposable runtime was stopped after capture.

# Mounted Groceries routing QA

- Candidate: pending commit from this worktree
- Origin: `http://issue-8-groceries-routing-delivery.issue-8-groceries-routing-qa.localhost:1355`
- Public base path: `/recipe-planner/`
- Data: isolated QA SQLite database, initialized with **Start Fresh**
- Browser: agent-browser on the mounted runtime
- Checks: direct `/recipe-planner/weeks/2026-08-24/groceries` load rendered the selected Week's Shopping list; navigating to Week then browser Back restored that exact Groceries URL and view.

`groceries-mounted.png` and `groceries-history.png` are the visible browser captures.

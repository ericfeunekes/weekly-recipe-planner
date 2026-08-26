import { expect, test } from "@playwright/test";

test("Combined Prep worker evidence metadata uses the configured override", ({}, testInfo) => {
  expect(testInfo.config.metadata.plannerE2eCombinedPrepEvidenceDirectory).toBe(
    process.env.PLANNER_E2E_COMBINED_PREP_EVIDENCE_DIR ?? "outputs/qa/prep-combined",
  );
});

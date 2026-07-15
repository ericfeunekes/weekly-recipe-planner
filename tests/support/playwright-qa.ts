import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const QA_VIEWPORTS = Object.freeze([
  Object.freeze({ id: "mobile-320x844", width: 320, height: 844 }),
  Object.freeze({ id: "short-375x400", width: 375, height: 400 }),
  Object.freeze({ id: "mobile-428x926", width: 428, height: 926 }),
  Object.freeze({ id: "tablet-620x900", width: 620, height: 900 }),
  Object.freeze({ id: "tablet-700x900", width: 700, height: 900 }),
  Object.freeze({ id: "tablet-701x900", width: 701, height: 900 }),
  Object.freeze({ id: "tablet-768x1024", width: 768, height: 1024 }),
  Object.freeze({ id: "tablet-840x900", width: 840, height: 900 }),
  Object.freeze({ id: "tablet-841x900", width: 841, height: 900 }),
  Object.freeze({ id: "desktop-980x900", width: 980, height: 900 }),
  Object.freeze({ id: "desktop-1280x900", width: 1280, height: 900 }),
  Object.freeze({ id: "desktop-1920x1080", width: 1920, height: 1080 }),
]);

function safeEvidenceId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value)) {
    throw new TypeError("QA evidence IDs must use lowercase letters, digits, and hyphens.");
  }
  return value;
}

async function viewportGeometry(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        bounds.width > 0 && bounds.height > 0;
    };
    const controls = [...document.querySelectorAll(
      "button,input,select,textarea,[role='dialog']",
    )].filter(visible).map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        name: element.getAttribute("aria-label") ??
          element.getAttribute("title") ??
          (element.textContent ?? "").trim().slice(0, 120),
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          right: bounds.right,
          bottom: bounds.bottom,
        },
      };
    });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      controls,
      userAgent: navigator.userAgent,
    };
  });
}

export async function assertViewportContained(page: Page): Promise<void> {
  const geometry = await viewportGeometry(page);
  expect(
    geometry.horizontalOverflow,
    `document width ${geometry.document.scrollWidth} exceeds viewport ${geometry.viewport.width}`,
  ).toBe(false);
}

export async function captureAccessibleQaEvidence(options: {
  page: Page;
  evidenceDirectory: string;
  scenarioId: string;
  viewportId: string;
}): Promise<{ axeViolations: number; browserVersion: string; geometryPath: string }> {
  const scenarioId = safeEvidenceId(options.scenarioId);
  const viewportId = safeEvidenceId(options.viewportId);
  const prefix = `${scenarioId}-${viewportId}`;
  await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  await assertViewportContained(options.page);
  const [geometry, axe] = await Promise.all([
    viewportGeometry(options.page),
    new AxeBuilder({ page: options.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze(),
  ]);
  const browserVersion = options.page.context().browser()?.version() ?? "unknown";
  const geometryPath = join(options.evidenceDirectory, `${prefix}.geometry.json`);
  await Promise.all([
    writeFile(
      geometryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        scenarioId,
        viewportId,
        browserVersion,
        ...geometry,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
    writeFile(
      join(options.evidenceDirectory, `${prefix}.axe.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        scenarioId,
        viewportId,
        browserVersion,
        testEngine: axe.testEngine,
        testEnvironment: axe.testEnvironment,
        violations: axe.violations,
        passes: axe.passes.map((result) => result.id).sort(),
        incomplete: axe.incomplete.map((result) => result.id).sort(),
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
    options.page.screenshot({
      path: join(options.evidenceDirectory, `${prefix}.viewport.png`),
      fullPage: false,
      animations: "disabled",
    }),
    options.page.screenshot({
      path: join(options.evidenceDirectory, `${prefix}.full.png`),
      fullPage: true,
      animations: "disabled",
    }),
  ]);
  expect(
    axe.violations,
    axe.violations.map((violation) =>
      `${violation.id}: ${violation.nodes.length} node(s)`).join("\n"),
  ).toEqual([]);
  return Object.freeze({
    axeViolations: axe.violations.length,
    browserVersion,
    geometryPath,
  });
}

import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

import {
  PlannerReleaseError,
  canonicalReleaseJson,
  isActivationId,
  isSha256,
} from "./planner-release-contract.mjs";
import {
  NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION,
} from "./planner-release-evidence-contract.mjs";

const MAX_EVIDENCE_FILES = 10_000;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const MANIFEST_NAME = "manifest.json";

function pathInside(parent, candidate) {
  const value = relative(parent, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) &&
    !isAbsolute(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngProjection(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(signature)) {
    throw new PlannerReleaseError("A retained QA PNG has invalid encoding.");
  }
  let offset = 8;
  let header = null;
  let sawEnd = false;
  const imageData = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new PlannerReleaseError("A retained QA PNG has a truncated chunk.");
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) {
      throw new PlannerReleaseError("A retained QA PNG has a truncated chunk body.");
    }
    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    if (crc32(bytes.subarray(typeStart, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      throw new PlannerReleaseError("A retained QA PNG failed its chunk CRC.");
    }
    if (header === null && (type !== "IHDR" || length !== 13)) {
      throw new PlannerReleaseError("A retained QA PNG does not begin with IHDR.");
    }
    if (type === "IHDR") {
      if (header !== null || length !== 13) {
        throw new PlannerReleaseError("A retained QA PNG has an invalid IHDR.");
      }
      header = Object.freeze({
        width: bytes.readUInt32BE(dataStart),
        height: bytes.readUInt32BE(dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        compression: bytes[dataStart + 10],
        filter: bytes[dataStart + 11],
        interlace: bytes[dataStart + 12],
      });
    } else if (type === "IDAT") {
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) {
        throw new PlannerReleaseError("A retained QA PNG has an invalid IEND.");
      }
      sawEnd = true;
    }
    offset = chunkEnd;
  }
  if (header === null || !sawEnd || imageData.length === 0 ||
      header.width < 1 || header.height < 1 ||
      header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new PlannerReleaseError("A retained QA PNG has invalid dimensions.");
  }
  const channelCounts = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
  const validDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  const channels = channelCounts.get(header.colorType);
  if (channels === undefined || !validDepths.get(header.colorType)?.has(header.bitDepth)) {
    throw new PlannerReleaseError("A retained QA PNG has an unsupported pixel format.");
  }
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const decodedBytes = (rowBytes + 1) * header.height;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > 256 * 1024 * 1024) {
    throw new PlannerReleaseError("A retained QA PNG exceeded its decoded image budget.");
  }
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: decodedBytes + 1 });
  } catch (error) {
    throw new PlannerReleaseError(
      "A retained QA PNG has invalid compressed pixels.",
      undefined,
      { cause: error },
    );
  }
  if (decoded.length !== decodedBytes) {
    throw new PlannerReleaseError("A retained QA PNG has incomplete pixel rows.");
  }
  for (let row = 0; row < header.height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) {
      throw new PlannerReleaseError("A retained QA PNG has an invalid row filter.");
    }
  }
  return {
    mediaType: "image/png",
    encoding: "png",
    width: header.width,
    height: header.height,
  };
}

function classifyJson(relativePath, bytes, observed) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new PlannerReleaseError(
      `Retained QA JSON is invalid: ${relativePath}`,
      undefined,
      { cause: error },
    );
  }
  if (relativePath.endsWith(".axe.json")) {
    if (!Array.isArray(value.violations) || value.violations.length !== 0) {
      throw new PlannerReleaseError(`Retained axe evidence is not green: ${relativePath}`);
    }
    observed.axeResults += 1;
  }
  if (relativePath.endsWith(".geometry.json")) {
    if (value.horizontalOverflow !== false) {
      throw new PlannerReleaseError(`Retained geometry evidence overflowed: ${relativePath}`);
    }
    observed.geometryResults += 1;
  }
  if (typeof value.scenarioId === "string") observed.scenarioIds.add(value.scenarioId);
  if (typeof value.viewportId === "string") observed.viewportIds.add(value.viewportId);
  if (typeof value.browserVersion === "string") observed.browserVersions.add(value.browserVersion);
  return { mediaType: "application/json", encoding: "utf-8" };
}

function classifyEvidence(relativePath, bytes, observed) {
  if (relativePath.endsWith(".png")) {
    observed.screenshots += 1;
    const projection = pngProjection(bytes);
    const requested = relativePath.match(/(?:^|-)([0-9]{2,4})x([0-9]{2,4})(?:\.|-)/u);
    if (requested !== null) {
      const requestedWidth = Number(requested[1]);
      const requestedHeight = Number(requested[2]);
      const exactViewport = relativePath.endsWith(".viewport.png");
      const completeFullPage = relativePath.endsWith(".full.png");
      if (
        projection.width !== requestedWidth ||
        (exactViewport && projection.height !== requestedHeight) ||
        (completeFullPage && projection.height < requestedHeight)
      ) {
        throw new PlannerReleaseError(
          `Retained QA screenshot dimensions do not match its viewport: ${relativePath}`,
        );
      }
    }
    return { artifactClass: "screenshot", ...projection };
  }
  if (relativePath.endsWith(".zip")) {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new PlannerReleaseError(`Retained trace archive is invalid: ${relativePath}`);
    }
    observed.traces += 1;
    return { artifactClass: "trace", mediaType: "application/zip", encoding: "zip" };
  }
  if (relativePath.endsWith(".axe.json")) {
    return { artifactClass: "axe", ...classifyJson(relativePath, bytes, observed) };
  }
  if (relativePath.endsWith(".geometry.json")) {
    return { artifactClass: "geometry", ...classifyJson(relativePath, bytes, observed) };
  }
  if (relativePath.endsWith(".json")) {
    return { artifactClass: "json", ...classifyJson(relativePath, bytes, observed) };
  }
  if (relativePath.endsWith(".log") || relativePath.endsWith(".txt")) {
    return { artifactClass: "log", mediaType: "text/plain", encoding: "utf-8" };
  }
  if (relativePath.endsWith(".webm")) {
    return { artifactClass: "video", mediaType: "video/webm", encoding: "webm" };
  }
  return { artifactClass: "binary", mediaType: "application/octet-stream" };
}

async function inventoryEvidence(root) {
  const observed = {
    scenarioIds: new Set(),
    viewportIds: new Set(),
    browserVersions: new Set(),
    screenshots: 0,
    traces: 0,
    axeResults: 0,
    geometryResults: 0,
    axeMatrix: new Set(),
    geometryMatrix: new Set(),
    viewportScreenshotMatrix: new Set(),
    fullScreenshotMatrix: new Set(),
  };
  const rows = [];
  const pending = [root];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (!pathInside(root, path) || relativePath === MANIFEST_NAME) continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new PlannerReleaseError(`Retained QA evidence contains a link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!metadata.isFile() || metadata.size > MAX_EVIDENCE_FILE_BYTES) {
        throw new PlannerReleaseError(`Retained QA evidence is unsafe or too large: ${relativePath}`);
      }
      totalBytes += metadata.size;
      if (rows.length >= MAX_EVIDENCE_FILES || totalBytes > MAX_EVIDENCE_BYTES) {
        throw new PlannerReleaseError("Retained QA evidence exceeded its inventory budget.");
      }
      const bytes = await readFile(path);
      rows.push({
        relativePath,
        ...classifyEvidence(relativePath, bytes, observed),
        bytes: bytes.length,
        sha256: sha256(bytes),
        validation: "valid",
      });
    }
  }
  rows.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { rows, totalBytes, observed };
}

async function readPackageVersion(path, label) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new PlannerReleaseError(`${label} package version is invalid.`);
  }
  return value.version;
}

async function hashRunnerFiles(appRoot) {
  const paths = [
    "playwright.config.ts",
    "scripts/support/planner-installed-qa.mjs",
    "scripts/support/planner-qa-evidence.mjs",
    "tests/e2e/installed-visual-qa.spec.ts",
    "tests/e2e/operation-journal.spec.ts",
    "tests/e2e/ui-contracts.spec.ts",
    "tests/support/playwright-qa.ts",
  ];
  return Promise.all(paths.map(async (relativePath) => {
    const bytes = await readFile(join(appRoot, relativePath));
    return Object.freeze({ relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }));
}

function assertReleaseBinding(value, activationId) {
  if (
    value === null || typeof value !== "object" ||
    value.activationId !== activationId ||
    !isSha256(value.stageSha256) || !isSha256(value.installedSha256) ||
    !isSha256(value.releaseCandidateSha256) ||
    value.releaseCandidateEvidenceSchemaVersion !== NATIVE_RELEASE_EVIDENCE_SCHEMA_VERSION ||
    value.nodeFloor?.version !== "v22.15.0" ||
    value.nodeFloor?.exactFloorVerified !== true ||
    value.nodeFloor?.recheckedAfterSuite !== true ||
    !isSha256(value.nodeFloor?.sha256)
  ) {
    throw new PlannerReleaseError("QA evidence requires the exact release predecessor and Node floor.");
  }
  return value;
}

async function writeExclusiveManifest(path, value) {
  const payload = `${canonicalReleaseJson(value)}\n`;
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function verifyQaEvidenceManifest(options) {
  const evidenceRoot = resolve(options.evidenceRoot);
  const manifestPath = resolve(options.manifestPath);
  if (manifestPath !== join(evidenceRoot, MANIFEST_NAME)) {
    throw new PlannerReleaseError("The QA evidence manifest path escaped its canonical root.");
  }
  const metadata = await lstat(manifestPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new PlannerReleaseError("The QA evidence manifest must be a real mode-0600 file.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const body = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "sha256"),
  );
  if (!isSha256(manifest.sha256) || manifest.sha256 !== sha256(canonicalReleaseJson(body)) ||
      (options.expectedSha256 !== undefined && manifest.sha256 !== options.expectedSha256)) {
    throw new PlannerReleaseError("The QA evidence manifest failed its canonical SHA-256 check.");
  }
  if (manifest.activationId !== options.activationId ||
      canonicalReleaseJson(manifest.releaseBinding) !== canonicalReleaseJson(
        assertReleaseBinding(options.releaseBinding, options.activationId),
      )) {
    throw new PlannerReleaseError("The QA evidence manifest changed its release binding.");
  }
  const current = await inventoryEvidence(evidenceRoot);
  if (canonicalReleaseJson(current.rows) !== canonicalReleaseJson(manifest.files) ||
      current.totalBytes !== manifest.summary?.bytes ||
      current.rows.length !== manifest.summary?.files) {
    throw new PlannerReleaseError("Retained QA evidence changed after its manifest was written.");
  }
  return Object.freeze({
    matched: true,
    sha256: manifest.sha256,
    files: current.rows.length,
    bytes: current.totalBytes,
  });
}

export async function createQaEvidenceManifest(options) {
  const evidenceRoot = resolve(options.evidenceRoot);
  const appRoot = resolve(options.appRoot);
  if (!isAbsolute(options.evidenceRoot) || evidenceRoot !== options.evidenceRoot ||
      !isAbsolute(options.appRoot) || appRoot !== options.appRoot) {
    throw new TypeError("QA evidence roots must be absolute normalized paths.");
  }
  if (!isActivationId(options.activationId)) {
    throw new TypeError("QA evidence requires a canonical activation ID.");
  }
  const releaseBinding = assertReleaseBinding(options.releaseBinding, options.activationId);
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const { rows, totalBytes, observed } = await inventoryEvidence(evidenceRoot);
  const body = Object.freeze({
    schemaVersion: 1,
    activationId: options.activationId,
    releaseBinding,
    tooling: Object.freeze({
      playwrightVersion: await readPackageVersion(
        join(appRoot, "node_modules", "@playwright", "test", "package.json"),
        "Playwright",
      ),
      axePlaywrightVersion: await readPackageVersion(
        join(appRoot, "node_modules", "@axe-core", "playwright", "package.json"),
        "Axe Playwright",
      ),
      axeCoreVersion: await readPackageVersion(
        join(appRoot, "node_modules", "@axe-core", "playwright", "node_modules", "axe-core", "package.json"),
        "axe-core",
      ),
      browserVersions: [...observed.browserVersions].sort(),
    }),
    scenarioIds: [...observed.scenarioIds].sort(),
    viewportIds: [...observed.viewportIds].sort(),
    summary: Object.freeze({
      files: rows.length,
      bytes: totalBytes,
      screenshots: observed.screenshots,
      traces: observed.traces,
      axeResults: observed.axeResults,
      geometryResults: observed.geometryResults,
    }),
    runners: await hashRunnerFiles(appRoot),
    files: rows,
  });
  const manifest = Object.freeze({ ...body, sha256: sha256(canonicalReleaseJson(body)) });
  const manifestPath = join(evidenceRoot, MANIFEST_NAME);
  await writeExclusiveManifest(manifestPath, manifest);
  await verifyQaEvidenceManifest({
    evidenceRoot,
    manifestPath,
    activationId: options.activationId,
    releaseBinding,
    expectedSha256: manifest.sha256,
  });
  return Object.freeze({
    manifestPath,
    relativePath: `evidence/${MANIFEST_NAME}`,
    sha256: manifest.sha256,
    files: rows.length,
    bytes: totalBytes,
    scenarioIds: manifest.scenarioIds,
    viewportIds: manifest.viewportIds,
    browserVersions: manifest.tooling.browserVersions,
    axeVersion: manifest.tooling.axeCoreVersion,
  });
}

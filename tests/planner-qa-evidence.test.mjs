import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  createQaEvidenceManifest,
  verifyQaEvidenceManifest,
} from "../scripts/support/planner-qa-evidence.mjs";

const activationId = "77777777-7777-4777-8777-777777777777";
const viewports = [
  ["mobile-320x844", 320, 844],
  ["short-375x400", 375, 400],
  ["mobile-428x926", 428, 926],
  ["tablet-620x900", 620, 900],
  ["tablet-700x900", 700, 900],
  ["tablet-701x900", 701, 900],
  ["tablet-768x1024", 768, 1024],
  ["tablet-840x900", 840, 900],
  ["tablet-841x900", 841, 900],
  ["desktop-980x900", 980, 900],
  ["desktop-1280x900", 1280, 900],
  ["desktop-1920x1080", 1920, 1080],
];

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

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  header[9] = 0;
  const rowBytes = Math.ceil(width / 8) + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function seedEvidenceMatrix(evidenceRoot) {
  await mkdir(join(evidenceRoot, "logs"), { recursive: true });
  await mkdir(join(evidenceRoot, "playwright"), { recursive: true });
  await Promise.all([
    writeFile(join(evidenceRoot, "logs", "boundary-tests.log"), "boundary proof passed\n"),
    writeFile(join(evidenceRoot, "playwright", "selected-clone.log"), "selected clone readback passed\n"),
  ]);
  await Promise.all(["d4", "d7"].flatMap((scenarioId) =>
    viewports.flatMap(([viewportId, width, height]) => {
      const prefix = `${scenarioId}-${viewportId}`;
      return [
        writeFile(join(evidenceRoot, `${prefix}.viewport.png`), png(width, height)),
        writeFile(join(evidenceRoot, `${prefix}.full.png`), png(width, height * 2)),
        writeFile(join(evidenceRoot, `${prefix}.axe.json`), `${JSON.stringify({
          scenarioId,
          viewportId,
          browserVersion: "fixture-browser",
          violations: [],
        })}\n`),
        writeFile(join(evidenceRoot, `${prefix}.geometry.json`), `${JSON.stringify({
          scenarioId,
          viewportId,
          browserVersion: "fixture-browser",
          horizontalOverflow: false,
        })}\n`),
      ];
    })));
}

test("QA evidence is content-addressed and tamper-evident", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-qa-evidence-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, "evidence");
  await mkdir(evidenceRoot, { mode: 0o700 });
  const releaseBinding = {
    activationId,
    stageSha256: "1".repeat(64),
    installedSha256: "2".repeat(64),
    releaseCandidateSha256: "3".repeat(64),
    releaseCandidateEvidenceSchemaVersion: 2,
    nodeFloor: {
      executable: "/fixture/node",
      version: "v22.15.0",
      sha256: "4".repeat(64),
      exactFloorVerified: true,
      recheckedAfterSuite: true,
    },
  };
  await seedEvidenceMatrix(evidenceRoot);
  const appRoot = await realpath(new URL("../", import.meta.url).pathname);
  const created = await createQaEvidenceManifest({
    evidenceRoot,
    appRoot,
    activationId,
    releaseBinding,
  });
  assert.match(created.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(created.relativePath, "evidence/manifest.json");
  assert.deepEqual(
    await verifyQaEvidenceManifest({
      evidenceRoot,
      manifestPath: created.manifestPath,
      activationId,
      releaseBinding,
      expectedSha256: created.sha256,
    }),
    { matched: true, sha256: created.sha256, files: 98, bytes: created.bytes },
  );

  await writeFile(join(evidenceRoot, "d4-mobile-320x844.geometry.json"), `${JSON.stringify({
    scenarioId: "d4",
    viewportId: "mobile-320x844",
    browserVersion: "fixture-browser",
    horizontalOverflow: false,
    changed: true,
  })}\n`);
  await assert.rejects(
    verifyQaEvidenceManifest({
      evidenceRoot,
      manifestPath: created.manifestPath,
      activationId,
      releaseBinding,
      expectedSha256: created.sha256,
    }),
    /changed after its manifest was written/,
  );
});

test("QA evidence requires installed boundary and selected-clone proof", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-qa-matrix-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, "evidence");
  await mkdir(evidenceRoot, { mode: 0o700 });
  await seedEvidenceMatrix(evidenceRoot);
  await rename(
    join(evidenceRoot, "playwright", "selected-clone.log"),
    join(evidenceRoot, "playwright", "other-browser-proof.log"),
  );
  const appRoot = await realpath(new URL("../", import.meta.url).pathname);
  await assert.rejects(
    createQaEvidenceManifest({
      evidenceRoot,
      appRoot,
      activationId,
      releaseBinding: {
        activationId,
        stageSha256: "1".repeat(64),
        installedSha256: "2".repeat(64),
        releaseCandidateSha256: "3".repeat(64),
        releaseCandidateEvidenceSchemaVersion: 2,
        nodeFloor: {
          executable: "/fixture/node",
          version: "v22.15.0",
          sha256: "4".repeat(64),
          exactFloorVerified: true,
          recheckedAfterSuite: true,
        },
      },
    }),
    /omitted its installed boundary or selected-clone browser proof/,
  );
});

test("QA evidence rejects a signature-only PNG that cannot decode", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planner-qa-png-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, "evidence");
  await mkdir(evidenceRoot, { mode: 0o700 });
  await seedEvidenceMatrix(evidenceRoot);
  const invalid = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(invalid, 0);
  invalid.write("IHDR", 12, "ascii");
  invalid.writeUInt32BE(320, 16);
  invalid.writeUInt32BE(844, 20);
  await writeFile(join(evidenceRoot, "d4-mobile-320x844.viewport.png"), invalid);
  const appRoot = await realpath(new URL("../", import.meta.url).pathname);
  await assert.rejects(
    createQaEvidenceManifest({
      evidenceRoot,
      appRoot,
      activationId,
      releaseBinding: {
        activationId,
        stageSha256: "1".repeat(64),
        installedSha256: "2".repeat(64),
        releaseCandidateSha256: "3".repeat(64),
        releaseCandidateEvidenceSchemaVersion: 2,
        nodeFloor: {
          executable: "/fixture/node",
          version: "v22.15.0",
          sha256: "4".repeat(64),
          exactFloorVerified: true,
          recheckedAfterSuite: true,
        },
      },
    }),
    /invalid encoding|truncated chunk/,
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { imageSize } from "image-size";

test("Vinext resolves image-size to the secure adapter", () => {
  const resolutionProgram = `
    import assert from "node:assert/strict";
    import { realpathSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    const vinextEntry = import.meta.resolve("vinext");
    const resolved = realpathSync(fileURLToPath(import.meta.resolve("image-size", vinextEntry)));
    assert.match(resolved, /packages\\/image-size-adapter\\/index\\.mjs$/u);
    assert.throws(
      () => import.meta.resolve("image-size", "file:///definitely-not-the-project/vinext/index.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-import-meta-resolve", "--input-type=module", "--eval", resolutionProgram],
    { cwd: process.cwd(), encoding: "utf8", timeout: 2_000 },
  );

  assert.equal(
    result.status,
    0,
    `Vinext did not resolve the secure adapter: ${result.error?.message ?? result.stderr}`,
  );
});

test("secure image-size adapter preserves static PNG dimensions", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  assert.deepEqual(imageSize(png), { width: 1, height: 1, type: "png" });
  assert.deepEqual(imageSize(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)), {
    width: 1,
    height: 1,
    type: "png",
  });
});

test("secure image-size adapter does not interpret a large ICO as a box container", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory.writeUInt16LE(1, 10);
  directory.writeUInt16LE(32, 12);
  directory.writeUInt32LE(png.length, 14);
  directory.writeUInt32LE(directory.length, 18);

  const unsafeBoxAtFirstScanOffset = Buffer.from(
    "000000186674797061766966000000006176696600000000",
    "hex",
  );
  const padding = Buffer.alloc(256 - directory.length - png.length);
  const icon = Buffer.concat([directory, png, padding, unsafeBoxAtFirstScanOffset]);

  assert.ok(icon.length > 256);
  assert.deepEqual(imageSize(icon), {
    width: 256,
    height: 256,
    type: "ico",
  });
});

test("secure image-size adapter rejects every advisory-affected container before parsing", () => {
  const unsafeFtypBrands = ["avif", "mif1", "msf1", "heic", "heix", "hevc", "hevx"];
  const malformedImages = [
    Buffer.from("69636e73000000106963303700000000", "hex"),
    Buffer.from("ff0a", "hex"),
    Buffer.from("0000000c4a584c200d0a870a00000000", "hex"),
    ...unsafeFtypBrands.map((brand) => Buffer.concat([
      Buffer.from("0000001866747970", "hex"),
      Buffer.from(brand, "ascii"),
      Buffer.from("00000000", "hex"),
      Buffer.from(brand, "ascii"),
      Buffer.from("00000000", "hex"),
    ])),
    Buffer.concat([
      Buffer.from("0000000866726565", "hex"),
      Buffer.from("000000186674797068656963000000006865696300000000", "hex"),
    ]),
    Buffer.concat([
      Buffer.from("0000000801020304", "hex"),
      Buffer.from("000000186674797068656963000000006865696300000000", "hex"),
    ]),
  ];

  const childProgram = `
    import { imageSize } from "image-size";
    try {
      imageSize(Buffer.from(process.argv[1], "hex"));
      process.exitCode = 2;
    } catch (error) {
      if (!/Unsupported image container/.test(String(error))) throw error;
    }
  `;

  for (const image of malformedImages) {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", childProgram, image.toString("hex")],
      { cwd: process.cwd(), encoding: "utf8", timeout: 1_000 },
    );
    assert.equal(
      result.status,
      0,
      `unsafe image did not reject within the deadline: ${result.error?.message ?? result.stderr}`,
    );
  }
});

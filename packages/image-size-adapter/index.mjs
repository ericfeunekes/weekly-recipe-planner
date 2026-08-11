import { imageMeta } from "image-meta";

const decoder = new TextDecoder();
const unsafeFtypBrands = new Set(["avif", "mif1", "msf1", "heic", "heix", "hevc", "hevx"]);
const maxContainerBoxes = 1_024;

function readUInt32BE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function isIconDirectory(bytes) {
  if (bytes.length < 6 || bytes[0] !== 0 || bytes[1] !== 0) return false;
  const type = bytes[2] + bytes[3] * 2 ** 8;
  const imageCount = bytes[4] + bytes[5] * 2 ** 8;
  return (type === 1 || type === 2) && imageCount > 0;
}

function looksLikeBoxContainer(bytes) {
  if (bytes.length < 12 || isIconDirectory(bytes)) return false;
  const firstBoxSize = readUInt32BE(bytes, 0);
  return firstBoxSize >= 8 && firstBoxSize <= bytes.length;
}

function rejectUnsafeContainerType(input) {
  // Keep advisory-affected containers out of the parser entirely. Both image-size 2.0.2
  // and its image-meta derivative can loop forever on zero-length boxes (GHSA-w3rx-r6r6-pgpr,
  // GHSA-5p2g-fcmc-qvqq). The planner has no static assets in these formats.
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const signature = decoder.decode(bytes.subarray(0, 4));
  const initialBoxType = decoder.decode(bytes.subarray(4, 8));
  const initialBrand = decoder.decode(bytes.subarray(8, 12));
  if (signature === "icns" || (bytes[0] === 0xff && bytes[1] === 0x0a) || initialBoxType === "JXL ") {
    throw new TypeError("Unsupported image container");
  }
  if (initialBoxType === "ftyp" && unsafeFtypBrands.has(initialBrand)) {
    throw new TypeError("Unsupported image container");
  }
  if (!looksLikeBoxContainer(bytes)) return bytes;
  let offset = 0;
  let boxCount = 0;
  while (offset + 8 <= bytes.length) {
    boxCount += 1;
    if (boxCount > maxContainerBoxes) {
      throw new TypeError("Image container has too many boxes");
    }
    const boxSize = readUInt32BE(bytes, offset);
    const boxType = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const brand = decoder.decode(bytes.subarray(offset + 8, offset + 12));
    if (boxType === "ftyp" && unsafeFtypBrands.has(brand)) {
      throw new TypeError("Unsupported image container");
    }
    if (boxSize < 8 || offset + boxSize > bytes.length) {
      break;
    }
    offset += boxSize;
  }
  return bytes;
}

export function imageSize(input) {
  const bytes = rejectUnsafeContainerType(input);
  const { width, height, type } = imageMeta(bytes);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError("Image dimensions must be positive safe integers");
  }
  return { width, height, type };
}

export default imageSize;

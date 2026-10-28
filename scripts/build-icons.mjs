// Resize the approved artwork for Windows; never redraw or regenerate the mascot.
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const source = readFileSync(
  fileURLToPath(new URL("../desktop/clawd-scope.png", import.meta.url)),
);
const metadata = await sharp(source).metadata();
if (metadata.width !== metadata.height || metadata.width < 256)
  throw new Error(
    "The approved icon must be square and at least 256 pixels wide.",
  );
const images = await Promise.all(
  [16, 20, 24, 32, 40, 48, 64, 128, 256].map(async (size) => ({
    size,
    bytes: await sharp(source)
      .resize(size, size, { kernel: "lanczos3" })
      .ensureAlpha()
      .png()
      .toBuffer(),
  })),
);
const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
images.forEach(({ size, bytes }, index) => {
  const at = 6 + index * 16;
  directory[at] = directory[at + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(bytes.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += bytes.length;
});
writeFileSync(
  fileURLToPath(new URL("../desktop/icon.png", import.meta.url)),
  images.at(-1).bytes,
);
writeFileSync(
  fileURLToPath(new URL("../desktop/icon.ico", import.meta.url)),
  Buffer.concat([directory, ...images.map((image) => image.bytes)]),
);

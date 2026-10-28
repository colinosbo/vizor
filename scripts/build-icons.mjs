// Original Vizor mark: orange V on charcoal, encoded as PNG and multi-size ICO.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type);
  const bytes = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  bytes.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function png(size) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  const polygon = [
    [52, 59],
    [91, 59],
    [128, 157],
    [165, 59],
    [204, 59],
    [146, 204],
    [110, 204],
  ];
  function inside(x, y) {
    let yes = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [a, b] = polygon[i],
        [c, d] = polygon[j];
      if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) yes = !yes;
    }
    return yes;
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const colors = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = ((x + (sx + 0.5) / 4) / size) * 256,
            py = ((y + (sy + 0.5) / 4) / size) * 256;
          const dx = Math.max(28 - px, px - 228, 0),
            dy = Math.max(28 - py, py - 228, 0);
          const color =
            dx * dx + dy * dy > 28 * 28
              ? [0, 0, 0, 0]
              : inside(px, py)
                ? [255, 114, 35, 255]
                : [28, 28, 30, 255];
          color.forEach((value, index) => {
            colors[index] += value / 16;
          });
        }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      colors.forEach((value, index) => {
        data[offset + index] = Math.round(value);
      });
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(data)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const images = [16, 32, 48, 64, 128, 256].map((size) => ({
  size,
  bytes: png(size),
}));
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

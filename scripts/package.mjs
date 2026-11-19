// Build a versioned runtime package: dist/vizor-<version>/ and dist/vizor-<version>.zip.
// Usage: node scripts/package.mjs [--version X.Y.Z] [--out dir]
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const version =
  option("--version") ??
  JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw Error("Invalid version " + version);
const out = resolve(option("--out") ?? join(repo, "dist"));
const name = "vizor-" + version;
const root = join(out, name);
rmSync(root, { recursive: true, force: true });
rmSync(root + ".zip", { force: true });
mkdirSync(join(root, "runtime"), { recursive: true });

// Runtime files only: tests and pilot review notes stay in the repository.
const source = join(repo, "scripts", "initiative-runtime");
for (const entry of ["scripts", "windows", "skills", "README.md"])
  cpSync(join(source, entry), join(root, "runtime", entry), {
    recursive: true,
  });
writeFileSync(join(root, "runtime", "VERSION"), version + "\n");

const files = {};
const walk = (dir, base) => {
  for (const item of readdirSync(dir).sort()) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) walk(path, base);
    else
      files[relative(base, path).split(sep).join("/")] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
  }
};
walk(join(root, "runtime"), join(root, "runtime"));
const manifest = {
  schema: "vizor.package/1",
  version,
  builtAt: new Date().toISOString(),
  files,
};
writeFileSync(
  join(root, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
for (const file of ["setup.mjs", "INSTALL.md", "FIRST-PLAN.md", "examples"])
  cpSync(join(repo, "packaging", file), join(root, file), { recursive: true });

// Minimal ZIP writer (deflate), readable by Windows Expand-Archive and unzip.
const entries = [];
const collect = (dir) => {
  for (const item of readdirSync(dir).sort()) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) collect(path);
    else entries.push(path);
  }
};
collect(root);
const chunks = [];
const central = [];
let offset = 0;
const dos = (() => {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
})();
for (const path of entries) {
  const nameBytes = Buffer.from(relative(out, path).split(sep).join("/"));
  const data = readFileSync(path);
  const packed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dos.time, 10);
  local.writeUInt16LE(dos.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  chunks.push(local, nameBytes, packed);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(dos.time, 12);
  header.writeUInt16LE(dos.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(packed.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE(offset, 42);
  central.push(header, nameBytes);
  offset += local.length + nameBytes.length + packed.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(root + ".zip", Buffer.concat([...chunks, ...central, end]));
const zipHash = createHash("sha256")
  .update(readFileSync(root + ".zip"))
  .digest("hex");
writeFileSync(root + ".zip.sha256", zipHash + "  " + name + ".zip\n");
console.log(
  "Built " + root + ".zip (" + Object.keys(files).length + " runtime files)",
);
console.log("sha256 " + zipHash);
if (!existsSync(join(root, "setup.mjs"))) process.exitCode = 1;

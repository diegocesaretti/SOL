import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const [, , sourceArg, outputArg] = process.argv;
if (!sourceArg || !outputArg) {
  console.error("Usage: node scripts/pack-sol-plugin.mjs <plugin-directory> <output.solplugin>");
  process.exit(2);
}

const source = resolve(sourceArg);
const output = resolve(outputArg);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${full}`);
    if (entry.isDirectory()) result.push(...await filesIn(full));
    else if (entry.isFile()) result.push(full);
  }
  return result.sort();
}

const files = await filesIn(source);
if (!files.some((file) => relative(source, file).replace(/\\/g, "/") === "sol-plugin.json")) {
  throw new Error("Plugin directory must contain sol-plugin.json at its root");
}

const localParts = [];
const centralParts = [];
let localOffset = 0;
for (const file of files) {
  const info = await stat(file);
  const data = await readFile(file);
  const name = relative(source, file).replace(/\\/g, "/");
  const nameBytes = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const { time, date } = dosDateTime(info.mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBytes, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE((info.mode & 0xffff) << 16 >>> 0, 38);
  central.writeUInt32LE(localOffset, 42);
  centralParts.push(central, nameBytes);
  localOffset += local.length + nameBytes.length + data.length;
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(localOffset, 16);
end.writeUInt16LE(0, 20);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([...localParts, centralDirectory, end]));
console.log(`Packed ${files.length} file(s) -> ${output}`);

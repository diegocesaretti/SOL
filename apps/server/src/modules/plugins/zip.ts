import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export interface ZipExtractionOptions {
  maxEntries?: number;
  maxUncompressedBytes?: number;
}

function requireRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) throw new Error(`Invalid ZIP: ${label} is out of bounds`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < 22) throw new Error("Invalid ZIP: archive is too small");
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("Invalid ZIP: central directory was not found");
}

function safeTarget(root: string, rawName: string): { target: string; relative: string; directory: boolean } {
  const normalized = rawName.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe ZIP path: ${rawName}`);
  }
  const directory = normalized.endsWith("/");
  const parts = normalized.split("/").filter((part, index, all) => part || index === all.length - 1 && directory);
  const meaningful = parts.filter(Boolean);
  if (!meaningful.length || meaningful.some((part) => part === "." || part === "..")) {
    throw new Error(`Unsafe ZIP path: ${rawName}`);
  }
  const relative = meaningful.join("/");
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, ...meaningful);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) throw new Error(`Unsafe ZIP path: ${rawName}`);
  return { target, relative, directory };
}

export function extractZipBuffer(buffer: Buffer, destination: string, options: ZipExtractionOptions = {}): string[] {
  const maxEntries = options.maxEntries ?? 2_000;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? 128 * 1024 * 1024;
  const eocd = findEndOfCentralDirectory(buffer);
  requireRange(buffer, eocd, 22, "end of central directory");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 plugin packages are not supported");
  }
  if (totalEntries > maxEntries) throw new Error(`Plugin package contains too many files (${totalEntries})`);
  requireRange(buffer, centralOffset, centralSize, "central directory");

  mkdirSync(destination, { recursive: true });
  let offset = centralOffset;
  let totalUncompressed = 0;
  const extracted: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < totalEntries; index++) {
    requireRange(buffer, offset, 46, "central directory entry");
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE) throw new Error("Invalid ZIP: malformed central directory entry");

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    requireRange(buffer, offset + 46, nameLength + extraLength + commentLength, "central directory filename");

    if (flags & 0x1) throw new Error("Encrypted plugin packages are not supported");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);

    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const safe = safeTarget(destination, rawName);
    if (seen.has(safe.relative)) throw new Error(`Duplicate ZIP entry: ${safe.relative}`);
    seen.add(safe.relative);

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`Symbolic links are not allowed in plugin packages: ${safe.relative}`);

    if (safe.directory) {
      mkdirSync(safe.target, { recursive: true });
      extracted.push(`${safe.relative}/`);
      offset += 46 + nameLength + extraLength + commentLength;
      continue;
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) throw new Error("Plugin package expands beyond the allowed size");

    requireRange(buffer, localHeaderOffset, 30, "local file header");
    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE) throw new Error(`Invalid ZIP local header for ${safe.relative}`);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    requireRange(buffer, dataOffset, compressedSize, `compressed data for ${safe.relative}`);
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) throw new Error(`Invalid uncompressed size for ${safe.relative}`);

    mkdirSync(dirname(safe.target), { recursive: true });
    writeFileSync(safe.target, data);
    if (unixMode && (unixMode & 0o111)) chmodSync(safe.target, unixMode & 0o777);
    extracted.push(safe.relative);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return extracted;
}

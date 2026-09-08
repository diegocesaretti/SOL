import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager } from "../modules/plugins/manager.js";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const packageManifest = {
  schemaVersion: 2 as const,
  id: "manifest-match-test",
  name: "Manifest Match Test",
  version: "1.0.0",
  runtime: "node" as const,
  entry: "index.mjs",
  autoStart: false,
  restartPolicy: "never" as const,
  capabilities: ["demo.health"],
  requires: ["plugin-api.v1"],
  permissions: [],
};

const expectedManifest = {
  schemaVersion: packageManifest.schemaVersion,
  id: packageManifest.id,
  name: packageManifest.name,
  version: packageManifest.version,
  capabilities: packageManifest.capabilities,
  requires: packageManifest.requires,
  permissions: packageManifest.permissions,
};

function packageBytes(): Buffer {
  return storedZip({
    "sol-plugin.json": JSON.stringify(packageManifest),
    "index.mjs": "process.exit(0);\n",
  });
}

test("GitHub install rejects a package whose host requirements differ from its repository descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-plugin-manifest-mismatch-"));
  const manager = new PluginManager({ rootDir: root, coreUrl: "http://127.0.0.1:3000" });
  try {
    await assert.rejects(
      () => manager.installPackage(packageBytes(), {
        expectedManifest: { ...expectedManifest, requires: [] },
      }),
      /github_plugin_package_manifest_mismatch/,
    );
    assert.deepEqual(await manager.list(), []);
  } finally {
    await manager.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub install accepts a package whose schema, capabilities and requirements match its descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-plugin-manifest-match-"));
  const manager = new PluginManager({ rootDir: root, coreUrl: "http://127.0.0.1:3000" });
  try {
    const installed = await manager.installPackage(packageBytes(), { expectedManifest });
    assert.equal(installed.manifest.schemaVersion, 2);
    assert.deepEqual(installed.manifest.requires, ["plugin-api.v1"]);
    assert.deepEqual(installed.manifest.capabilities, ["demo.health"]);
  } finally {
    await manager.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

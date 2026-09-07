import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginManager } from "./manager.js";
import { extractZipBuffer } from "./zip.js";

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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for plugin state");
}

test("PluginManager installs, starts, reports health, restarts, stops and uninstalls a .solplugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-plugin-test-"));
  const manager = new PluginManager({ rootDir: root, coreUrl: "http://127.0.0.1:3000" });
  try {
    const manifest = {
      schemaVersion: 1,
      id: "hello-test",
      name: "Hello Test",
      version: "1.0.0",
      runtime: "node",
      entry: "index.mjs",
      autoStart: false,
      restartPolicy: "on-failure",
      capabilities: ["demo.health"],
      permissions: [],
    };
    const script = `
console.log(JSON.stringify({type:'sol.plugin.ready',health:'healthy',details:{test:true}}));
console.log(JSON.stringify({type:'sol.plugin.log',level:'info',message:'hello from test'}));
setInterval(()=>{},1000);
process.on('SIGTERM',()=>process.exit(0));
`;
    const installed = await manager.installPackage(storedZip({
      "sol-plugin.json": JSON.stringify(manifest),
      "index.mjs": script,
    }));
    assert.equal(installed.manifest.id, "hello-test");
    assert.equal(installed.state, "stopped");
    assert.equal(installed.enabled, false);

    const started = await manager.start("hello-test");
    assert.equal(started.state, "running");
    assert.ok(started.pid);
    await waitFor(async () => (await manager.get("hello-test")).health === "healthy");
    assert.ok((await manager.getLogs("hello-test")).some((entry) => entry.message.includes("hello from test")));

    const restarted = await manager.restart("hello-test");
    assert.equal(restarted.state, "running");
    assert.ok(restarted.pid);

    const stopped = await manager.stop("hello-test");
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.enabled, false);

    await manager.uninstall("hello-test");
    assert.deepEqual(await manager.list(), []);
  } finally {
    await manager.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP extractor rejects path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-plugin-zip-test-"));
  try {
    assert.throws(() => extractZipBuffer(storedZip({ "../escape.txt": "nope" }), root), /Unsafe ZIP path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

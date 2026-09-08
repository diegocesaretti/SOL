import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SafePluginManager } from "./safe-manager.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const packScript = join(repoRoot, "scripts", "pack-sol-plugin.mjs");

interface PackageOptions {
  version: string;
  permissions?: string[];
  autoStart?: boolean;
  runtime?: "node" | "executable";
  executable?: boolean;
}

async function makePackage(work: string, options: PackageOptions): Promise<Buffer> {
  const source = join(work, `source-${options.version.replace(/[^a-z0-9]/gi, "-")}-${Math.random().toString(16).slice(2)}`);
  const output = join(work, `plugin-${options.version}-${Math.random().toString(16).slice(2)}.solplugin`);
  await mkdir(source, { recursive: true });
  const entry = options.runtime === "executable" ? "plugin-entry" : "index.mjs";
  await writeFile(join(source, "sol-plugin.json"), JSON.stringify({
    schemaVersion: 2,
    id: "upgrade-test",
    name: "Upgrade Test",
    version: options.version,
    runtime: options.runtime ?? "node",
    entry,
    args: [],
    autoStart: options.autoStart ?? false,
    restartPolicy: "never",
    capabilities: [],
    requires: ["plugin-api.v1", "filesystem.plugin-data"],
    permissions: options.permissions ?? ["network.local"],
    settings: [
      { key: "token", label: "Token", type: "secret", required: true },
      { key: "label", label: "Label", type: "text", default: "default-label" },
      ...(options.version === "1.0.0" ? [] : [{ key: "new_option", label: "New option", type: "boolean", default: true }]),
    ],
  }, null, 2));
  await writeFile(join(source, entry), options.runtime === "executable"
    ? "not a native executable\n"
    : "setInterval(() => {}, 10000);\n");
  if (options.runtime === "executable" && options.executable) await chmod(join(source, entry), 0o755);
  await execFileAsync(process.execPath, [packScript, source, output], { cwd: repoRoot });
  return readFile(output);
}

async function fixture() {
  const work = await mkdtemp(join(tmpdir(), "sol-safe-plugin-"));
  const rootDir = join(work, "state", "plugins");
  const manager = new SafePluginManager({ rootDir, coreUrl: "http://127.0.0.1:39999" });
  return { work, rootDir, manager };
}

test("in-place upgrade preserves settings, scope and plugin-data", async () => {
  const { work, rootDir, manager } = await fixture();
  try {
    const first = await makePackage(work, { version: "1.0.0" });
    await manager.installPackage(first, {
      approvedPermissions: ["network.local"],
      settings: { token: "secret-value", label: "custom-label" },
      scope: { householdId: "11111111-1111-1111-1111-111111111111", memberId: "22222222-2222-2222-2222-222222222222" },
    });
    const dataFile = join(rootDir, "..", "plugin-data", "upgrade-test", "session.txt");
    await mkdir(join(dataFile, ".."), { recursive: true });
    await writeFile(dataFile, "keep-me");

    const second = await makePackage(work, { version: "1.1.0" });
    const updated = await manager.upgradePackage("upgrade-test", second);
    assert.equal(updated.manifest.version, "1.1.0");
    assert.equal(updated.settings.token, "secret-value");
    assert.equal(updated.settings.label, "custom-label");
    assert.equal(updated.settings.new_option, true);
    assert.equal(updated.scope?.householdId, "11111111-1111-1111-1111-111111111111");
    assert.equal(await readFile(dataFile, "utf8"), "keep-me");
  } finally {
    await manager.shutdown().catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
});

test("upgrade requiring new permissions leaves the installed version untouched", async () => {
  const { work, manager } = await fixture();
  try {
    const first = await makePackage(work, { version: "1.0.0" });
    await manager.installPackage(first, {
      approvedPermissions: ["network.local"],
      settings: { token: "secret-value" },
    });
    const second = await makePackage(work, { version: "1.1.0", permissions: ["network.local", "mcp.register"] });
    await assert.rejects(
      manager.upgradePackage("upgrade-test", second),
      /plugin_update_permissions_required:mcp\.register/,
    );
    assert.equal((await manager.get("upgrade-test")).manifest.version, "1.0.0");
    assert.equal((await manager.getSettings("upgrade-test")).values.token, "secret-value");
  } finally {
    await manager.shutdown().catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
});

test("failed replacement start restores the previous package and state", async () => {
  const { work, manager } = await fixture();
  try {
    const first = await makePackage(work, { version: "1.0.0" });
    await manager.installPackage(first, {
      approvedPermissions: ["network.local"],
      settings: { token: "before-rollback" },
    });
    const broken = await makePackage(work, {
      version: "1.1.0",
      runtime: "executable",
      autoStart: true,
      executable: false,
    });
    await assert.rejects(
      manager.upgradePackage("upgrade-test", broken),
      /plugin_update_rolled_back:/,
    );
    const restored = await manager.get("upgrade-test");
    assert.equal(restored.manifest.version, "1.0.0");
    assert.equal((await manager.getSettings("upgrade-test")).values.token, "before-rollback");
  } finally {
    await manager.shutdown().catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
});

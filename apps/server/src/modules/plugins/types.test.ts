import assert from "node:assert/strict";
import test from "node:test";
import { validatePluginManifest } from "./types.js";

function manifest(schemaVersion: 1 | 2, requires?: string[]) {
  return {
    schemaVersion,
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    runtime: "node",
    entry: "index.mjs",
    autoStart: false,
    restartPolicy: "never",
    capabilities: [],
    permissions: [],
    ...(requires === undefined ? {} : { requires }),
  };
}

test("plugin schema v1 remains backward compatible", () => {
  const parsed = validatePluginManifest(manifest(1));
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.requires, []);
});

test("plugin schema v1 cannot silently declare host requirements", () => {
  assert.throws(
    () => validatePluginManifest(manifest(1, ["plugin-api.v1"])),
    /requires is only supported by plugin schemaVersion 2/,
  );
});

test("plugin schema v2 accepts supported host capability requirements", () => {
  const parsed = validatePluginManifest(manifest(2, [
    "plugin-api.v1",
    "input.register",
    "input.write",
    "input.status",
    "identity.v1",
    "identity.read",
    "connections.read",
    "connections.write",
    "credentials.v1",
    "credentials.read",
    "credentials.write",
    "oauth.v1",
    "mcp.register",
    "mcp.invoke.read",
    "filesystem.plugin-data",
  ]));
  assert.deepEqual(parsed.requires, [
    "plugin-api.v1",
    "input.register",
    "input.write",
    "input.status",
    "identity.v1",
    "identity.read",
    "connections.read",
    "connections.write",
    "credentials.v1",
    "credentials.read",
    "credentials.write",
    "oauth.v1",
    "mcp.register",
    "mcp.invoke.read",
    "filesystem.plugin-data",
  ]);
});

test("plugin schema v2 rejects capabilities unavailable in this SOL host", () => {
  assert.throws(
    () => validatePluginManifest(manifest(2, ["future.speaker-identification.v9"])),
    /plugin_host_capabilities_required:future\.speaker-identification\.v9/,
  );
});

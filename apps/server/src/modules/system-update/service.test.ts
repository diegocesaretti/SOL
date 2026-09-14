import assert from "node:assert/strict";
import test from "node:test";
import { compareSystemVersions, isSystemUpdateAvailable, parseUpdateManifest } from "./service.js";

test("compares stable system versions", () => {
  assert.equal(compareSystemVersions("0.14.0", "0.13.9"), 1);
  assert.equal(compareSystemVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareSystemVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareSystemVersions("2.0.0", "10.0.0"), -1);
});

test("stable updater requires a higher version, not only a different commit", () => {
  const installed = { version: "0.15.4", commit: "a".repeat(40) };
  const base = {
    schemaVersion: 1 as const,
    channel: "stable" as const,
    version: "0.15.4",
    commit: "b".repeat(40),
    downloadUrl: "https://github.com/diegocesaretti/SOL/releases/download/sol-windows-latest/SOL-Windows.zip",
    sha256: "c".repeat(64),
    publishedAt: "2026-09-14T12:00:00Z",
  };
  assert.equal(isSystemUpdateAvailable(installed, base), false);
  assert.equal(isSystemUpdateAvailable(installed, { ...base, version: "0.15.5" }), true);
});

test("validates update manifests before they can reach the updater", () => {
  const manifest = parseUpdateManifest({
    schemaVersion: 1,
    channel: "stable",
    version: "0.14.0",
    commit: "a".repeat(40),
    downloadUrl: "https://github.com/diegocesaretti/SOL/releases/download/sol-windows-latest/SOL-Windows.zip",
    sha256: "b".repeat(64),
    publishedAt: "2026-09-09T12:00:00Z",
  });
  assert.equal(manifest.version, "0.14.0");
  assert.equal(manifest.commit, "a".repeat(40));
  assert.equal(manifest.sha256, "b".repeat(64));

  assert.throws(() => parseUpdateManifest({
    ...manifest,
    downloadUrl: "http://example.test/SOL-Windows.zip",
  }), /system_update_manifest_invalid_url/);
  assert.throws(() => parseUpdateManifest({
    ...manifest,
    sha256: "not-a-hash",
  }), /system_update_manifest_invalid_sha256/);
});

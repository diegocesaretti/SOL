import test from "node:test";
import assert from "node:assert/strict";
import { validatePluginManifest, validateSettingValues } from "./types.js";

function manifestWithSetting(setting: Record<string, unknown>) {
  return validatePluginManifest({
    schemaVersion: 2,
    id: "dynamic-options-test",
    name: "Dynamic options test",
    version: "1.0.0",
    runtime: "node",
    entry: "entry.mjs",
    args: [],
    autoStart: false,
    restartPolicy: "never",
    capabilities: [],
    requires: [],
    permissions: [],
    settings: [
      {
        key: "options_port",
        label: "Options port",
        type: "number",
        required: false,
        default: 8768,
        min: 1024,
        max: 65535,
      },
      setting,
    ],
  });
}

test("dynamic select accepts optionsSource plus a static fallback", () => {
  const manifest = manifestWithSetting({
    key: "provider",
    label: "Provider",
    type: "select",
    required: false,
    default: "manual",
    options: [{ value: "manual", label: "Manual" }],
    optionsSource: {
      type: "plugin-http",
      portSetting: "options_port",
      path: "/options/providers",
    },
  });

  const provider = manifest.settings.find((setting) => setting.key === "provider");
  assert.deepEqual(provider?.optionsSource, {
    type: "plugin-http",
    portSetting: "options_port",
    path: "/options/providers",
  });
  assert.deepEqual(validateSettingValues(manifest.settings, {
    options_port: 8768,
    provider: "com.example.latino",
  }), {
    options_port: 8768,
    provider: "com.example.latino",
  });
});

test("static selects keep rejecting values outside declared options", () => {
  const manifest = manifestWithSetting({
    key: "provider",
    label: "Provider",
    type: "select",
    required: false,
    default: "manual",
    options: [{ value: "manual", label: "Manual" }],
  });
  assert.throws(
    () => validateSettingValues(manifest.settings, { provider: "com.example.latino" }),
    /must match one of its options/,
  );
});

test("dynamic select source rejects unsafe paths", () => {
  assert.throws(() => manifestWithSetting({
    key: "provider",
    label: "Provider",
    type: "select",
    required: false,
    optionsSource: {
      type: "plugin-http",
      portSetting: "options_port",
      path: "https://example.com/options",
    },
  }), /absolute local path/);
});

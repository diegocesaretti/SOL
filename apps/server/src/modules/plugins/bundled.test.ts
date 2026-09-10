import assert from "node:assert/strict";
import test from "node:test";
import { decideBundledPluginAction } from "./bundled.js";

test("installs a missing bundled plugin only when a member scope exists", () => {
  assert.equal(decideBundledPluginAction(undefined, "1.0.0", true), "install");
  assert.equal(decideBundledPluginAction(undefined, "1.0.0", false), "skip-no-scope");
});

test("upgrades only when the bundled semantic version is newer", () => {
  assert.equal(decideBundledPluginAction("1.4.2", "1.5.0", true), "upgrade");
  assert.equal(decideBundledPluginAction("1.5.0", "1.5.0", true), "skip");
  assert.equal(decideBundledPluginAction("1.6.0", "1.5.0", true), "skip");
});

test("stable releases outrank prereleases at the same semantic version", () => {
  assert.equal(decideBundledPluginAction("2.0.0-beta.2", "2.0.0", true), "upgrade");
  assert.equal(decideBundledPluginAction("2.0.0", "2.0.0-beta.3", true), "skip");
});

import test from "node:test";
import assert from "node:assert/strict";
import { windowsAutostartCommand, windowsLauncherPath } from "./autostart.js";

test("Windows autostart points at the portable SOL launcher in background mode", () => {
  const root = "C:\\Program Files\\SOL";
  assert.equal(windowsLauncherPath(root), "C:\\Program Files\\SOL\\SOL.exe");
  assert.equal(windowsAutostartCommand(root), '"C:\\Program Files\\SOL\\SOL.exe" --background');
});

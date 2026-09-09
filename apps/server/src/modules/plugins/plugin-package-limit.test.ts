import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedLimit = 256 * 1024 * 1024;

test("plugin runtime and upload route share the 256 MB package limit", async () => {
  const runtime = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
  const routes = await readFile(new URL("./routes.ts", import.meta.url), "utf8");

  assert.match(runtime, /pluginPackageMaxBytes\s*=\s*256\s*\*\s*1024\s*\*\s*1024/);
  assert.match(routes, /readBinary\(request,\s*pluginPackageMaxBytes\)/);
  assert.match(routes, /contentLengthExceeds\(request,\s*pluginPackageMaxBytes\)/);
  assert.equal(expectedLimit, 268_435_456);
});

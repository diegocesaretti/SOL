import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const source = resolve("plugins/sol-agent");
const output = resolve("dist/SOLAgent-0.3.1-pi-experimental.solplugin");
const stage = await mkdtemp(join(tmpdir(), "sol-agent-pi-"));
const src = join(stage, "plugin");

function run(command, args, cwd) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, {
      cwd, stdio: "inherit", shell: process.platform === "win32", windowsHide: true
    });
    child.on("error", fail);
    child.on("close", code => code === 0 ? ok() : fail(new Error(command + " exited " + code)));
  });
}
async function unlinkSymlinks(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // npm CLI symlinks are not required by our SDK, and SOL package
      // validation intentionally rejects all symlinks.
      await rm(full, { force: true });
    } else if (entry.isDirectory()) await unlinkSymlinks(full);
  }
}
async function totalBytes(dir) {
  let sum = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) sum += await totalBytes(file);
    else if (entry.isFile()) sum += (await stat(file)).size;
  }
  return sum;
}
try {
  await cp(source, src, {
    recursive: true,
    filter: path => !/(?:^|[\\/])(?:node_modules|\\.data|dist|\\.git)(?:[\\/]|$)/.test(path)
  });
  const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(join(src, "package.json"), "utf8"));
  if (pkg.dependencies?.["@earendil-works/pi-coding-agent"] !== "1.4.0") throw new Error("pi_sdk_not_pinned");
  await (await import("node:fs/promises")).access(join(src, "package-lock.json"));
  await run(process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], src);
  await unlinkSymlinks(join(src, "node_modules"));
  const bytes = await totalBytes(src);
  if (bytes > 180 * 1024 * 1024) throw new Error("plugin_too_large:" + bytes);
  await run(process.execPath, ["scripts/pack-sol-plugin.mjs", src, output], process.cwd());
  console.log("Experimental plugin packaged: " + output + " (" + bytes + " input bytes)");
} finally {
  await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

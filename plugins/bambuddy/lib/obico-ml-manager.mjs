import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function tailText(path, maxBytes = 32 * 1024) {
  try {
    const raw = await readFile(path);
    return raw.subarray(Math.max(0, raw.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

export function createObicoMlManager({ dataDir, port = 3333, enabled = true }) {
  const root = join(dataDir, "obico-ml");
  const launchScript = join(root, "launch.ps1");
  const bootstrapScript = join(process.env.SOL_PLUGIN_ROOT || process.cwd(), "obico-ml", "bootstrap.ps1");
  const healthUrl = `http://127.0.0.1:${port}/hc/`;

  async function health() {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      const body = (await response.text()).trim();
      return { ok: response.ok && body.toLowerCase() === "ok", statusCode: response.status, body };
    } catch (error) {
      return { ok: false, statusCode: null, body: null, error: error?.message || String(error) };
    }
  }

  async function status() {
    const [runtimeInstalled, modelInstalled, venvInstalled, currentHealth, log] = await Promise.all([
      exists(launchScript),
      exists(join(root, "models", "model-weights.onnx")),
      exists(join(root, "venv", "Scripts", "python.exe")),
      health(),
      tailText(join(root, "logs", "obico-ml.out.log"))
    ]);
    const providerMatch = [...log.matchAll(/providers=\[([^\]]+)\]/g)].at(-1);
    const providers = providerMatch
      ? providerMatch[1].split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
      : [];
    return {
      enabled,
      root,
      port,
      health: currentHealth,
      installed: runtimeInstalled && modelInstalled && venvInstalled,
      runtimeInstalled,
      modelInstalled,
      venvInstalled,
      providers,
      gpuActive: providers.includes("CUDAExecutionProvider"),
      bootstrapAvailable: await exists(bootstrapScript)
    };
  }

  async function runPowerShell(script, args = [], timeoutMs = 15000) {
    return await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args
      ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("powershell_timeout"));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        else reject(new Error(stderr.trim() || stdout.trim() || `powershell_exit_${code}`));
      });
    });
  }

  async function start() {
    if (!enabled) return { ok: false, skipped: "managed_obico_disabled", status: await status() };
    const before = await status();
    if (before.health.ok) return { ok: true, alreadyRunning: true, status: before };
    if (!before.installed) return { ok: false, installed: false, bootstrapAvailable: before.bootstrapAvailable, status: before };
    const launch = await runPowerShell(launchScript, [], 15000);
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const h = await health();
      if (h.ok) return { ok: true, alreadyRunning: false, launch, status: await status() };
    }
    return { ok: false, error: "obico_ml_health_timeout", launch, status: await status() };
  }

  async function stop() {
    const script = `
$root = ${JSON.stringify(root)}
$port = ${port}
$c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $c) { Write-Output "NOT_RUNNING"; exit 0 }
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
if (-not $p.CommandLine -or $p.CommandLine -notlike "*$root*") { throw "Refusing to stop non-managed listener PID $($c.OwningProcess)" }
Stop-Process -Id $c.OwningProcess -Force
Write-Output "STOPPED PID=$($c.OwningProcess)"
`;
    return await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (x) => { stdout += x.toString(); });
      child.stderr.on("data", (x) => { stderr += x.toString(); });
      child.on("error", reject);
      child.on("exit", async (code) => {
        if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `powershell_exit_${code}`));
        await sleep(500);
        resolve({ ok: true, stdout: stdout.trim(), status: await status() });
      });
    });
  }

  async function restart() {
    await stop().catch(() => undefined);
    return await start();
  }

  async function bootstrap() {
    if (!(await exists(bootstrapScript))) throw new Error("obico_bootstrap_script_missing");
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bootstrapScript,
      "-DataDir", dataDir
    ], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SOL_PLUGIN_DATA_DIR: dataDir }
    });
    child.unref();
    return { ok: true, launched: true, root, note: "Bootstrap runs asynchronously; check bambuddy_obico_status for progress." };
  }

  return { root, port, healthUrl, status, start, stop, restart, bootstrap };
}

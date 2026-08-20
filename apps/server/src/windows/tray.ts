import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { config } from "../config.js";

let trayProcess: ChildProcess | undefined;

export function startWindowsTray(): void {
  if (process.platform !== "win32") return;
  if (process.env.SOL_TRAY?.trim().toLowerCase() === "false") return;
  if (trayProcess && !trayProcess.killed) return;
  const script = join(config.repoRoot, "scripts", "windows", "sol-tray.ps1");
  trayProcess = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-HostName", config.host, "-Port", String(config.port)],
    { windowsHide: true, stdio: "ignore" },
  );
  trayProcess.once("exit", () => { trayProcess = undefined; });
  trayProcess.once("error", (error) => {
    console.error("SOL Windows tray failed to start", error);
    trayProcess = undefined;
  });
}

export function stopWindowsTray(): void {
  if (!trayProcess) return;
  trayProcess.kill();
  trayProcess = undefined;
}

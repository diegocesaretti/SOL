import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const AUTOSTART_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_VALUE = "SOLFull";

export interface WindowsAutostartStatus {
  supported: boolean;
  enabled: boolean;
  command?: string;
}

export function windowsLauncherPath(root = config.repoRoot): string {
  return win32.resolve(root, "SOL.exe");
}

export function windowsAutostartCommand(root = config.repoRoot): string {
  return `"${windowsLauncherPath(root)}" --background`;
}

function commandFromRegQuery(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes(AUTOSTART_VALUE) || !line.includes("REG_SZ")) continue;
    const marker = line.indexOf("REG_SZ");
    const value = line.slice(marker + "REG_SZ".length).trim();
    return value || undefined;
  }
  return undefined;
}

export async function getWindowsAutostart(): Promise<WindowsAutostartStatus> {
  if (process.platform !== "win32") return { supported: false, enabled: false };
  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", AUTOSTART_KEY, "/v", AUTOSTART_VALUE],
      { windowsHide: true },
    );
    const command = commandFromRegQuery(stdout);
    return {
      supported: true,
      enabled: Boolean(command),
      ...(command ? { command } : {}),
    };
  } catch {
    return { supported: true, enabled: false };
  }
}

export async function setWindowsAutostart(enabled: boolean): Promise<WindowsAutostartStatus> {
  if (process.platform !== "win32") throw new Error("windows_autostart_unavailable");

  if (enabled) {
    await execFileAsync(
      "reg.exe",
      [
        "add",
        AUTOSTART_KEY,
        "/v",
        AUTOSTART_VALUE,
        "/t",
        "REG_SZ",
        "/d",
        windowsAutostartCommand(),
        "/f",
      ],
      { windowsHide: true },
    );
  } else {
    await execFileAsync(
      "reg.exe",
      ["delete", AUTOSTART_KEY, "/v", AUTOSTART_VALUE, "/f"],
      { windowsHide: true },
    ).catch(() => undefined);
  }

  return await getWindowsAutostart();
}

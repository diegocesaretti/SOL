import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../../config.js";

const DEFAULT_UPDATE_MANIFEST_URL =
  "https://github.com/diegocesaretti/SOL/releases/download/sol-windows-latest/update-manifest.json";
const UPDATE_CACHE_MS = 15 * 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export interface SystemBuildInfo {
  version: string;
  commit: string;
}

export interface SystemUpdateManifest {
  schemaVersion: 1;
  channel: "stable";
  version: string;
  commit: string;
  downloadUrl: string;
  sha256: string;
  publishedAt: string;
}

export interface SystemUpdateStatus {
  installed: SystemBuildInfo;
  latest: SystemUpdateManifest;
  updateAvailable: boolean;
  canInstall: boolean;
  installUnavailableReason?: string;
}

interface CachedManifest {
  manifest: SystemUpdateManifest;
  fetchedAt: number;
}

let cachedManifest: CachedManifest | undefined;

function updateManifestUrl(): string {
  return process.env.SOL_UPDATE_MANIFEST_URL?.trim() || DEFAULT_UPDATE_MANIFEST_URL;
}

function semverParts(version: string): [number, number, number, string] {
  const [core, prerelease = ""] = version.split("-", 2);
  const [major, minor, patch] = core!.split(".").map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0, prerelease];
}

export function compareSystemVersions(a: string, b: string): number {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (left[3] === right[3]) return 0;
  if (!left[3]) return 1;
  if (!right[3]) return -1;
  return left[3].localeCompare(right[3]);
}

export function parseUpdateManifest(value: unknown): SystemUpdateManifest {
  if (!value || typeof value !== "object") throw new Error("system_update_manifest_invalid");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || input.channel !== "stable") {
    throw new Error("system_update_manifest_invalid");
  }
  if (typeof input.version !== "string" || !VERSION_PATTERN.test(input.version)) {
    throw new Error("system_update_manifest_invalid_version");
  }
  if (typeof input.commit !== "string" || !COMMIT_PATTERN.test(input.commit)) {
    throw new Error("system_update_manifest_invalid_commit");
  }
  if (typeof input.sha256 !== "string" || !SHA256_PATTERN.test(input.sha256)) {
    throw new Error("system_update_manifest_invalid_sha256");
  }
  if (typeof input.downloadUrl !== "string") throw new Error("system_update_manifest_invalid_url");
  let download: URL;
  try {
    download = new URL(input.downloadUrl);
  } catch {
    throw new Error("system_update_manifest_invalid_url");
  }
  if (download.protocol !== "https:") throw new Error("system_update_manifest_invalid_url");
  if (typeof input.publishedAt !== "string" || Number.isNaN(Date.parse(input.publishedAt))) {
    throw new Error("system_update_manifest_invalid_published_at");
  }
  return {
    schemaVersion: 1,
    channel: "stable",
    version: input.version,
    commit: input.commit.toLowerCase(),
    downloadUrl: download.toString(),
    sha256: input.sha256.toLowerCase(),
    publishedAt: input.publishedAt,
  };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function installedSystemBuild(): Promise<SystemBuildInfo> {
  const packaged = await readJsonFile(resolve(config.repoRoot, "version.json"));
  if (
    typeof packaged?.version === "string" && VERSION_PATTERN.test(packaged.version) &&
    typeof packaged?.commit === "string" && COMMIT_PATTERN.test(packaged.commit)
  ) {
    return { version: packaged.version, commit: packaged.commit.toLowerCase() };
  }

  const rootPackage = await readJsonFile(resolve(config.repoRoot, "package.json"));
  const version = typeof rootPackage?.version === "string" && VERSION_PATTERN.test(rootPackage.version)
    ? rootPackage.version
    : "0.0.0";
  return { version, commit: "development" };
}

async function latestManifest(force = false): Promise<SystemUpdateManifest> {
  if (!force && cachedManifest && Date.now() - cachedManifest.fetchedAt < UPDATE_CACHE_MS) {
    return cachedManifest.manifest;
  }

  let response: Response;
  try {
    response = await fetch(updateManifestUrl(), {
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": "SOL-Core-Updater" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new Error(`system_update_check_failed:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`system_update_manifest_http_${response.status}`);
  const manifest = parseUpdateManifest(await response.json());
  cachedManifest = { manifest, fetchedAt: Date.now() };
  return manifest;
}

async function updaterAvailable(): Promise<{ ok: boolean; reason?: string }> {
  if (process.platform !== "win32") return { ok: false, reason: "windows_portable_required" };
  if (!/^\d+$/.test(process.env.SOL_LAUNCHER_PID?.trim() ?? "")) {
    return { ok: false, reason: "sol_launcher_required" };
  }
  try {
    await access(resolve(config.repoRoot, "SOL.Updater.exe"));
    return { ok: true };
  } catch {
    return { ok: false, reason: "updater_not_bundled" };
  }
}

export async function systemUpdateStatus(force = false): Promise<SystemUpdateStatus> {
  const [installed, latest, updater] = await Promise.all([
    installedSystemBuild(),
    latestManifest(force),
    updaterAvailable(),
  ]);
  const versionComparison = compareSystemVersions(latest.version, installed.version);
  const sameVersionDifferentPackagedCommit =
    versionComparison === 0 && installed.commit !== "development" && latest.commit !== installed.commit;
  const updateAvailable = versionComparison > 0 || sameVersionDifferentPackagedCommit;
  return {
    installed,
    latest,
    updateAvailable,
    canInstall: updater.ok,
    installUnavailableReason: updater.reason,
  };
}

export async function prepareSystemUpdate(): Promise<SystemUpdateManifest> {
  const status = await systemUpdateStatus(true);
  if (!status.updateAvailable) throw new Error("system_update_not_available");
  if (!status.canInstall) {
    throw new Error(`system_update_install_unavailable:${status.installUnavailableReason ?? "unknown"}`);
  }

  await mkdir(config.dataDir, { recursive: true });
  const target = resolve(config.dataDir, "system-update-request.json");
  const temporary = `${target}.tmp`;
  const request = {
    schemaVersion: 1,
    version: status.latest.version,
    commit: status.latest.commit,
    downloadUrl: status.latest.downloadUrl,
    sha256: status.latest.sha256,
    publishedAt: status.latest.publishedAt,
    requestedAt: new Date().toISOString(),
    port: config.port,
  };
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return status.latest;
}

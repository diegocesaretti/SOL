import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { config } from "../../config.js";
import { db } from "../../database/client.js";
import { comparePluginVersions, type SafePluginManager } from "./safe-manager.js";
import type { SolPluginScope, SolPluginSource } from "./types.js";

interface BundledPluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  file: string;
  sha256?: string;
  repository?: string;
  releaseTag?: string;
}

interface BundledPluginCatalog {
  schemaVersion: 1;
  generatedAt?: string;
  plugins: BundledPluginCatalogEntry[];
}

export type BundledPluginAction = "install" | "upgrade" | "skip" | "skip-no-scope";

export interface BundledPluginSyncResult {
  id: string;
  bundledVersion: string;
  installedVersion?: string;
  action: BundledPluginAction | "error";
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validCatalogEntry(value: unknown): value is BundledPluginCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BundledPluginCatalogEntry>;
  if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id)) return false;
  if (typeof entry.name !== "string" || !entry.name.trim()) return false;
  if (typeof entry.version !== "string" || !entry.version.trim()) return false;
  if (typeof entry.file !== "string" || !entry.file.endsWith(".solplugin")) return false;
  if (entry.file !== basename(entry.file) || /[\\/]/.test(entry.file)) return false;
  if (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(entry.sha256)) return false;
  return true;
}

function parseCatalog(raw: string): BundledPluginCatalog {
  const value = JSON.parse(raw) as Partial<BundledPluginCatalog>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.plugins) || value.plugins.some((entry) => !validCatalogEntry(entry))) {
    throw new Error("bundled_plugin_catalog_invalid");
  }
  const ids = new Set<string>();
  for (const entry of value.plugins) {
    if (ids.has(entry.id)) throw new Error(`bundled_plugin_catalog_duplicate:${entry.id}`);
    ids.add(entry.id);
  }
  return value as BundledPluginCatalog;
}

export function decideBundledPluginAction(
  installedVersion: string | undefined,
  bundledVersion: string,
  hasScope: boolean,
): BundledPluginAction {
  if (!installedVersion) return hasScope ? "install" : "skip-no-scope";
  return comparePluginVersions(bundledVersion, installedVersion) > 0 ? "upgrade" : "skip";
}

async function defaultOwnerScope(): Promise<SolPluginScope | undefined> {
  const result = await db.query<{ household_id: string; member_id: string }>(
    `SELECT household_id, id AS member_id
       FROM members
      WHERE role = 'owner' AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 2`,
  );
  if (result.rows.length !== 1) return undefined;
  const row = result.rows[0];
  return row ? { householdId: row.household_id, memberId: row.member_id } : undefined;
}

function sourceFor(entry: BundledPluginCatalogEntry): SolPluginSource {
  return {
    type: entry.repository ? "github" : "file",
    repository: entry.repository,
    releaseTag: entry.releaseTag,
    installedAt: new Date().toISOString(),
  };
}

function bundleDirectory(): string {
  const explicit = process.env.SOL_BUNDLED_PLUGINS_DIR?.trim();
  return resolve(explicit || join(config.repoRoot, "bundled-plugins"));
}

function verifyDigest(bytes: Buffer, expected?: string): void {
  if (!expected) return;
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`bundled_plugin_digest_mismatch:${expected}:${actual}`);
  }
}

export async function syncBundledPlugins(
  manager: SafePluginManager,
  explicitScope?: SolPluginScope,
): Promise<BundledPluginSyncResult[]> {
  const directory = bundleDirectory();
  let catalogRaw: string;
  try {
    catalogRaw = await readFile(join(directory, "catalog.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const catalog = parseCatalog(catalogRaw);
  const current = new Map((await manager.list()).map((plugin) => [plugin.manifest.id, plugin]));
  const needsScope = catalog.plugins.some((entry) => !current.has(entry.id));
  const scope = explicitScope ?? (needsScope ? await defaultOwnerScope().catch(() => undefined) : undefined);
  const results: BundledPluginSyncResult[] = [];

  for (const entry of catalog.plugins) {
    const installed = current.get(entry.id);
    let action: BundledPluginAction;
    try {
      action = decideBundledPluginAction(installed?.manifest.version, entry.version, !!scope);
    } catch (error) {
      results.push({ id: entry.id, bundledVersion: entry.version, installedVersion: installed?.manifest.version, action: "error", error: errorMessage(error) });
      continue;
    }

    if (action === "skip" || action === "skip-no-scope") {
      results.push({ id: entry.id, bundledVersion: entry.version, installedVersion: installed?.manifest.version, action });
      continue;
    }

    try {
      const bytes = await readFile(join(directory, entry.file));
      verifyDigest(bytes, entry.sha256);
      if (action === "install") {
        if (!scope) throw new Error("bundled_plugin_scope_missing");
        const plugin = await manager.installPackage(bytes, {
          scope,
          source: sourceFor(entry),
        });
        current.set(entry.id, plugin);
        console.log(`SOL Full installed bundled plugin ${entry.id} ${plugin.manifest.version}`);
        results.push({ id: entry.id, bundledVersion: entry.version, installedVersion: plugin.manifest.version, action });
      } else {
        const plugin = await manager.upgradePackage(entry.id, bytes, {
          source: sourceFor(entry),
        });
        current.set(entry.id, plugin);
        console.log(`SOL Full upgraded bundled plugin ${entry.id} ${installed?.manifest.version ?? "?"} -> ${plugin.manifest.version}`);
        results.push({ id: entry.id, bundledVersion: entry.version, installedVersion: plugin.manifest.version, action });
      }
    } catch (error) {
      const reason = errorMessage(error);
      console.warn(`SOL Full could not ${action} bundled plugin ${entry.id}: ${reason}`);
      results.push({ id: entry.id, bundledVersion: entry.version, installedVersion: installed?.manifest.version, action: "error", error: reason });
    }
  }

  return results;
}

export async function initializePluginsWithBundle(manager: SafePluginManager): Promise<void> {
  const first = await syncBundledPlugins(manager).catch((error) => {
    console.warn(`SOL Full bundled plugin sync failed: ${errorMessage(error)}`);
    return [] as BundledPluginSyncResult[];
  });

  await manager.startEnabled();

  if (!first.some((result) => result.action === "skip-no-scope")) return;

  let attempts = 0;
  const retry = async (): Promise<void> => {
    attempts += 1;
    const results = await syncBundledPlugins(manager).catch((error) => {
      console.warn(`SOL Full bundled plugin onboarding retry failed: ${errorMessage(error)}`);
      return [] as BundledPluginSyncResult[];
    });
    if (results.some((result) => result.action === "skip-no-scope") && attempts < 60) {
      const timer = setTimeout(() => void retry(), 10_000);
      timer.unref?.();
    }
  };

  const timer = setTimeout(() => void retry(), 10_000);
  timer.unref?.();
}

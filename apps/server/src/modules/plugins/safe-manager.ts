import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PluginManager } from "./manager.js";
import { extractZipBuffer } from "./zip.js";
import {
  type SolPluginManifest,
  type SolPluginRuntimePrincipal,
  type SolPluginSettingValue,
  type SolPluginSnapshot,
  type SolPluginSource,
  validatePluginManifest,
  validateSettingValues,
} from "./types.js";

export interface SafePluginManagerOptions {
  rootDir: string;
  coreUrl: string;
  maxPackageBytes?: number;
  logLimit?: number;
}

export interface UpgradePackageOptions {
  approvedPermissions?: string[];
  source?: SolPluginSource;
  expectedManifest?: Pick<SolPluginManifest, "schemaVersion" | "id" | "name" | "version" | "capabilities" | "requires" | "permissions">;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}

function assertExpectedManifest(actual: SolPluginManifest, expected?: UpgradePackageOptions["expectedManifest"]): void {
  if (!expected) return;
  if (
    actual.schemaVersion !== expected.schemaVersion
    || actual.id !== expected.id
    || actual.name !== expected.name
    || actual.version !== expected.version
    || !sameStrings(actual.capabilities, expected.capabilities)
    || !sameStrings(actual.requires, expected.requires)
    || !sameStrings(actual.permissions, expected.permissions)
  ) {
    throw new Error("github_plugin_package_manifest_mismatch");
  }
}

function semverParts(version: string): [number, number, number, string] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/);
  if (!match) return [0, 0, 0, version];
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

function compareSemver(a: string, b: string): number {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return Number(left[index]) - Number(right[index]);
  }
  if (left[3] === right[3]) return 0;
  if (!left[3]) return 1;
  if (!right[3]) return -1;
  return String(left[3]).localeCompare(String(right[3]));
}

function normalizedPermissions(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
}

function preservedSettings(
  manifest: SolPluginManifest,
  current: Record<string, SolPluginSettingValue>,
): Record<string, SolPluginSettingValue> {
  const allowed = new Set(manifest.settings.map((definition) => definition.key));
  const candidate = Object.fromEntries(Object.entries(current).filter(([key]) => allowed.has(key)));
  try {
    return validateSettingValues(manifest.settings, candidate, { allowMissingRequired: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`plugin_update_setting_migration_required:${reason}`);
  }
}

/**
 * Compatibility wrapper around PluginManager.
 *
 * Existing install/start/runtime behaviour remains delegated to the proven manager.
 * Only upgrades are added here, so old plugins do not need to opt into a new lifecycle.
 */
export class SafePluginManager {
  private readonly options: SafePluginManagerOptions;
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly maxPackageBytes: number;
  private inner: PluginManager;
  private upgradeTail: Promise<void> = Promise.resolve();

  constructor(options: SafePluginManagerOptions) {
    this.options = { ...options };
    this.rootDir = resolve(options.rootDir);
    this.statePath = join(this.rootDir, ".plugin-state.json");
    this.maxPackageBytes = options.maxPackageBytes ?? 64 * 1024 * 1024;
    this.inner = this.newManager();
  }

  private newManager(): PluginManager {
    return new PluginManager(this.options as ConstructorParameters<typeof PluginManager>[0]);
  }

  init(): Promise<void> { return this.inner.init(); }
  list(): Promise<SolPluginSnapshot[]> { return this.inner.list(); }
  get(id: string): Promise<SolPluginSnapshot> { return this.inner.get(id); }
  authenticateRuntimeToken(token: string): Promise<SolPluginRuntimePrincipal | null> { return this.inner.authenticateRuntimeToken(token); }
  getLogs(id: string, limit = 200) { return this.inner.getLogs(id, limit); }
  getSettings(id: string) { return this.inner.getSettings(id); }
  updateSettings(id: string, values: unknown) { return this.inner.updateSettings(id, values); }
  installPackage(buffer: Buffer, options = {}) { return this.inner.installPackage(buffer, options); }
  uninstall(id: string) { return this.inner.uninstall(id); }
  start(id: string) { return this.inner.start(id); }
  stop(id: string) { return this.inner.stop(id); }
  restart(id: string) { return this.inner.restart(id); }
  startEnabled() { return this.inner.startEnabled(); }
  shutdown() { return this.inner.shutdown(); }

  async upgradePackage(id: string, buffer: Buffer, options: UpgradePackageOptions = {}): Promise<SolPluginSnapshot> {
    let resolveTurn!: () => void;
    const previous = this.upgradeTail;
    this.upgradeTail = new Promise<void>((resolveTurnValue) => { resolveTurn = resolveTurnValue; });
    await previous.catch(() => undefined);
    try {
      return await this.upgradePackageNow(id, buffer, options);
    } finally {
      resolveTurn();
    }
  }

  private async inspectUpgradePackage(buffer: Buffer): Promise<SolPluginManifest> {
    if (!buffer.length) throw new Error("plugin package is empty");
    if (buffer.length > this.maxPackageBytes) throw new Error("plugin package exceeds the configured size limit");
    await mkdir(this.rootDir, { recursive: true });
    const temporary = join(this.rootDir, `.inspect-${randomUUID()}`);
    try {
      extractZipBuffer(buffer, temporary, { maxUncompressedBytes: this.maxPackageBytes * 2 });
      const raw = await readFile(join(temporary, "sol-plugin.json"), "utf8");
      return validatePluginManifest(JSON.parse(raw) as unknown);
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async upgradePackageNow(id: string, buffer: Buffer, options: UpgradePackageOptions): Promise<SolPluginSnapshot> {
    await this.inner.init();
    const current = await this.inner.get(id);
    const nextManifest = await this.inspectUpgradePackage(buffer);
    assertExpectedManifest(nextManifest, options.expectedManifest);

    if (nextManifest.id !== current.manifest.id) {
      throw new Error(`plugin_update_id_mismatch:${current.manifest.id}:${nextManifest.id}`);
    }
    if (compareSemver(nextManifest.version, current.manifest.version) < 0) {
      throw new Error(`plugin_downgrade_not_allowed:${current.manifest.version}:${nextManifest.version}`);
    }

    const currentSettings = (await this.inner.getSettings(id)).values;
    const settings = preservedSettings(nextManifest, currentSettings);
    const oldApproved = normalizedPermissions(current.approvedPermissions);
    const explicitlyApproved = options.approvedPermissions === undefined
      ? undefined
      : normalizedPermissions(options.approvedPermissions);
    const approved = explicitlyApproved ?? oldApproved.filter((permission) => nextManifest.permissions.includes(permission));
    const unknownApprovals = approved.filter((permission) => !nextManifest.permissions.includes(permission));
    if (unknownApprovals.length) throw new Error(`plugin_permission_not_requested:${unknownApprovals.join(",")}`);
    const missingPermissions = nextManifest.permissions.filter((permission) => !approved.includes(permission));
    if (missingPermissions.length) {
      throw new Error(`plugin_update_permissions_required:${missingPermissions.join(",")}`);
    }

    const destination = join(this.rootDir, id);
    if (!existsSync(destination)) throw new Error(`plugin_directory_missing:${id}`);
    const backupDirectory = join(this.rootDir, `.rollback-${id}-${randomUUID()}`);
    const backupState = join(this.rootDir, `.rollback-state-${randomUUID()}.json`);
    const hadState = existsSync(this.statePath);
    const oldEnabled = current.enabled;

    await cp(destination, backupDirectory, { recursive: true, force: false, errorOnExist: true });
    if (hadState) await copyFile(this.statePath, backupState);

    let newInstalled = false;
    try {
      await this.inner.stop(id);
      await this.inner.uninstall(id);
      const source = options.source ?? current.source ?? { type: "file", installedAt: new Date().toISOString() };
      let installed = await this.inner.installPackage(buffer, {
        approvedPermissions: approved,
        settings,
        expectedManifest: options.expectedManifest,
        scope: current.scope,
        source,
      });
      newInstalled = true;

      // Preserve the user's enable/disable choice across versions.
      if (!oldEnabled && installed.enabled) installed = await this.inner.stop(id);
      if (oldEnabled && !installed.enabled) {
        const missingRequired = nextManifest.settings
          .filter((definition) => definition.required && settings[definition.key] === undefined && definition.default === undefined)
          .map((definition) => definition.key);
        if (!missingRequired.length) installed = await this.inner.start(id);
      }

      await rm(backupDirectory, { recursive: true, force: true });
      await rm(backupState, { force: true });
      return installed;
    } catch (error) {
      const updateError = error instanceof Error ? error.message : String(error);
      try {
        if (newInstalled) await this.inner.uninstall(id).catch(() => undefined);
        await rm(destination, { recursive: true, force: true });
        if (existsSync(backupDirectory)) await rename(backupDirectory, destination);
        if (hadState && existsSync(backupState)) await copyFile(backupState, this.statePath);
        else if (!hadState) await rm(this.statePath, { force: true });

        this.inner = this.newManager();
        await this.inner.init();
        if (oldEnabled) await this.inner.start(id);
      } catch (rollbackError) {
        const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`plugin_update_failed_and_rollback_failed:${updateError}:${rollbackReason}`);
      } finally {
        await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
        await rm(backupState, { force: true }).catch(() => undefined);
      }
      throw new Error(`plugin_update_rolled_back:${updateError}`);
    }
  }
}

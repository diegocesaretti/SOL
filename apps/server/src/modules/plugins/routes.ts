import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendHtml, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { renderPluginsPage } from "../../ui/plugins.js";
import { downloadGithubPlugin, inspectGithubPlugin } from "./github.js";
import { pluginManager } from "./runtime.js";

function canManage(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

async function readBinary(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("plugin_package_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  if (!request.headers["content-type"]?.includes("application/json")) throw new Error("content_type_must_be_application_json");
  return await readJsonBody<T>(request);
}

function pluginError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("plugin_not_found:")) {
    sendJson(response, 404, { error: message });
    return;
  }
  if (message.startsWith("plugin_already_installed:")) {
    sendJson(response, 409, { error: message });
    return;
  }
  if (message.startsWith("plugin_permissions_required:") || message.startsWith("plugin_update_permissions_required:")) {
    const permissions = message.split(":", 2)[1]?.split(",").filter(Boolean) ?? [];
    sendJson(response, 403, { error: message, permissions });
    return;
  }
  if (message.startsWith("plugin_update_rolled_back:")) {
    sendJson(response, 409, { error: message, rolledBack: true });
    return;
  }
  if (message === "plugin_package_too_large") {
    sendJson(response, 413, { error: message });
    return;
  }
  if (message === "repository_or_plugin_manifest_not_found" || message.startsWith("github_release_asset_not_found:")) {
    sendJson(response, 404, { error: message });
    return;
  }
  if (message.startsWith("github_http_401") || message.startsWith("github_http_403") || message.startsWith("github_asset_http_401") || message.startsWith("github_asset_http_403")) {
    sendJson(response, 401, { error: message, githubAuthRequired: true });
    return;
  }
  if (message === "content_type_must_be_application_json") {
    sendJson(response, 415, { error: message });
    return;
  }
  sendJson(response, 400, { error: message });
}

export async function handlePluginsApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/plugins/ui" && request.method === "GET") {
    sendHtml(response, 200, renderPluginsPage());
    return true;
  }

  if (path === "/v1/plugins" && request.method === "GET") {
    sendJson(response, 200, { plugins: await pluginManager.list(), canManage: canManage(principal) });
    return true;
  }

  if (path === "/v1/plugins/install" && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/octet-stream" && contentType !== "application/zip") {
      sendJson(response, 415, { error: "Upload the .solplugin file as application/octet-stream or application/zip" });
      return true;
    }
    try {
      const packageBytes = await readBinary(request, 64 * 1024 * 1024);
      sendJson(response, 201, { plugin: await pluginManager.installPackage(packageBytes, { scope: { householdId: principal.householdId, memberId: principal.memberId } }) });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  if (path === "/v1/plugins/github/preview" && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      const body = await readJson<{ repository?: string }>(request);
      const preview = await inspectGithubPlugin(body.repository ?? "");
      sendJson(response, 200, { preview });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  if (path === "/v1/plugins/github/install" && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      const body = await readJson<{
        repository?: string;
        approvedPermissions?: string[];
        settings?: Record<string, string | number | boolean>;
      }>(request);
      const preview = await inspectGithubPlugin(body.repository ?? "");
      const downloaded = await downloadGithubPlugin(preview);
      const plugin = await pluginManager.installPackage(downloaded.bytes, {
        approvedPermissions: Array.isArray(body.approvedPermissions) ? body.approvedPermissions : [],
        settings: body.settings,
        expectedManifest: preview.manifest,
        scope: { householdId: principal.householdId, memberId: principal.memberId },
        source: {
          type: "github",
          repository: preview.repository,
          ref: preview.defaultBranch,
          releaseTag: downloaded.releaseTag,
          installedAt: new Date().toISOString(),
        },
      });
      sendJson(response, 201, { plugin });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  const fileUpdateMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/update$/);
  if (fileUpdateMatch && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/octet-stream" && contentType !== "application/zip") {
      sendJson(response, 415, { error: "Upload the replacement .solplugin as application/octet-stream or application/zip" });
      return true;
    }
    try {
      const packageBytes = await readBinary(request, 64 * 1024 * 1024);
      const plugin = await pluginManager.upgradePackage(fileUpdateMatch[1]!, packageBytes);
      sendJson(response, 200, { plugin, updated: true });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  const githubUpdateMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/github\/update$/);
  if (githubUpdateMatch && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      const id = githubUpdateMatch[1]!;
      const current = await pluginManager.get(id);
      if (current.source?.type !== "github" || !current.source.repository) {
        throw new Error(`plugin_update_source_not_github:${id}`);
      }
      const body = await readJson<{ approvedPermissions?: string[] }>(request);
      const preview = await inspectGithubPlugin(current.source.repository);
      const downloaded = await downloadGithubPlugin(preview);
      const plugin = await pluginManager.upgradePackage(id, downloaded.bytes, {
        approvedPermissions: Array.isArray(body.approvedPermissions) ? body.approvedPermissions : undefined,
        expectedManifest: preview.manifest,
        source: {
          type: "github",
          repository: preview.repository,
          ref: preview.defaultBranch,
          releaseTag: downloaded.releaseTag,
          installedAt: new Date().toISOString(),
        },
      });
      sendJson(response, 200, { plugin, updated: true, previousVersion: current.manifest.version });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  const settingsMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/settings$/);
  if (settingsMatch && request.method === "GET") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      sendJson(response, 200, await pluginManager.getSettings(settingsMatch[1]!));
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }
  if (settingsMatch && request.method === "PUT") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      const body = await readJson<{ values?: Record<string, string | number | boolean> }>(request);
      sendJson(response, 200, { plugin: await pluginManager.updateSettings(settingsMatch[1]!, body.values ?? {}) });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  const logsMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/logs$/);
  if (logsMatch && request.method === "GET") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    const url = new URL(request.url ?? path, "http://sol.local");
    const rawLimit = Number(url.searchParams.get("limit") ?? "200");
    try {
      sendJson(response, 200, {
        logs: await pluginManager.getLogs(logsMatch[1]!, Number.isFinite(rawLimit) ? rawLimit : 200),
      });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  const actionMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/(start|stop|restart)$/);
  if (actionMatch && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      const id = actionMatch[1]!;
      const action = actionMatch[2]!;
      const plugin = action === "start"
        ? await pluginManager.start(id)
        : action === "stop"
          ? await pluginManager.stop(id)
          : await pluginManager.restart(id);
      sendJson(response, 200, { plugin });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  const pluginMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})$/);
  if (pluginMatch && request.method === "DELETE") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      await pluginManager.uninstall(pluginMatch[1]!);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      pluginError(response, error);
    }
    return true;
  }

  return false;
}

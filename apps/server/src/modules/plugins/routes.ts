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
  if (message.startsWith("plugin_not_found:")) { sendJson(response, 404, { error: message }); return; }
  if (message.startsWith("plugin_already_installed:")) { sendJson(response, 409, { error: message }); return; }
  if (message.startsWith("plugin_permissions_required:")) { sendJson(response, 403, { error: message }); return; }
  if (message === "plugin_package_too_large") { sendJson(response, 413, { error: message }); return; }
  if (message === "repository_or_plugin_manifest_not_found" || message.startsWith("github_release_asset_not_found:")) { sendJson(response, 404, { error: message }); return; }
  if (message.startsWith("github_http_401") || message.startsWith("github_http_403") || message.startsWith("github_asset_http_401") || message.startsWith("github_asset_http_403")) {
    sendJson(response, 401, { error: message, githubAuthRequired: true }); return;
  }
  if (message === "content_type_must_be_application_json") { sendJson(response, 415, { error: message }); return; }
  sendJson(response, 400, { error: message });
}

function loopbackDashboardUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1")) return null;
    return url;
  } catch { return null; }
}

async function pluginDashboard(id: string): Promise<Record<string, unknown>> {
  const plugin = await pluginManager.get(id);
  const url = loopbackDashboardUrl(plugin.healthDetails?.bridgeUrl ?? plugin.healthDetails?.adminUrl);
  if (!url || plugin.state !== "running") return { available: false };

  if (id !== "nexo-whatsapp") return { available: true, openUrl: url.toString() };
  const stateUrl = new URL("/api/state", url);
  try {
    const result = await fetch(stateUrl, { signal: AbortSignal.timeout(2_500), headers: { accept: "application/json" } });
    if (!result.ok) return { available: true, openUrl: url.toString(), statusAvailable: false };
    const body = await result.json() as { accounts?: Array<{ role?: string; runtime?: { state?: string } }> };
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    const inputs = accounts.filter((account) => account.role === "input");
    const outputs = accounts.filter((account) => account.role === "output");
    return {
      available: true,
      openUrl: url.toString(),
      statusAvailable: true,
      inputs: inputs.length,
      outputs: outputs.length,
      connectedInputs: inputs.filter((account) => account.runtime?.state === "open").length,
      connectedOutputs: outputs.filter((account) => account.runtime?.state === "open").length,
    };
  } catch {
    return { available: true, openUrl: url.toString(), statusAvailable: false };
  }
}

export async function handlePluginsApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/plugins/ui" && request.method === "GET") { sendHtml(response, 200, renderPluginsPage()); return true; }
  if (path === "/v1/plugins" && request.method === "GET") {
    sendJson(response, 200, { plugins: await pluginManager.list(), canManage: canManage(principal) }); return true;
  }

  const dashboardMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/dashboard$/);
  if (dashboardMatch && request.method === "GET") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    try { sendJson(response, 200, await pluginDashboard(dashboardMatch[1]!)); }
    catch (error) { pluginError(response, error); }
    return true;
  }

  if (path === "/v1/plugins/install" && request.method === "POST") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/octet-stream" && contentType !== "application/zip") {
      sendJson(response, 415, { error: "Upload the .solplugin file as application/octet-stream or application/zip" }); return true;
    }
    try {
      const packageBytes = await readBinary(request, 64 * 1024 * 1024);
      sendJson(response, 201, { plugin: await pluginManager.installPackage(packageBytes, { scope: { householdId: principal.householdId, memberId: principal.memberId } }) });
    } catch (error) { pluginError(response, error); }
    return true;
  }

  if (path === "/v1/plugins/github/preview" && request.method === "POST") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    try {
      const body = await readJson<{ repository?: string }>(request);
      const preview = await inspectGithubPlugin(body.repository ?? "");
      sendJson(response, 200, { preview });
    } catch (error) { pluginError(response, error); }
    return true;
  }

  if (path === "/v1/plugins/github/install" && request.method === "POST") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    try {
      const body = await readJson<{ repository?: string; approvedPermissions?: string[]; settings?: Record<string, string | number | boolean> }>(request);
      const preview = await inspectGithubPlugin(body.repository ?? "");
      const downloaded = await downloadGithubPlugin(preview);
      const plugin = await pluginManager.installPackage(downloaded.bytes, {
        approvedPermissions: Array.isArray(body.approvedPermissions) ? body.approvedPermissions : [],
        settings: body.settings,
        expectedManifest: preview.manifest,
        scope: { householdId: principal.householdId, memberId: principal.memberId },
        source: { type: "github", repository: preview.repository, ref: preview.defaultBranch, releaseTag: downloaded.releaseTag, installedAt: new Date().toISOString() },
      });
      sendJson(response, 201, { plugin });
    } catch (error) { pluginError(response, error); }
    return true;
  }

  const settingsMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/settings$/);
  if (settingsMatch && request.method === "GET") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    try { sendJson(response, 200, await pluginManager.getSettings(settingsMatch[1]!)); }
    catch (error) { pluginError(response, error); }
    return true;
  }
  if (settingsMatch && request.method === "PUT") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    try {
      const body = await readJson<{ values?: Record<string, string | number | boolean> }>(request);
      sendJson(response, 200, { plugin: await pluginManager.updateSettings(settingsMatch[1]!, body.values ?? {}) });
    } catch (error) { pluginError(response, error); }
    return true;
  }

  const logsMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/logs$/);
  if (logsMatch && request.method === "GET") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    const url = new URL(request.url ?? path, "http://sol.local");
    const rawLimit = Number(url.searchParams.get("limit") ?? "200");
    try { sendJson(response, 200, { logs: await pluginManager.getLogs(logsMatch[1]!, Number.isFinite(rawLimit) ? rawLimit : 200) }); }
    catch (error) { pluginError(response, error); }
    return true;
  }

  const actionMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/(start|stop|restart)$/);
  if (actionMatch && request.method === "POST") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    try {
      const id = actionMatch[1]!;
      const action = actionMatch[2]!;
      const plugin = action === "start" ? await pluginManager.start(id) : action === "stop" ? await pluginManager.stop(id) : await pluginManager.restart(id);
      sendJson(response, 200, { plugin });
    } catch (error) { pluginError(response, error); }
    return true;
  }

  const pluginMatch = path.match(/^\/v1\/plugins\/([a-z0-9][a-z0-9._-]{0,63})$/);
  if (pluginMatch && request.method === "DELETE") {
    if (!canManage(principal)) { sendJson(response, 403, { error: "forbidden" }); return true; }
    try { await pluginManager.uninstall(pluginMatch[1]!); sendJson(response, 200, { ok: true }); }
    catch (error) { pluginError(response, error); }
    return true;
  }

  return false;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHtml, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { renderPluginsPage } from "../../ui/plugins.js";
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
  if (message === "plugin_package_too_large") {
    sendJson(response, 413, { error: message });
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
      sendJson(response, 201, { plugin: await pluginManager.installPackage(packageBytes) });
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

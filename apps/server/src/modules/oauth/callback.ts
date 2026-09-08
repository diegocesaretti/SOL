import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHtml } from "../../http.js";
import { completeOAuthCallback } from "./service.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function handleOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://sol.local");
  if (url.pathname !== "/v1/oauth/callback") return false;
  if (request.method !== "GET") {
    sendHtml(response, 405, "<!doctype html><title>SOL OAuth</title><p>Método no permitido.</p>");
    return true;
  }

  const result = await completeOAuthCallback({
    state: url.searchParams.get("state"),
    code: url.searchParams.get("code"),
    error: url.searchParams.get("error"),
    errorDescription: url.searchParams.get("error_description"),
  });

  if (result.ok) {
    sendHtml(
      response,
      200,
      `<!doctype html><meta charset="utf-8"><title>SOL · Conexión completada</title><body style="font-family:system-ui;max-width:600px;margin:48px auto;padding:0 20px"><h1>Conexión completada</h1><p>${escapeHtml(result.provider ?? "OAuth")} quedó conectada a SOL.</p><p>Ya podés cerrar esta ventana.</p></body>`,
    );
    return true;
  }

  sendHtml(
    response,
    400,
    `<!doctype html><meta charset="utf-8"><title>SOL · Error OAuth</title><body style="font-family:system-ui;max-width:600px;margin:48px auto;padding:0 20px"><h1>No se pudo completar la conexión</h1><p>${escapeHtml(result.error ?? "oauth_failed")}</p><p>Podés cerrar esta ventana y reintentar desde SOL.</p></body>`,
  );
  return true;
}

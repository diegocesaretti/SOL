import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { gatewayConfig } from "./config.js";
import { closeMcpHandler, mcpHandler } from "./mcp.js";
import { cleanupOAuthState, handleOAuth, oauthChallenge, verifyAccessToken } from "./oauth.js";
import {
  authenticateBridge,
  bridgeConnection,
  cleanupState,
  completeBridgeJob,
  enrollBridge,
  issuePairCode,
  pollBridgeJob,
  updateBridgeCatalog,
} from "./state.js";

function json(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  response.end(body);
}

function text(response: ServerResponse, status: number, value: string, contentType = "text/plain; charset=utf-8"): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(value);
}

function publicPage(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:820px;margin:8vh auto;padding:0 22px;line-height:1.55;color:#202328}h1{line-height:1.15}code{background:#f1f3f5;padding:2px 5px;border-radius:5px}.muted{color:#656b73}a{color:#075fd8}</style></head><body><h1>${title}</h1>${body}<p class="muted">SOL Plugin Gateway</p></body></html>`;
}

async function readBody(request: IncomingMessage, limit = 512 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (!body.length) return {};
  const parsed = JSON.parse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body_must_be_object");
  return parsed as Record<string, unknown>;
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (typeof value === "string") headers.set(name, value);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request, 2 * 1024 * 1024);
  return new Request(new URL(request.url ?? "/", gatewayConfig.publicOrigin), {
    method: request.method ?? "GET",
    headers,
    body: body && body.length ? new Uint8Array(body) : undefined,
  });
}

async function sendWebResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (!result.body) {
    response.end();
    return;
  }
  const stream = Readable.fromWeb(result.body as any);
  stream.on("error", (error) => {
    console.error("Response stream failed", error);
    if (!response.writableEnded) response.end();
  });
  stream.pipe(response);
}

function bearer(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  return typeof value === "string" ? value : null;
}

function bridgeInstance(request: IncomingMessage, response: ServerResponse): string | null {
  const instanceId = authenticateBridge(bearer(request));
  if (!instanceId) {
    json(response, 401, { error: "invalid_bridge_token" });
    return null;
  }
  return instanceId;
}

const enrollBuckets = new Map<string, { count: number; resetAt: number }>();
function allowEnrollment(request: IncomingMessage): boolean {
  const key = String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "unknown").split(",")[0]!.trim();
  const now = Date.now();
  const bucket = enrollBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    enrollBuckets.set(key, { count: 1, resetAt: now + 60 * 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 20;
}

async function handleBridge(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (path === "/bridge/enroll" && request.method === "POST") {
    if (!allowEnrollment(request)) {
      json(response, 429, { error: "enrollment_rate_limited" });
      return true;
    }
    try {
      const body = await jsonBody(request);
      const result = enrollBridge(typeof body.instanceId === "string" ? body.instanceId : undefined);
      json(response, 201, result);
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
    return true;
  }

  if (!path.startsWith("/bridge/")) return false;
  const instanceId = bridgeInstance(request, response);
  if (!instanceId) return true;

  if (path === "/bridge/catalog" && request.method === "POST") {
    try {
      const body = await jsonBody(request);
      const catalog = updateBridgeCatalog(instanceId, body);
      json(response, 200, { ok: true, instanceId, toolCount: catalog.tools.length, updatedAt: new Date(catalog.updatedAt).toISOString() });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "invalid_catalog" });
    }
    return true;
  }

  if (path === "/bridge/pair-code" && request.method === "POST") {
    try {
      const body = await jsonBody(request);
      json(response, 200, issuePairCode(instanceId, body.scopes));
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "pair_code_failed" });
    }
    return true;
  }

  if (path === "/bridge/status" && request.method === "GET") {
    json(response, 200, { instanceId, ...bridgeConnection(instanceId) });
    return true;
  }

  if (path === "/bridge/jobs" && request.method === "GET") {
    const url = new URL(request.url ?? "/", gatewayConfig.publicOrigin);
    const requested = Number(url.searchParams.get("wait") ?? gatewayConfig.bridgeLongPollMs);
    const job = await pollBridgeJob(instanceId, Number.isFinite(requested) ? requested : gatewayConfig.bridgeLongPollMs);
    if (!job) {
      response.statusCode = 204;
      response.end();
    } else {
      json(response, 200, job);
    }
    return true;
  }

  const resultMatch = path.match(/^\/bridge\/jobs\/([A-Za-z0-9_-]{8,120})\/result$/);
  if (resultMatch && request.method === "POST") {
    try {
      const body = await jsonBody(request);
      const accepted = completeBridgeJob(instanceId, resultMatch[1]!, body);
      json(response, accepted ? 200 : 404, accepted ? { ok: true } : { error: "job_not_found" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "invalid_result" });
    }
    return true;
  }

  json(response, 404, { error: "bridge_route_not_found" });
  return true;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", gatewayConfig.publicOrigin);
  const path = url.pathname;

  if (path === "/health" && request.method === "GET") {
    json(response, 200, { ok: true, service: "sol-plugin-gateway", origin: gatewayConfig.publicOrigin });
    return;
  }

  if (path === "/.well-known/openai-apps-challenge" && request.method === "GET") {
    if (!gatewayConfig.challengeToken) {
      text(response, 404, "challenge_not_configured");
      return;
    }
    text(response, 200, gatewayConfig.challengeToken);
    return;
  }

  if (path === "/" && request.method === "GET") {
    text(response, 200, publicPage("SOL para ChatGPT", `<p>Gateway oficial de SOL para conectar ChatGPT y otros clientes MCP con una instalación privada de SOL.</p><p>El servidor público no contiene credenciales de Home Assistant ni abre puertos en la casa. La instancia local de SOL mantiene una conexión HTTPS saliente y ejecuta las herramientas con permisos por miembro.</p><p><a href="/privacy">Privacidad</a> · <a href="/terms">Términos</a> · <a href="/support">Soporte</a></p>`), "text/html; charset=utf-8");
    return;
  }

  if (path === "/privacy" && request.method === "GET") {
    text(response, 200, publicPage("Política de privacidad de SOL", `<p>SOL Plugin Gateway procesa únicamente los datos necesarios para enrutar una solicitud MCP autenticada a la instancia de SOL que el usuario vinculó. Las credenciales de Home Assistant y otros proveedores permanecen en la instalación privada de SOL.</p><p>Las llamadas pueden contener nombres de herramientas, argumentos y resultados necesarios para responder a la solicitud. El gateway no usa esos datos para publicidad ni los vende. Los códigos de emparejamiento son temporales y los tokens OAuth tienen vencimiento.</p><p>Para desvincular ChatGPT, revocá el acceso desde SOL y desde la configuración de Plugins de ChatGPT.</p>`), "text/html; charset=utf-8");
    return;
  }

  if (path === "/terms" && request.method === "GET") {
    text(response, 200, publicPage("Términos de uso de SOL", `<p>SOL permite consultar información y ejecutar acciones en servicios que el usuario configuró y autorizó. El usuario conserva el control de su instalación, permisos y dispositivos.</p><p>Las acciones sobre Home Assistant u otros sistemas sólo están disponibles cuando la instancia local de SOL las habilita y el acceso OAuth incluye el permiso correspondiente.</p><p>El servicio se ofrece sin garantía de disponibilidad continua; para acciones críticas o de seguridad debe existir un método local alternativo.</p>`), "text/html; charset=utf-8");
    return;
  }

  if (path === "/support" && request.method === "GET") {
    const contact = gatewayConfig.supportEmail ? `<p>Contacto: <a href="mailto:${gatewayConfig.supportEmail}">${gatewayConfig.supportEmail}</a></p>` : "";
    text(response, 200, publicPage("Soporte de SOL", `<p>Para diagnosticar una conexión, verificá que SOL esté encendido, que el bridge figure online y que el código de emparejamiento no haya vencido.</p><p>Las herramientas de lectura requieren <code>sol.read</code>; memoria requiere <code>sol.submit</code>; acciones de dispositivos requieren <code>sol.actions</code>.</p>${contact}`), "text/html; charset=utf-8");
    return;
  }

  const webRequest = await toWebRequest(request);
  const oauth = await handleOAuth(webRequest);
  if (oauth) {
    await sendWebResponse(response, oauth);
    return;
  }

  if (await handleBridge(path, request, response)) return;

  if (path === "/mcp") {
    const access = verifyAccessToken(webRequest.headers.get("authorization"));
    if (!access) {
      json(response, 401, { error: "unauthorized" }, { "www-authenticate": oauthChallenge(["sol.read"]) });
      return;
    }
    const result = await mcpHandler.fetch(webRequest, {
      authInfo: {
        token: webRequest.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
        clientId: access.instanceId,
        scopes: access.scopes,
        expiresAt: access.exp,
      } as any,
    });
    await sendWebResponse(response, result);
    return;
  }

  json(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    console.error("Unhandled gateway request error", error);
    if (!response.headersSent) json(response, 500, { error: "internal_error" });
    else if (!response.writableEnded) response.end();
  });
});

server.listen(gatewayConfig.port, "0.0.0.0", () => {
  console.log(`SOL Plugin Gateway listening on 0.0.0.0:${gatewayConfig.port} (${gatewayConfig.publicOrigin})`);
});

const cleanupTimer = setInterval(() => {
  cleanupState();
  cleanupOAuthState();
}, 60_000);
cleanupTimer.unref();

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down SOL Plugin Gateway`);
  clearInterval(cleanupTimer);
  await closeMcpHandler().catch(() => undefined);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

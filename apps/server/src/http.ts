import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

export function sendHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

export async function readJsonBody<T>(
  request: IncomingMessage,
  maxBytes = 32_768,
): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("request body is required");

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

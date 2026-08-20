import assert from "node:assert/strict";
import test from "node:test";
import { extractGmailText } from "./sync.js";

type GmailMessageInput = Parameters<typeof extractGmailText>[0];

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

test("Gmail extraction prefers text/plain from multipart messages", () => {
  const message: GmailMessageInput = {
    snippet: "fallback",
    payload: {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: encoded("Hola Diego\nEste es el texto útil.") } },
        { mimeType: "text/html", body: { data: encoded("<p>HTML alternativo</p>") } },
      ],
    },
  };
  assert.equal(extractGmailText(message), "Hola Diego\nEste es el texto útil.");
});

test("Gmail extraction falls back to readable HTML text", () => {
  const message: GmailMessageInput = {
    payload: {
      mimeType: "text/html",
      body: { data: encoded("<p>Pedido confirmado</p><p>Entrega: viernes</p>") },
    },
  };
  assert.equal(extractGmailText(message), "Pedido confirmado\nEntrega: viernes");
});

test("Gmail extraction uses snippet when body text is unavailable", () => {
  const message: GmailMessageInput = { snippet: "Resumen disponible" };
  assert.equal(extractGmailText(message), "Resumen disponible");
});

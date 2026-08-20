import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderWhatsappPage } from "./whatsapp.js";

test("WhatsApp page renders syntactically valid embedded JavaScript", () => {
  const html = renderWhatsappPage();
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1], "rendered WhatsApp page should contain an inline script");
  assert.doesNotThrow(() => new vm.Script(match[1], { filename: "whatsapp-inline.js" }));
});

test("WhatsApp diagnostics copy uses an escaped newline inside rendered JavaScript", () => {
  const html = renderWhatsappPage();
  assert.match(html, /header\.concat\(lines\)\.join\('\\n'\)/);
});

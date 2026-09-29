import assert from "node:assert/strict";
import test from "node:test";
import { pkceS256, signOpaqueToken, verifyOpaqueToken } from "./crypto.js";

test("opaque tokens round-trip and reject wrong type", () => {
  const token = signOpaqueToken({ typ: "demo", iat: Math.floor(Date.now() / 1000), value: "ok" });
  assert.equal(verifyOpaqueToken<any>(token, "demo")?.value, "ok");
  assert.equal(verifyOpaqueToken<any>(token, "other"), null);
});

test("PKCE S256 is stable", () => {
  assert.equal(
    pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { hashOAuthState, oauthPkceChallenge } from "./service.js";

test("PKCE S256 matches RFC 7636 reference vector", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(
    oauthPkceChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("OAuth state is stored as a one-way stable hash", () => {
  const state = "random-state-value";
  const hashed = hashOAuthState(state);
  assert.equal(hashed, hashOAuthState(state));
  assert.notEqual(hashed, state);
  assert.notEqual(hashed, hashOAuthState("different-state"));
});

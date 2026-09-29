import assert from "node:assert/strict";
import test from "node:test";
import { pkceS256 } from "./crypto.js";
import { handleOAuth, verifyAccessToken } from "./oauth.js";
import { enrollBridge, issuePairCode } from "./state.js";

async function mustHandle(request: Request): Promise<Response> {
  const response = await handleOAuth(request);
  assert.ok(response instanceof Response);
  return response;
}

test("OAuth DCR + PKCE + SOL pair code issues an instance-bound access token", async () => {
  const redirectUri = "https://chatgpt.com/aip/oauth/callback";
  const register = await mustHandle(new Request("http://127.0.0.1:8787/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT test",
      redirect_uris: [redirectUri],
    }),
  }));
  assert.equal(register.status, 201);
  const registration = await register.json() as { client_id?: string };
  assert.ok(registration.client_id);

  const enrolled = enrollBridge();
  const pairing = issuePairCode(enrolled.instanceId, ["read", "submit", "actions"]);
  const verifier = "test-verifier-01234567890123456789012345678901234567890123456789";
  const challenge = pkceS256(verifier);
  const authorize = new URLSearchParams({
    client_id: registration.client_id!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "sol.read sol.submit sol.actions",
    state: "state-test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "http://127.0.0.1:8787",
    pair_code: pairing.code,
  });
  const approved = await mustHandle(new Request("http://127.0.0.1:8787/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorize,
    redirect: "manual",
  }));
  assert.equal(approved.status, 302);
  const location = approved.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const token = await mustHandle(new Request("http://127.0.0.1:8787/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id!,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: "http://127.0.0.1:8787",
    }),
  }));
  assert.equal(token.status, 200);
  const body = await token.json() as { access_token?: string; scope?: string };
  assert.ok(body.access_token);
  assert.equal(body.scope, "sol.read sol.submit sol.actions");

  const access = verifyAccessToken(`Bearer ${body.access_token}`);
  assert.equal(access?.instanceId, enrolled.instanceId);
  assert.deepEqual(access?.scopes, ["sol.read", "sol.submit", "sol.actions"]);
});

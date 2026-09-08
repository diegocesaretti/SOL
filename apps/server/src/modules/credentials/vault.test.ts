import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decryptSecretJson, encryptSecretJson, loadVaultMasterKey } from "./vault.js";

test("credential payload round-trips with AES-256-GCM", () => {
  const key = randomBytes(32);
  const aad = "sol.credentials.v1:h:m:p:c";
  const encrypted = encryptSecretJson(key, { accessToken: "secret", refreshToken: "refresh" }, aad);
  assert.notEqual(encrypted.ciphertext.toString("utf8"), "secret");
  assert.deepEqual(
    decryptSecretJson(key, encrypted, aad),
    { accessToken: "secret", refreshToken: "refresh" },
  );
});

test("credential ciphertext cannot be replayed under a different owner context", () => {
  const key = randomBytes(32);
  const encrypted = encryptSecretJson(key, { token: "abc" }, "sol.credentials.v1:h:m:plugin-a:c");
  assert.throws(
    () => decryptSecretJson(key, encrypted, "sol.credentials.v1:h:m:plugin-b:c"),
  );
});

test("vault master key is created once and reused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sol-vault-test-"));
  try {
    const path = join(dir, "vault.key");
    const first = await loadVaultMasterKey(path);
    const second = await loadVaultMasterKey(path);
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

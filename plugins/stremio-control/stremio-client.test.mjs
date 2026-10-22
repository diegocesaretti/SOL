import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StremioControlClient } from "./lib/stremio-client.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("health is unauthenticated, pairing persists token, and semantic calls use bearer auth", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sol-stremio-test-"));
  const calls = [];
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/v1/health") return jsonResponse(200, { ok: true, paired: false });
    if (pathname === "/api/v1/pair") return jsonResponse(200, { ok: true, token, device: { name: "TV" } });
    if (pathname === "/api/v1/details") return jsonResponse(200, { ok: true, videos: [{ id: "series:1:1" }] });
    throw new Error(`unexpected path ${pathname}`);
  };

  try {
    const client = new StremioControlClient({
      baseUrl: "http://192.168.1.50:8768/",
      timeoutMs: 2000,
      dataDir,
      fetchImpl
    });
    await client.initialize();

    await client.health();
    assert.equal(calls[0].url, "http://192.168.1.50:8768/api/v1/health");
    assert.equal(calls[0].init.headers.authorization, undefined);

    const paired = await client.pair("123456");
    assert.equal(paired.paired, true);
    assert.equal(calls[1].init.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(calls[1].init.body), { code: "123456", clientName: "SOL" });

    const state = JSON.parse(await readFile(path.join(dataDir, "pairing.json"), "utf8"));
    assert.equal(state.token, token);

    await client.details("series", "tt123");
    assert.equal(calls[2].url, "http://192.168.1.50:8768/api/v1/details");
    assert.equal(calls[2].init.headers.authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(calls[2].init.body), { type: "series", id: "tt123" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("invalid pairing code is rejected before network access", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sol-stremio-test-"));
  let requests = 0;
  try {
    const client = new StremioControlClient({
      baseUrl: "http://127.0.0.1:8768",
      dataDir,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse(500, {});
      }
    });
    await client.initialize();
    await assert.rejects(() => client.pair("12-345"), /pairing_code_must_be_6_digits/);
    assert.equal(requests, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("authenticated routes fail locally when Stremio is not paired", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sol-stremio-test-"));
  let requests = 0;
  try {
    const client = new StremioControlClient({
      baseUrl: "http://127.0.0.1:8768",
      dataDir,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse(500, {});
      }
    });
    await client.initialize();
    await assert.rejects(() => client.search("Severance"), /stremio_not_paired/);
    assert.equal(requests, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("remote API errors are preserved without exposing response bodies or tokens", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sol-stremio-test-"));
  try {
    const client = new StremioControlClient({
      baseUrl: "http://127.0.0.1:8768",
      token: "configured-secret-token",
      dataDir,
      fetchImpl: async () => jsonResponse(403, { error: "invalid_or_expired_pairing_code", secret: "do-not-surface" })
    });
    await client.initialize();
    await assert.rejects(
      () => client.playerState(),
      (error) => error instanceof Error
        && error.message === "stremio_api:invalid_or_expired_pairing_code"
        && !error.message.includes("configured-secret-token")
        && !error.message.includes("do-not-surface")
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

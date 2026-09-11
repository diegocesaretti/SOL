import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { TvSatelliteClient } from "../lib/tv-client.mjs";

async function withSatellite(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    return await handler.run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("TV client observes, captures and sends actions without authentication", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const handler = (request, response) => {
    assert.equal(request.headers["x-codex-token"], undefined);
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, android_api: 26, authentication: "none" }));
      return;
    }
    if (request.url === "/observe") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, package: "com.stremio.one" }));
      return;
    }
    if (request.url === "/screenshot") {
      response.setHeader("content-type", "image/jpeg");
      response.end(jpeg);
      return;
    }
    if (request.url === "/action") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, action: body.action, text: body.text || null }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  };
  handler.run = async (baseUrl) => {
    const client = new TvSatelliteClient({ enabled: true, baseUrl });
    assert.equal(client.configured, true);
    assert.equal(client.summary().authentication, "none");
    const health = await client.health();
    assert.equal(health.reachable, true);
    assert.equal(health.satellite.android_api, 26);
    const observed = await client.observe();
    assert.equal(observed.package, "com.stremio.one");
    const shot = await client.screenshot();
    assert.equal(shot.contentType, "image/jpeg");
    assert.deepEqual(shot.buffer, jpeg);
    const action = await client.action("set_text", { text: "Interstellar" });
    assert.equal(action.ok, true);
    assert.equal(action.text, "Interstellar");
  };
  await withSatellite(handler);
});

test("TV client treats Android 7/8 DPAD 409 as a structured fallback result", async () => {
  const handler = (request, response) => {
    if (request.url === "/action") {
      response.statusCode = 409;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: false,
        error: "native_dpad_unavailable_on_this_android_version",
        fallback: "home_assistant"
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  };
  handler.run = async (baseUrl) => {
    const client = new TvSatelliteClient({ enabled: true, baseUrl });
    const result = await client.action("dpad_left");
    assert.equal(result.httpStatus, 409);
    assert.equal(result.fallback, "home_assistant");
  };
  await withSatellite(handler);
});

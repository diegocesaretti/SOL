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

function pathOf(request) {
  return new URL(request.url, "http://127.0.0.1").pathname;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

test("TV client uses execute-observe, progressive capture and no authentication", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let executeCalls = 0;
  const handler = async (request, response) => {
    assert.equal(request.headers["x-codex-token"], undefined);
    const path = pathOf(request);
    if (path === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, android_api: 26, authentication: "none", execute_observe: true }));
      return;
    }
    if (path === "/observe") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, package: "com.stremio.one", ui_event_sequence: 2, tree: {} }));
      return;
    }
    if (path === "/screenshot") {
      response.setHeader("content-type", "image/jpeg");
      response.setHeader("x-codex-dhash", "0000000000000000");
      response.setHeader("x-codex-profile", new URL(request.url, "http://x").searchParams.get("profile") || "full");
      response.end(jpeg);
      return;
    }
    if (path === "/execute") {
      executeCalls += 1;
      const body = await readBody(request);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        actions: [{ ok: true, action: body.actions[0]?.action, text: body.actions[0]?.text || null }],
        observation: { ok: true, package: "com.stremio.one", ui_event_sequence: 3, tree: {} },
        screenshot_b64: jpeg.toString("base64"),
        screenshot_content_type: "image/jpeg",
        frame_dhash: "0000000000000001",
        screenshot_profile: "preview",
        focus_contrast: 0.2,
        settle: { changed: true, sequence: 3 }
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  };
  handler.run = async (baseUrl) => {
    const client = new TvSatelliteClient({ enabled: true, baseUrl });
    assert.equal(client.configured, true);
    const health = await client.health();
    assert.equal(health.reachable, true);
    const observed = await client.observe();
    assert.equal(observed.package, "com.stremio.one");
    const shot = await client.screenshot({ profile: "full" });
    assert.equal(shot.contentType, "image/jpeg");
    assert.equal(shot.dHash, "0000000000000000");
    const action = await client.action("set_text", { text: "Interstellar" });
    assert.equal(action.ok, true);
    assert.equal(executeCalls, 1);
    const cachedObservation = await client.observe();
    const cachedShot = await client.screenshot();
    assert.equal(cachedObservation.package, "com.stremio.one");
    assert.deepEqual(cachedShot.buffer, jpeg);
  };
  await withSatellite(handler);
});

test("TV client keeps Android 7/8 DPAD fallback structured", async () => {
  const handler = async (request, response) => {
    const path = pathOf(request);
    if (path === "/execute") {
      await readBody(request);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: false,
        actions: [{
          ok: false,
          action: "dpad_left",
          error: "native_dpad_unavailable_on_this_android_version",
          fallback: "home_assistant"
        }],
        observation: { ok: true, package: "com.stremio.one", ui_event_sequence: 1, tree: {} }
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

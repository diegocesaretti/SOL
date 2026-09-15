import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { SolPluginClient, STREMIO_MCP_TOOLS } from "../lib/sol-client.mjs";

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("registers one public Stremio playback action without detail-launch bypass", async () => {
  let registered = null;
  const solHost = await listen(async (req, res) => {
    if (req.url === "/v1/plugin-api/mcp/tools/register") {
      registered = await jsonBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tools: registered.tools }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const client = new SolPluginClient({ SOL_PLUGIN_API_URL: solHost.url, SOL_PLUGIN_TOKEN: "test" });
  try {
    const callbackUrl = "http://127.0.0.1:8767/mcp/direct";
    await client.registerMcpTools(callbackUrl, STREMIO_MCP_TOOLS);
    assert.equal(registered.callbackUrl, callbackUrl);
    assert.equal("mcpProxyServer" in client, false);
    assert.equal(registered.tools.filter((tool) => tool.name === "home_assistant_stremio_play_best").length, 1);
    assert.equal(registered.tools.some((tool) => tool.name === "home_assistant_stremio_play"), false);
    assert.equal(registered.tools.some((tool) => tool.name === "home_assistant_stremio_open_detail"), false);
  } finally {
    solHost.server.close();
  }
});

test("launches official Stremio through the one configured Home Assistant remote", async () => {
  let haCall = null;
  const haHost = await listen(async (req, res) => {
    if (req.url === "/api/services/remote/turn_on") {
      haCall = await jsonBody(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ entity_id: haCall.entity_id }]));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const client = new SolPluginClient({ HA_URL: haHost.url, HA_TOKEN: "ha-test", HA_SOL_ALLOW_CONTROL: "true", HA_SOL_STREMIO_ENABLED: "true", HA_SOL_TV_REMOTE_ENTITY_ID: "remote.tv_living" });
  try {
    const result = await client.handleStremioTool("home_assistant_stremio_open_search", { query: "Interstellar" });
    assert.equal(result.ok, true);
    assert.equal(result.deepLink, "stremio:///search?search=Interstellar");
    assert.deepEqual(haCall, { entity_id: "remote.tv_living", activity: "stremio:///search?search=Interstellar" });
  } finally {
    haHost.server.close();
  }
});

test("merges playback defaults before native stream selection", () => {
  const client = new SolPluginClient({ HA_SOL_STREMIO_DEFAULT_QUALITY: "1080p", HA_SOL_STREMIO_DEFAULT_LANGUAGE: "spanish" });
  assert.deepEqual(client.streamPreferences({}), { quality: "1080p", language: "spanish" });
  assert.deepEqual(client.streamPreferences({ quality: "4k", language: "latin" }), { quality: "4k", language: "latin" });
});

test("deduplicates simultaneous and recently repeated identical play_best requests", async () => {
  const client = new SolPluginClient({ HA_SOL_STREMIO_PLAYBACK_DEDUPE_MS: "30000" });
  let physicalRuns = 0;
  let releaseRun;
  const gate = new Promise((resolve) => { releaseRun = resolve; });
  client.playBest = async () => {
    physicalRuns += 1;
    await gate;
    return { playbackRequested: true, marker: physicalRuns };
  };

  const args = { query: "Matrix", language: "spanish", quality: "1080p" };
  const first = client.handleStremioTool("home_assistant_stremio_play_best", args);
  const second = client.handleStremioTool("home_assistant_stremio_play_best", args);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(physicalRuns, 1);
  releaseRun();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.playbackRequested, true);
  assert.equal(secondResult.playbackRequested, true);
  assert.equal(secondResult.deduplicated, true);
  assert.equal(secondResult.dedupeReason, "identical_playback_in_flight");
  assert.equal(physicalRuns, 1);

  const thirdResult = await client.handleStremioTool("home_assistant_stremio_play_best", args);
  assert.equal(thirdResult.deduplicated, true);
  assert.equal(thirdResult.dedupeReason, "identical_playback_recently_completed");
  assert.equal(physicalRuns, 1);
});

test("different play_best requests are not deduplicated", async () => {
  const client = new SolPluginClient({ HA_SOL_STREMIO_PLAYBACK_DEDUPE_MS: "30000" });
  let physicalRuns = 0;
  client.playBest = async (args) => {
    physicalRuns += 1;
    return { playbackRequested: true, query: args.query };
  };
  await client.handleStremioTool("home_assistant_stremio_play_best", { query: "Matrix", language: "spanish" });
  await client.handleStremioTool("home_assistant_stremio_play_best", { query: "Interstellar", language: "spanish" });
  assert.equal(physicalRuns, 2);
});

test("removed open_detail tool cannot launch Stremio", async () => {
  const client = new SolPluginClient({});
  await assert.rejects(
    () => client.handleStremioTool("home_assistant_stremio_open_detail", { mediaType: "movie", id: "tt0133093" }),
    /stremio_tool_not_found/
  );
});

test("Matrix Spanish follows exactly one launch-wait-move-center path", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "https://addon.example/stream/movie/tt0133093.json") {
      return new Response(JSON.stringify({ streams: [
        { title: "Matrix 720p English", url: "https://video.example/1" },
        { title: "Matrix 1080p English", url: "https://video.example/2" },
        { title: "Matrix 720p Español", url: "https://video.example/3" },
        { title: "Matrix 1080p Español", url: "https://video.example/4" }
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  const client = new SolPluginClient({
    HA_SOL_STREMIO_DEFAULT_QUALITY: "1080p",
    HA_SOL_STREMIO_DEFAULT_LANGUAGE: "any",
    HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX: "0",
    HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_CENTER_HOLD_MS: "120",
    HA_SOL_TV_REMOTE_ENTITY_ID: "remote.tv",
    HA_SOL_STREMIO_ENABLED: "true",
    HA_SOL_ALLOW_CONTROL: "true"
  });
  client.account = {
    configured: true,
    addons: [{ id: "test.addon", name: "Test Addon", roles: ["stream"], transportUrl: "https://addon.example/manifest.json" }],
    async refresh() { return {}; },
    snapshot() { return { configured: true }; }
  };
  client.resolveForStream = async () => ({ resolved: { type: "movie", id: "tt0133093", videoId: "tt0133093", selected: { name: "The Matrix" } }, streamId: "tt0133093", episodeDecision: null });
  let launched = null;
  let launchCount = 0;
  client.launchStremio = async (uri) => { launchCount += 1; launched = uri; return { ok: true, deepLink: uri }; };
  client.haService = async (_domain, _service, payload) => { calls.push(payload); return { ok: true }; };

  try {
    const result = await client.handleStremioTool("home_assistant_stremio_play_best", { query: "Matrix", language: "spanish" });
    assert.equal(result.playbackRequested, true);
    assert.equal(result.selected.nativeIndex, 3);
    assert.equal(result.preferences.quality, "1080p");
    assert.equal(launchCount, 1);
    assert.equal(launched.includes("autoPlay=true"), false);
    assert.deepEqual(calls.map((item) => item.command), ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_RIGHT", "DPAD_CENTER"]);
    assert.equal(calls.at(-1).hold_secs, 0.12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

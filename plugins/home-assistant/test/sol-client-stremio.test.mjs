import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { SolPluginClient } from "../lib/sol-client.mjs";

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

test("SolPluginClient registers Stremio tools through proxy and launches deep link through HA remote.turn_on", async () => {
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

  const original = await listen(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, original: true }));
  });

  const client = new SolPluginClient({
    SOL_PLUGIN_API_URL: solHost.url,
    SOL_PLUGIN_TOKEN: "test",
    SOL_PLUGIN_ID: "home-assistant",
    HA_URL: haHost.url,
    HA_TOKEN: "ha-test",
    HA_SOL_ALLOW_CONTROL: "true",
    HA_SOL_STREMIO_ENABLED: "true",
    HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.tv_living",
    HA_SOL_STREMIO_AUTOPLAY: "true"
  });

  try {
    await client.registerMcpTools(`${original.url}/mcp/original`, [{
      name: "home_assistant_cache_status",
      description: "test",
      inputSchema: { type: "object", properties: {} },
      requiredScope: "read"
    }]);

    assert.ok(registered.callbackUrl.includes("/mcp-proxy/"));
    assert.ok(registered.tools.some((tool) => tool.name === "home_assistant_stremio_open_search"));

    const response = await fetch(registered.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "sol.plugin.mcp.invoke",
        pluginId: "home-assistant",
        tool: "home_assistant_stremio_open_search",
        arguments: { query: "Interstellar" }
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.deepLink, "stremio:///search?search=Interstellar");
    assert.deepEqual(haCall, {
      entity_id: "remote.tv_living",
      activity: "stremio:///search?search=Interstellar"
    });
  } finally {
    client.mcpProxyServer?.close();
    solHost.server.close();
    haHost.server.close();
    original.server.close();
  }
});

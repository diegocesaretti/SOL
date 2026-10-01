import test from "node:test";
import assert from "node:assert/strict";
import { createSolRequestRouter } from "./sol-request.js";
import type { PluginMcpTool } from "../plugins/mcp-registry.js";

function pluginTool(
  name: string,
  requiredScope: "read" | "submit" | "actions",
  description: string,
  properties: Record<string, unknown> = {},
): PluginMcpTool {
  return {
    pluginId: "test-plugin",
    name,
    description,
    inputSchema: { type: "object", properties, additionalProperties: true },
    callbackUrl: "http://127.0.0.1:1/mcp",
    requiredScope,
    visibility: "private",
  };
}

const stremio = pluginTool(
  "home_assistant_stremio_play_best",
  "actions",
  "Play the requested movie or series in Stremio.",
  {
    query: { type: "string" },
    target: { type: "string", enum: ["cocina", "dormitorio"] },
    language: { type: "string", enum: ["any", "latin", "spanish", "english"] },
    quality: { type: "string" },
    autoPlay: { type: "boolean" },
  },
);

test("fast Stremio defaults to cocina and leaves language unspecified", async () => {
  let called: any;
  const router = createSolRequestRouter({} as any, ["read", "actions"], [stremio], {
    invokePlugin: (async (_principal: any, tool: any, args: any) => {
      called = { tool: tool.name, args };
      return { ok: true };
    }) as any,
  });

  const result: any = await router.handle({ text: "Poné Los Simpson", confirmedByUser: true });
  assert.equal(result.route, "fast");
  assert.equal(result.intent, "stremio_play");
  assert.equal(result.target, "cocina");
  assert.equal(result.query, "Los Simpson");
  assert.equal(result.language, "any");
  assert.equal(called.args.target, "cocina");
  assert.equal("language" in called.args, false);
});

test("fast Stremio sends dormitorio and explicit Latin language only when requested", async () => {
  let args: any;
  const router = createSolRequestRouter({} as any, ["read", "actions"], [stremio], {
    invokePlugin: (async (_principal: any, _tool: any, input: any) => {
      args = input;
      return { ok: true };
    }) as any,
  });

  const result: any = await router.handle({
    text: "Poné Los Simpson en Stremio en la TV del dormitorio en español latino",
    confirmedByUser: true,
  });
  assert.equal(result.target, "dormitorio");
  assert.equal(result.language, "latin");
  assert.equal(args.target, "dormitorio");
  assert.equal(args.language, "latin");
});

test("fast action refuses execution without explicit current-user confirmation", async () => {
  const router = createSolRequestRouter({} as any, ["read", "actions"], [stremio], {
    invokePlugin: (async () => ({ ok: true })) as any,
  });
  await assert.rejects(
    router.handle({ text: "Poné Matrix", confirmedByUser: false }),
    /user_confirmation_required/,
  );
});

test("fast Home Assistant state lookup chooses the live TV entity", async () => {
  const search = pluginTool("home_assistant_search_states", "read", "Search live Home Assistant states.");
  const get = pluginTool("home_assistant_get_state", "read", "Read one live Home Assistant state.");
  const router = createSolRequestRouter({} as any, ["read"], [search, get], {
    invokePlugin: (async (_principal: any, tool: any, args: any) => {
      if (tool.name === "home_assistant_search_states") {
        return {
          results: [
            { entityId: "media_player.tv_dormitorio", domain: "media_player", state: "off", attributes: {} },
            { entityId: "media_player.tv_dormitorio_2", domain: "media_player", state: "on", attributes: { device_class: "tv" } },
          ],
        };
      }
      return { entityId: args.entityId, domain: "media_player", state: "on", attributes: { device_class: "tv" } };
    }) as any,
  });

  const result: any = await router.handle({ text: "¿Está prendida la tele del dormitorio?" });
  assert.equal(result.route, "fast");
  assert.equal(result.intent, "home_state");
  assert.equal(result.target.entityId, "media_player.tv_dormitorio_2");
  assert.equal(result.result.state, "on");
});

test("fast Home Assistant action resolves, executes and verifies", async () => {
  const search = pluginTool("home_assistant_search_states", "read", "Search live Home Assistant states.");
  const get = pluginTool("home_assistant_get_state", "read", "Read one live Home Assistant state.");
  const action = pluginTool("home_assistant_call_service", "actions", "Call a Home Assistant service.", {
    confirmedByUser: { const: true },
  });
  const calls: Array<{ name: string; args: any }> = [];
  const router = createSolRequestRouter({} as any, ["read", "actions"], [search, get, action], {
    sleep: async () => undefined,
    invokePlugin: (async (_principal: any, tool: any, args: any) => {
      calls.push({ name: tool.name, args });
      if (tool.name === "home_assistant_search_states") {
        return { results: [{ entityId: "media_player.tv_dormitorio_2", domain: "media_player", state: "on", attributes: { device_class: "tv" } }] };
      }
      if (tool.name === "home_assistant_call_service") return { ok: true };
      return { entityId: args.entityId, domain: "media_player", state: "off", attributes: { device_class: "tv" } };
    }) as any,
  });

  const result: any = await router.handle({ text: "Apagá la tele del dormitorio", confirmedByUser: true });
  assert.equal(result.route, "fast");
  assert.equal(result.verification.state, "off");
  const actionCall = calls.find((item) => item.name === "home_assistant_call_service");
  assert.equal(actionCall?.args.service, "turn_off");
  assert.equal(actionCall?.args.target.entity_id, "media_player.tv_dormitorio_2");
  assert.equal(actionCall?.args.confirmedByUser, true);
});

test("agent fallback may select one canonical plugin tool but SOL executes it", async () => {
  const lookup = pluginTool("test_plugin_lookup", "read", "Buscar algo especial en datos de prueba.");
  let executed = false;
  let plannerCalls = 0;
  const router = createSolRequestRouter({} as any, ["read"], [lookup], {
    planner: async () => {
      plannerCalls += 1;
      if (plannerCalls > 1) throw new Error("simple_read_must_not_replan");
      return {
        decision: "tool",
        tool: "test_plugin_lookup",
        arguments: { query: "algo" },
        message: "Consulta seleccionada",
        continueAfterTool: true,
      };
    },
    invokePlugin: (async (_principal: any, tool: any, args: any) => {
      executed = true;
      assert.equal(tool.name, "test_plugin_lookup");
      assert.equal(args.query, "algo");
      return { answer: 42 };
    }) as any,
  });

  const result: any = await router.handle({ text: "Buscá algo especial", mode: "agent" });
  assert.equal(executed, true);
  assert.equal(plannerCalls, 1);
  assert.equal(result.route, "agent");
  assert.equal(result.tool, "test_plugin_lookup");
  assert.equal(result.result.answer, 42);
});

test("agent fallback cannot execute action without confirmation even if planner asks", async () => {
  const action = pluginTool("test_plugin_action", "actions", "Acción especial de prueba.", {
    confirmedByUser: { const: true },
  });
  const router = createSolRequestRouter({} as any, ["read", "actions"], [action], {
    planner: async () => ({
      decision: "tool",
      tool: "test_plugin_action",
      arguments: {},
      message: "Acción",
      continueAfterTool: false,
    }),
    invokePlugin: (async () => {
      throw new Error("must_not_execute");
    }) as any,
  });

  const result: any = await router.handle({ text: "Acción especial", mode: "agent", confirmedByUser: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "user_confirmation_required");
});

test("fast-only mode fails closed instead of invoking Codex", async () => {
  const router = createSolRequestRouter({} as any, ["read"], [], {
    planner: async () => {
      throw new Error("planner_must_not_run");
    },
  });
  const result: any = await router.handle({ text: "Pedido desconocido", mode: "fast" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "fast_route_not_found");
});

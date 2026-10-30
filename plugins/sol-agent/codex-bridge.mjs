// SOL Core owns Codex App Server credentials and the fixed reasoning prompt.
// The plugin receives a limited decision JSON, never a Codex token or CLI access.
export function validateSolCoreUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("sol_core_url_invalid"); }
  if (url.protocol !== "http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("sol_core_url_not_local");
  return url.origin;
}
export function parseCodexDecision(result) {
  if (!result || typeof result !== "object" || result.provider !== "codex" || result.ok !== true)
    throw new Error("sol_codex_provider_invalid");
  if (typeof result.text !== "string" || result.text.length > 12000) throw new Error("sol_codex_response_invalid");
  let parsed;
  try { parsed = JSON.parse(result.text.trim()); } catch { throw new Error("sol_codex_json_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("sol_codex_json_invalid");
  // The autonomous runtime validates tool names, plans and proposal evidence;
  // a model response can NEVER directly invoke or approve a tool.
  return parsed;
}
export async function decideWithSolCodex({
  apiUrl, pluginToken, missionId, objective, profile = "general",
  tools = [], history = [], feedback = [], observation = null,
  guidance = "", steps = 0, cycles = 0, fetcher = fetch
}) {
  if (!pluginToken || typeof pluginToken !== "string") throw new Error("sol_plugin_token_missing");
  const origin = validateSolCoreUrl(apiUrl);
  const context = { missionId, objective, profile, tools, history, feedback,
    observation, guidance, steps, cycles };
  const serialized = JSON.stringify({context});
  if (Buffer.byteLength(serialized, "utf8") > 18000) throw new Error("sol_codex_context_too_large");
  const response = await fetcher(origin + "/v1/plugin-api/ai/reason", {
    method: "POST", redirect: "error",
    headers: { authorization: "Bearer " + pluginToken, "content-type": "application/json" },
    body: serialized, signal: AbortSignal.timeout(125000)
  });
  const raw = await response.text();
  if (raw.length > 14000) throw new Error("sol_codex_http_response_too_large");
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("sol_codex_http_invalid_json"); }
  if (!response.ok) throw new Error("sol_codex_http_" + response.status +
    (typeof data?.error === "string" ? ":" + data.error.slice(0, 100) : ""));
  return parseCodexDecision(data);
}

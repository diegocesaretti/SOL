const PROFILE_TOOLS = new Set([
  "home_assistant_stremio_streams",
  "home_assistant_stremio_select_stream",
  "home_assistant_stremio_play_best",
  "home_assistant_stremio_play"
]);

function clean(value) {
  return String(value ?? "").trim();
}

export function applyFamilyLanguagePolicy(args = {}) {
  const profile = clean(args.profile || "auto").toLowerCase();
  const language = clean(args.language || "").toLowerCase();
  if (profile !== "family" && profile !== "kids") return { ...args };
  if (language) return { ...args };
  return { ...args, language: "latin" };
}

export function installStremioFamilyLanguagePolicy(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioFamilyLanguagePolicyInstalled) return SolPluginClient;
  proto.__stremioFamilyLanguagePolicyInstalled = true;

  const originalHandle = proto.handleStremioTool;
  proto.handleStremioTool = async function handleStremioToolWithFamilyLanguagePolicy(tool, args = {}) {
    if (!PROFILE_TOOLS.has(tool)) return originalHandle.call(this, tool, args);
    return originalHandle.call(this, tool, applyFamilyLanguagePolicy(args));
  };

  return SolPluginClient;
}

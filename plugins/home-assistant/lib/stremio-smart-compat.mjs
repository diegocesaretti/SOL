export function installStremioSmartCompatibility(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioSmartCompatibilityInstalled) return SolPluginClient;
  proto.__stremioSmartCompatibilityInstalled = true;

  const smartHandle = proto.handleStremioTool;
  proto.handleStremioTool = async function handleStremioToolSmartCompatibility(tool, args = {}) {
    if (tool === "home_assistant_stremio_play") {
      return smartHandle.call(this, "home_assistant_stremio_play_best", args);
    }
    return smartHandle.call(this, tool, args);
  };
  return SolPluginClient;
}

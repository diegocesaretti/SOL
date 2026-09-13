export function installHaRemoteCommandNormalization(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__haRemoteCommandNormalizationInstalled) return SolPluginClient;
  proto.__haRemoteCommandNormalizationInstalled = true;

  const originalHaService = proto.haService;
  proto.haService = async function haServiceWithRemoteNormalization(domain, service, data = {}) {
    let normalized = data;
    if (domain === "remote" && service === "send_command" && Array.isArray(data?.command) && data.command.length === 1) {
      normalized = { ...data, command: data.command[0] };
    }
    return originalHaService.call(this, domain, service, normalized);
  };

  return SolPluginClient;
}

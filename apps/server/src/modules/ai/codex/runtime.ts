import { config } from "../../../config.js";
import { CodexAppServerClient } from "./app-server.js";
import { CodexProvider } from "./provider.js";

const codexEnv: NodeJS.ProcessEnv = { ...process.env };
if (config.codexHome) codexEnv.CODEX_HOME = config.codexHome;

export const codexAppServer = new CodexAppServerClient({
  command: config.codexBin,
  cwd: config.codexWorkingDirectory,
  env: codexEnv,
  requestTimeoutMs: config.codexRequestTimeoutMs,
});

export const codexProvider = new CodexProvider(codexAppServer);

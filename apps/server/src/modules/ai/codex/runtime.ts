import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../../config.js";
import { CodexAppServerClient } from "./app-server.js";
import { CodexProvider } from "./provider.js";

// Keep SOL's ChatGPT OAuth cache separate from the developer's normal Codex CLI/IDE
// session. File storage is deliberate here: CODEX_HOME is private, gitignored, and
// can later be mounted/persisted explicitly when SOL moves to a server/container.
mkdirSync(config.codexHome, { recursive: true, mode: 0o700 });
mkdirSync(config.codexWorkingDirectory, { recursive: true, mode: 0o700 });

const codexConfigPath = join(config.codexHome, "config.toml");
if (!existsSync(codexConfigPath)) {
  writeFileSync(
    codexConfigPath,
    [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
}

const codexEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CODEX_HOME: config.codexHome,
};

export const codexAppServer = new CodexAppServerClient({
  command: config.codexBin,
  cwd: config.codexWorkingDirectory,
  env: codexEnv,
  requestTimeoutMs: config.codexRequestTimeoutMs,
});

export const codexProvider = new CodexProvider(codexAppServer);

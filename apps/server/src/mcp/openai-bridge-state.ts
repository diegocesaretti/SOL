import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";

export interface OpenAiBridgeState {
  gatewayUrl: string;
  instanceId: string;
  bridgeToken: string;
  pairCode?: string;
  pairExpiresAt?: string;
  lastCatalogAt?: string;
  toolCount?: number;
  profile?: Record<string, unknown>;
}

const statePath = resolve(config.dataDir, "openai-plugin-bridge.json");

export async function readOpenAiBridgeState(): Promise<OpenAiBridgeState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as OpenAiBridgeState;
    if (!parsed || typeof parsed !== "object" || !parsed.gatewayUrl || !parsed.instanceId || !parsed.bridgeToken) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeOpenAiBridgeState(state: OpenAiBridgeState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  await chmod(statePath, 0o600).catch(() => undefined);
}

export async function publicOpenAiBridgeState(): Promise<Record<string, unknown>> {
  const state = await readOpenAiBridgeState();
  if (!state) return { configured: false };
  return {
    configured: true,
    gatewayUrl: state.gatewayUrl,
    instanceId: state.instanceId,
    pairCode: state.pairCode,
    pairExpiresAt: state.pairExpiresAt,
    lastCatalogAt: state.lastCatalogAt,
    toolCount: state.toolCount ?? 0,
    profile: state.profile ?? null,
  };
}

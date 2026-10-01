import { gatewayConfig } from "./config.js";
import { randomId, signOpaqueToken, signSelfContainedPairCode, verifyOpaqueToken, verifySelfContainedPairCode, type SignedPayload } from "./crypto.js";

export type SolScope = "read" | "submit" | "actions";

export interface RemoteToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  requiredScope: SolScope;
}

export interface BridgeProfile {
  displayName?: string;
  memberRole?: string;
  solVersion?: string;
}

export interface BridgeCatalog {
  instanceId: string;
  tools: RemoteToolDefinition[];
  profile?: BridgeProfile;
  updatedAt: number;
}

export interface BridgeJob {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  createdAt: number;
}

interface BridgeTokenPayload extends SignedPayload {
  typ: "bridge";
  instanceId: string;
}

interface PairingRecord {
  instanceId: string;
  expiresAt: number;
  allowedScopes: SolScope[];
}

interface PendingJob {
  instanceId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const catalogs = new Map<string, BridgeCatalog>();
const consumedPairings = new Map<string, { firstConsumedAt: number; expiresAt: number }>();
const queues = new Map<string, BridgeJob[]>();
const pending = new Map<string, PendingJob>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizedScopes(scopes: unknown): SolScope[] {
  const allowed = new Set<SolScope>(["read", "submit", "actions"]);
  const values = Array.isArray(scopes) ? scopes.filter((value): value is SolScope => typeof value === "string" && allowed.has(value as SolScope)) : [];
  return [...new Set<SolScope>(["read", ...values])];
}

export function enrollBridge(): { instanceId: string; bridgeToken: string } {
  const instanceId = `sol_${randomId(18)}`;
  const bridgeToken = signOpaqueToken({
    typ: "bridge",
    instanceId,
    iat: nowSeconds(),
  });
  return { instanceId, bridgeToken };
}

export function authenticateBridge(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return null;
  const payload = verifyOpaqueToken<BridgeTokenPayload>(match[1], "bridge");
  return payload?.instanceId ?? null;
}

export function updateBridgeCatalog(
  instanceId: string,
  input: { tools?: unknown; profile?: unknown },
): BridgeCatalog {
  if (!Array.isArray(input.tools) || input.tools.length > 80) throw new Error("tools_invalid");
  const tools: RemoteToolDefinition[] = input.tools.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`tool_${index}_invalid`);
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(name)) throw new Error(`tool_${index}_name_invalid`);
    if (!description || description.length > 2000) throw new Error(`tool_${index}_description_invalid`);
    const schema = item.inputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`tool_${index}_schema_invalid`);
    const encoded = JSON.stringify(schema);
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new Error(`tool_${index}_schema_too_large`);
    const annotations = item.annotations && typeof item.annotations === "object" && !Array.isArray(item.annotations)
      ? item.annotations as RemoteToolDefinition["annotations"]
      : undefined;
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 160) : undefined;
    const scope = item.requiredScope === "actions" || item.requiredScope === "submit" ? item.requiredScope : "read";
    return {
      name,
      title,
      description,
      inputSchema: schema as Record<string, unknown>,
      annotations,
      requiredScope: scope,
    };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("duplicate_tool_name");

  const profile = input.profile && typeof input.profile === "object" && !Array.isArray(input.profile)
    ? input.profile as BridgeProfile
    : undefined;
  const catalog: BridgeCatalog = {
    instanceId,
    tools,
    profile,
    updatedAt: Date.now(),
  };
  catalogs.set(instanceId, catalog);
  return catalog;
}

export function getBridgeCatalog(instanceId: string): BridgeCatalog | undefined {
  return catalogs.get(instanceId);
}

export function issuePairCode(instanceId: string, scopes: unknown): { code: string; expiresAt: string; scopes: SolScope[] } {
  const values = normalizedScopes(scopes);
  let scopeBits = 1;
  if (values.includes("submit")) scopeBits |= 2;
  if (values.includes("actions")) scopeBits |= 4;
  const signed = signSelfContainedPairCode(instanceId, scopeBits, gatewayConfig.pairCodeTtlMs);
  return {
    code: signed.code,
    expiresAt: new Date(signed.expiresAt).toISOString(),
    scopes: values,
  };
}

export function consumePairCode(code: string): PairingRecord | null {
  const verified = verifySelfContainedPairCode(code);
  if (!verified) return null;

  const now = Date.now();
  const prior = consumedPairings.get(verified.replayKey);
  if (prior && now - prior.firstConsumedAt > 20_000) return null;
  if (!prior) consumedPairings.set(verified.replayKey, { firstConsumedAt: now, expiresAt: verified.expiresAt });

  const allowedScopes: SolScope[] = ["read"];
  if ((verified.scopeBits & 2) !== 0) allowedScopes.push("submit");
  if ((verified.scopeBits & 4) !== 0) allowedScopes.push("actions");

  return {
    instanceId: verified.instanceId,
    expiresAt: verified.expiresAt,
    allowedScopes,
  };
}

export function bridgeConnection(instanceId: string): {
  online: boolean;
  lastCatalogAt?: string;
  toolCount: number;
  profile?: BridgeProfile;
} {
  const catalog = catalogs.get(instanceId);
  if (!catalog) return { online: false, toolCount: 0 };
  const online = Date.now() - catalog.updatedAt < 90_000;
  return {
    online,
    lastCatalogAt: new Date(catalog.updatedAt).toISOString(),
    toolCount: catalog.tools.length,
    profile: catalog.profile,
  };
}

export async function invokeBridgeTool(
  instanceId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const catalog = catalogs.get(instanceId);
  if (!catalog || Date.now() - catalog.updatedAt > 90_000) throw new Error("sol_bridge_offline");
  if (!catalog.tools.some((entry) => entry.name === tool)) throw new Error("tool_not_available");

  const id = `job_${randomId(18)}`;
  const job: BridgeJob = {
    id,
    tool,
    arguments: args,
    createdAt: Date.now(),
  };
  const queue = queues.get(instanceId) ?? [];
  if (queue.length >= 64) throw new Error("bridge_queue_full");
  queue.push(job);
  queues.set(instanceId, queue);

  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("sol_bridge_timeout"));
    }, gatewayConfig.jobTimeoutMs);
    pending.set(id, { instanceId, resolve, reject, timer });
  });
}

export async function pollBridgeJob(instanceId: string, waitMs = gatewayConfig.bridgeLongPollMs): Promise<BridgeJob | null> {
  const until = Date.now() + Math.max(0, Math.min(gatewayConfig.bridgeLongPollMs, waitMs));
  while (true) {
    const queue = queues.get(instanceId);
    const job = queue?.shift();
    if (job) return job;
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function completeBridgeJob(
  instanceId: string,
  jobId: string,
  input: { ok?: unknown; result?: unknown; error?: unknown },
): boolean {
  const item = pending.get(jobId);
  if (!item || item.instanceId !== instanceId) return false;
  pending.delete(jobId);
  clearTimeout(item.timer);
  if (input.ok === true) item.resolve(input.result);
  else item.reject(new Error(typeof input.error === "string" && input.error ? input.error : "remote_tool_failed"));
  return true;
}

export function cleanupState(): void {
  const now = Date.now();
  for (const [key, pairing] of consumedPairings) {
    if (pairing.expiresAt <= now) consumedPairings.delete(key);
  }
  for (const [instanceId, catalog] of catalogs) {
    if (now - catalog.updatedAt > 24 * 60 * 60_000) catalogs.delete(instanceId);
  }
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../../database/client.js";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import {
  deleteSourceAccount,
  getSourceAccount,
  listSourceAccounts,
  updateSourceAccount,
  type SourceAccountRecord,
} from "../identity/source-accounts.js";
import { handlePluginsApi } from "../plugins/routes.js";

function adult(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

function canRead(principal: AuthPrincipal, account: SourceAccountRecord): boolean {
  if (account.householdId !== principal.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return principal.role !== "guest";
}

function canManage(principal: AuthPrincipal, account: SourceAccountRecord): boolean {
  if (account.householdId !== principal.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return adult(principal);
}

async function sourceStats(accountIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  if (!accountIds.length) return new Map();
  const result = await db.query<{
    source_account_id: string;
    total_items: string;
    items_24h: string;
    last_item_at: Date | null;
    last_observed_at: Date | null;
    text_items: string;
  }>(
    `SELECT source_account_id,
            count(*)::text AS total_items,
            count(*) FILTER (WHERE observed_at >= now() - interval '24 hours')::text AS items_24h,
            max(occurred_at) AS last_item_at,
            max(observed_at) AS last_observed_at,
            count(*) FILTER (WHERE body_text IS NOT NULL AND btrim(body_text) <> '')::text AS text_items
     FROM source_items
     WHERE source_account_id = ANY($1::uuid[]) AND deleted_at IS NULL
     GROUP BY source_account_id`,
    [accountIds],
  );
  return new Map(result.rows.map((row) => [row.source_account_id, {
    totalItems: Number(row.total_items),
    items24h: Number(row.items_24h),
    textItems: Number(row.text_items),
    lastItemAt: row.last_item_at?.toISOString(),
    lastObservedAt: row.last_observed_at?.toISOString(),
  }]));
}

async function readBody<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content-type must be application/json" });
    return null;
  }
  try {
    return await readJsonBody<T>(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    return null;
  }
}

export async function handleInputsApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/inputs/plugins" || path.startsWith("/v1/inputs/plugins/")) {
    const pluginPath = path.replace(/^\/v1\/inputs\/plugins/, "/v1/plugins");
    return handlePluginsApi(pluginPath, request, response, principal);
  }

  if (path === "/v1/inputs" && request.method === "GET") {
    const accounts = await listSourceAccounts(principal.householdId, principal.memberId, adult(principal));
    const visible = accounts.filter((account) => canRead(principal, account));
    const stats = await sourceStats(visible.map((account) => account.id));
    sendJson(response, 200, {
      inputs: visible.map((account) => ({
        ...account,
        shared: !account.ownerMemberId,
        canManage: canManage(principal, account),
        pluginManaged: (account.authMode ?? "").startsWith("plugin:"),
        pluginId: (account.authMode ?? "").startsWith("plugin:") ? account.authMode!.slice("plugin:".length) : undefined,
        canCleanupResidual: canManage(principal, account) && (account.authMode ?? "").startsWith("plugin:") && account.status !== "connected",
        stats: stats.get(account.id) ?? {
          totalItems: 0,
          items24h: 0,
          textItems: 0,
        },
      })),
      server: {
        ok: true,
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        platform: process.platform,
      },
    });
    return true;
  }

  const match = path.match(/^\/v1\/inputs\/([0-9a-f-]{36})(?:\/(items))?$/i);
  if (!match?.[1]) return false;
  const sourceAccountId = match[1];
  const action = match[2];
  const account = await getSourceAccount(sourceAccountId);
  if (!account || account.householdId !== principal.householdId || !canRead(principal, account)) {
    sendJson(response, 404, { error: "input_not_found" });
    return true;
  }

  if (action === "items" && request.method === "GET") {
    const url = new URL(request.url ?? path, "http://sol.local");
    const limit = Math.max(10, Math.min(200, Number(url.searchParams.get("limit") || 80)));
    const result = await db.query<{
      id: string;
      kind: string;
      occurred_at: Date;
      observed_at: Date;
      title: string | null;
      body_text: string | null;
      raw_metadata: Record<string, unknown>;
    }>(
      `SELECT id, kind, occurred_at, observed_at, title, body_text, raw_metadata
       FROM source_items
       WHERE source_account_id = $1 AND deleted_at IS NULL
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [sourceAccountId, limit],
    );
    sendJson(response, 200, {
      items: result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        occurredAt: row.occurred_at.toISOString(),
        observedAt: row.observed_at.toISOString(),
        title: row.title ?? undefined,
        text: row.body_text ?? undefined,
        metadata: {
          origin: row.raw_metadata?.origin,
          fromMe: row.raw_metadata?.fromMe,
          pushName: row.raw_metadata?.pushName,
          messageType: row.raw_metadata?.messageType,
          candidateScore: row.raw_metadata?.candidateScore,
          from: row.raw_metadata?.from,
          fromAddress: row.raw_metadata?.fromAddress,
          to: row.raw_metadata?.to,
          labelIds: row.raw_metadata?.labelIds,
          threadId: row.raw_metadata?.threadId,
        },
      })),
    });
    return true;
  }

  if (!canManage(principal, account)) {
    sendJson(response, 403, { error: "forbidden" });
    return true;
  }

  if (!action && request.method === "PATCH") {
    const body = await readBody<{ label?: string; shared?: boolean }>(request, response);
    if (!body) return true;
    if (body.shared === true && !adult(principal)) {
      sendJson(response, 403, { error: "shared_input_requires_adult" });
      return true;
    }
    try {
      const updated = await updateSourceAccount(sourceAccountId, {
        householdId: principal.householdId,
        ownerMemberId: principal.memberId,
        label: body.label,
        shared: body.shared,
      });
      if (!updated) {
        sendJson(response, 404, { error: "input_not_found" });
        return true;
      }
      sendJson(response, 200, { input: updated });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (!action && request.method === "DELETE") {
    const pluginManaged = (account.authMode ?? "").startsWith("plugin:");
    const url = new URL(request.url ?? path, "http://sol.local");
    const cleanupResidual = url.searchParams.get("cleanup") === "1";
    if (pluginManaged && !cleanupResidual) {
      sendJson(response, 409, {
        error: "input_is_plugin_managed",
        hint: "Remove the real account from its plugin. If this is only a stale SOL projection, retry with ?cleanup=1 while it is disconnected.",
        canCleanupResidual: account.status !== "connected",
      });
      return true;
    }
    if (pluginManaged && cleanupResidual && account.status === "connected") {
      sendJson(response, 409, {
        error: "connected_plugin_input_cannot_be_cleaned",
        hint: "Disconnect or remove the account from its plugin first.",
      });
      return true;
    }
    const deleted = await deleteSourceAccount(sourceAccountId, principal.householdId);
    sendJson(response, deleted ? 200 : 404, {
      ok: deleted,
      residualCleanup: Boolean(pluginManaged && cleanupResidual && deleted),
    });
    return true;
  }

  return false;
}

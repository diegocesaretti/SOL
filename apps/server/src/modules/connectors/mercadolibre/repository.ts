import { db } from "../../../database/client.js";

export interface MercadoLibreAccount {
  id: string;
  householdId: string;
  ownerMemberId?: string;
  label: string;
  status: "connected" | "disconnected" | "error";
  userId?: string;
  nickname?: string;
  siteId?: string;
  countryId?: string;
  tokenExpiresAt?: string;
  lastSyncAt?: string;
  lastError?: string;
}

interface AccountRow {
  id: string;
  household_id: string;
  owner_member_id: string | null;
  label: string;
  status: MercadoLibreAccount["status"];
  user_id: string | null;
  nickname: string | null;
  site_id: string | null;
  country_id: string | null;
  expires_at: Date | null;
  last_sync_at: Date | null;
  last_error: string | null;
}

function mapAccount(row: AccountRow): MercadoLibreAccount {
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    label: row.label,
    status: row.status,
    userId: row.user_id ?? undefined,
    nickname: row.nickname ?? undefined,
    siteId: row.site_id ?? undefined,
    countryId: row.country_id ?? undefined,
    tokenExpiresAt: row.expires_at?.toISOString(),
    lastSyncAt: row.last_sync_at?.toISOString(),
    lastError: row.last_error ?? undefined,
  };
}

const ACCOUNT_SELECT = `
  SELECT sa.id, sa.household_id, sa.owner_member_id, sa.label, sa.status::text AS status,
         mc.user_id, mc.nickname, mc.site_id, mc.country_id, mc.expires_at,
         sa.last_sync_at, mc.last_error
  FROM source_accounts sa
  LEFT JOIN mercadolibre_oauth_credentials mc ON mc.source_account_id = sa.id
  WHERE sa.provider = 'mercadolibre'
`;

export async function listMercadoLibreAccounts(
  householdId: string,
  viewerMemberId: string,
  canSeeAll: boolean,
): Promise<MercadoLibreAccount[]> {
  const result = await db.query<AccountRow>(
    `${ACCOUNT_SELECT}
     AND sa.household_id = $1
     AND ($3::boolean OR sa.owner_member_id = $2 OR sa.owner_member_id IS NULL)
     ORDER BY sa.created_at ASC`,
    [householdId, viewerMemberId, canSeeAll],
  );
  return result.rows.map(mapAccount);
}

export async function getMercadoLibreAccount(sourceAccountId: string): Promise<MercadoLibreAccount | null> {
  const result = await db.query<AccountRow>(`${ACCOUNT_SELECT} AND sa.id = $1 LIMIT 1`, [sourceAccountId]);
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

export async function updateMercadoLibreProfile(
  sourceAccountId: string,
  profile: { userId: string; nickname?: string; siteId?: string; countryId?: string },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE mercadolibre_oauth_credentials
       SET user_id = $2, nickname = $3, site_id = $4, country_id = $5,
           last_error = NULL, updated_at = now()
       WHERE source_account_id = $1`,
      [sourceAccountId, profile.userId, profile.nickname ?? null, profile.siteId ?? null, profile.countryId ?? null],
    );
    await client.query(
      `UPDATE source_accounts
       SET external_account_id = $2, status = 'connected', updated_at = now()
       WHERE id = $1 AND provider = 'mercadolibre'`,
      [sourceAccountId, profile.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markMercadoLibreSynced(sourceAccountId: string): Promise<void> {
  await db.query(
    `UPDATE source_accounts SET status = 'connected', last_sync_at = now(), updated_at = now() WHERE id = $1`,
    [sourceAccountId],
  );
  await db.query(
    `UPDATE mercadolibre_oauth_credentials SET last_error = NULL, updated_at = now() WHERE source_account_id = $1`,
    [sourceAccountId],
  );
}

export async function markMercadoLibreError(sourceAccountId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
  await Promise.all([
    db.query("UPDATE source_accounts SET status = 'error', updated_at = now() WHERE id = $1", [sourceAccountId]),
    db.query(
      "UPDATE mercadolibre_oauth_credentials SET last_error = $2, updated_at = now() WHERE source_account_id = $1",
      [sourceAccountId, message],
    ),
  ]);
}

export async function markMercadoLibreDisconnected(sourceAccountId: string): Promise<void> {
  await db.query(
    `UPDATE source_accounts
     SET status = 'disconnected', external_account_id = NULL, updated_at = now()
     WHERE id = $1 AND provider = 'mercadolibre'`,
    [sourceAccountId],
  );
}

export interface MercadoLibreDashboard {
  stats: {
    orders: number;
    paidOrders: number;
    revenue: number;
    currency?: string;
    activeItems: number;
    unansweredQuestions: number;
  };
  orders: Array<{
    id: string;
    status: string;
    totalAmount?: number;
    currencyId?: string;
    buyerNickname?: string;
    itemTitles: string[];
    shippingId?: string;
    occurredAt?: string;
  }>;
  questions: Array<{
    id: string;
    itemId?: string;
    status: string;
    text: string;
    answered: boolean;
    dateCreated?: string;
  }>;
  items: Array<{
    id: string;
    title: string;
    status: string;
    price?: number;
    currencyId?: string;
    availableQuantity?: number;
    soldQuantity?: number;
    permalink?: string;
  }>;
}

export async function getMercadoLibreDashboard(sourceAccountId: string): Promise<MercadoLibreDashboard> {
  const [stats, orders, questions, items] = await Promise.all([
    db.query<{
      orders: string;
      paid_orders: string;
      revenue: string | null;
      currency_id: string | null;
      active_items: string;
      unanswered_questions: string;
    }>(
      `SELECT
         (SELECT count(*) FROM mercadolibre_orders WHERE source_account_id = $1) AS orders,
         (SELECT count(*) FROM mercadolibre_orders WHERE source_account_id = $1 AND status = 'paid') AS paid_orders,
         (SELECT COALESCE(sum(total_amount), 0) FROM mercadolibre_orders WHERE source_account_id = $1 AND status = 'paid') AS revenue,
         (SELECT currency_id FROM mercadolibre_orders WHERE source_account_id = $1 AND currency_id IS NOT NULL ORDER BY COALESCE(date_closed, date_created) DESC NULLS LAST LIMIT 1) AS currency_id,
         (SELECT count(*) FROM mercadolibre_items WHERE source_account_id = $1 AND status = 'active') AS active_items,
         (SELECT count(*) FROM mercadolibre_questions WHERE source_account_id = $1 AND status IN ('UNANSWERED', 'unanswered')) AS unanswered_questions`,
      [sourceAccountId],
    ),
    db.query<{
      order_id: string;
      status: string;
      total_amount: string | null;
      currency_id: string | null;
      buyer_nickname: string | null;
      shipping_id: string | null;
      order_items: unknown;
      occurred_at: Date | null;
    }>(
      `SELECT order_id, status, total_amount, currency_id, buyer_nickname, shipping_id,
              order_items, COALESCE(date_closed, date_created) AS occurred_at
       FROM mercadolibre_orders
       WHERE source_account_id = $1
       ORDER BY COALESCE(date_closed, date_created) DESC NULLS LAST
       LIMIT 30`,
      [sourceAccountId],
    ),
    db.query<{
      question_id: string;
      item_id: string | null;
      status: string;
      question_text: string;
      answer: unknown;
      date_created: Date | null;
    }>(
      `SELECT question_id, item_id, status, question_text, answer, date_created
       FROM mercadolibre_questions
       WHERE source_account_id = $1
       ORDER BY date_created DESC NULLS LAST
       LIMIT 30`,
      [sourceAccountId],
    ),
    db.query<{
      item_id: string;
      title: string;
      status: string;
      price: string | null;
      currency_id: string | null;
      available_quantity: number | null;
      sold_quantity: number | null;
      permalink: string | null;
    }>(
      `SELECT item_id, title, status, price, currency_id, available_quantity, sold_quantity, permalink
       FROM mercadolibre_items
       WHERE source_account_id = $1
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 80`,
      [sourceAccountId],
    ),
  ]);

  const stat = stats.rows[0];
  return {
    stats: {
      orders: Number(stat?.orders ?? 0),
      paidOrders: Number(stat?.paid_orders ?? 0),
      revenue: Number(stat?.revenue ?? 0),
      currency: stat?.currency_id ?? undefined,
      activeItems: Number(stat?.active_items ?? 0),
      unansweredQuestions: Number(stat?.unanswered_questions ?? 0),
    },
    orders: orders.rows.map((row) => {
      const entries = Array.isArray(row.order_items) ? row.order_items : [];
      const titles = entries
        .map((entry) => {
          if (!entry || typeof entry !== "object") return undefined;
          const item = (entry as { item?: { title?: unknown } }).item;
          return typeof item?.title === "string" ? item.title : undefined;
        })
        .filter((value): value is string => Boolean(value));
      return {
        id: row.order_id,
        status: row.status,
        totalAmount: row.total_amount == null ? undefined : Number(row.total_amount),
        currencyId: row.currency_id ?? undefined,
        buyerNickname: row.buyer_nickname ?? undefined,
        itemTitles: titles,
        shippingId: row.shipping_id ?? undefined,
        occurredAt: row.occurred_at?.toISOString(),
      };
    }),
    questions: questions.rows.map((row) => ({
      id: row.question_id,
      itemId: row.item_id ?? undefined,
      status: row.status,
      text: row.question_text,
      answered: Boolean(row.answer),
      dateCreated: row.date_created?.toISOString(),
    })),
    items: items.rows.map((row) => ({
      id: row.item_id,
      title: row.title,
      status: row.status,
      price: row.price == null ? undefined : Number(row.price),
      currencyId: row.currency_id ?? undefined,
      availableQuantity: row.available_quantity ?? undefined,
      soldQuantity: row.sold_quantity ?? undefined,
      permalink: row.permalink ?? undefined,
    })),
  };
}

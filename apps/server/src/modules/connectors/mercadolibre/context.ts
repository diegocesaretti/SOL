import { db } from "../../../database/client.js";

export interface MercadoLibreReasoningContext {
  accounts: Array<{
    id: string;
    label: string;
    status: string;
    lastSyncAt?: string;
  }>;
  period: {
    start: string;
    end: string;
    orders: number;
    paidOrders: number;
    revenueByCurrency: Array<{ currency: string; amount: number }>;
    recentOrders: Array<{
      id: string;
      status: string;
      totalAmount?: number;
      currencyId?: string;
      itemTitles: string[];
      occurredAt?: string;
    }>;
  };
  activeItems: number;
  unansweredQuestions: Array<{
    id: string;
    itemId?: string;
    text: string;
    dateCreated?: string;
  }>;
}

type HouseholdRole = "owner" | "adult" | "member" | "child" | "guest";

function titles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const item = (entry as { item?: { title?: unknown } }).item;
      return typeof item?.title === "string" ? item.title.trim().slice(0, 300) : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

/**
 * Compact business context for reasoning/briefs. The visible-account CTE enforces
 * source ownership before any marketplace rows are retrieved, so an owner/admin
 * still cannot read another member's private Mercado Libre account.
 */
export async function buildMercadoLibreReasoningContext(input: {
  householdId: string;
  memberId: string;
  role: HouseholdRole;
  periodStart: Date;
  periodEnd: Date;
}): Promise<MercadoLibreReasoningContext | null> {
  if (input.role === "guest") return null;

  const accountResult = await db.query<{
    id: string;
    label: string;
    status: string;
    last_sync_at: Date | null;
  }>(
    `SELECT sa.id, sa.label, sa.status::text, sa.last_sync_at
     FROM source_accounts sa
     WHERE sa.household_id = $1
       AND sa.provider = 'mercadolibre'
       AND (sa.owner_member_id = $2 OR sa.owner_member_id IS NULL)
     ORDER BY sa.created_at ASC`,
    [input.householdId, input.memberId],
  );
  if (!accountResult.rows.length) return null;
  const accountIds = accountResult.rows.map((row) => row.id);

  const [periodStats, revenue, recentOrders, activeItems, questions] = await Promise.all([
    db.query<{ orders: string; paid_orders: string }>(
      `SELECT count(*) AS orders,
              count(*) FILTER (WHERE status = 'paid') AS paid_orders
       FROM mercadolibre_orders
       WHERE source_account_id = ANY($1::uuid[])
         AND COALESCE(date_closed, date_created) >= $2
         AND COALESCE(date_closed, date_created) < $3`,
      [accountIds, input.periodStart, input.periodEnd],
    ),
    db.query<{ currency_id: string | null; amount: string }>(
      `SELECT currency_id, COALESCE(sum(total_amount), 0)::text AS amount
       FROM mercadolibre_orders
       WHERE source_account_id = ANY($1::uuid[])
         AND status = 'paid'
         AND COALESCE(date_closed, date_created) >= $2
         AND COALESCE(date_closed, date_created) < $3
       GROUP BY currency_id
       ORDER BY currency_id NULLS LAST`,
      [accountIds, input.periodStart, input.periodEnd],
    ),
    db.query<{
      order_id: string;
      status: string;
      total_amount: string | null;
      currency_id: string | null;
      order_items: unknown;
      occurred_at: Date | null;
    }>(
      `SELECT order_id, status, total_amount, currency_id, order_items,
              COALESCE(date_closed, date_created) AS occurred_at
       FROM mercadolibre_orders
       WHERE source_account_id = ANY($1::uuid[])
         AND COALESCE(date_closed, date_created) >= $2
         AND COALESCE(date_closed, date_created) < $3
       ORDER BY COALESCE(date_closed, date_created) DESC NULLS LAST
       LIMIT 12`,
      [accountIds, input.periodStart, input.periodEnd],
    ),
    db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM mercadolibre_items
       WHERE source_account_id = ANY($1::uuid[]) AND status = 'active'`,
      [accountIds],
    ),
    db.query<{
      question_id: string;
      item_id: string | null;
      question_text: string;
      date_created: Date | null;
    }>(
      `SELECT question_id, item_id, question_text, date_created
       FROM mercadolibre_questions
       WHERE source_account_id = ANY($1::uuid[])
         AND status IN ('UNANSWERED', 'unanswered')
       ORDER BY date_created DESC NULLS LAST
       LIMIT 12`,
      [accountIds],
    ),
  ]);

  const stats = periodStats.rows[0];
  return {
    accounts: accountResult.rows.map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      lastSyncAt: row.last_sync_at?.toISOString(),
    })),
    period: {
      start: input.periodStart.toISOString(),
      end: input.periodEnd.toISOString(),
      orders: Number(stats?.orders ?? 0),
      paidOrders: Number(stats?.paid_orders ?? 0),
      revenueByCurrency: revenue.rows.map((row) => ({
        currency: row.currency_id ?? "unknown",
        amount: Number(row.amount),
      })),
      recentOrders: recentOrders.rows.map((row) => ({
        id: row.order_id,
        status: row.status,
        totalAmount: row.total_amount == null ? undefined : Number(row.total_amount),
        currencyId: row.currency_id ?? undefined,
        itemTitles: titles(row.order_items),
        occurredAt: row.occurred_at?.toISOString(),
      })),
    },
    activeItems: Number(activeItems.rows[0]?.count ?? 0),
    unansweredQuestions: questions.rows.map((row) => ({
      id: row.question_id,
      itemId: row.item_id ?? undefined,
      text: row.question_text.slice(0, 1500),
      dateCreated: row.date_created?.toISOString(),
    })),
  };
}

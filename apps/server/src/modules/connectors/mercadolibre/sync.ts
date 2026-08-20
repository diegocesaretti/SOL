import { db } from "../../../database/client.js";
import { mercadoLibreGet } from "./client.js";
import {
  getMercadoLibreAccount,
  markMercadoLibreError,
  markMercadoLibreSynced,
  updateMercadoLibreProfile,
} from "./repository.js";

const PAGE_SIZE = 50;
const MAX_ITEMS = 500;
const MAX_ORDERS = 200;
const MAX_QUESTIONS = 100;

interface MlUser {
  id: string | number;
  nickname?: string;
  site_id?: string;
  country_id?: string;
}

interface IdSearchResponse {
  results?: Array<string | number>;
  paging?: { total?: number; offset?: number; limit?: number };
}

interface MlItem {
  id: string | number;
  title?: string;
  status?: string;
  price?: number;
  currency_id?: string;
  available_quantity?: number;
  sold_quantity?: number;
  listing_type_id?: string;
  condition?: string;
  permalink?: string;
  catalog_product_id?: string | null;
  seller_custom_field?: string | null;
  date_created?: string;
  last_updated?: string;
}

interface MultiGetItem {
  code?: number;
  body?: MlItem;
}

interface MlOrder {
  id: string | number;
  status?: string;
  status_detail?: unknown;
  total_amount?: number;
  currency_id?: string;
  buyer?: { id?: string | number; nickname?: string };
  pack_id?: string | number | null;
  shipping?: { id?: string | number | null };
  order_items?: unknown[];
  payments?: unknown[];
  tags?: string[];
  date_created?: string;
  date_closed?: string;
  date_last_updated?: string;
  cancel_detail?: unknown;
  context?: unknown;
}

interface OrderSearchResponse {
  results?: MlOrder[];
  paging?: { total?: number; offset?: number; limit?: number };
}

interface MlQuestion {
  id: string | number;
  item_id?: string;
  status?: string;
  text?: string;
  from?: { id?: string | number };
  answer?: unknown;
  date_created?: string;
  date_answered?: string;
}

interface QuestionSearchResponse {
  questions?: MlQuestion[];
  total?: number;
  limit?: number;
  offset?: number;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeJson(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

async function sourcePrivacy(sourceAccountId: string): Promise<{
  householdId: string;
  ownerMemberId: string | null;
  visibility: "private" | "family";
}> {
  const result = await db.query<{ household_id: string; owner_member_id: string | null }>(
    `SELECT household_id, owner_member_id
     FROM source_accounts
     WHERE id = $1 AND provider = 'mercadolibre'`,
    [sourceAccountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Mercado Libre source account not found");
  return {
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id,
    visibility: row.owner_member_id ? "private" : "family",
  };
}

async function loadAllItemIds(sourceAccountId: string, userId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < MAX_ITEMS; offset += PAGE_SIZE) {
    const page = await mercadoLibreGet<IdSearchResponse>(
      sourceAccountId,
      `/users/${encodeURIComponent(userId)}/items/search?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    const pageIds = (page.results ?? []).map(asId).filter((value): value is string => Boolean(value));
    ids.push(...pageIds);
    const total = Number(page.paging?.total ?? ids.length);
    if (!pageIds.length || ids.length >= total) break;
  }
  return ids.slice(0, MAX_ITEMS);
}

async function syncItems(sourceAccountId: string, userId: string): Promise<number> {
  const ids = await loadAllItemIds(sourceAccountId, userId);
  let count = 0;
  for (let index = 0; index < ids.length; index += 20) {
    const batch = ids.slice(index, index + 20);
    const params = new URLSearchParams({
      ids: batch.join(","),
      attributes: [
        "id", "title", "status", "price", "currency_id", "available_quantity",
        "sold_quantity", "listing_type_id", "condition", "permalink",
        "catalog_product_id", "seller_custom_field", "date_created", "last_updated",
      ].join(","),
    });
    const response = await mercadoLibreGet<MultiGetItem[]>(sourceAccountId, `/items?${params}`);
    for (const entry of response ?? []) {
      const item = entry?.body;
      const itemId = asId(item?.id);
      if (!item || !itemId) continue;
      await db.query(
        `INSERT INTO mercadolibre_items(
           source_account_id, item_id, title, status, price, currency_id,
           available_quantity, sold_quantity, listing_type_id, condition, permalink,
           catalog_product_id, seller_custom_field, date_created, last_updated, raw,
           discovered_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,now(),now())
         ON CONFLICT(source_account_id, item_id)
         DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status, price = EXCLUDED.price,
                       currency_id = EXCLUDED.currency_id,
                       available_quantity = EXCLUDED.available_quantity,
                       sold_quantity = EXCLUDED.sold_quantity,
                       listing_type_id = EXCLUDED.listing_type_id,
                       condition = EXCLUDED.condition, permalink = EXCLUDED.permalink,
                       catalog_product_id = EXCLUDED.catalog_product_id,
                       seller_custom_field = EXCLUDED.seller_custom_field,
                       date_created = EXCLUDED.date_created, last_updated = EXCLUDED.last_updated,
                       raw = EXCLUDED.raw, discovered_at = now(), updated_at = now()`,
        [
          sourceAccountId,
          itemId,
          item.title?.slice(0, 500) || itemId,
          item.status || "unknown",
          item.price ?? null,
          item.currency_id ?? null,
          item.available_quantity ?? null,
          item.sold_quantity ?? null,
          item.listing_type_id ?? null,
          item.condition ?? null,
          item.permalink ?? null,
          item.catalog_product_id ?? null,
          item.seller_custom_field ?? null,
          asDate(item.date_created),
          asDate(item.last_updated),
          safeJson({ catalog_product_id: item.catalog_product_id ?? null }, {}),
        ],
      );
      count += 1;
    }
  }
  return count;
}

function orderTitles(orderItems: unknown[] | undefined): string[] {
  return (orderItems ?? [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const item = (entry as { item?: { title?: unknown } }).item;
      return typeof item?.title === "string" ? item.title.trim() : undefined;
    })
    .filter((value): value is string => Boolean(value));
}

async function persistOrder(
  sourceAccountId: string,
  privacy: Awaited<ReturnType<typeof sourcePrivacy>>,
  order: MlOrder,
): Promise<boolean> {
  const orderId = asId(order.id);
  if (!orderId) return false;
  const buyerId = asId(order.buyer?.id);
  const packId = asId(order.pack_id);
  const shippingId = asId(order.shipping?.id);
  const occurredAt = asDate(order.date_closed) ?? asDate(order.date_created) ?? new Date();
  const titles = orderTitles(order.order_items);
  const title = titles.length ? `Venta Mercado Libre · ${titles.slice(0, 2).join(" + ")}` : `Venta Mercado Libre #${orderId}`;
  const body = [
    order.status || "unknown",
    order.total_amount != null ? `${order.currency_id ?? ""} ${order.total_amount}`.trim() : undefined,
    buyerId ? `buyer:${buyerId}` : undefined,
  ].filter(Boolean).join(" · ");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO mercadolibre_orders(
         source_account_id, order_id, status, status_detail, total_amount, currency_id,
         buyer_id, buyer_nickname, pack_id, shipping_id, order_items, payments, tags,
         date_created, date_closed, date_last_updated, raw, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::text[],$14,$15,$16,$17::jsonb,now())
       ON CONFLICT(source_account_id, order_id)
       DO UPDATE SET status = EXCLUDED.status, status_detail = EXCLUDED.status_detail,
                     total_amount = EXCLUDED.total_amount, currency_id = EXCLUDED.currency_id,
                     buyer_id = EXCLUDED.buyer_id, buyer_nickname = EXCLUDED.buyer_nickname,
                     pack_id = EXCLUDED.pack_id, shipping_id = EXCLUDED.shipping_id,
                     order_items = EXCLUDED.order_items, payments = EXCLUDED.payments,
                     tags = EXCLUDED.tags, date_created = EXCLUDED.date_created,
                     date_closed = EXCLUDED.date_closed,
                     date_last_updated = EXCLUDED.date_last_updated,
                     raw = EXCLUDED.raw, updated_at = now()`,
      [
        sourceAccountId,
        orderId,
        order.status || "unknown",
        safeJson(order.status_detail, {}),
        order.total_amount ?? null,
        order.currency_id ?? null,
        buyerId ?? null,
        order.buyer?.nickname?.slice(0, 240) ?? null,
        packId ?? null,
        shippingId ?? null,
        safeJson(order.order_items, []),
        safeJson(order.payments, []),
        Array.isArray(order.tags) ? order.tags.slice(0, 80) : [],
        asDate(order.date_created),
        asDate(order.date_closed),
        asDate(order.date_last_updated),
        safeJson({ cancel_detail: order.cancel_detail ?? null, context: order.context ?? null }, {}),
      ],
    );
    await client.query(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind, owner_member_id,
         visibility, occurred_at, title, body_text, raw_metadata
       ) VALUES ($1,$2,$3,'mercadolibre_order',$4,$5::visibility_scope,$6,$7,$8,$9::jsonb)
       ON CONFLICT(source_account_id, kind, external_id)
       DO UPDATE SET observed_at = now(), title = EXCLUDED.title, body_text = EXCLUDED.body_text,
                     raw_metadata = EXCLUDED.raw_metadata, deleted_at = NULL`,
      [
        privacy.householdId,
        sourceAccountId,
        orderId,
        privacy.ownerMemberId,
        privacy.visibility,
        occurredAt,
        title.slice(0, 500),
        body.slice(0, 4000),
        safeJson({ orderId, status: order.status ?? "unknown", totalAmount: order.total_amount ?? null, currencyId: order.currency_id ?? null, shippingId: shippingId ?? null }, {}),
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncOrders(sourceAccountId: string, userId: string): Promise<number> {
  const privacy = await sourcePrivacy(sourceAccountId);
  let count = 0;
  for (let offset = 0; offset < MAX_ORDERS; offset += PAGE_SIZE) {
    const page = await mercadoLibreGet<OrderSearchResponse>(
      sourceAccountId,
      `/orders/search?seller=${encodeURIComponent(userId)}&sort=date_desc&limit=${PAGE_SIZE}&offset=${offset}`,
    );
    const orders = page.results ?? [];
    for (const order of orders) if (await persistOrder(sourceAccountId, privacy, order)) count += 1;
    const total = Number(page.paging?.total ?? count);
    if (!orders.length || offset + orders.length >= total) break;
  }
  return count;
}

async function persistQuestion(
  sourceAccountId: string,
  privacy: Awaited<ReturnType<typeof sourcePrivacy>>,
  question: MlQuestion,
): Promise<boolean> {
  const questionId = asId(question.id);
  if (!questionId || !question.text) return false;
  const fromId = asId(question.from?.id);
  const occurredAt = asDate(question.date_created) ?? new Date();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO mercadolibre_questions(
         source_account_id, question_id, item_id, status, question_text,
         from_user_id, answer, date_created, date_answered, raw, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,now())
       ON CONFLICT(source_account_id, question_id)
       DO UPDATE SET item_id = EXCLUDED.item_id, status = EXCLUDED.status,
                     question_text = EXCLUDED.question_text, from_user_id = EXCLUDED.from_user_id,
                     answer = EXCLUDED.answer, date_created = EXCLUDED.date_created,
                     date_answered = EXCLUDED.date_answered, raw = EXCLUDED.raw, updated_at = now()`,
      [
        sourceAccountId,
        questionId,
        question.item_id ?? null,
        question.status || "unknown",
        question.text.slice(0, 12000),
        fromId ?? null,
        question.answer == null ? null : safeJson(question.answer, null),
        asDate(question.date_created),
        asDate(question.date_answered),
        safeJson({ itemId: question.item_id ?? null }, {}),
      ],
    );
    await client.query(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind, owner_member_id,
         visibility, occurred_at, title, body_text, raw_metadata
       ) VALUES ($1,$2,$3,'mercadolibre_question',$4,$5::visibility_scope,$6,$7,$8,$9::jsonb)
       ON CONFLICT(source_account_id, kind, external_id)
       DO UPDATE SET observed_at = now(), title = EXCLUDED.title, body_text = EXCLUDED.body_text,
                     raw_metadata = EXCLUDED.raw_metadata, deleted_at = NULL`,
      [
        privacy.householdId,
        sourceAccountId,
        questionId,
        privacy.ownerMemberId,
        privacy.visibility,
        occurredAt,
        `Pregunta Mercado Libre${question.item_id ? ` · ${question.item_id}` : ""}`,
        question.text.slice(0, 12000),
        safeJson({ questionId, itemId: question.item_id ?? null, status: question.status ?? "unknown", answered: Boolean(question.answer) }, {}),
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncQuestions(sourceAccountId: string, userId: string): Promise<number> {
  const privacy = await sourcePrivacy(sourceAccountId);
  let count = 0;
  for (let offset = 0; offset < MAX_QUESTIONS; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      seller_id: userId,
      api_version: "4",
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort_fields: "date_created",
      sort_types: "DESC",
    });
    const page = await mercadoLibreGet<QuestionSearchResponse>(sourceAccountId, `/questions/search?${params}`);
    const questions = page.questions ?? [];
    for (const question of questions) if (await persistQuestion(sourceAccountId, privacy, question)) count += 1;
    const total = Number(page.total ?? count);
    if (!questions.length || offset + questions.length >= total) break;
  }
  return count;
}

export async function syncMercadoLibreAccount(sourceAccountId: string): Promise<{
  items: number;
  orders: number;
  questions: number;
  seller: { userId: string; nickname?: string; siteId?: string };
}> {
  const account = await getMercadoLibreAccount(sourceAccountId);
  if (!account) throw new Error("Mercado Libre account not found");
  try {
    const profile = await mercadoLibreGet<MlUser>(sourceAccountId, "/users/me");
    const userId = asId(profile.id);
    if (!userId) throw new Error("Mercado Libre /users/me did not return a valid user id");
    await updateMercadoLibreProfile(sourceAccountId, {
      userId,
      nickname: profile.nickname,
      siteId: profile.site_id,
      countryId: profile.country_id,
    });
    const [items, orders, questions] = await Promise.all([
      syncItems(sourceAccountId, userId),
      syncOrders(sourceAccountId, userId),
      syncQuestions(sourceAccountId, userId),
    ]);
    await markMercadoLibreSynced(sourceAccountId);
    return {
      items,
      orders,
      questions,
      seller: { userId, nickname: profile.nickname, siteId: profile.site_id },
    };
  } catch (error) {
    await markMercadoLibreError(sourceAccountId, error).catch(() => undefined);
    throw error;
  }
}

import { db } from "../../../database/client.js";
import { GoogleApiError, googleCalendarFetch } from "./client.js";
import { listGoogleCalendars, type GoogleCalendarRecord } from "./repository.js";

interface CalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
  selected?: boolean;
  deleted?: boolean;
}

interface CalendarListResponse {
  items?: CalendarListEntry[];
  nextPageToken?: string;
}

interface EventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  created?: string;
  updated?: string;
  recurrence?: string[];
  recurringEventId?: string;
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  organizer?: { email?: string; displayName?: string };
  creator?: { email?: string; displayName?: string };
}

interface EventListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

function writable(accessRole: string | undefined): boolean {
  return accessRole === "writer" || accessRole === "owner" || accessRole === "writerWithoutPrivateAccess";
}

function visibilityFor(ownerMemberId: string | null): "private" | "family" {
  return ownerMemberId ? "private" : "family";
}

function eventStart(event: GoogleEvent): { startsAt: Date; allDay: boolean } {
  const value = event.start?.dateTime || event.start?.date;
  if (value) {
    const date = new Date(event.start?.dateTime || `${value}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return { startsAt: date, allDay: Boolean(event.start?.date && !event.start?.dateTime) };
  }
  const fallback = new Date(event.updated || event.created || Date.now());
  return { startsAt: Number.isNaN(fallback.getTime()) ? new Date() : fallback, allDay: false };
}

function eventEnd(event: GoogleEvent): Date | null {
  const value = event.end?.dateTime || event.end?.date;
  if (!value) return null;
  const date = new Date(event.end?.dateTime || `${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function persistGoogleEvent(
  sourceAccount: { id: string; householdId: string; ownerMemberId: string | null },
  calendar: GoogleCalendarRecord,
  event: GoogleEvent,
): Promise<void> {
  if (!event.id) return;
  const externalId = `${calendar.externalCalendarId}:${event.id}`;
  const visibility = visibilityFor(sourceAccount.ownerMemberId);
  const cancelled = event.status === "cancelled";
  const { startsAt, allDay } = eventStart(event);
  const endsAt = eventEnd(event);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const sourceResult = await client.query<{ id: string }>(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind, owner_member_id,
         visibility, occurred_at, title, body_text, raw_metadata, deleted_at
       ) VALUES ($1, $2, $3, 'calendar_event', $4, $5::visibility_scope, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT(source_account_id, kind, external_id)
       DO UPDATE SET occurred_at = EXCLUDED.occurred_at,
                     title = EXCLUDED.title,
                     body_text = EXCLUDED.body_text,
                     raw_metadata = EXCLUDED.raw_metadata,
                     deleted_at = EXCLUDED.deleted_at
       RETURNING id`,
      [
        sourceAccount.householdId,
        sourceAccount.id,
        externalId,
        sourceAccount.ownerMemberId,
        visibility,
        startsAt,
        event.summary ?? "Evento",
        event.description ?? null,
        JSON.stringify({
          provider: "google_calendar",
          calendarId: calendar.externalCalendarId,
          calendarName: calendar.summary,
          eventId: event.id,
          etag: event.etag ?? null,
          status: event.status ?? null,
          allDay,
          start: event.start ?? null,
          end: event.end ?? null,
          location: event.location ?? null,
          recurrence: event.recurrence ?? null,
          recurringEventId: event.recurringEventId ?? null,
          attendees: event.attendees ?? null,
          organizer: event.organizer ?? null,
          creator: event.creator ?? null,
        }),
        cancelled ? new Date() : null,
      ],
    );
    const sourceItemId = sourceResult.rows[0]?.id;
    if (!sourceItemId) throw new Error("Failed to persist Google Calendar source item");

    const existingLink = await client.query<{ life_event_id: string | null }>(
      `SELECT life_event_id FROM google_event_links
       WHERE source_account_id = $1 AND google_calendar_id = $2 AND external_event_id = $3`,
      [sourceAccount.id, calendar.id, event.id],
    );
    let lifeEventId = existingLink.rows[0]?.life_event_id ?? null;

    if (cancelled) {
      if (lifeEventId) {
        await client.query("DELETE FROM life_events WHERE id = $1", [lifeEventId]);
        lifeEventId = null;
      }
    } else if (lifeEventId) {
      await client.query(
        `UPDATE life_events
         SET title = $2, description = $3, starts_at = $4, ends_at = $5,
             visibility = $6::visibility_scope, metadata = $7::jsonb, updated_at = now()
         WHERE id = $1`,
        [
          lifeEventId,
          event.summary ?? "Evento",
          event.description ?? null,
          startsAt,
          endsAt,
          visibility,
          JSON.stringify({ provider: "google_calendar", sourceAccountId: sourceAccount.id, googleCalendarId: calendar.id, externalEventId: event.id, allDay, recurrence: event.recurrence ?? null }),
        ],
      );
    } else {
      const lifeResult = await client.query<{ id: string }>(
        `INSERT INTO life_events(
           household_id, owner_member_id, event_type, title, description,
           starts_at, ends_at, visibility, confidence, metadata
         ) VALUES ($1, $2, 'calendar', $3, $4, $5, $6, $7::visibility_scope, 1, $8::jsonb)
         RETURNING id`,
        [
          sourceAccount.householdId,
          sourceAccount.ownerMemberId,
          event.summary ?? "Evento",
          event.description ?? null,
          startsAt,
          endsAt,
          visibility,
          JSON.stringify({ provider: "google_calendar", sourceAccountId: sourceAccount.id, googleCalendarId: calendar.id, externalEventId: event.id, allDay, recurrence: event.recurrence ?? null }),
        ],
      );
      lifeEventId = lifeResult.rows[0]?.id ?? null;
    }

    await client.query(
      `INSERT INTO google_event_links(
         source_account_id, google_calendar_id, external_event_id,
         source_item_id, life_event_id, etag, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT(source_account_id, google_calendar_id, external_event_id)
       DO UPDATE SET source_item_id = EXCLUDED.source_item_id,
                     life_event_id = EXCLUDED.life_event_id,
                     etag = EXCLUDED.etag,
                     updated_at = now()`,
      [sourceAccount.id, calendar.id, event.id, sourceItemId, lifeEventId, event.etag ?? null],
    );

    if (lifeEventId) {
      await client.query(
        `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
         VALUES ($1, 'life_event', $2, 'represents')
         ON CONFLICT(source_item_id, target_type, target_id, relation) DO NOTHING`,
        [sourceItemId, lifeEventId],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function discoverGoogleCalendars(sourceAccountId: string): Promise<GoogleCalendarRecord[]> {
  const entries: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "250" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await googleCalendarFetch<CalendarListResponse>(
      sourceAccountId,
      `/users/me/calendarList?${params}`,
    );
    entries.push(...(response.items ?? []).filter((item) => !item.deleted && item.id));
    pageToken = response.nextPageToken;
  } while (pageToken);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const entry of entries) {
      const accessRole = entry.accessRole ?? "reader";
      await client.query(
        `INSERT INTO google_calendars(
           source_account_id, external_calendar_id, summary, timezone, access_role,
           is_primary, selected_for_sync, selected_for_write, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, now())
         ON CONFLICT(source_account_id, external_calendar_id)
         DO UPDATE SET summary = EXCLUDED.summary,
                       timezone = EXCLUDED.timezone,
                       access_role = EXCLUDED.access_role,
                       is_primary = EXCLUDED.is_primary,
                       updated_at = now()`,
        [
          sourceAccountId,
          entry.id,
          entry.summaryOverride || entry.summary || entry.id,
          entry.timeZone ?? null,
          accessRole,
          Boolean(entry.primary),
          Boolean(entry.primary && writable(accessRole)),
        ],
      );
    }

    const primary = entries.find((entry) => entry.primary);
    await client.query(
      `UPDATE source_accounts
       SET status = 'connected',
           external_account_id = COALESCE($2, external_account_id),
           updated_at = now()
       WHERE id = $1 AND provider = 'google_calendar'`,
      [sourceAccountId, primary?.id ?? null],
    );
    if (primary?.id) {
      await client.query(
        `UPDATE google_oauth_credentials
         SET google_account_email = $2, updated_at = now()
         WHERE source_account_id = $1`,
        [sourceAccountId, primary.id],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return listGoogleCalendars(sourceAccountId);
}

async function sourceAccountForSync(sourceAccountId: string): Promise<{ id: string; householdId: string; ownerMemberId: string | null }> {
  const result = await db.query<{ id: string; household_id: string; owner_member_id: string | null }>(
    `SELECT id, household_id, owner_member_id
     FROM source_accounts WHERE id = $1 AND provider = 'google_calendar' AND status = 'connected'`,
    [sourceAccountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Connected Google Calendar source account not found");
  return { id: row.id, householdId: row.household_id, ownerMemberId: row.owner_member_id };
}

async function syncOneCalendar(
  sourceAccount: { id: string; householdId: string; ownerMemberId: string | null },
  calendar: GoogleCalendarRecord,
  reset = false,
): Promise<number> {
  const tokenResult = await db.query<{ sync_token: string | null }>(
    "SELECT sync_token FROM google_calendars WHERE id = $1",
    [calendar.id],
  );
  let syncToken = reset ? undefined : tokenResult.rows[0]?.sync_token ?? undefined;
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let count = 0;

  try {
    do {
      const params = new URLSearchParams({ maxResults: "2500", showDeleted: "true", singleEvents: "false" });
      if (syncToken) params.set("syncToken", syncToken);
      if (pageToken) params.set("pageToken", pageToken);
      const response = await googleCalendarFetch<EventListResponse>(
        sourceAccount.id,
        `/calendars/${encodeURIComponent(calendar.externalCalendarId)}/events?${params}`,
      );
      for (const event of response.items ?? []) {
        await persistGoogleEvent(sourceAccount, calendar, event);
        count += 1;
      }
      pageToken = response.nextPageToken;
      if (response.nextSyncToken) nextSyncToken = response.nextSyncToken;
    } while (pageToken);
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 410 && !reset) {
      await db.query("UPDATE google_calendars SET sync_token = NULL WHERE id = $1", [calendar.id]);
      return syncOneCalendar(sourceAccount, calendar, true);
    }
    throw error;
  }

  await db.query(
    `UPDATE google_calendars
     SET sync_token = COALESCE($2, sync_token), last_sync_at = now(), updated_at = now()
     WHERE id = $1`,
    [calendar.id, nextSyncToken ?? null],
  );
  return count;
}

export async function syncGoogleCalendarAccount(sourceAccountId: string): Promise<{ calendars: number; events: number }> {
  const sourceAccount = await sourceAccountForSync(sourceAccountId);
  const calendars = await listGoogleCalendars(sourceAccountId);
  let events = 0;
  let synced = 0;
  for (const calendar of calendars.filter((item) => item.selectedForSync)) {
    events += await syncOneCalendar(sourceAccount, calendar);
    synced += 1;
  }
  await db.query(
    "UPDATE source_accounts SET last_sync_at = now(), status = 'connected', updated_at = now() WHERE id = $1",
    [sourceAccountId],
  );
  return { calendars: synced, events };
}

export interface UpcomingCalendarEvent {
  sourceAccountId: string;
  googleCalendarId: string;
  calendarName: string;
  eventId: string;
  title: string;
  description?: string;
  location?: string;
  start: EventDateTime;
  end?: EventDateTime;
}

export async function listUpcomingGoogleEvents(
  sourceAccountId: string,
  from: Date,
  to: Date,
): Promise<UpcomingCalendarEvent[]> {
  const calendars = (await listGoogleCalendars(sourceAccountId)).filter((item) => item.selectedForSync);
  const output: UpcomingCalendarEvent[] = [];
  for (const calendar of calendars) {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        showDeleted: "false",
        orderBy: "startTime",
        maxResults: "2500",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await googleCalendarFetch<EventListResponse>(
        sourceAccountId,
        `/calendars/${encodeURIComponent(calendar.externalCalendarId)}/events?${params}`,
      );
      for (const event of response.items ?? []) {
        if (!event.id || !event.start) continue;
        output.push({
          sourceAccountId,
          googleCalendarId: calendar.id,
          calendarName: calendar.summary,
          eventId: event.id,
          title: event.summary ?? "Evento",
          description: event.description,
          location: event.location,
          start: event.start,
          end: event.end,
        });
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
  }
  return output;
}

export async function createGoogleCalendarEvent(input: {
  sourceAccountId: string;
  googleCalendarId: string;
  proposalId: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt?: Date;
}): Promise<{ eventId: string; htmlLink?: string }> {
  const result = await db.query<{ external_calendar_id: string; access_role: string }>(
    `SELECT external_calendar_id, access_role
     FROM google_calendars
     WHERE id = $1 AND source_account_id = $2 AND selected_for_write = true`,
    [input.googleCalendarId, input.sourceAccountId],
  );
  const calendar = result.rows[0];
  if (!calendar) throw new Error("Selected writable Google Calendar was not found");
  if (!writable(calendar.access_role)) throw new Error("Google Calendar is not writable");

  const eventId = `sol${input.proposalId.replace(/-/g, "")}`;
  const body = {
    id: eventId,
    summary: input.title,
    description: input.description,
    start: { dateTime: input.startsAt.toISOString() },
    end: { dateTime: (input.endsAt ?? new Date(input.startsAt.getTime() + 60 * 60 * 1000)).toISOString() },
    extendedProperties: {
      private: {
        solProposalId: input.proposalId,
      },
    },
  };

  try {
    return await googleCalendarFetch<{ id: string; htmlLink?: string }>(
      input.sourceAccountId,
      `/calendars/${encodeURIComponent(calendar.external_calendar_id)}/events`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((event) => ({ eventId: event.id, htmlLink: event.htmlLink }));
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 409) {
      const existing = await googleCalendarFetch<{ id: string; htmlLink?: string }>(
        input.sourceAccountId,
        `/calendars/${encodeURIComponent(calendar.external_calendar_id)}/events/${encodeURIComponent(eventId)}`,
      );
      return { eventId: existing.id, htmlLink: existing.htmlLink };
    }
    throw error;
  }
}

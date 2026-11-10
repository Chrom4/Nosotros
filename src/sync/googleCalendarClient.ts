/**
 * Google Calendar REST API v3 Client
 * Strictly avoids `googleapis` library; uses native REST fetch with Bearer token authentication.
 * Uses `extendedProperties.private` for idempotent upsert of bills and invoices.
 */

export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

export interface CalendarEventPayload {
  summary: string;
  description?: string;
  dueDate: string; // YYYY-MM-DD
  nosotrosEventId: string; // Unique domain key, e.g. "invoice:inv-123"
  additionalProperties?: Record<string, string>;
}

export interface CalendarEventResponse {
  id: string;
  summary: string;
  description?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

export interface UpsertCalendarEventOptions {
  accessToken: string;
  event: CalendarEventPayload;
  calendarId?: string;
  fetchFn?: typeof fetch;
}

export interface FindCalendarEventOptions {
  accessToken: string;
  nosotrosEventId: string;
  calendarId?: string;
  fetchFn?: typeof fetch;
}

export interface DeleteCalendarEventOptions {
  accessToken: string;
  eventId: string;
  calendarId?: string;
  fetchFn?: typeof fetch;
}

export interface SyncRemindersOptions {
  accessToken: string;
  reminders: CalendarEventPayload[];
  calendarId?: string;
  fetchFn?: typeof fetch;
}

export interface SyncRemindersResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

/**
 * Finds an existing calendar event by its private `nosotros_event_id` property.
 */
export async function findEventByNosotrosId(
  options: FindCalendarEventOptions,
): Promise<CalendarEventResponse | null> {
  const {
    accessToken,
    nosotrosEventId,
    calendarId = 'primary',
    fetchFn = fetch,
  } = options;

  if (!accessToken) {
    throw new Error('CALENDAR_AUTH_ERROR: Missing Google Calendar access token');
  }

  const queryParams = new URLSearchParams({
    privateExtendedProperty: `nosotros_event_id=${nosotrosEventId}`,
  });

  const response = await fetchFn(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${queryParams.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `CALENDAR_QUERY_FAILED: HTTP ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as { items?: CalendarEventResponse[] };
  return (data.items && data.items.length > 0) ? data.items[0] : null;
}

/**
 * Idempotently inserts or updates an event in Google Calendar.
 * Matches on `extendedProperties.private.nosotros_event_id`.
 */
export async function upsertCalendarEvent(
  options: UpsertCalendarEventOptions,
): Promise<{ event: CalendarEventResponse; action: 'CREATED' | 'UPDATED' }> {
  const {
    accessToken,
    event,
    calendarId = 'primary',
    fetchFn = fetch,
  } = options;

  if (!accessToken) {
    throw new Error('CALENDAR_AUTH_ERROR: Missing Google Calendar access token');
  }

  const existingEvent = await findEventByNosotrosId({
    accessToken,
    nosotrosEventId: event.nosotrosEventId,
    calendarId,
    fetchFn,
  });

  const bodyPayload = {
    summary: event.summary,
    description: event.description ?? '',
    start: {
      date: event.dueDate,
    },
    end: {
      date: event.dueDate,
    },
    extendedProperties: {
      private: {
        nosotros_event_id: event.nosotrosEventId,
        ...(event.additionalProperties ?? {}),
      },
    },
  };

  if (existingEvent) {
    // Update existing event
    const response = await fetchFn(
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existingEvent.id)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `CALENDAR_UPDATE_FAILED: HTTP ${response.status} - ${errorText}`,
      );
    }

    const updated = (await response.json()) as CalendarEventResponse;
    return { event: updated, action: 'UPDATED' };
  } else {
    // Create new event
    const response = await fetchFn(
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `CALENDAR_CREATE_FAILED: HTTP ${response.status} - ${errorText}`,
      );
    }

    const created = (await response.json()) as CalendarEventResponse;
    return { event: created, action: 'CREATED' };
  }
}

/**
 * Deletes an event by its Google Calendar event ID.
 */
export async function deleteCalendarEvent(
  options: DeleteCalendarEventOptions,
): Promise<void> {
  const { accessToken, eventId, calendarId = 'primary', fetchFn = fetch } = options;

  if (!accessToken) {
    throw new Error('CALENDAR_AUTH_ERROR: Missing Google Calendar access token');
  }

  const response = await fetchFn(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok && response.status !== 404) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `CALENDAR_DELETE_FAILED: HTTP ${response.status} - ${errorText}`,
    );
  }
}

/**
 * Synchronizes a list of invoice/bill reminders to the couple's Google Calendar.
 */
export async function syncRemindersToCalendar(
  options: SyncRemindersOptions,
): Promise<SyncRemindersResult> {
  const { accessToken, reminders, calendarId = 'primary', fetchFn = fetch } = options;

  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const reminder of reminders) {
    try {
      const res = await upsertCalendarEvent({
        accessToken,
        event: reminder,
        calendarId,
        fetchFn,
      });

      if (res.action === 'CREATED') {
        created++;
      } else {
        updated++;
      }
    } catch (err: unknown) {
      failed++;
      errors.push(
        `Failed for ${reminder.nosotrosEventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    total: reminders.length,
    created,
    updated,
    failed,
    errors,
  };
}

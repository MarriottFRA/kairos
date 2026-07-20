/**
 * Calendar IPC Handlers
 * Budget/forecast calendar (calendar days, public holidays, weekends and the
 * net productive days derived from them), stored per hotel OU + year in the
 * unencrypted local SQLite store.
 */

import { IpcHandler, IpcResult } from "../types";
import {
  getCalendarYear,
  saveCalendarYear,
  listCalendarYears,
  deleteCalendarYear,
} from "../../local_db";
import {
  CalendarYear,
  DEFAULT_WEEKEND_MASK,
  buildDefaultCalendar,
  normalizeCalendar,
} from "../../shared/calendar";

interface CalendarKeyRequest {
  ou: string;
  year: number;
}

/** Reject anything that isn't a usable (ou, year) pair before touching the DB. */
function parseKey(request: Partial<CalendarKeyRequest> | undefined): CalendarKeyRequest {
  const ou = typeof request?.ou === "string" ? request.ou.trim() : "";
  const year = Math.trunc(Number(request?.year));

  if (!ou) throw new Error("A hotel OU is required");
  if (!Number.isFinite(year) || year < 1900 || year > 2999) {
    throw new Error(`Invalid calendar year: ${request?.year}`);
  }
  return { ou, year };
}

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  return {
    success: false,
    error: error instanceof Error ? error.message : "Unknown error",
    data,
    timestamp: Date.now(),
  };
}

export class CalendarHandlers {
  /**
   * Load one hotel-year calendar. A year that has never been saved comes back
   * seeded from the real calendar (Sat/Sun weekends, no holidays) and flagged
   * `saved: false`, so the grid always has something to render.
   */
  getCalendar: IpcHandler<any, IpcResult<{ calendar: CalendarYear; saved: boolean } | null>> =
    async (_event, request) => {
      try {
        const { ou, year } = parseKey(request);
        const stored = await getCalendarYear(ou, year);

        return ok({
          calendar: stored ?? buildDefaultCalendar(ou, year, DEFAULT_WEEKEND_MASK),
          saved: stored !== null,
        });
      } catch (error) {
        console.error("Failed to get calendar:", error);
        return fail(error, null);
      }
    };

  /** Upsert a whole hotel-year calendar and return what was persisted. */
  saveCalendar: IpcHandler<any, IpcResult<CalendarYear | null>> = async (_event, request) => {
    try {
      const { ou, year } = parseKey(request);
      const calendar = normalizeCalendar(
        ou,
        year,
        Number(request?.weekendMask),
        Array.isArray(request?.months) ? request.months : []
      );

      await saveCalendarYear(calendar);
      return ok(await getCalendarYear(ou, year));
    } catch (error) {
      console.error("Failed to save calendar:", error);
      return fail(error, null);
    }
  };

  /** Years with a saved calendar for this OU (newest first). */
  listYears: IpcHandler<any, IpcResult<number[]>> = async (_event, request) => {
    try {
      const ou = typeof request?.ou === "string" ? request.ou.trim() : "";
      if (!ou) throw new Error("A hotel OU is required");
      return ok(await listCalendarYears(ou));
    } catch (error) {
      console.error("Failed to list calendar years:", error);
      return fail(error, [] as number[]);
    }
  };

  /** Delete a saved calendar. */
  deleteCalendar: IpcHandler<any, IpcResult<void>> = async (_event, request) => {
    try {
      const { ou, year } = parseKey(request);
      await deleteCalendarYear(ou, year);
      return ok(undefined as void);
    } catch (error) {
      console.error("Failed to delete calendar:", error);
      return fail(error, undefined as void);
    }
  };
}

export function createCalendarHandlers() {
  const handlers = new CalendarHandlers();

  return {
    "calendar:get": handlers.getCalendar,
    "calendar:save": handlers.saveCalendar,
    "calendar:list-years": handlers.listYears,
    "calendar:delete": handlers.deleteCalendar,
  };
}

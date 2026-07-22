/**
 * Position Safe-Defaults IPC Handlers
 * The numbers a new position's Contract columns start from (Yearly Days, Days
 * Off, Public Holidays, Daily Hours), stored per hotel OU + year in the
 * unencrypted local store beside the calendar they mostly track.
 *
 * Linked fields are resolved against the saved calendar *here*, on read, so the
 * Positions tab always seeds with current numbers without loading the calendar
 * itself — even if the user never re-saved the defaults after editing it.
 */

import { IpcHandler, IpcResult } from "../types";
import {
  getCalendarYear,
  getPositionDefaults,
  savePositionDefaults,
} from "../../local_db";
import {
  DEFAULT_WEEKEND_MASK,
  buildDefaultCalendar,
} from "../../shared/calendar";
import {
  PositionDefaults,
  buildDefaultPositionDefaults,
  normalizePositionDefaults,
  resolvePositionDefaults,
} from "../../shared/positionDefaults";

interface DefaultsKeyRequest {
  ou: string;
  year: number;
}

/** Reject anything that isn't a usable (ou, year) pair before touching the DB. */
function parseKey(request: Partial<DefaultsKeyRequest> | undefined): DefaultsKeyRequest {
  const ou = typeof request?.ou === "string" ? request.ou.trim() : "";
  const year = Math.trunc(Number(request?.year));

  if (!ou) throw new Error("A hotel OU is required");
  if (!Number.isFinite(year) || year < 1900 || year > 2999) {
    throw new Error(`Invalid year: ${request?.year}`);
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

/** Resolve linked fields against the hotel-year calendar (or a default one). */
async function resolveAgainstCalendar(
  ou: string,
  year: number,
  defaults: PositionDefaults
): Promise<PositionDefaults> {
  const calendar =
    (await getCalendarYear(ou, year)) ??
    buildDefaultCalendar(ou, year, DEFAULT_WEEKEND_MASK);
  return resolvePositionDefaults(defaults, calendar);
}

export class PositionDefaultsHandlers {
  /**
   * Load one hotel-year's safe defaults. A year that has never been saved comes
   * back seeded (all linked, 40h/week) and flagged `saved: false`. Linked
   * fields are resolved against the current calendar either way.
   */
  getDefaults: IpcHandler<
    any,
    IpcResult<{ defaults: PositionDefaults; saved: boolean } | null>
  > = async (_event, request) => {
    try {
      const { ou, year } = parseKey(request);
      const stored = await getPositionDefaults(ou, year);
      const base = stored ?? buildDefaultPositionDefaults(ou, year);
      const defaults = await resolveAgainstCalendar(ou, year, base);

      return ok({ defaults, saved: stored !== null });
    } catch (error) {
      console.error("Failed to get position defaults:", error);
      return fail(error, null);
    }
  };

  /** Upsert one hotel-year's safe defaults and return what was persisted. */
  saveDefaults: IpcHandler<any, IpcResult<PositionDefaults | null>> = async (
    _event,
    request
  ) => {
    try {
      const { ou, year } = parseKey(request);
      const normalized = normalizePositionDefaults(
        ou,
        year,
        request?.weeklyHours,
        request?.fields
      );

      await savePositionDefaults(normalized);
      const stored = await getPositionDefaults(ou, year);
      const resolved = await resolveAgainstCalendar(
        ou,
        year,
        stored ?? normalized
      );
      return ok(resolved);
    } catch (error) {
      console.error("Failed to save position defaults:", error);
      return fail(error, null);
    }
  };
}

export function createPositionDefaultsHandlers() {
  const handlers = new PositionDefaultsHandlers();

  return {
    "position-defaults:get": handlers.getDefaults,
    "position-defaults:save": handlers.saveDefaults,
  };
}

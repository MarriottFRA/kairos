/**
 * Calendar Service
 * Renderer-side access to the budget/forecast calendar stored in the local
 * SQLite database (one calendar per hotel OU + year).
 *
 * `sendIpcRequest` returns the full { success, data } envelope and throws when
 * the main process reports a failure, so these helpers just unwrap `data`.
 */

import { CalendarYear } from "../shared/calendar";

interface LoadedCalendar {
  calendar: CalendarYear;
  /** false when nothing has been saved yet and the grid is showing defaults. */
  saved: boolean;
}

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Load a hotel-year calendar; unsaved years come back seeded from defaults. */
export async function loadCalendar(ou: string, year: number): Promise<LoadedCalendar> {
  const response = await ipc().sendIpcRequest("calendar:get", { ou, year });
  return response.data as LoadedCalendar;
}

/** Upsert a calendar and return what was persisted. */
export async function saveCalendar(calendar: CalendarYear): Promise<CalendarYear> {
  const response = await ipc().sendIpcRequest("calendar:save", calendar);
  return response.data as CalendarYear;
}

/** Years with a saved calendar for this OU, newest first. */
export async function listCalendarYears(ou: string): Promise<number[]> {
  const response = await ipc().sendIpcRequest("calendar:list-years", { ou });
  return (response.data as number[]) ?? [];
}

/** Delete a saved calendar. */
export async function deleteCalendar(ou: string, year: number): Promise<void> {
  await ipc().sendIpcRequest("calendar:delete", { ou, year });
}

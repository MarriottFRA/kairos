/**
 * TEMPORARY sign-in tracing IPC — DELETE WITH `main/auth/authDebug.ts`.
 * -----------------------------------------------------------
 * Two channels only: read the current state, and set it. The renderer owns the
 * discreet toggle + red indicator on the sign-in screen; main owns the actual
 * tracing and the diagnostics window.
 *
 * `auth:debug-trace-changed` is pushed back to the renderer so the indicator
 * follows state changed from elsewhere — the in-window chord, or the user
 * closing the diagnostics window.
 */

import { IpcHandler } from "../types";
import {
  authDebugArmed,
  authDebugOnChange,
  authDebugSetArmed,
} from "../../main/auth/authDebug";

export const AUTH_DEBUG_CHANNELS = {
  GET: "auth:debugTraceGet",
  SET: "auth:debugTraceSet",
} as const;

/** Renderer event carrying `{ on }` whenever tracing is switched. */
export const AUTH_DEBUG_CHANGED_EVENT = "auth:debug-trace-changed";

export function createAuthDebugHandlers(
  sendToRenderer: (channel: string, payload?: unknown) => void
): Record<string, IpcHandler> {
  authDebugOnChange((on) => sendToRenderer(AUTH_DEBUG_CHANGED_EVENT, { on }));

  const get: IpcHandler = () => ({ on: authDebugArmed() });

  // No payload => toggle. Explicit `{ on }` => set.
  const set: IpcHandler<{ on?: boolean } | undefined> = (_event, payload) => ({
    on: authDebugSetArmed(payload?.on ?? !authDebugArmed()),
  });

  return {
    [AUTH_DEBUG_CHANNELS.GET]: get,
    [AUTH_DEBUG_CHANNELS.SET]: set,
  };
}

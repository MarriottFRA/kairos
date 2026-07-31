/**
 * usePresenceReporter — tell the server there is unpublished work here.
 * -----------------------------------------------------------
 * `POST /plans/{id}/presence` roughly every 60 seconds while the user has
 * unsaved changes, and once with `dirtyEntities: 0` after a successful publish.
 *
 * ## Why this is not optional
 *
 * It is the ONLY way the server can warn an owner before a force-withdrawal. An
 * owner revoking a delegation from somebody with a morning's unpublished work
 * gets a 409 naming exactly what is about to be stranded — but only if that
 * person has been reporting. Without it the owner revokes blind, and the first
 * anybody hears about the stranded work is when the delegate tries to publish.
 *
 * It also backs the soft presence display ("B edited Rooms 2 minutes ago").
 *
 * ## Advisory, never a lock
 *
 * An offline-capable desktop client cannot hold a pessimistic lock honestly, and
 * a crashed one would strand it forever. Presence is never an authorisation
 * input: two people editing the same department is a conflict resolved at commit
 * time on content hashes, not prevented here.
 *
 * Failures are silent by design. Somebody who cannot reach the server must still
 * be able to work — that is the whole premise of the app.
 */

import { useEffect, useRef } from "react";
import { presence } from "../services/kairosSyncService";

/** The cadence from the API guide (§7.4b). */
const PRESENCE_INTERVAL_MS = 60 * 1000;

export interface PresenceInput {
  ou: string | null;
  planId: string | null;
  /** Rows edited since the last publish. Zero means "all clear". */
  dirtyEntities: number;
  /** Which departments the unpublished work is in, for the owner's warning. */
  departments: string[];
  lastLocalEditAt: string | null;
  /** Skip entirely when the plan was never published. */
  enabled?: boolean;
}

export function usePresenceReporter(input: PresenceInput): void {
  const { ou, planId, dirtyEntities, departments, lastLocalEditAt } = input;
  const enabled = input.enabled !== false;

  // Read through a ref so a changing dirty count does not tear down and rebuild
  // the interval on every keystroke — the timer's cadence is the point, and
  // restarting it on each edit would mean a busy typist never actually reports.
  const latest = useRef(input);
  latest.current = input;

  // The last value sent, so the transition to zero is reported exactly once
  // rather than every minute for the rest of the session.
  const lastSent = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !ou || !planId) return;

    const report = (): void => {
      const current = latest.current;
      if (current.dirtyEntities === 0 && lastSent.current === 0) return;
      lastSent.current = current.dirtyEntities;
      void presence(
        ou,
        planId,
        current.dirtyEntities,
        current.departments,
        current.lastLocalEditAt
      );
    };

    // Report immediately on mount so an owner looking right now sees the truth,
    // then settle into the interval.
    report();
    const timer = window.setInterval(report, PRESENCE_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // Deliberately NOT depending on dirtyEntities: see the ref above.
  }, [ou, planId, enabled]);

  // A publish drops the count to zero, and the server should hear about that
  // straight away rather than up to a minute later — an owner deciding whether
  // to revoke is looking at this number.
  useEffect(() => {
    if (!enabled || !ou || !planId) return;
    if (dirtyEntities !== 0 || lastSent.current === 0) return;
    lastSent.current = 0;
    void presence(ou, planId, 0, departments, lastLocalEditAt);
  }, [enabled, ou, planId, dirtyEntities, departments, lastLocalEditAt]);
}

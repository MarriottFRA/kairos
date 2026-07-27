/**
 * Which scenario is "the" scenario for a hotel + budget year.
 *
 * The backend guarantees at least one scenario per (ou, year) — it seeds a
 * "Planning" row on demand (structureRepo.ensureDefaultScenario) — but NOT that
 * exactly one exists, nor that one is labelled Planning: a hotel whose only 2027
 * scenario is "Aggressive" never gets a Planning row, and nothing forbids two
 * rows sharing a label. So resolution is a preference ladder, not a lookup.
 *
 * It lives here because four callers must agree on it: the Positions, Results
 * and Allocations pages (which heal a stale persisted id), and cluster-position
 * sync in the main process, which has to pick the SAME scenario in another hotel
 * that that hotel's own grid would show — otherwise a mirrored row would land
 * somewhere the user never looks.
 */

import { ScenarioDto } from "./ipc";

/** The label ensureDefaultScenario seeds; mirrored from structureRepo so the
 *  renderer does not hardcode the string in three places. */
export const DEFAULT_SCENARIO_LABEL = "Planning";

/**
 * Preference order: the caller's persisted choice, then the seeded default,
 * then whatever exists for the year. null only when the year has no scenarios
 * at all.
 */
export function resolvePlanningScenario(
  scenarios: readonly ScenarioDto[],
  year: number,
  preferredId?: string | null
): ScenarioDto | null {
  const forYear = scenarios.filter((scenario) => scenario.year === year);
  return (
    (preferredId ? forYear.find((s) => s.id === preferredId) : undefined) ??
    forYear.find((s) => s.label === DEFAULT_SCENARIO_LABEL) ??
    forYear[0] ??
    null
  );
}

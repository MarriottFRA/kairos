/**
 * scenarioSourceOptions — the "copy from" source list, shared by the two places
 * a scenario can be seeded from another one: the Manage scenarios create form
 * (ScenarioPicker) and the roll-forward dialog (CopyScenarioDialog).
 *
 * A scenario carries its year, so "last year's budget" and "this year's what-if"
 * are the same kind of source and belong in the same list. Grouping under year
 * subheaders is what makes that readable: a flat "2026 — Planning / 2026 —
 * Aggressive hiring / 2025 — Planning" list reads as a list of YEARS, which is
 * exactly the misconception these controls exist to clear up.
 *
 * Two MUI constraints shape the API:
 *   - A Select reads its children to match the selected value, so they must be a
 *     FLAT array — a Fragment around each group breaks value matching. Hence
 *     flatMap rather than nested elements.
 *   - Moving the year into the subheader leaves each MenuItem rendering only its
 *     label, so the CLOSED field would lose the year. renderScenarioSourceValue
 *     puts it back.
 */

import { ReactNode } from "react";
import { ListSubheader, MenuItem } from "@mui/material";
import { ScenarioDto } from "../../shared/positions/ipc";

export interface ScenarioSourceOptions {
  /** Never offer a scenario as a source for itself. */
  excludeId?: string;
  /** Flagged in its subheader, so same-year siblings read as siblings. */
  currentYear?: number;
}

/** Newest year first, then by label — the previous year is nearly always what
 *  you want, and it lands directly under the current one. */
function sortSources(
  scenarios: readonly ScenarioDto[],
  excludeId?: string
): ScenarioDto[] {
  return scenarios
    .filter((scenario) => scenario.id !== excludeId)
    .slice()
    .sort((a, b) => b.year - a.year || a.label.localeCompare(b.label));
}

/**
 * The grouped MenuItem children for a `TextField select` / `Select`.
 *
 * Returns a flat array: [subheader, ...items, subheader, ...items].
 */
export function scenarioSourceItems(
  scenarios: readonly ScenarioDto[],
  options: ScenarioSourceOptions = {}
): ReactNode[] {
  const byYear = new Map<number, ScenarioDto[]>();
  for (const scenario of sortSources(scenarios, options.excludeId)) {
    const group = byYear.get(scenario.year);
    if (group) group.push(scenario);
    else byYear.set(scenario.year, [scenario]);
  }

  return [...byYear.entries()].flatMap(([year, group]) => [
    <ListSubheader key={`year-${year}`}>
      {year === options.currentYear ? `${year} · this year` : year}
    </ListSubheader>,
    ...group.map((scenario) => (
      <MenuItem key={scenario.id} value={scenario.id}>
        {scenario.label}
      </MenuItem>
    )),
  ]);
}

/** True when there is anything to offer — callers disable the field otherwise. */
export function hasScenarioSources(
  scenarios: readonly ScenarioDto[],
  excludeId?: string
): boolean {
  return scenarios.some((scenario) => scenario.id !== excludeId);
}

/**
 * `renderValue` for the closed field: the year lives in the subheader, so it has
 * to be re-added here or the collapsed select says only "Planning" and the user
 * cannot tell which year they picked.
 */
export function renderScenarioSourceValue(
  scenarios: readonly ScenarioDto[],
  emptyLabel: ReactNode
): (value: unknown) => ReactNode {
  return (value) => {
    const id = String(value ?? "");
    if (!id) return emptyLabel;
    const match = scenarios.find((scenario) => scenario.id === id);
    return match ? `${match.year} — ${match.label}` : id;
  };
}

/** The same "{year} — {label}" shape for prose (helper text, notices). */
export function scenarioSourceLabel(
  scenarios: readonly ScenarioDto[],
  id: string
): string {
  const match = scenarios.find((scenario) => scenario.id === id);
  return match ? `${match.year} — ${match.label}` : "";
}

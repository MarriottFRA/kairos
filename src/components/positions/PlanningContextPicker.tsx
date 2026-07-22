/**
 * PlanningContextPicker — the budget year + planning scenario, in the app bar.
 *
 * These two choices scope everything downstream (positions, and the outputs
 * generated from them), so they belong beside the hotel switcher rather than on
 * one page. Both are persisted settings (`budgetYear`, `planningScenarioId` in
 * the plaintext user_settings table), so the selection follows the user across
 * screens and across restarts — this component is only their placement.
 *
 * Both render as ContextChips, the same control the hotel switcher uses: the
 * three read as one row of peer scope selectors, outermost first.
 */

import { useEffect, useState } from "react";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import CheckIcon from "@mui/icons-material/Check";
import { ListItemIcon, ListItemText, MenuItem, Stack } from "@mui/material";
import {
  useBudgetYear,
  usePlanningScenarioId,
  useSelectedHotel,
  useSettingsStore,
} from "../../store/settings";
import ContextChip from "../ContextChip";
import ScenarioPicker from "./ScenarioPicker";

/** A window around the current selection — planning runs a year or two out,
 *  and prior years stay reachable as copy sources. */
function yearOptions(current: number): number[] {
  const base = new Date().getFullYear();
  const from = Math.min(base - 3, current - 1);
  const to = Math.max(base + 2, current + 1);
  const years: number[] = [];
  for (let year = from; year <= to; year++) years.push(year);
  return years;
}

export default function PlanningContextPicker() {
  const selectedHotelOu = useSelectedHotel();
  const budgetYear = useBudgetYear();
  const planningScenarioId = usePlanningScenarioId();
  const setBudgetYear = useSettingsStore((s) => s.setBudgetYear);
  const setPlanningScenarioId = useSettingsStore((s) => s.setPlanningScenarioId);
  const [error, setError] = useState<string | null>(null);

  // Logged rather than surfaced in the bar: a scenario-list failure here must
  // not cover the page the user is actually on.
  useEffect(() => {
    if (error) console.error("Planning context:", error);
  }, [error]);

  if (!selectedHotelOu) return null;

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", mr: 1 }}>
      <ContextChip
        icon={<CalendarMonthIcon />}
        label={String(budgetYear)}
        tooltip="Budget year — scopes positions and everything generated from them"
      >
        {(close) =>
          yearOptions(budgetYear).map((year) => (
            <MenuItem
              key={year}
              selected={year === budgetYear}
              onClick={() => {
                void setBudgetYear(year);
                close();
              }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                {year === budgetYear && <CheckIcon fontSize="small" />}
              </ListItemIcon>
              <ListItemText primary={year} />
            </MenuItem>
          ))
        }
      </ContextChip>

      <ScenarioPicker
        ou={selectedHotelOu}
        year={budgetYear}
        selectedId={planningScenarioId}
        onSelect={(id) => void setPlanningScenarioId(id)}
        onError={setError}
      />
    </Stack>
  );
}

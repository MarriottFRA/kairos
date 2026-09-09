/**
 * Vacation settings — the hotel-year vacation policy, opened from the cog on
 * the Vacation band of the positions grid.
 *
 * Two switches, both country policy rather than per-position facts, so they
 * live on the calendar year (beside the bank-holiday knobs) and apply to every
 * position in the plan:
 *
 *   Day rate  — what a vacation day is worth for salaried staff: 1/30 of the
 *               month, or the monthly salary ÷ that month's working days.
 *   Booking   — vacation carved out of salary (the default: the year totals
 *               the salary) or booked on top of it (the year totals salary +
 *               vacation).
 *
 * The dialog edits a copy and hands the whole CalendarYear back on Save; the
 * page persists it through the same calendar:save channel the Home page uses,
 * so the live sim, the Vacation Cost column and the Results staleness stamp
 * all follow from one write.
 */

import { useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { CalendarYear, VacationDayBasis, netProductiveDays } from "../../shared/calendar";

export interface VacationSettingsDialogProps {
  open: boolean;
  /** The plan year's calendar, or null while it is still loading / missing. */
  calendar: CalendarYear | null;
  hotelName?: string;
  saving?: boolean;
  onClose: () => void;
  /** The calendar with the two policy fields updated — nothing else touched. */
  onSave: (next: CalendarYear) => void;
}

export default function VacationSettingsDialog({
  open,
  calendar,
  hotelName,
  saving,
  onClose,
  onSave,
}: VacationSettingsDialogProps) {
  const [dayBasis, setDayBasis] = useState<VacationDayBasis>("FLAT");
  const [additive, setAdditive] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDayBasis(calendar?.vacationDayBasis ?? "FLAT");
    setAdditive(!!calendar?.vacationAdditive);
  }, [open, calendar]);

  // The live figure that makes the working-days choice tangible: this year's
  // average net productive days per month, from the calendar the user keeps.
  const averageWorkingDays = useMemo(() => {
    if (!calendar || calendar.months.length === 0) return null;
    let total = 0;
    for (const row of calendar.months) total += netProductiveDays(row);
    return total / calendar.months.length;
  }, [calendar]);

  const dirty =
    !!calendar &&
    (dayBasis !== (calendar.vacationDayBasis ?? "FLAT") ||
      additive !== !!calendar.vacationAdditive);

  const scope = `${hotelName ? `${hotelName}'s` : "this hotel's"} ${
    calendar?.year ?? ""
  } plan`.replace(/\s+/g, " ");

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Vacation settings</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            How a day of vacation is valued and booked. Applies to every position in{" "}
            {scope}.
          </Typography>

          {!calendar && (
            <Typography variant="body2" color="warning.main">
              Set up the calendar for this year on the Home page first — the vacation
              policy is stored with it.
            </Typography>
          )}

          <Stack spacing={1}>
            <Typography variant="subtitle2">Day rate — salaried staff</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={dayBasis}
              disabled={!calendar}
              onChange={(_event, next: VacationDayBasis | null) => next && setDayBasis(next)}
            >
              <ToggleButton value="FLAT">Calendar month</ToggleButton>
              <ToggleButton value="WORKING_DAYS">Working days</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary">
              {dayBasis === "WORKING_DAYS"
                ? `A vacation day is worth the monthly salary ÷ that month's working days — calendar days minus weekends and public holidays, from the hotel calendar${
                    averageWorkingDays != null
                      ? ` (≈ ${averageWorkingDays.toFixed(1)} days a month this year)`
                      : ""
                  }.`
                : "A vacation day is worth 1/30 of the monthly salary — the same 30-day basis the salary itself spreads on."}
              {" "}
              Hourly staff are unaffected either way: their day is already rate × contract
              hours.
            </Typography>
          </Stack>

          <Stack spacing={0.75}>
            <Typography variant="subtitle2">Booking</Typography>
            <FormControlLabel
              disabled={!calendar}
              control={
                <Switch
                  size="small"
                  checked={additive}
                  onChange={(event) => setAdditive(event.target.checked)}
                />
              }
              label={
                <Typography variant="body2">
                  Vacation is an extra cost
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                    sx={{ ml: 1 }}
                  >
                    {additive ? "— on top of salary" : "— carved out of salary"}
                  </Typography>
                </Typography>
              }
            />
            {additive ? (
              <Box
                sx={{
                  display: "flex",
                  gap: 1,
                  alignItems: "flex-start",
                  p: 1.25,
                  borderRadius: 1.5,
                  bgcolor: (theme) => alpha(theme.palette.primary.main, 0.05),
                }}
              >
                <InfoOutlinedIcon sx={{ fontSize: 16, mt: "1px", color: "text.disabled" }} />
                <Typography variant="caption" color="text.secondary">
                  Base Salary stays whole and Vacation Cost is added on top, so the year
                  totals salary + vacation. Hourly staff&apos;s base already pays every
                  working day, so their leave is paid in addition to it — check that is
                  how their contracts are entered.
                </Typography>
              </Box>
            ) : (
              <Typography variant="caption" color="text.secondary">
                Base Salary = salary − vacation and Vacation Cost adds it back, so the
                year totals the salary.
              </Typography>
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!calendar || !dirty || saving}
          onClick={() =>
            calendar &&
            onSave({ ...calendar, vacationDayBasis: dayBasis, vacationAdditive: additive })
          }
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

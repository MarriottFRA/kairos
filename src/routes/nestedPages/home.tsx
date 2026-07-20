/**
 * Home — Budget / Forecast calendar
 * -----------------------------------------------------------
 * The landing page is the calendar input grid: for the selected hotel OU and
 * year the user records public holidays and weekend days per month, and the
 * page derives net productive days (Calendar − Holidays − Weekends) plus the
 * year totals. Everything is persisted in the unencrypted local SQLite store
 * via the `calendar:*` IPC channels.
 *
 * Calendar Days are read-only (they are a fact about the year). Weekends are
 * seeded from a weekday pattern — Sat/Sun by default, but EMEA and beyond do
 * not all rest on the same days — and remain editable per month afterwards.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SaveIcon from "@mui/icons-material/Save";
import {
  DataGridPremium,
  GridCellParams,
  GridColDef,
} from "@mui/x-data-grid-premium";
import {
  CalendarYear,
  DEFAULT_WEEKEND_MASK,
  MONTH_LABELS,
  WEEKDAY_LABELS,
  buildDefaultCalendar,
  calendarTotals,
  isWeekendDay,
  netProductiveDays,
  reseedWeekends,
} from "../../shared/calendar";
import { loadCalendar, listCalendarYears, saveCalendar } from "../../services/calendarService";
import { useSelectedHotel } from "../../store/settings";

// Row ids double as the metric key, so a cell edit maps straight onto the model.
type MetricId = "calendarDays" | "publicHolidays" | "weekendDays" | "netProductiveDays";

const EDITABLE_METRICS: MetricId[] = ["publicHolidays", "weekendDays"];

const METRIC_LABELS: Record<MetricId, string> = {
  calendarDays: "Calendar Days",
  publicHolidays: "Public Holidays",
  weekendDays: "Weekends",
  netProductiveDays: "Net Productive Days",
};

interface CalendarGridRow extends Record<string, unknown> {
  id: MetricId;
  metric: string;
  total: number;
}

/** Column field for a 1-based month. */
const monthField = (month: number) => `m${month}`;

/** Years offered in the picker: a window around today plus anything saved. */
function yearOptions(savedYears: number[]): number[] {
  const thisYear = new Date().getFullYear();
  const window = Array.from({ length: 7 }, (_, i) => thisYear - 2 + i);
  return Array.from(new Set([...window, ...savedYears])).sort((a, b) => b - a);
}

function toGridRows(calendar: CalendarYear): CalendarGridRow[] {
  const totals = calendarTotals(calendar);

  return (Object.keys(METRIC_LABELS) as MetricId[]).map((id) => {
    const row: CalendarGridRow = {
      id,
      metric: METRIC_LABELS[id],
      total: totals[id],
    };
    for (const month of calendar.months) {
      row[monthField(month.month)] =
        id === "netProductiveDays" ? netProductiveDays(month) : month[id];
    }
    return row;
  });
}

export default function Home() {
  const selectedHotelOu = useSelectedHotel();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [calendar, setCalendar] = useState<CalendarYear | null>(null);
  // JSON snapshot of what is in the database, for the dirty check.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [savedYears, setSavedYears] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Load the calendar whenever the hotel or year changes.
  useEffect(() => {
    if (!selectedHotelOu) {
      setCalendar(null);
      setSavedSnapshot(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [{ calendar: loaded, saved }, years] = await Promise.all([
          loadCalendar(selectedHotelOu, year),
          listCalendarYears(selectedHotelOu),
        ]);
        if (cancelled) return;
        setCalendar(loaded);
        setSavedSnapshot(saved ? JSON.stringify(loaded.months) : null);
        setSavedYears(years);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load calendar:", err);
        setError(err instanceof Error ? err.message : "Failed to load calendar");
        setCalendar(buildDefaultCalendar(selectedHotelOu, year));
        setSavedSnapshot(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, year]);

  const dirty = useMemo(
    () => !!calendar && JSON.stringify(calendar.months) !== savedSnapshot,
    [calendar, savedSnapshot]
  );

  const rows = useMemo(() => (calendar ? toGridRows(calendar) : []), [calendar]);

  const columns = useMemo<GridColDef<CalendarGridRow>[]>(
    () => [
      {
        field: "metric",
        headerName: "Budget / Forecast Year",
        width: 210,
        sortable: false,
        disableColumnMenu: true,
      },
      ...MONTH_LABELS.map<GridColDef<CalendarGridRow>>((label, index) => ({
        field: monthField(index + 1),
        headerName: label,
        type: "number",
        width: 78,
        editable: true,
        sortable: false,
        disableColumnMenu: true,
        headerAlign: "center",
        align: "center",
      })),
      {
        field: "total",
        headerName: "Total",
        type: "number",
        width: 96,
        sortable: false,
        disableColumnMenu: true,
        headerAlign: "center",
        align: "center",
      },
    ],
    []
  );

  /** Only the two typed rows accept edits; the derived rows stay locked. */
  const isCellEditable = useCallback(
    (params: GridCellParams) => EDITABLE_METRICS.includes(params.row.id as MetricId),
    []
  );

  /**
   * Apply one edited cell to the calendar model. Values are clamped to
   * 0…calendar days for that month so a typo cannot produce a negative or
   * impossible count; the grid row is rebuilt from the updated model so the
   * Net and Total cells refresh together.
   */
  const processRowUpdate = useCallback(
    (newRow: CalendarGridRow, oldRow: CalendarGridRow): CalendarGridRow => {
      if (!calendar) return oldRow;

      const metric = newRow.id;
      const changed = MONTH_LABELS.map((_, index) => monthField(index + 1)).find(
        (field) => newRow[field] !== oldRow[field]
      );
      if (!changed || !EDITABLE_METRICS.includes(metric)) return oldRow;

      const month = Number(changed.slice(1));
      const next: CalendarYear = {
        ...calendar,
        months: calendar.months.map((row) => {
          if (row.month !== month) return row;
          const value = Math.trunc(Number(newRow[changed]) || 0);
          return {
            ...row,
            [metric]: Math.min(row.calendarDays, Math.max(0, value)),
          };
        }),
      };

      setCalendar(next);
      return toGridRows(next).find((row) => row.id === metric) ?? oldRow;
    },
    [calendar]
  );

  /** Re-seed the Weekends row from a new weekday pattern (overwrites edits). */
  const handleWeekendPatternChange = useCallback(
    (_event: React.MouseEvent<HTMLElement>, weekdays: number[]) => {
      if (!calendar) return;
      const mask = weekdays.reduce((acc, day) => acc | (1 << day), 0);
      setCalendar(reseedWeekends(calendar, mask));
    },
    [calendar]
  );

  const handleReset = useCallback(() => {
    if (!selectedHotelOu) return;
    setCalendar(
      buildDefaultCalendar(selectedHotelOu, year, calendar?.weekendMask ?? DEFAULT_WEEKEND_MASK)
    );
  }, [selectedHotelOu, year, calendar]);

  const handleSave = useCallback(async () => {
    if (!calendar) return;
    setSaving(true);
    setError(null);
    try {
      const persisted = await saveCalendar(calendar);
      setCalendar(persisted);
      setSavedSnapshot(JSON.stringify(persisted.months));
      setSavedYears((years) =>
        years.includes(persisted.year) ? years : [...years, persisted.year].sort((a, b) => b - a)
      );
      setToast(`Calendar saved for ${persisted.year}`);
    } catch (err) {
      console.error("Failed to save calendar:", err);
      setError(err instanceof Error ? err.message : "Failed to save calendar");
    } finally {
      setSaving(false);
    }
  }, [calendar]);

  const weekendPattern = useMemo(() => {
    const mask = calendar?.weekendMask ?? DEFAULT_WEEKEND_MASK;
    return WEEKDAY_LABELS.map((_, day) => day).filter((day) => isWeekendDay(mask, day));
  }, [calendar]);

  const totals = calendar ? calendarTotals(calendar) : null;

  return (
    <Box sx={{ p: 3, maxWidth: 1600, mx: "auto" }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" gutterBottom sx={{ fontWeight: 700 }}>
          Budget / Forecast Calendar
        </Typography>
        <Typography variant="body1" sx={{ color: "text.secondary" }}>
          Record public holidays and weekend days per month. Net productive days and
          the yearly totals are calculated for you.
        </Typography>
      </Box>

      {!selectedHotelOu && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Select a hotel from the switcher in the top bar to load its calendar.
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card sx={{ borderRadius: 3, border: 1, borderColor: "divider" }}>
        <CardContent sx={{ p: 3 }}>
          <Stack
            direction={{ xs: "column", lg: "row" }}
            spacing={2}
            sx={{ mb: 3, alignItems: { lg: "center" }, justifyContent: "space-between" }}
          >
            <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <TextField
                select
                size="small"
                label="Year"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
                sx={{ minWidth: 120 }}
                disabled={!selectedHotelOu}
              >
                {yearOptions(savedYears).map((option) => (
                  <MenuItem key={option} value={option}>
                    {option}
                    {savedYears.includes(option) ? " •" : ""}
                  </MenuItem>
                ))}
              </TextField>

              <Box>
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
                  Weekend days
                </Typography>
                <ToggleButtonGroup
                  size="small"
                  value={weekendPattern}
                  onChange={handleWeekendPatternChange}
                  disabled={!calendar}
                  aria-label="Weekend days"
                >
                  {WEEKDAY_LABELS.map((label, day) => (
                    <ToggleButton key={label} value={day} sx={{ px: 1.25 }}>
                      {label[0]}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Box>

              <Tooltip title="Changing the pattern refills the Weekends row from the real calendar">
                <Typography variant="caption" sx={{ color: "text.secondary", maxWidth: 220 }}>
                  Weekend counts are seeded from this pattern and can still be
                  overridden month by month.
                </Typography>
              </Tooltip>
            </Stack>

            <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
              {totals && (
                <Chip
                  color="primary"
                  variant="outlined"
                  label={`${totals.netProductiveDays} net productive days`}
                  sx={{ fontWeight: 600 }}
                />
              )}
              <Chip
                size="small"
                color={dirty ? "warning" : savedSnapshot ? "success" : "default"}
                variant={dirty ? "filled" : "outlined"}
                label={dirty ? "Unsaved changes" : savedSnapshot ? "Saved" : "Not saved yet"}
              />
              <Button
                startIcon={<RestartAltIcon />}
                onClick={handleReset}
                disabled={!calendar || saving}
              >
                Reset
              </Button>
              <Button
                variant="contained"
                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                onClick={handleSave}
                disabled={!calendar || !dirty || saving}
              >
                Save
              </Button>
            </Stack>
          </Stack>

          <Box sx={{ height: 300, width: "100%" }}>
            <DataGridPremium
              rows={rows}
              columns={columns}
              loading={loading}
              hideFooter
              disableRowSelectionOnClick
              isCellEditable={isCellEditable}
              processRowUpdate={processRowUpdate}
              onProcessRowUpdateError={(err) => {
                console.error("Calendar cell update failed:", err);
                setError("Could not apply that change");
              }}
              initialState={{ pinnedColumns: { left: ["metric"], right: ["total"] } }}
              getCellClassName={(params) =>
                isCellEditable(params) || params.field === "metric" ? "" : "calendar-cell--derived"
              }
              getRowClassName={(params) =>
                params.id === "netProductiveDays" ? "calendar-row--net" : ""
              }
              sx={{
                "& .calendar-cell--derived": { color: "text.secondary" },
                "& .calendar-row--net": {
                  fontWeight: 700,
                  bgcolor: (theme) => theme.palette.action.hover,
                },
                "& .MuiDataGrid-cell:focus-within": { outlineOffset: -2 },
              }}
            />
          </Box>

          <Typography variant="caption" sx={{ color: "text.secondary", mt: 2, display: "block" }}>
            Net Productive Days = Calendar Days − Public Holidays − Weekends. Double-click
            a Public Holidays or Weekends cell to edit it.
          </Typography>
        </CardContent>
      </Card>

      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        message={toast ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      />
    </Box>
  );
}

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

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SaveIcon from "@mui/icons-material/Save";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
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
  WEEKDAY_ORDER,
  buildDefaultCalendar,
  calendarTotals,
  isWeekendDay,
  netProductiveDays,
  reseedWeekends,
} from "../../shared/calendar";
import { loadCalendar, listCalendarYears, saveCalendar } from "../../services/calendarService";
import {
  loadPositionDefaults,
  savePositionDefaults,
} from "../../services/positionDefaultsService";
import {
  DEFAULT_KEYS,
  DEFAULT_LABELS,
  DefaultKey,
  PositionDefaults,
  buildDefaultPositionDefaults,
  resolvePositionDefaults,
} from "../../shared/positionDefaults";
import {
  useBudgetYear,
  useSelectedHotel,
  useSettingsStore,
} from "../../store/settings";

// One height for every interactive control in the toolbar, and one for the grid's
// rows/header. Sharing these constants is what keeps the row of controls reading
// as a single band rather than three differently-sized clusters.
const CONTROL_HEIGHT = 36;
const LABEL_HEIGHT = 18;
const ROW_HEIGHT = 44;

// Row ids double as the metric key, so a cell edit maps straight onto the model.
type MetricId = "calendarDays" | "publicHolidays" | "weekendDays" | "netProductiveDays";

const EDITABLE_METRICS: MetricId[] = ["publicHolidays", "weekendDays"];

const METRIC_LABELS: Record<MetricId, string> = {
  calendarDays: "Calendar Days",
  publicHolidays: "Public Holidays",
  weekendDays: "Weekends",
  netProductiveDays: "Net Productive Days",
};

/** Row order in the grid, top to bottom. */
const METRIC_ORDER: MetricId[] = [
  "calendarDays",
  "publicHolidays",
  "weekendDays",
  "netProductiveDays",
];

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

  return METRIC_ORDER.map((id) => {
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

/**
 * Canonical form of the *user-editable* part of the defaults for the dirty
 * check: weekly hours, each field's link flag, and the pinned value of any
 * unlinked field. Linked values are omitted — they track the calendar, whose
 * own dirty check already gates the Save button.
 */
function defaultsSignature(defaults: PositionDefaults): string {
  return JSON.stringify({
    weeklyHours: defaults.weeklyHours,
    fields: DEFAULT_KEYS.map((key) => {
      const field = defaults.fields[key];
      return field.linked ? { linked: true } : { linked: false, value: field.value };
    }),
  });
}

/**
 * A toolbar control with a caption above it. Every field uses the same label
 * height and the same control height, so controls sit on a shared baseline no
 * matter how wide they are.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Box>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ alignItems: "center", height: LABEL_HEIGHT, mb: 0.5 }}
      >
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            lineHeight: 1,
          }}
        >
          {label}
        </Typography>
        {hint && (
          <Tooltip title={hint}>
            <InfoOutlinedIcon sx={{ fontSize: 14, color: "text.disabled" }} />
          </Tooltip>
        )}
      </Stack>
      {children}
    </Box>
  );
}

/** Trim a default to at most 2 decimals for display (Daily Hours can be 7.5). */
function formatDefault(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * One safe-default cell: a labelled value with a link toggle. Linked shows the
 * calendar-derived number read-only; unlinked turns into an editable input that
 * no longer tracks the calendar, with the same toggle to relink it.
 */
function DefaultCell({
  label,
  value,
  linked,
  disabled,
  onToggleLink,
  onValueChange,
}: {
  label: string;
  value: number;
  linked: boolean;
  disabled: boolean;
  onToggleLink: () => void;
  onValueChange: (value: number) => void;
}) {
  return (
    <Box
      sx={{
        flex: "1 1 0",
        minWidth: 150,
        border: 1,
        borderColor: linked ? "divider" : "primary.main",
        borderRadius: 2,
        px: 1.5,
        py: 1,
        bgcolor: (theme) =>
          linked ? "transparent" : alpha(theme.palette.primary.main, 0.06),
      }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", mb: 0.5 }}
      >
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            lineHeight: 1,
          }}
        >
          {label}
        </Typography>
        <Tooltip title={linked ? "Linked to calendar — click to set your own" : "Unlinked — click to follow the calendar"}>
          <span>
            <IconButton
              size="small"
              onClick={onToggleLink}
              disabled={disabled}
              color={linked ? "default" : "primary"}
              sx={{ p: 0.25 }}
              aria-label={linked ? "Unlink from calendar" : "Relink to calendar"}
            >
              {linked ? (
                <LinkIcon sx={{ fontSize: 18 }} />
              ) : (
                <LinkOffIcon sx={{ fontSize: 18 }} />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {linked ? (
        <Typography
          variant="h6"
          sx={{ fontWeight: 700, color: "text.secondary", lineHeight: 1.2 }}
        >
          {formatDefault(value)}
        </Typography>
      ) : (
        <TextField
          type="number"
          size="small"
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChange(Number(event.target.value))}
          slotProps={{ htmlInput: { min: 0 } }}
          sx={{ width: "100%", "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT } }}
        />
      )}
    </Box>
  );
}

export default function Home() {
  const selectedHotelOu = useSelectedHotel();
  // Budget year is a persisted setting shared with the app bar's picker; this
  // page also uses it as the calendar being edited below. The scenario picker
  // moved to the app bar — it had no second role here.
  const year = useBudgetYear();
  const setBudgetYear = useSettingsStore((s) => s.setBudgetYear);
  const [calendar, setCalendar] = useState<CalendarYear | null>(null);
  // Safe defaults that seed new positions; edited alongside the calendar and
  // saved by the same button. Linked fields track the calendar (see resolved
  // below); this is the raw editable model.
  const [defaults, setDefaults] = useState<PositionDefaults | null>(null);
  const [savedDefaultsSig, setSavedDefaultsSig] = useState<string | null>(null);
  const [devKeyInfo, setDevKeyInfo] = useState<string | null>(null);
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
      setDefaults(null);
      setSavedDefaultsSig(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [{ calendar: loaded, saved }, years, loadedDefaults] = await Promise.all([
          loadCalendar(selectedHotelOu, year),
          listCalendarYears(selectedHotelOu),
          loadPositionDefaults(selectedHotelOu, year),
        ]);
        if (cancelled) return;
        setCalendar(loaded);
        setSavedSnapshot(saved ? JSON.stringify(loaded.months) : null);
        setSavedYears(years);
        setDefaults(loadedDefaults.defaults);
        setSavedDefaultsSig(
          loadedDefaults.saved ? defaultsSignature(loadedDefaults.defaults) : null
        );
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load calendar:", err);
        setError(err instanceof Error ? err.message : "Failed to load calendar");
        setCalendar(buildDefaultCalendar(selectedHotelOu, year));
        setSavedSnapshot(null);
        setDefaults(buildDefaultPositionDefaults(selectedHotelOu, year));
        setSavedDefaultsSig(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, year]);

  // Linked defaults resolved against the *live* calendar model, so previews
  // update as the user edits holidays/weekends before saving. Also what gets
  // persisted, so stored linked values stay in step with the calendar.
  const resolvedDefaults = useMemo(
    () => (defaults && calendar ? resolvePositionDefaults(defaults, calendar) : null),
    [defaults, calendar]
  );

  const calendarDirty = useMemo(
    () => !!calendar && JSON.stringify(calendar.months) !== savedSnapshot,
    [calendar, savedSnapshot]
  );

  const defaultsDirty = useMemo(
    () => !!defaults && defaultsSignature(defaults) !== savedDefaultsSig,
    [defaults, savedDefaultsSig]
  );

  const dirty = calendarDirty || defaultsDirty;

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
      // The twelve months share the leftover width equally, so the grid always
      // fills the card instead of trailing off with an empty strip on the right.
      ...MONTH_LABELS.map<GridColDef<CalendarGridRow>>((label, index) => ({
        field: monthField(index + 1),
        headerName: label,
        type: "number",
        flex: 1,
        minWidth: 64,
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
        width: 104,
        sortable: false,
        disableColumnMenu: true,
        headerAlign: "center",
        align: "center",
        cellClassName: "calendar-cell--total",
        headerClassName: "calendar-cell--total",
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

  // ── Safe defaults ──
  const handleWeeklyHoursChange = useCallback((value: number) => {
    setDefaults((current) =>
      current ? { ...current, weeklyHours: Math.max(0, value) } : current
    );
  }, []);

  /** Unlink a default (pinning the current calendar-derived value so the user
   *  starts from it) or relink it back to the calendar. */
  const handleToggleLink = useCallback(
    (key: DefaultKey) => {
      setDefaults((current) => {
        if (!current) return current;
        const field = current.fields[key];
        const nextLinked = !field.linked;
        // Pin the value showing right now when unlinking; on relink the value is
        // recomputed by resolvePositionDefaults, so what we store is moot.
        const pinned = calendar
          ? resolvePositionDefaults(current, calendar).fields[key].value
          : field.value;
        return {
          ...current,
          fields: {
            ...current.fields,
            [key]: { value: pinned, linked: nextLinked },
          },
        };
      });
    },
    [calendar]
  );

  const handleDefaultValueChange = useCallback((key: DefaultKey, value: number) => {
    setDefaults((current) =>
      current
        ? {
            ...current,
            fields: {
              ...current.fields,
              [key]: { value: Math.max(0, value), linked: false },
            },
          }
        : current
    );
  }, []);

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

      // Persist the safe defaults in the same action, with linked fields
      // resolved against the calendar we just saved.
      if (defaults) {
        const resolved = resolvePositionDefaults(defaults, persisted);
        const persistedDefaults = await savePositionDefaults(resolved);
        setDefaults(persistedDefaults);
        setSavedDefaultsSig(defaultsSignature(persistedDefaults));
      }

      setToast(`Calendar saved for ${persisted.year}`);
    } catch (err) {
      console.error("Failed to save calendar:", err);
      setError(err instanceof Error ? err.message : "Failed to save calendar");
    } finally {
      setSaving(false);
    }
  }, [calendar, defaults]);

  /** TEMP / DEV ONLY: fetch the secure-DB key so the encrypted file can be
   *  opened in an external SQLite tool. The channel throws in packaged builds. */
  const handleRevealDevKey = useCallback(async () => {
    try {
      const api = (window as any)?.ipcApi;
      const response = await api.sendIpcRequest("app:dev-secure-db-key");
      const { keyHex, cipher } = (response?.data ?? response) as {
        keyHex: string;
        cipher: string;
      };
      setDevKeyInfo(
        `-- Open %LOCALAPPDATA%\\Kairos\\kairos_secure.db with:\n` +
          `PRAGMA cipher = '${cipher}';\nPRAGMA key = '${keyHex}';`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Key reveal failed");
    }
  }, []);

  const weekendPattern = useMemo(() => {
    const mask = calendar?.weekendMask ?? DEFAULT_WEEKEND_MASK;
    return WEEKDAY_LABELS.map((_, day) => day).filter((day) => isWeekendDay(mask, day));
  }, [calendar]);

  const totals = calendar ? calendarTotals(calendar) : null;

  return (
    <Box sx={{ p: 3, maxWidth: 1600, mx: "auto" }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>
          Budget / Forecast Calendar
        </Typography>
        <Typography variant="body1" sx={{ color: "text.secondary", maxWidth: 720 }}>
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
            spacing={3}
            sx={{
              alignItems: { xs: "stretch", lg: "flex-end" },
              justifyContent: "space-between",
            }}
          >
            {/* Inputs — each labelled, all on one baseline. */}
            <Stack direction="row" spacing={2.5} sx={{ alignItems: "flex-end" }}>
              <Field label="Year" hint="The budget year everything plans against — persisted, and shared with the Positions grid.">
                <TextField
                  select
                  size="small"
                  value={year}
                  onChange={(event) => void setBudgetYear(Number(event.target.value))}
                  disabled={!selectedHotelOu}
                  sx={{
                    width: 132,
                    "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT },
                  }}
                >
                  {yearOptions(savedYears).map((option) => (
                    <MenuItem key={option} value={option}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: "center", width: "100%" }}
                      >
                        <span>{option}</span>
                        {savedYears.includes(option) && (
                          <Box
                            sx={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              bgcolor: "success.main",
                            }}
                          />
                        )}
                      </Stack>
                    </MenuItem>
                  ))}
                </TextField>
              </Field>

              <Field
                label="Weekend days"
                hint="Seeds the Weekends row from the real calendar. Individual months can still be overridden afterwards."
              >
                <ToggleButtonGroup
                  size="small"
                  value={weekendPattern}
                  onChange={handleWeekendPatternChange}
                  disabled={!calendar}
                  aria-label="Weekend days"
                  sx={{
                    "& .MuiToggleButton-root": {
                      width: CONTROL_HEIGHT,
                      height: CONTROL_HEIGHT,
                      p: 0,
                      fontWeight: 600,
                    },
                  }}
                >
                  {WEEKDAY_ORDER.map((day) => {
                    const label = WEEKDAY_LABELS[day];
                    return (
                      <ToggleButton key={label} value={day} aria-label={label}>
                        {label[0]}
                      </ToggleButton>
                    );
                  })}
                </ToggleButtonGroup>
              </Field>

            </Stack>

            {/* Status + actions — same height band as the inputs. */}
            <Stack
              direction="row"
              spacing={1.5}
              sx={{ alignItems: "center", height: CONTROL_HEIGHT }}
            >
              {totals && (
                <Chip
                  size="small"
                  variant="outlined"
                  color="primary"
                  label={`${totals.netProductiveDays} net productive days`}
                  sx={{ height: 28, fontWeight: 600 }}
                />
              )}
              <Chip
                size="small"
                variant={dirty ? "filled" : "outlined"}
                color={dirty ? "warning" : savedSnapshot ? "success" : "default"}
                label={dirty ? "Unsaved changes" : savedSnapshot ? "Saved" : "Not saved yet"}
                sx={{ height: 28, fontWeight: 600 }}
              />
              <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
              {/* TEMP dev-only helper — remove before release. */}
              <Button
                variant="outlined"
                color="warning"
                onClick={() => void handleRevealDevKey()}
                sx={{ height: CONTROL_HEIGHT, px: 2 }}
              >
                DB key (dev)
              </Button>
              <Button
                variant="outlined"
                startIcon={<RestartAltIcon />}
                onClick={handleReset}
                disabled={!calendar || saving}
                sx={{ height: CONTROL_HEIGHT, px: 2 }}
              >
                Reset
              </Button>
              <Button
                variant="contained"
                disableElevation
                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                onClick={handleSave}
                disabled={!calendar || !dirty || saving}
                sx={{ height: CONTROL_HEIGHT, px: 2.5, minWidth: 108 }}
              >
                Save
              </Button>
            </Stack>
          </Stack>

          <Divider sx={{ my: 3 }} />

          {/* Header + one row per metric, so the grid never scrolls vertically. */}
          <Box sx={{ height: ROW_HEIGHT * (METRIC_ORDER.length + 1) + 2, width: "100%" }}>
            <DataGridPremium
              rows={rows}
              columns={columns}
              loading={loading}
              hideFooter
              disableRowSelectionOnClick
              rowHeight={ROW_HEIGHT}
              columnHeaderHeight={ROW_HEIGHT}
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
                borderRadius: 2,
                "& .MuiDataGrid-columnHeaderTitle": {
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                },
                "& .MuiDataGrid-cell": { display: "flex", alignItems: "center" },
                "& .calendar-cell--derived": { color: "text.secondary" },
                "& .calendar-cell--total": { fontWeight: 700 },
                // Editable cells read as inputs: subtle tint plus a hover affordance.
                "& .MuiDataGrid-cell--editable": {
                  bgcolor: (theme) => alpha(theme.palette.primary.main, 0.04),
                  cursor: "text",
                  "&:hover": {
                    bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                  },
                },
                "& .calendar-row--net": {
                  fontWeight: 700,
                  bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
                },
                "& .MuiDataGrid-cell:focus-within": { outlineOffset: -2 },
              }}
            />
          </Box>

          <Typography variant="caption" sx={{ color: "text.secondary", mt: 2, display: "block" }}>
            Net Productive Days = Calendar Days − Public Holidays − Weekends. Double-click
            a Public Holidays or Weekends cell to edit it.
          </Typography>

          {/* ── Safe defaults for new positions ── */}
          <Divider sx={{ my: 3 }} />

          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={2}
            sx={{ justifyContent: "space-between", alignItems: { xs: "stretch", md: "flex-end" } }}
          >
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Safe defaults for new positions
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 640 }}>
                These seed each new position's Contract columns (Yearly Days, Days Off,
                Public Holidays, Daily Hours) on the Positions tab. Linked values follow
                the calendar above; unlink any to pin your own. Rows stay independent once
                created.
              </Typography>
            </Box>
            <Field label="Weekly Hours" hint="Sets the Daily Hours default for new positions (Weekly ÷ 5).">
              <TextField
                type="number"
                size="small"
                value={defaults?.weeklyHours ?? ""}
                disabled={!defaults}
                onChange={(event) => handleWeeklyHoursChange(Number(event.target.value))}
                slotProps={{ htmlInput: { min: 0 } }}
                sx={{ width: 132, "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT } }}
              />
            </Field>
          </Stack>

          <Stack direction="row" sx={{ mt: 2, flexWrap: "wrap", gap: 2 }}>
            {resolvedDefaults &&
              DEFAULT_KEYS.map((key) => (
                <DefaultCell
                  key={key}
                  label={DEFAULT_LABELS[key]}
                  value={resolvedDefaults.fields[key].value}
                  linked={resolvedDefaults.fields[key].linked}
                  disabled={!defaults}
                  onToggleLink={() => handleToggleLink(key)}
                  onValueChange={(value) => handleDefaultValueChange(key, value)}
                />
              ))}
          </Stack>
        </CardContent>
      </Card>

      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        message={toast ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      />

      {/* TEMP dev-only dialog showing the secure-DB key for external review. */}
      <Dialog open={!!devKeyInfo} onClose={() => setDevKeyInfo(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Secure database key (development)</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
            Paste these pragmas into a SQLite tool that supports SQLite3
            Multiple Ciphers to open the encrypted database. Dev builds only —
            this button does not work in a packaged app.
          </Typography>
          <Box
            component="pre"
            sx={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "0.8125rem",
              bgcolor: "action.hover",
              borderRadius: 1,
              p: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "all",
            }}
          >
            {devKeyInfo}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              if (devKeyInfo) void navigator.clipboard.writeText(devKeyInfo);
            }}
          >
            Copy
          </Button>
          <Button onClick={() => setDevKeyInfo(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

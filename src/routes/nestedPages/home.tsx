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
  Collapse,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Snackbar,
  Stack,
  Switch,
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
  BankHolidayAppliesTo,
  CalendarYear,
  DEFAULT_BANK_HOLIDAY_APPLIES_TO,
  DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER,
  DEFAULT_BANK_HOLIDAY_STAFF_FRACTION,
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
import { bankHolidayCoefficient } from "../../shared/engine/types";
import { loadCalendar, listCalendarYears, saveCalendar } from "../../services/calendarService";
import { loadAccounts } from "../../services/mappingTablesService";
import { loadBudgetDepartments } from "../../services/budgetImportService";
import { AccountOption } from "../../shared/mappingTables/types";
import { BudgetDepartmentOption } from "../../shared/budgetImport/ipc";
import AccountAutocomplete from "../../components/common/AccountAutocomplete";
import BetaNotice from "../../components/home/BetaNotice";
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

// The bank holiday premium books to an A5… account, same rule the Positions
// grid's salary/vacation account fields use (see fieldSeed AccountFilter). A
// module constant so the reference is stable across renders — a first, broad
// pass to be narrowed later.
const BANK_HOLIDAY_ACCOUNT_FILTER = { startsWith: ["A5"] };

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
 * Canonical snapshot of the whole calendar for the dirty check: the twelve
 * months plus the bank-holiday premium config that lives on the calendar head.
 * Both feed the Save button, so both belong in the signature.
 */
function calendarSignature(calendar: CalendarYear): string {
  return JSON.stringify({
    months: calendar.months,
    bankHolidayEnabled: !!calendar.bankHolidayEnabled,
    bankHolidayStaffFraction: calendar.bankHolidayStaffFraction ?? null,
    bankHolidayPremiumMultiplier: calendar.bankHolidayPremiumMultiplier ?? null,
    bankHolidayAccount: (calendar.bankHolidayAccount ?? "").trim(),
    bankHolidayAppliesTo: calendar.bankHolidayAppliesTo ?? null,
    bankHolidayPaidWhenNotWorked: !!calendar.bankHolidayPaidWhenNotWorked,
    // Key-sorted so re-typing an override in a different order is not a change.
    bankHolidayCoverageByDepartment: Object.entries(
      calendar.bankHolidayCoverageByDepartment ?? {}
    ).sort(([a], [b]) => a.localeCompare(b)),
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
  // JSON snapshot of what is in the database, for the dirty check.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [savedYears, setSavedYears] = useState<number[]>([]);
  // Account options (the whole account_maps cache) for the bank-holiday premium
  // account picker; narrowed to A5… by the field's filter. Empty until synced,
  // which degrades the field to free text rather than blocking.
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  // Departments for the per-department coverage overrides. These come from the
  // hotel's own BST pull, NOT the mapping tables: the company-wide chart runs to
  // 200-plus departments, which is unusable as a picker and mostly irrelevant to
  // any one hotel. Empty (never pulled) hides the overrides panel behind a note.
  const [departments, setDepartments] = useState<BudgetDepartmentOption[]>([]);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Load the saved calendar + defaults for the current hotel/year from the
  // store. Shared by the initial load effect and the Reset button, which is
  // just a reload — it discards unsaved edits by fetching the saved state again.
  const loadData = useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (!selectedHotelOu) {
        setCalendar(null);
        setSavedSnapshot(null);
        setDefaults(null);
        setSavedDefaultsSig(null);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const [{ calendar: loaded, saved }, years, loadedDefaults] = await Promise.all([
          loadCalendar(selectedHotelOu, year),
          listCalendarYears(selectedHotelOu),
          loadPositionDefaults(selectedHotelOu, year),
        ]);
        if (signal?.cancelled) return;
        setCalendar(loaded);
        setSavedSnapshot(saved ? calendarSignature(loaded) : null);
        setSavedYears(years);
        setDefaults(loadedDefaults.defaults);
        setSavedDefaultsSig(
          loadedDefaults.saved ? defaultsSignature(loadedDefaults.defaults) : null
        );
      } catch (err) {
        if (signal?.cancelled) return;
        console.error("Failed to load calendar:", err);
        setError(err instanceof Error ? err.message : "Failed to load calendar");
        setCalendar(buildDefaultCalendar(selectedHotelOu, year));
        setSavedSnapshot(null);
        setDefaults(buildDefaultPositionDefaults(selectedHotelOu, year));
        setSavedDefaultsSig(null);
      } finally {
        if (!signal?.cancelled) setLoading(false);
      }
    },
    [selectedHotelOu, year]
  );

  // Load the calendar whenever the hotel or year changes.
  useEffect(() => {
    const signal = { cancelled: false };
    void loadData(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [loadData]);

  // Account reference data (global, not OU-scoped): loaded once for the bank
  // holiday premium account picker. Best-effort — a never-synced cache resolves
  // to [], which degrades the field to free text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const options = await loadAccounts();
        if (!cancelled) setAccounts(options);
      } catch (err) {
        console.error("Failed to load accounts:", err);
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The hotel's own departments for the coverage overrides, from its BST pull.
  // OU-scoped, so it reloads with the hotel switcher. Best-effort: a hotel that
  // has never pulled resolves to [] and the panel says so.
  useEffect(() => {
    if (!selectedHotelOu) {
      setDepartments([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const options = await loadBudgetDepartments(selectedHotelOu);
        if (!cancelled) setDepartments(options);
      } catch (err) {
        console.error("Failed to load budget departments:", err);
        if (!cancelled) setDepartments([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu]);

  // Linked defaults resolved against the *live* calendar model, so previews
  // update as the user edits holidays/weekends before saving. Also what gets
  // persisted, so stored linked values stay in step with the calendar.
  const resolvedDefaults = useMemo(
    () => (defaults && calendar ? resolvePositionDefaults(defaults, calendar) : null),
    [defaults, calendar]
  );

  const calendarDirty = useMemo(
    () => !!calendar && calendarSignature(calendar) !== savedSnapshot,
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

  // ── Bank-holiday premium (lives on the calendar head) ──
  const handleToggleBankHoliday = useCallback((enabled: boolean) => {
    setCalendar((current) =>
      current
        ? {
            ...current,
            bankHolidayEnabled: enabled,
            // Seed sensible knobs the first time it is switched on, so the
            // revealed inputs are never blank.
            bankHolidayStaffFraction:
              current.bankHolidayStaffFraction ?? DEFAULT_BANK_HOLIDAY_STAFF_FRACTION,
            bankHolidayPremiumMultiplier:
              current.bankHolidayPremiumMultiplier ?? DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER,
          }
        : current
    );
  }, []);

  const handleBankHolidayStaffPct = useCallback((pct: number) => {
    const fraction = Math.min(1, Math.max(0, (Number(pct) || 0) / 100));
    setCalendar((current) =>
      current ? { ...current, bankHolidayStaffFraction: fraction } : current
    );
  }, []);

  const handleBankHolidayMultiplier = useCallback((value: number) => {
    setCalendar((current) =>
      current
        ? { ...current, bankHolidayPremiumMultiplier: Math.max(0, Number(value) || 0) }
        : current
    );
  }, []);

  const handleBankHolidayAccount = useCallback((value: string) => {
    setCalendar((current) => (current ? { ...current, bankHolidayAccount: value } : current));
  }, []);

  const handleBankHolidayAppliesTo = useCallback((value: BankHolidayAppliesTo) => {
    setCalendar((current) => (current ? { ...current, bankHolidayAppliesTo: value } : current));
  }, []);

  const handleBankHolidayPaidWhenNotWorked = useCallback((paid: boolean) => {
    setCalendar((current) =>
      current ? { ...current, bankHolidayPaidWhenNotWorked: paid } : current
    );
  }, []);

  /** Set or clear one department's coverage override. A blank field removes the
   *  key entirely, which is what makes the map sparse — the department then
   *  follows the hotel-wide number, including when that number later changes. */
  const handleBankHolidayCoverage = useCallback((code: string, raw: string) => {
    setCalendar((current) => {
      if (!current) return current;
      const next = { ...(current.bankHolidayCoverageByDepartment ?? {}) };
      if (raw.trim() === "") {
        delete next[code];
      } else {
        next[code] = Math.min(1, Math.max(0, (Number(raw) || 0) / 100));
      }
      return { ...current, bankHolidayCoverageByDepartment: next };
    });
  }, []);

  const handleClearBankHolidayCoverage = useCallback(() => {
    setCalendar((current) =>
      current ? { ...current, bankHolidayCoverageByDepartment: {} } : current
    );
  }, []);

  // Discard unsaved edits by reloading the saved state from the store.
  const handleReset = useCallback(() => {
    void loadData();
  }, [loadData]);

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
      setSavedSnapshot(calendarSignature(persisted));
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

  const weekendPattern = useMemo(() => {
    const mask = calendar?.weekendMask ?? DEFAULT_WEEKEND_MASK;
    return WEEKDAY_LABELS.map((_, day) => day).filter((day) => isWeekendDay(mask, day));
  }, [calendar]);

  const totals = calendar ? calendarTotals(calendar) : null;

  // Bank-holiday premium display state. Percent is the friendly unit; the model
  // stores a 0..1 fraction.
  const bankHolidayEnabled = !!calendar?.bankHolidayEnabled;
  const bankHolidayStaffPct = Math.round(
    (calendar?.bankHolidayStaffFraction ?? DEFAULT_BANK_HOLIDAY_STAFF_FRACTION) * 100
  );
  const bankHolidayMultiplier =
    calendar?.bankHolidayPremiumMultiplier ?? DEFAULT_BANK_HOLIDAY_PREMIUM_MULTIPLIER;
  const bankHolidayAccount = calendar?.bankHolidayAccount ?? "";
  const bankHolidayAppliesTo =
    calendar?.bankHolidayAppliesTo ?? DEFAULT_BANK_HOLIDAY_APPLIES_TO;
  const bankHolidayPaidWhenNotWorked = !!calendar?.bankHolidayPaidWhenNotWorked;
  const bankHolidayCoverage = calendar?.bankHolidayCoverageByDepartment ?? {};
  const bankHolidayOverrideCount = Object.keys(bankHolidayCoverage).length;

  // The rows the coverage panel shows: the hotel's budget departments, plus any
  // override whose department has since dropped out of the file. Those would
  // otherwise keep pricing a department with no way to see or clear them.
  const coverageRows = useMemo(() => {
    const known = new Set(departments.map((department) => department.code));
    const orphans = Object.keys(bankHolidayCoverage)
      .filter((code) => !known.has(code))
      .sort()
      .map((code) => ({ code, name: `${code} (not in the budget file)` }));
    return [...departments, ...orphans];
  }, [departments, bankHolidayCoverage]);
  const bankHolidayAccountMissing = bankHolidayEnabled && !bankHolidayAccount.trim();

  // How many days of pay one public holiday costs per head, at the hotel-wide
  // coverage. Computed by the engine's own coefficient function against two
  // probe positions, so the preview can never drift from what actually gets
  // booked — an empty override map makes both probes read the hotel-wide value.
  const bankHolidayProbe = useMemo(
    () => ({
      bankHolidayStaffFraction: calendar?.bankHolidayStaffFraction ?? 0,
      bankHolidayPremiumMultiplier: calendar?.bankHolidayPremiumMultiplier ?? 0,
      bankHolidayAppliesTo,
      bankHolidayPaidWhenNotWorked,
      bankHolidayCoverageByDepartment: {},
    }),
    [
      calendar?.bankHolidayStaffFraction,
      calendar?.bankHolidayPremiumMultiplier,
      bankHolidayAppliesTo,
      bankHolidayPaidWhenNotWorked,
    ]
  );
  const bankHolidayHourlyDays = bankHolidayCoefficient(bankHolidayProbe, {
    hourlyRate: 1,
    departmentCode: "",
  });
  const bankHolidaySalariedDays = bankHolidayCoefficient(bankHolidayProbe, {
    hourlyRate: 0,
    departmentCode: "",
  });

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
              <Button
                variant="outlined"
                startIcon={<RestartAltIcon />}
                onClick={handleReset}
                disabled={!calendar || !dirty || saving}
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

          {/* ── Bank holiday premium ── */}
          <Divider sx={{ my: 3 }} />

          <Stack
            direction="row"
            spacing={2}
            sx={{ justifyContent: "space-between", alignItems: "flex-start" }}
          >
            <Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.25 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Bank holiday premium
                </Typography>
                <Chip
                  size="small"
                  label={
                    bankHolidayAppliesTo === "ALL" ? "All staff" : "Hourly staff only"
                  }
                  sx={{ height: 20, fontSize: 11, fontWeight: 600 }}
                />
              </Stack>
              <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 640 }}>
                Add the cost of the staff who work each public holiday. Set a hotel-wide
                starting point here and refine it per department — or leave it off and
                build the cost yourself with a block.
              </Typography>
            </Box>
            <Switch
              checked={bankHolidayEnabled}
              onChange={(event) => handleToggleBankHoliday(event.target.checked)}
              disabled={!calendar}
              slotProps={{ input: { "aria-label": "Enable bank holiday premium" } }}
            />
          </Stack>

          <Collapse in={bankHolidayEnabled} unmountOnExit>
            <Box
              sx={{
                mt: 2,
                p: 2,
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
                bgcolor: (theme) => alpha(theme.palette.primary.main, 0.04),
              }}
            >
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={2.5}
                sx={{ alignItems: { sm: "flex-start" } }}
              >
                <Field
                  label="Staff working"
                  hint="Share of a position's staff rostered to work a public holiday — the rest have the day off and earn no premium. A 5-day rota in a 7-day operation already puts about 70% of a team on duty on any given day; departments that close on holidays are far lower, which is what the per-department overrides below are for."
                >
                  <TextField
                    type="number"
                    size="small"
                    value={bankHolidayStaffPct}
                    onChange={(event) => handleBankHolidayStaffPct(Number(event.target.value))}
                    slotProps={{
                      htmlInput: { min: 0, max: 100, step: 5 },
                      input: {
                        endAdornment: <InputAdornment position="end">%</InputAdornment>,
                      },
                    }}
                    sx={{ width: 128, "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT } }}
                  />
                </Field>

                <Field
                  label="Pay rate"
                  hint="Pay multiplier for a worked holiday — e.g. 1.5× (time and a half) or 2× (double time)."
                >
                  <TextField
                    type="number"
                    size="small"
                    value={bankHolidayMultiplier}
                    onChange={(event) => handleBankHolidayMultiplier(Number(event.target.value))}
                    slotProps={{
                      htmlInput: { min: 0, step: 0.5 },
                      input: {
                        startAdornment: <InputAdornment position="start">×</InputAdornment>,
                      },
                    }}
                    sx={{ width: 120, "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT } }}
                  />
                </Field>

                <Field
                  label="Applies to"
                  hint="Hourly pay is calculated on net productive days, which already exclude public holidays — so a worked holiday is entirely additional and is charged at the full pay rate. Salaried pay spreads over the whole year and already covers the day, so including them charges only the uplift over a normal day."
                >
                  <TextField
                    select
                    size="small"
                    value={bankHolidayAppliesTo}
                    onChange={(event) =>
                      handleBankHolidayAppliesTo(event.target.value as BankHolidayAppliesTo)
                    }
                    sx={{ width: 190, "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT } }}
                  >
                    <MenuItem value="HOURLY">Hourly-paid staff</MenuItem>
                    <MenuItem value="ALL">All staff</MenuItem>
                  </TextField>
                </Field>

                <Field
                  label="Post to account"
                  hint="The GL account the premium is booked to, using each position's own department. Search by description; the account code is stored."
                >
                  <AccountAutocomplete
                    options={accounts}
                    filter={BANK_HOLIDAY_ACCOUNT_FILTER}
                    value={bankHolidayAccount}
                    onChange={handleBankHolidayAccount}
                    placeholder="Search account…"
                    error={bankHolidayAccountMissing}
                    helperText={bankHolidayAccountMissing ? "Add an account to book the cost" : " "}
                    sx={{ width: 220 }}
                  />
                </Field>
              </Stack>

              <FormControlLabel
                sx={{ mt: 1.5, alignItems: "flex-start" }}
                control={
                  <Switch
                    size="small"
                    checked={bankHolidayPaidWhenNotWorked}
                    onChange={(event) =>
                      handleBankHolidayPaidWhenNotWorked(event.target.checked)
                    }
                    sx={{ mt: 0.25, mr: 1 }}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2">
                      The holiday is paid even when it is not worked
                    </Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      Hourly pay is calculated on net productive days, so a public holiday
                      is not in base pay at all. Switch this on where the law or the
                      contract pays the day regardless — it adds a normal day&rsquo;s pay
                      for the staff who are off, which the budget would otherwise miss.
                    </Typography>
                  </Box>
                }
              />

              {departments.length === 0 ? (
                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", display: "block", mt: 1.5 }}
                >
                  Coverage can be set per department once this hotel&rsquo;s budget file
                  has been pulled — the departments come from the file, not the
                  company-wide chart.
                </Typography>
              ) : (
                <Box sx={{ mt: 1.5 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => setCoverageOpen((open) => !open)}
                    >
                      {coverageOpen ? "Hide" : "Coverage by department"}
                      {bankHolidayOverrideCount > 0 && ` (${bankHolidayOverrideCount})`}
                    </Button>
                    {bankHolidayOverrideCount > 0 && (
                      <Button
                        size="small"
                        variant="text"
                        color="inherit"
                        onClick={handleClearBankHolidayCoverage}
                      >
                        Clear overrides
                      </Button>
                    )}
                  </Stack>

                  <Collapse in={coverageOpen} unmountOnExit>
                    <Typography
                      variant="caption"
                      sx={{ color: "text.secondary", display: "block", mt: 0.5, mb: 1 }}
                    >
                      A hotel does not staff a holiday evenly: Rooms and F&amp;B run close
                      to normal while the back office closes. Leave a department blank to
                      follow the hotel-wide {bankHolidayStaffPct}%.
                    </Typography>
                    <Box
                      sx={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                        gap: 1,
                      }}
                    >
                      {coverageRows.map((department) => {
                        const override = bankHolidayCoverage[department.code];
                        return (
                          <Stack
                            key={department.code}
                            direction="row"
                            spacing={1}
                            sx={{ alignItems: "center" }}
                          >
                            <Typography
                              variant="body2"
                              sx={{
                                flex: 1,
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                color: override === undefined ? "text.secondary" : "text.primary",
                              }}
                              title={`${department.code} — ${department.name}`}
                            >
                              {department.name}
                            </Typography>
                            <TextField
                              type="number"
                              size="small"
                              value={override === undefined ? "" : Math.round(override * 100)}
                              placeholder={String(bankHolidayStaffPct)}
                              onChange={(event) =>
                                handleBankHolidayCoverage(department.code, event.target.value)
                              }
                              slotProps={{
                                htmlInput: {
                                  min: 0,
                                  max: 100,
                                  step: 5,
                                  "aria-label": `${department.name} coverage`,
                                },
                                input: {
                                  endAdornment: (
                                    <InputAdornment position="end">%</InputAdornment>
                                  ),
                                },
                              }}
                              sx={{
                                width: 96,
                                "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT },
                              }}
                            />
                          </Stack>
                        );
                      })}
                    </Box>
                  </Collapse>
                </Box>
              )}

              <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: "flex-start" }}>
                <InfoOutlinedIcon sx={{ fontSize: 16, color: "primary.main", mt: "3px" }} />
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {bankHolidayHourlyDays > 0 || bankHolidaySalariedDays > 0 ? (
                    <>
                      At {bankHolidayStaffPct}% coverage, each public holiday costs about{" "}
                      <Box component="span" sx={{ fontWeight: 700, color: "text.primary" }}>
                        {formatDefault(bankHolidayHourlyDays)} days
                      </Box>{" "}
                      of pay per hourly employee
                      {bankHolidayAppliesTo === "ALL" && (
                        <>
                          {" "}and{" "}
                          <Box component="span" sx={{ fontWeight: 700, color: "text.primary" }}>
                            {formatDefault(bankHolidaySalariedDays)} days
                          </Box>{" "}
                          per salaried employee
                        </>
                      )}
                      {totals && totals.publicHolidays > 0 ? (
                        <>
                          {" "}— roughly{" "}
                          <Box component="span" sx={{ fontWeight: 700, color: "text.primary" }}>
                            {formatDefault(bankHolidayHourlyDays * totals.publicHolidays)} days
                          </Box>{" "}
                          each across the {totals.publicHolidays} bank holiday
                          {totals.publicHolidays === 1 ? "" : "s"} recorded this year.
                        </>
                      ) : (
                        <>. Record public holidays in the grid above to see the yearly cost.</>
                      )}
                      {bankHolidayOverrideCount > 0 && (
                        <>
                          {" "}
                          {bankHolidayOverrideCount} department
                          {bankHolidayOverrideCount === 1 ? " is" : "s are"} priced at their
                          own coverage.
                        </>
                      )}
                    </>
                  ) : (
                    "Set a staff share and pay rate above to price the premium."
                  )}
                </Typography>
              </Stack>
            </Box>
          </Collapse>

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

      {/* Below the inputs, not above them: the calendar is why the page exists. */}
      <BetaNotice />

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

/**
 * Positions — the staffing / payroll positions grid.
 * -----------------------------------------------------------
 * One editable row per position for the selected hotel OU + scenario, with
 * catalog-driven columns grouped into sections (Employee PII / Employee /
 * Contract / Seasonality / Basic Salary / Vacation), the first of which the
 * user can extend with hotel-wide columns of their own. PII is masked by
 * default on every load and masked
 * cells are read-only. Edits persist through a coalescing write queue into the
 * encrypted store — one batch, one transaction, field-level last-write-wins.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Snackbar,
} from "@mui/material";
import {
  GridFilterModel,
  GridInitialState,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import {
  FieldCatalog,
  FieldDataType,
  fieldLabel,
  HOTEL_CLUSTER_KEY,
  SectionId,
} from "../../shared/positions/fields";
import {
  changedFieldKeys,
  fteById,
  newDraftRow,
  manhoursWorkedById,
  PositionRow,
  sanitizeRow,
  toCreate,
  toPatch,
  toRow,
  vacationCostById,
} from "../../shared/positions/rowModel";
import {
  DerivedRowValues,
  rowIdsWithChangedTotals,
  ruleRatesForRows,
} from "../../shared/positions/derivedRowValues";
import { rowDepartmentWritable } from "../../shared/positions/writeScope";
import type { DepartmentWritePolicy } from "../../shared/kairosSync/writePolicy";
import { departmentPickList } from "../../shared/positions/departmentPickList";
import { lockReasonsByDepartment } from "../../shared/kairosSync/lockReason";
import { buildCalendarContext } from "../../shared/engine/calendarContext";
import { CalendarContext } from "../../shared/engine/types";
import { CalendarYear } from "../../shared/calendar";
import { loadCalendar } from "../../services/calendarService";
import { BlockDto, BlockInput, BlocksListResponse } from "../../shared/blocks/ipc";
import {
  applyComponentValuesToRow,
  blockPatchesFromRow,
  changedBlockKeys,
  sanitizeBlockInputs,
} from "../../shared/positions/blockRows";
import {
  BlockResultsById,
  createLiveSimCache,
  runLiveSim,
} from "../../shared/positions/liveSim";
import {
  applyBlockPreset as applyBlockPresetService,
  deleteBlock as deleteBlockService,
  listBlocks,
  restoreBlock as restoreBlockService,
  saveBlock as saveBlockService,
} from "../../services/blocksService";
import { findBlockPreset } from "../../shared/blocks/presets";
import { SsCountryPreset } from "../../shared/socialSecurity/presets";
import { listKpiDrivers } from "../../services/kpiDriversService";
import { KpiDriverWithSeries } from "../../shared/kpiDrivers/ipc";
import { listClusters as listHotelClusters } from "../../services/hotelClustersService";
import { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import { recomputeNiOpenings, saveSsScheme } from "../../services/socialSecurityService";
import BlockDialog from "../../components/blocks/BlockDialog";
import SsSchemeDialog, {
  SsSchemeDialogSave,
} from "../../components/socialSecurity/SsSchemeDialog";
import {
  RemovedFieldDto,
  ScenarioDto,
  SECURE_DB_LOCKED,
} from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import {
  CLUSTER_LINK_ROW_KEY,
  ClusterSyncResult,
} from "../../shared/positions/clusterSync";
import authService from "../../services/auth";
import { useLocation, useNavigate } from "react-router-dom";
import {
  addSectionField,
  getFieldCatalog,
  listRemovedFields,
  purgeFields,
  removeSectionField,
  restoreField,
  sweepRemovedFields,
} from "../../services/fieldCatalogService";
import { loadPii, loadPositions } from "../../services/positionsService";
import { loadAccounts, loadDepartments } from "../../services/mappingTablesService";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { listScenarios } from "../../services/scenarioService";
import { loadPositionDefaults } from "../../services/positionDefaultsService";
import {
  FullTimeReference,
  PositionDefaults,
  fullTimeReference,
  seedInitForPosition,
} from "../../shared/positionDefaults";
import {
  PositionsWriteQueue,
  QueueSnapshot,
} from "../../services/positionsWriteQueue";
import {
  useBudgetYear,
  usePlanningScenarioId,
  useSelectedHotel,
  useSettingsStore,
} from "../../store/settings";
import { useGridStatePersistence } from "../../hooks/useGridStatePersistence";
import { usePlanScope } from "../../hooks/usePlanScope";
import { usePresenceReporter } from "../../hooks/usePresenceReporter";
import PositionsGrid from "../../components/positions/PositionsGrid";
import PositionsToolbar, {
  MAX_BULK_ADD,
} from "../../components/positions/PositionsToolbar";
import AddFieldDialog from "../../components/positions/AddFieldDialog";
import RemoveFieldDialog from "../../components/positions/RemoveFieldDialog";
import ManageColumnsDialog from "../../components/positions/ManageColumnsDialog";
import CopyScenarioDialog from "../../components/positions/CopyScenarioDialog";
import DeleteClusterPositionDialog, {
  PendingPositionDelete,
} from "../../components/positions/DeleteClusterPositionDialog";
import PositionFormDialog from "../../components/positions/PositionFormDialog";
import { uuidv7 } from "../../shared/engine/ids";

/**
 * Splice a freshly created column into the grid's exported layout.
 *
 * Without this the grid appends unknown fields to the far right of the column
 * order, which both hides the new column and splits its section band in two.
 * The new field goes immediately after the last column of its section.
 */
function withNewFieldInLayout(
  state: GridInitialState,
  catalog: FieldCatalog,
  section: SectionId,
  key: string
): GridInitialState {
  const next: GridInitialState = { ...state };
  // Layout only — the same subset the persistence hook keeps.
  delete (next as Record<string, unknown>).rows;
  delete (next as Record<string, unknown>).preferencePanel;
  delete (next as Record<string, unknown>).filter;

  const bandKeys = catalog.fields
    .filter((def) => def.section === section && def.visible && def.key !== key)
    .map((def) => def.key);
  if (bandKeys.length === 0) return next;

  const insertAfter = (fields: string[]): string[] => {
    const without = fields.filter((field) => field !== key);
    const last = Math.max(...bandKeys.map((band) => without.indexOf(band)));
    const at = last >= 0 ? last + 1 : without.length;
    return [...without.slice(0, at), key, ...without.slice(at)];
  };

  if (next.columns?.orderedFields) {
    next.columns = {
      ...next.columns,
      orderedFields: insertAfter(next.columns.orderedFields),
    };
  }

  return next;
}

/**
 * Drop a removed column from the grid's exported layout — the mirror of
 * {@link withNewFieldInLayout}. A key left behind in orderedFields is mostly
 * tolerated by the grid, but its width and visibility entries would come back
 * to life if the column were ever re-added, so prune all three.
 */
function withoutFieldInLayout(
  state: GridInitialState,
  key: string
): GridInitialState {
  const next: GridInitialState = { ...state };
  delete (next as Record<string, unknown>).rows;
  delete (next as Record<string, unknown>).preferencePanel;
  delete (next as Record<string, unknown>).filter;

  if (next.columns) {
    const columns = { ...next.columns };
    if (columns.orderedFields) {
      columns.orderedFields = columns.orderedFields.filter((field) => field !== key);
    }
    if (columns.columnVisibilityModel && key in columns.columnVisibilityModel) {
      const model = { ...columns.columnVisibilityModel };
      delete model[key];
      columns.columnVisibilityModel = model;
    }
    if (columns.dimensions && key in columns.dimensions) {
      const dimensions = { ...columns.dimensions };
      delete dimensions[key];
      columns.dimensions = dimensions;
    }
    next.columns = columns;
  }

  return next;
}

const IDLE_SNAPSHOT: QueueSnapshot = {
  state: "idle",
  pendingRows: 0,
  statusByRow: new Map(),
  lastError: null,
};

/**
 * Mirror the picked department's code into its sibling code column.
 *
 * Runs on every committed edit and paste (via processRowUpdate), so a
 * hand-typed or pasted name fills the code just like a dropdown pick would. It
 * is keyed off the catalog's `departments` sources, so it stays correct if a
 * second such pairing is ever added. An unknown name clears the code rather than
 * leaving a stale one; with no reference data loaded the map is empty and the
 * code column is left editable (see columnFactory), so nothing is touched here.
 */
/** Shared empty list, so "no blocks yet" is one identity rather than a new one
 *  per render (see the `blocks` memo below). */
const EMPTY_BLOCKS: BlockDto[] = [];

/** "The simulation has not produced anything yet" as one identity — the block
 *  Total column reads an empty map and a missing one identically (blank cell),
 *  so the non-nullable field saves a branch in a per-cell callback. */
const EMPTY_BLOCK_RESULTS: BlockResultsById = new Map();

/** "No column filters" as one identity — the grid diffs the filter model by
 *  reference, so clearing back to a fresh object would cost a filter pass. */
const EMPTY_FILTER: GridFilterModel = { items: [] };

/** The only two operators MUI ships with `requiresFilterValue: false` — they
 *  narrow the grid on their own, so the filter count has to include them. */
const NO_VALUE_OPERATORS = new Set(["isEmpty", "isNotEmpty"]);

function applyDeptCodeAutofill(
  row: PositionRow,
  oldRow: PositionRow,
  catalog: FieldCatalog,
  deptCodeByName: ReadonlyMap<string, string>
): void {
  if (deptCodeByName.size === 0) return;
  for (const def of catalog.fields) {
    const source = def.dropdownSource;
    if (source?.kind !== "departments" || !source.codeField) continue;
    if (Object.is(row[def.key], oldRow[def.key])) continue;
    const name = typeof row[def.key] === "string" ? (row[def.key] as string) : "";
    row[source.codeField] = name ? deptCodeByName.get(name) ?? null : null;
  }
}

export default function Positions() {
  const selectedHotelOu = useSelectedHotel();
  const apiRef = useGridApiRef();

  // Planning context comes from persisted settings (chosen on the Home page):
  // budget year + planning scenario. This page only resolves and consumes it.
  const budgetYear = useBudgetYear();
  const planningScenarioId = usePlanningScenarioId();
  const setPlanningScenarioId = useSettingsStore((s) => s.setPlanningScenarioId);

  const [scenario, setScenario] = useState<ScenarioDto | null>(null);
  /** Every scenario for this hotel, all years — the copy dialog's source list. */
  const [allScenarios, setAllScenarios] = useState<ScenarioDto[]>([]);
  const [catalog, setCatalog] = useState<FieldCatalog | null>(null);
  // Global reference data (not OU-scoped): loaded once, feeds the Department
  // type-ahead and the Dept Name auto-fill.
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  // Global reference data (not OU-scoped): the whole account_maps cache, loaded
  // once, feeds every account type-ahead — each field narrows it to its subset.
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [rows, setRows] = useState<PositionRow[]>([]);
  // The calendar's day basis (net productive / flat days) feeds the engine's
  // vacation valuation; null until loaded, which reads as a blank cost column.
  const [calendarCtx, setCalendarCtx] = useState<CalendarContext | null>(null);
  // The raw calendar record too — the live block simulation needs the year's
  // full config (incl. the bank-holiday premium) to mirror a budget run.
  const [calendarYear, setCalendarYear] = useState<CalendarYear | null>(null);
  // The hotel's blocks + their compiled definitions + SS schemes — the
  // structure half of the live simulation, loaded with the positions.
  const [blocksModel, setBlocksModel] = useState<BlocksListResponse | null>(null);
  // Hotel clusters (cross-hotel reference data): the Cluster column's picker
  // options and the live-sim's multiplier source. Best-effort — with none
  // loaded, assignments resolve to weight 1 and the column degrades to text.
  const [hotelClusters, setHotelClusters] = useState<HotelClusterDto[]>([]);
  // OU -> hotel name, so a cluster position can say WHICH hotels it is shared
  // with rather than showing raw OU codes. Best-effort, like the cluster list.
  const [hotelNames, setHotelNames] = useState<ReadonlyMap<string, string>>(
    new Map()
  );
  /** A delete batch holding at least one clustered row, awaiting the "this
   *  deletes it in every hotel" confirm. */
  const [pendingDelete, setPendingDelete] = useState<PendingPositionDelete | null>(
    null
  );
  /** The row open in the Edit Position form, by id — never the row itself, so
   *  the dialog always re-reads the LIVE row and its derived values refresh as
   *  you type. The grid stays editable throughout; this is a second way in. */
  const [editRowId, setEditRowId] = useState<string | null>(null);
  /** The cell the form was opened from, so it can focus the same field. */
  const [editFocusField, setEditFocusField] = useState<string | null>(null);
  /** What the last write did in the other member hotels. */
  const [clusterNotice, setClusterNotice] = useState<{
    severity: "info" | "warning";
    message: string;
  } | null>(null);
  // KPI drivers with cached series: the block dialog's KPI options AND the
  // series feed for KPI-based blocks in the live sim.
  const [kpiDrivers, setKpiDrivers] = useState<KpiDriverWithSeries[]>([]);
  /** Block dialog: closed | create | edit-this-block. */
  const [blockDialog, setBlockDialog] = useState<
    { mode: "create" } | { mode: "edit"; block: BlockDto } | null
  >(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [undoBlock, setUndoBlock] = useState<BlockDto | null>(null);
  /** The NI/SS configurator: closed (null), editing a block, or adding a new
   *  scheme (block: null). Opened from an SS block's cog or the block palette.
   *  `preset` is set only when the Ready-made tab picked a country scheme — it
   *  seeds the form; nothing is written until the user reviews and saves. */
  const [niDialog, setNiDialog] = useState<{
    block: BlockDto | null;
    preset?: SsCountryPreset;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [masked, setMasked] = useState(true); // masked on EVERY load, never persisted
  const [groupByDept, setGroupByDept] = useState(false);
  // Positions persist across years, so most scenarios carry rows that are on
  // file but not budgeted. Hidden by default; the toolbar toggle reveals them.
  const [showInactive, setShowInactive] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  /** Checkbox selection, for the toolbar's bulk actions. */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** Bumped after a copy lands, to re-run the load effect. */
  const [reloadToken, setReloadToken] = useState(0);
  const [quickFilter, setQuickFilter] = useState("");
  // The column filters built in the grid's filter panel. Held here, not in the
  // grid, because adding or removing a column remounts it (see `gridEpoch`) and
  // a filter that vanished on every new column would read as a bug. Deliberately
  // not persisted with the layout either: reopening the app onto a silently
  // filtered grid looks like missing data.
  const [userFilter, setUserFilter] = useState<GridFilterModel>(EMPTY_FILTER);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>(IDLE_SNAPSHOT);
  /** The last deleted batch (a single row delete is a batch of one). */
  const [undoRows, setUndoRows] = useState<PositionRow[] | null>(null);
  const [addFieldSection, setAddFieldSection] = useState<SectionId | null>(null);
  const [addingField, setAddingField] = useState(false);
  // Column removal: the count-aware confirm (data-bearing only), the busy flag,
  // and the durable-undo surface. `undoRemoved` drives the quick snackbar;
  // `manageOpen` the "Recently removed" dialog behind the banner gear.
  const [removeTarget, setRemoveTarget] = useState<{
    key: string;
    label: string;
    section: SectionId;
    valueCount: number;
  } | null>(null);
  const [removingField, setRemovingField] = useState(false);
  const [undoRemoved, setUndoRemoved] = useState<{
    key: string;
    label: string;
    section: SectionId;
  } | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [removedList, setRemovedList] = useState<RemovedFieldDto[]>([]);
  const [removedLoading, setRemovedLoading] = useState(false);
  const [manageBusyKey, setManageBusyKey] = useState<string | null>(null);
  // A new column has to enter the grid's own column state, which is only read
  // at mount — so the grid is remounted with a layout we patched by hand.
  // Bumping the epoch is the remount; the override carries the live layout
  // across it so nothing the user had arranged is lost.
  const [gridEpoch, setGridEpoch] = useState(0);
  const [layoutOverride, setLayoutOverride] = useState<GridInitialState | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  const queueRef = useRef<PositionsWriteQueue | null>(null);
  const catalogRef = useRef<FieldCatalog | null>(null);
  catalogRef.current = catalog;
  // Blocks mirror, so handleRowUpdate stays a stable callback while the block
  // set changes under it (same pattern as catalogRef).
  const blocksRef = useRef<BlockDto[]>([]);
  blocksRef.current = blocksModel?.blocks ?? [];
  // The grid's blocks prop, memoized: `blocksModel?.blocks ?? []` inline mints a
  // new empty array on every render while blocks are still loading, which alone
  // is enough to invalidate the grid's columnGroupingModel memo every time the
  // page renders — and rebuilding that model re-walks every column.
  const blocks = useMemo(() => blocksModel?.blocks ?? EMPTY_BLOCKS, [blocksModel]);
  // Same pattern for hotel names: the cluster-sync reporter must stay stable,
  // because it is handed to the write queue and a new identity would tear the
  // queue down mid-edit.
  const hotelNamesRef = useRef<ReadonlyMap<string, string>>(new Map());
  hotelNamesRef.current = hotelNames;
  // name -> code, for the Department code auto-fill in the edit/paste path. A
  // ref so handleRowUpdate stays a stable callback while the map updates under
  // it. Names carry the unique code, so the mapping is effectively 1:1; on the
  // rare duplicate name the last department wins.
  const deptCodeByNameRef = useRef<ReadonlyMap<string, string>>(new Map());
  deptCodeByNameRef.current = useMemo(
    () => new Map(departments.map((dept) => [dept.name, dept.code])),
    [departments]
  );
  // Safe defaults for (hotel, budget year). The ref is the add-a-position seed
  // (read only on that path, and the new row is independent afterwards); the
  // state is the FTE denominator, which every row is displayed against and so
  // has to re-render the grid when it lands. Both are set from one fetch.
  const defaultsRef = useRef<PositionDefaults | null>(null);
  const [fullTime, setFullTime] = useState<FullTimeReference | null>(null);

  const restoredState = useGridStatePersistence(
    apiRef,
    !!catalog && !loading && !!scenario
  );

  // ── Resolve the persisted planning scenario for (hotel, budget year) ──
  // A stale persisted id (deleted scenario, different year) heals to the
  // year's "Planning" default, which the backend guarantees exists.
  useEffect(() => {
    if (!selectedHotelOu) {
      setScenario(null);
      setAllScenarios([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const scenarios = await listScenarios(selectedHotelOu, budgetYear);
        if (cancelled) return;
        setAllScenarios(scenarios);
        const resolved = resolvePlanningScenario(
          scenarios,
          budgetYear,
          planningScenarioId
        );
        setScenario(resolved);
        if (resolved && resolved.id !== planningScenarioId) {
          void setPlanningScenarioId(resolved.id);
        }
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to resolve planning scenario:", err);
        setError(
          err instanceof Error ? err.message : "Failed to resolve planning scenario"
        );
        setScenario(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, budgetYear, planningScenarioId, setPlanningScenarioId]);

  // ── Department + account reference data (global): the pickers' options ──
  // Best-effort — a never-synced cache resolves to [], which the grid renders as
  // free-text columns rather than blocking data entry.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [deptOptions, accountOptions] = await Promise.all([
          loadDepartments(),
          loadAccounts(),
        ]);
        if (cancelled) return;
        setDepartments(deptOptions);
        setAccounts(accountOptions);
      } catch (err) {
        console.error("Failed to load reference data:", err);
        if (!cancelled) {
          setDepartments([]);
          setAccounts([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Safe defaults for (hotel, budget year) ──
  // Two jobs: the seed for a new position, and the full-time contract every
  // row's FTE is derived against. The handler resolves linked fields against
  // the saved calendar, so this is the same yardstick loadScenarioInput builds.
  useEffect(() => {
    if (!selectedHotelOu) {
      defaultsRef.current = null;
      setFullTime(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { defaults } = await loadPositionDefaults(selectedHotelOu, budgetYear);
        if (!cancelled) {
          defaultsRef.current = defaults;
          setFullTime(fullTimeReference(defaults));
        }
      } catch (err) {
        console.error("Failed to load position defaults:", err);
        if (!cancelled) {
          defaultsRef.current = null;
          setFullTime(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, budgetYear]);

  // ── Calendar day basis for the engine's vacation valuation ──
  // Same source loadScenarioInput uses; unsaved years come back seeded from
  // defaults, so the cost column matches what a budget run would compute.
  useEffect(() => {
    if (!selectedHotelOu || !scenario) {
      setCalendarCtx(null);
      setCalendarYear(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { calendar } = await loadCalendar(selectedHotelOu, scenario.year);
        if (!cancelled) {
          setCalendarCtx(buildCalendarContext(calendar));
          setCalendarYear(calendar);
        }
      } catch (err) {
        console.error("Failed to load calendar for vacation cost:", err);
        if (!cancelled) {
          setCalendarCtx(null);
          setCalendarYear(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, scenario]);

  // ── KPI drivers (per OU): the block dialog's KPI options + live-sim series ──
  // Best-effort — with none loaded, KPI-based blocks simply show zero totals.
  useEffect(() => {
    if (!selectedHotelOu) {
      setKpiDrivers([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const drivers = await listKpiDrivers(selectedHotelOu);
        if (!cancelled) setKpiDrivers(drivers);
      } catch (err) {
        console.error("Failed to load KPI drivers for blocks:", err);
        if (!cancelled) setKpiDrivers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu]);

  // ── Hotel clusters (cross-hotel; not OU-scoped). Reloaded on hotel switch
  // anyway so edits made on the Clusters tab are picked up on return. ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const clusters = await listHotelClusters();
        if (!cancelled) setHotelClusters(clusters);
      } catch (err) {
        console.error("Failed to load hotel clusters:", err);
        if (!cancelled) setHotelClusters([]);
      }
      // Names are cosmetic — a failure leaves cluster tooltips showing OU codes,
      // which is worse to read but never wrong, so it never blocks the grid.
      try {
        const hotels = await authService.getHotels();
        if (!cancelled) {
          setHotelNames(
            new Map(hotels.map((hotel) => [hotel.ou, hotel.hotel_name]))
          );
        }
      } catch (err) {
        console.warn("Hotel names unavailable for cluster tooltips:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, reloadToken]);

  // Engine-simulated vacation cost per row, recomputed as rows or the calendar
  // change. One pass of the same spread math the budget runs — instant for a
  // grid's worth of positions, and never drifts from the authoritative figure.
  const vacationCosts = useMemo(
    () => vacationCostById(rows, calendarCtx, scenario?.id ?? ""),
    [rows, calendarCtx, scenario]
  );

  // Calendar-derived Manhours Worked per row — the auto value the grid shows
  // when a row has no manual override (matches what the engine spreads).
  const manhoursWorked = useMemo(
    () => manhoursWorkedById(rows, calendarCtx, scenario?.id ?? ""),
    [rows, calendarCtx, scenario]
  );

  // Derived FTE per row — the row's contract over the hotel's full-timer. Blank
  // (empty map) until the defaults that supply the denominator have loaded.
  const ftes = useMemo(() => fteById(rows, fullTime), [rows, fullTime]);

  // ── Live block simulation: the real engine over the live rows ──
  // Recomputed on every committed edit (cell commit, not keystroke) — a full
  // compile + simulate is single-digit milliseconds at grid scale, and the
  // math is the exact code a budget run executes, so totals can never drift.
  const kpiSeriesByDriver = useMemo(() => {
    const map = new Map(kpiDrivers.map((entry) => [entry.driver.id as string, entry.series]));
    return (driverId: string) => map.get(driverId) ?? [];
  }, [kpiDrivers]);

  // The rate each rules-driven multiplier resolved per row — the read-only
  // cell where the rate column used to be. Same evaluator the loaders run
  // (including KPI-condition series), so the display can never disagree with
  // the engine.
  const ruleRates = useMemo(
    () =>
      ruleRatesForRows(rows, blocks, calendarYear?.year ?? null, {
        kpiSeries: kpiSeriesByDriver,
      }),
    [rows, blocks, calendarYear, kpiSeriesByDriver]
  );

  /**
   * What the server says this user may write on this plan.
   *
   * Unrestricted until the plan is published — a hotel that never syncs sees no
   * difference. Once it is, `writePolicy` locks the grid to exactly what a save
   * would accept, including locking an owner out of a department they have
   * delegated. A department the server has never mentioned is a different case
   * and stays open for a full-scope owner; see `departmentWritePolicy`.
   */
  const planScope = usePlanScope(selectedHotelOu, scenario?.id ?? null);

  /**
   * The one place a write is refused, and the reason it is refused.
   *
   * Held in a ref because the write paths below are deliberately dependency-free
   * callbacks — they read `catalogRef` and `queueRef` the same way — and giving
   * them a dependency on the scope would rebuild every handler each time the
   * ownership answer arrives, which in turn rebuilds the grid's columns.
   *
   * `isCellEditable` already stops a delegated cell opening for edit. This is
   * the backstop for everything that does NOT go through a cell: the row form,
   * duplicate, delete, and the toolbar's bulk actions. Two enforcement points
   * would be one too many if they could disagree, so both consult the same
   * server-supplied set.
   */
  /**
   * Why creating a row would be refused, or null when it would not.
   *
   * Four independent situations, and the wrong sentence in any of them sends
   * somebody to their administrator over a system that is working. "Add
   * position" used to be gated on nothing but the loading state, so a read-only
   * share, a plan held under a support lease and a plan that had stopped being
   * shared all offered it and all failed at save.
   *
   * `canAddRows` is the delegation flag the owner set when they granted. It has
   * been on the wire since delegation shipped and nothing has ever read it.
   */
  const addRefusal = useMemo((): string | null => {
    if (planScope.notShared) {
      return (
        "This plan is no longer shared with you. You can read what is here, " +
        "but new positions cannot be added."
      );
    }
    if (planScope.planLocked) {
      return "An administrator is holding this plan, so nothing can be added to it.";
    }
    if (planScope.holdsNoDepartment) {
      return (
        "This plan was shared with you to look at, not to change. Ask its owner " +
        "if you need to edit a department."
      );
    }
    if (planScope.canAddRows === false) {
      return (
        "Your delegation covers editing the positions that are already here, " +
        "not adding new ones. Ask the plan's owner if you need to add rows."
      );
    }
    return null;
  }, [
    planScope.notShared,
    planScope.planLocked,
    planScope.holdsNoDepartment,
    planScope.canAddRows,
  ]);

  const writeScopeRef = useRef<{
    writable: DepartmentWritePolicy | undefined;
    planLocked: boolean;
    partial: boolean;
    notShared: boolean;
    addRefusal: string | null;
  }>({
    writable: undefined,
    planLocked: false,
    partial: false,
    notShared: false,
    addRefusal: null,
  });
  writeScopeRef.current = {
    writable: planScope.writePolicy,
    planLocked: planScope.planLocked,
    partial: planScope.scopeKind === "PARTIAL",
    notShared: planScope.notShared,
    addRefusal,
  };

  const rowWritable = useCallback((row: PositionRow): boolean => {
    const scope = writeScopeRef.current;
    return rowDepartmentWritable(row, {
      writePolicy: scope.writable,
      planLocked: scope.planLocked,
    });
  }, []);

  /** What the Department picker may offer here. See `departmentPickList`. */
  const departmentPicks = useMemo(
    () => departmentPickList(departments, planScope.ownership),
    [departments, planScope.ownership]
  );

  /**
   * Why each locked department is locked, for the row menu.
   *
   * There is deliberately no banner listing them (see the note below the grid),
   * so this is the only place the grid explains itself — and the wording depends
   * on which side of the grant is reading, which is the whole reason it is
   * derived centrally rather than written out here.
   */
  const lockReasonByDepartment = useMemo(
    () => lockReasonsByDepartment(planScope.ownership),
    [planScope.ownership]
  );

  /**
   * The escape hatch, on the screen where somebody hits the wall.
   *
   * Bypasses the ETag, so it is on a user action and nothing else. Offered only
   * from a locked row's menu — a lock that is correct needs no re-check, and a
   * lock that is wrong is indistinguishable from here without asking.
   */
  // Keyed on `refresh` rather than on `planScope`, which is a fresh object every
  // time the answer is recomputed — depending on it would rebuild the grid's
  // columns on each one.
  const planScopeRefresh = planScope.refresh;
  const recheckAccess = useCallback(
    () => planScopeRefresh({ unconditional: true }),
    [planScopeRefresh]
  );

  // Read inside `addPositions`, which is deliberately dependency-free — see the
  // note on `writeScopeRef`.
  const structureEditableRef = useRef(true);
  structureEditableRef.current = planScope.structureEditable;

  /** Why a write was refused, in the words the Sync page would use. */
  const refusalReason = useCallback((count: number): string => {
    const scope = writeScopeRef.current;
    const rows = count === 1 ? "That position is" : `${count} of those positions are`;
    // Checked before `planLocked`, which it also sets: "an administrator is
    // holding this plan" is a temporary situation somebody is actively working
    // on, and this is not that.
    if (scope.notShared) {
      return (
        `${rows} read-only: this plan is no longer shared with you. Ask its ` +
        "owner to delegate the departments you need."
      );
    }
    if (scope.planLocked) {
      return `${rows} read-only: an administrator is holding this plan.`;
    }
    return `${rows} in a department somebody else is editing. Withdraw the delegation on the Sync page to take it back.`;
  }, []);

  /**
   * Tell the server there is unpublished work here, about once a minute.
   *
   * Advisory only, and never a lock — but it is what lets the owner be warned
   * before they withdraw a delegation from somebody mid-edit. Only runs once the
   * plan is published; there is nobody to warn otherwise.
   */
  usePresenceReporter({
    ou: selectedHotelOu,
    planId: scenario?.id ?? null,
    dirtyEntities: queueSnapshot.pendingRows,
    departments: planScope.enumeratedWritable,
    lastLocalEditAt: null,
    // `/presence` is one of the routes a plan you cannot read refuses, and
    // there is nobody to warn anyway — presence exists so an owner knows that
    // withdrawing a delegation right now would strand somebody, and it already
    // has been.
    enabled: !planScope.unpublished && !planScope.notShared,
  });

  /**
   * The live sim's compiled-structure cache, and the way to throw it away.
   *
   * A value-only edit reuses the plan's shape and only repacks the numbers (see
   * shared/engine/structureKey for what "value-only" means and what guards it).
   * `simEpoch` is the escape hatch: bumping it drops the cache and forces a full
   * compile. Wired to the toolbar's Refresh action AND to every wholesale
   * invalidation — hotel, scenario, reload, column epoch — so the cache can
   * never outlive the data it was built from. runLiveSim additionally refuses a
   * cache entry whose hotel/scenario/year scope does not match.
   */
  const simCache = useRef(createLiveSimCache());
  const [simEpoch, setSimEpoch] = useState(0);
  const refreshTotals = useCallback(() => {
    // Synchronously, not in an effect: effects run AFTER the render that the
    // state bump triggers, so an effect would clear the cache one render too
    // late and the button would appear to do nothing until the next edit.
    simCache.current = createLiveSimCache();
    setSimEpoch((epoch) => epoch + 1);
  }, []);
  // Defence in depth for the wholesale invalidations. runLiveSim already
  // refuses an entry whose hotel/scenario/year scope does not match — which is
  // what actually makes a mid-render switch safe, since this effect runs after
  // that render — but a cache that outlives its data should not depend on one
  // guard alone.
  useEffect(() => {
    simCache.current = createLiveSimCache();
  }, [selectedHotelOu, scenario?.id, reloadToken, gridEpoch]);

  const liveSim = useMemo(() => {
    if (!blocksModel || !scenario || !selectedHotelOu) {
      return { results: null, errors: null } as const;
    }
    const run = runLiveSim({
      rows,
      blocks: blocksModel.blocks,
      definitions: blocksModel.definitions,
      ssSchemes: blocksModel.ssSchemes,
      calendarYear,
      kpiSeries: kpiSeriesByDriver,
      scenarioId: scenario.id,
      ou: selectedHotelOu,
      hotelClusters,
      // FTE is derived, so the sim has to derive it too — an FTE-based pooled
      // block would otherwise spread over a grid of zeros.
      fullTime: fullTime ?? undefined,
      cache: simCache.current,
    });
    // Where the frame went, in dev only (statically eliminated from the
    // production bundle — see src/global.d.ts). StrictMode double-invokes this
    // memo, so TWO lines per committed edit is correct and is itself the
    // measurement of the StrictMode tax; don't "fix" the duplicate.
    if (import.meta.env.DEV && run.timings) {
      const t = run.timings;
      console.debug(
        `[liveSim] ${t.positions}/${t.rows} rows × ${t.blocks} blocks — ` +
          `input ${t.inputMs.toFixed(1)} + ` +
          `${t.structureReused ? "repack" : "COMPILE"} ${t.compileMs.toFixed(1)} + ` +
          `exec ${t.execMs.toFixed(1)} + agg ${t.aggMs.toFixed(1)} = ${t.totalMs.toFixed(1)} ms`
      );
    }
    return { results: run.results, errors: run.errors } as const;
    // simEpoch is the Refresh action: it carries no data, it exists so this
    // memo re-runs after the structure cache has been dropped.
  }, [rows, blocksModel, calendarYear, kpiSeriesByDriver, scenario, selectedHotelOu, hotelClusters, fullTime, simEpoch]);

  /**
   * The four displayed-but-not-stored per-row maps, behind ONE stable ref.
   *
   * All four change on every committed edit. Passed to the grid as four props
   * they were column-memo dependencies, so a single cell commit rebuilt ~100
   * colDefs, re-ran MUI's column pipeline and re-rendered every mounted row —
   * a whole-grid repaint to move one number. The ref's identity never changes,
   * so the columns are built once and the cell callbacks read through it.
   *
   * Assigned during render, not in an effect (the same idiom as hotelNamesRef
   * and writeScopeRef above): the values must be current for the SAME render
   * that produced them, or the edited cell paints one frame stale. A whole
   * fresh object every time, never an incremental mutation, so StrictMode's
   * double-invoke is a no-op.
   */
  const derived = useMemo<DerivedRowValues>(
    () => ({
      vacationCostById: vacationCosts,
      manhoursWorkedById: manhoursWorked,
      fteById: ftes,
      blockResults: liveSim.results ?? EMPTY_BLOCK_RESULTS,
      ruleRatesById: ruleRates,
    }),
    [vacationCosts, manhoursWorked, ftes, liveSim, ruleRates]
  );
  const derivedRef = useRef<DerivedRowValues>(derived);
  derivedRef.current = derived;

  /**
   * Refresh the rows whose block totals moved without their row object moving.
   *
   * Three of the four maps above are per-row pure: their values change only for
   * a row that was itself edited, and that row's object identity has already
   * changed, so MUI re-renders it and re-applies sorting and filtering with the
   * fresh value. `blockResults` is the exception — a POOL_SPREAD block re-slices
   * its pot across every eligible member whenever any one of them is edited, so
   * row Y's displayed total can move while row Y's object did not.
   *
   * `updateRows` with an id-only partial merges as `{...oldRow, ...partial}`,
   * producing a content-identical clone: enough to defeat GridRow's memo for
   * exactly those rows, with none of the column pipeline. It then publishes
   * `rowsSet`, which is what re-applies sorting, filtering and aggregation — so
   * a sort on a block Total cannot go stale. THE INVARIANT: an empty diff means
   * no displayed value moved, so no cached order can be wrong.
   *
   * Must stay a passive effect. MUI syncs its `rows` prop into its row cache in
   * a passive effect too, and passive effects flush child-first — a layout
   * effect here would run BEFORE that sync and have its clones discarded.
   */
  const prevBlockResults = useRef<BlockResultsById | null>(null);
  useEffect(() => {
    const next = derived.blockResults;
    const previous = prevBlockResults.current;
    prevBlockResults.current = next;
    if (!previous) return; // first run — the initial render is already fresh
    const changed = rowIdsWithChangedTotals(previous, next);
    if (changed.length === 0) return;
    const api = apiRef.current;
    if (!api) return;
    // A row can be in the diff because it LEFT the results (deactivated,
    // deleted); those are gone from the grid too, and updateRows would
    // resurrect them as empty rows.
    const live = changed.filter((id) => api.getRowNode(id));
    if (live.length > 0) api.updateRows(live.map((id) => ({ id })));
  }, [derived, apiRef]);

  /**
   * Report what a write did to the OTHER member hotels.
   *
   * Two things must never be silent: rows appearing in hotels the user is not
   * looking at, and values that could NOT be mirrored (block inputs and user
   * columns are matched by label, so a hotel without a matching block simply
   * does not get that cost). The first is an info toast, the second a warning
   * that names what was left behind.
   */
  const handleClusterSync = useCallback(
    (result: ClusterSyncResult) => {
      const nameOf = (ou: string) => hotelNamesRef.current.get(ou) ?? ou;
      const parts: string[] = [];
      if (result.created.length > 0) {
        const hotels = [...new Set(result.created.map((made) => made.ou))].map(nameOf);
        parts.push(`Also added to ${hotels.join(", ")}`);
      }
      if (result.unlinked > 0) {
        parts.push(
          `${result.unlinked} position${result.unlinked === 1 ? "" : "s"} in other hotels left the cluster`
        );
      }
      if (result.skips.length > 0) {
        const detail = result.skips
          .map(
            (skip) =>
              `“${skip.label}” → ${nameOf(skip.targetOu)} (${
                skip.reason === "AMBIGUOUS"
                  ? "more than one match"
                  : "no match there"
              })`
          )
          .join("; ");
        setClusterNotice({
          severity: "warning",
          message: `Not mirrored: ${detail}. Add a matching block or column in that hotel, then re-save the row.`,
        });
        return;
      }
      if (parts.length > 0) {
        setClusterNotice({ severity: "info", message: parts.join(" · ") });
      }
    },
    []
  );

  // ── Queue lifecycle: one per (hotel, scenario), flushed before swap ──
  useEffect((): (() => void) | undefined => {
    if (!selectedHotelOu || !scenario) {
      queueRef.current = null;
      setQueueSnapshot(IDLE_SNAPSHOT);
      return undefined;
    }
    const queue = new PositionsWriteQueue(
      selectedHotelOu,
      scenario.id,
      setQueueSnapshot,
      handleClusterSync
    );
    queueRef.current = queue;
    setQueueSnapshot(IDLE_SNAPSHOT);

    const flushOnBlur = (): void => {
      void queue.flushNow();
    };
    window.addEventListener("blur", flushOnBlur);
    window.addEventListener("beforeunload", flushOnBlur);
    return () => {
      window.removeEventListener("blur", flushOnBlur);
      window.removeEventListener("beforeunload", flushOnBlur);
      if (queueRef.current === queue) queueRef.current = null;
      void queue.dispose(); // final flush
    };
  }, [selectedHotelOu, scenario, handleClusterSync]);

  // ── Load catalog + rows + PII when the scope changes ──
  useEffect(() => {
    if (!selectedHotelOu || !scenario) {
      setRows([]);
      setCatalog(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setMasked(true);

    (async () => {
      try {
        const [loadedCatalog, values, pii, blocksResponse] = await Promise.all([
          getFieldCatalog(selectedHotelOu),
          loadPositions(selectedHotelOu, scenario.id),
          loadPii(selectedHotelOu, scenario.id),
          listBlocks(selectedHotelOu),
        ]);
        if (cancelled) return;
        setCatalog(loadedCatalog);
        setBlocksModel(blocksResponse);
        // Fold each position's block inputs (component values) into its flat
        // row — one source of truth for editing, saving and the live sim.
        const valuesByPosition = new Map<string, typeof values.componentValues>();
        for (const value of values.componentValues) {
          const list = valuesByPosition.get(value.positionId) ?? [];
          list.push(value);
          valuesByPosition.set(value.positionId, list);
        }
        setRows(
          values.positions.map((p) =>
            applyComponentValuesToRow(
              toRow(p, pii[p.id] ?? null),
              valuesByPosition.get(p.id),
              blocksResponse.blocks
            )
          )
        );
        // Best-effort cleanup: purge removed columns that are empty or past the
        // grace window. The secure store is unlocked (we just read it), and
        // purged keys are already out of the catalog, so nothing here needs the
        // result — people don't tidy up, so this does it for them.
        void sweepRemovedFields(selectedHotelOu);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load positions:", err);
        const message = err instanceof Error ? err.message : "Failed to load positions";
        setError(
          message === SECURE_DB_LOCKED
            ? "The secure store is locked — sign out and back in to load position data."
            : message
        );
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, scenario, reloadToken]);

  // ── Editing pipeline ──
  const handleRowUpdate = useCallback(
    (newRow: PositionRow, oldRow: PositionRow): PositionRow => {
      const currentCatalog = catalogRef.current;
      const queue = queueRef.current;
      if (!currentCatalog || !queue) return oldRow;

      // Every cell edit already passed `isCellEditable`, but the row form and
      // any future caller land here directly. Refusing by returning `oldRow` is
      // the grid's own idiom for "that edit did not happen".
      if (!rowWritable(oldRow)) {
        setToast(refusalReason(1));
        return oldRow;
      }

      const blocks = blocksRef.current;
      let sanitized = sanitizeRow(newRow, oldRow, currentCatalog);
      sanitized = sanitizeBlockInputs(sanitized, oldRow, blocks);
      // Derive the department code from the picked/typed/pasted name before
      // diffing, so the mirrored code rides into the same patch as the name.
      applyDeptCodeAutofill(sanitized, oldRow, currentCatalog, deptCodeByNameRef.current);
      const changed = changedFieldKeys(oldRow, sanitized, currentCatalog);
      const changedBlocks = changedBlockKeys(oldRow, sanitized, blocks);
      if (changed.length === 0 && changedBlocks.length === 0) return oldRow;

      if (changed.length > 0) {
        queue.enqueuePatch(sanitized.id, toPatch(sanitized, changed, currentCatalog));
      }
      // Block inputs ride the same queue as component-value patches — same
      // coalescing, same status dots, same transaction as any position edit.
      for (const patch of blockPatchesFromRow(sanitized, changedBlocks, blocks)) {
        queue.enqueueComponentPatch(patch.positionId, patch.componentDefId, patch.fields);
      }
      setRows((current) =>
        current.map((row) => (row.id === sanitized.id ? sanitized : row))
      );
      return sanitized;
    },
    [rowWritable, refusalReason]
  );

  const handleRowUpdateError = useCallback((err: unknown) => {
    console.error("Position cell update failed:", err);
    setError("Could not apply that change");
  }, []);

  // ── Edit Position form ──
  // The live row, looked up each render: every commit re-renders the page, so
  // the form's derived values, salary pair and block totals move with it.
  const editRow = useMemo(
    () => (editRowId ? rows.find((row) => row.id === editRowId) ?? null : null),
    [rows, editRowId]
  );

  // Deleted, filtered away, or the hotel/scenario changed under the dialog —
  // close it rather than strand the user on a row that no longer exists.
  useEffect(() => {
    if (editRowId && !editRow) setEditRowId(null);
  }, [editRowId, editRow]);

  /** The rows in the order the grid is showing them, for the form's ↑/↓. */
  const orderedRowIds = useCallback((): string[] => {
    const known = new Set(rows.map((row) => row.id));
    // Row grouping injects synthetic group rows, so filter to real ids; before
    // the grid mounts (or with no sort applied) fall back to load order.
    const sorted = (apiRef.current?.getSortedRowIds?.() ?? [])
      .map(String)
      .filter((id) => known.has(id));
    return sorted.length > 0 ? sorted : rows.map((row) => row.id);
  }, [rows, apiRef]);

  const editIndex = useMemo(
    () => (editRowId ? orderedRowIds().indexOf(editRowId) : -1),
    [editRowId, orderedRowIds]
  );

  const handleEditRow = useCallback((row: PositionRow, field?: string) => {
    setEditRowId(row.id);
    setEditFocusField(field ?? null);
  }, []);

  const handleEditNavigate = useCallback(
    (delta: 1 | -1) => {
      const ids = orderedRowIds();
      const next = ids[ids.indexOf(editRowId ?? "") + delta];
      if (next) setEditRowId(next);
    },
    [orderedRowIds, editRowId]
  );

  const addPositions = useCallback(
    (count: number, clusterId?: string) => {
      const currentCatalog = catalogRef.current;
      const queue = queueRef.current;
      if (!currentCatalog || !queue) return;

      /**
       * The backstop, and it is load-bearing rather than belt-and-braces.
       *
       * The toolbar's own gate covers the button, but this is also called from
       * the cluster-seed navigation effect below, which never touches the
       * toolbar — so a "add a position in this cluster" link would otherwise
       * walk straight past the refusal.
       */
      const refusal = writeScopeRef.current.addRefusal;
      if (refusal) {
        setToast(refusal);
        return;
      }

      const total = Math.min(Math.max(Math.trunc(count) || 1, 1), MAX_BULK_ADD);

      // Seed the Contract columns (Yearly Days, Days Off, Public Holidays, Daily
      // Hours) from the hotel-year safe defaults set on the Home page. The seed is
      // a one-time copy — the row is fully independent and editable afterwards.
      // newDraftRow spreads it into a fresh row each call, so one object is safe
      // to share across the batch.
      const seed: Partial<PositionRow> | undefined = defaultsRef.current
        ? seedInitForPosition(defaultsRef.current)
        : undefined;

      const drafts: PositionRow[] = [];
      for (let i = 0; i < total; i += 1) {
        const draft = newDraftRow(
          currentCatalog,
          // Started from the Clusters screen: the assignment is the one thing that
          // page already knows, so the row arrives with it made and mirrors into
          // the other member hotels on its first save.
          clusterId ? { ...seed, [HOTEL_CLUSTER_KEY]: clusterId } : seed
        );
        queue.enqueueCreate(toCreate(draft, currentCatalog));
        drafts.push(draft);
      }
      setRows((current) => [...current, ...drafts]);
      /**
       * A new row has no department, and only somebody with structure rights can
       * publish one of those.
       *
       * The condition used to be `partial`, which was wrong twice: it missed a
       * full-scope delegate entirely, and it told people the row could not be
       * EDITED — which was true at the time and was itself the bug, because the
       * lock covered the department picker they needed. The row is editable now;
       * what it cannot do is go anywhere unclassified, and the amber tint keeps
       * saying so after the snackbar has gone.
       */
      if (!structureEditableRef.current) {
        setToast(
          drafts.length === 1
            ? "Position added. Give it a department before you publish — a row with no " +
                "department can only be published by the plan's owner."
            : `${drafts.length} positions added. Give them a department before you publish — ` +
                "rows with no department can only be published by the plan's owner."
        );
      } else if (drafts.length > 1) {
        setToast(`${drafts.length} positions added`);
      }

      requestAnimationFrame(() => {
        try {
          const first = drafts[0];
          const rowIndex = apiRef.current?.getRowIndexRelativeToVisibleRows(first.id);
          if (rowIndex !== undefined && rowIndex >= 0) {
            apiRef.current?.scrollToIndexes({ rowIndex });
          }
          // A single new row lands the user in its first editable cell. A batch
          // deliberately does not: an open editor on row 1 of 20 is something to
          // dismiss before the rows it created are even visible.
          if (drafts.length === 1) {
            // With PII masked, the first reachable editable cell is the Department
            // picker (Dept Name) — departmentCode is the read-only code mirror now.
            const firstField = masked ? "deptName" : "empNumber";
            apiRef.current?.startCellEditMode({ id: first.id, field: firstField });
          }
        } catch {
          /* focus is best-effort */
        }
      });
    },
    [apiRef, masked]
  );

  // ── "Add position" from a cluster card: create the pre-assigned row once ──
  // The intent rides on the navigation rather than in persisted state, so a
  // reload or a back-navigation never resurrects it.
  const clusterSeedHandled = useRef(false);
  useEffect(() => {
    const seedCluster = (location.state as { newPositionInCluster?: string } | null)
      ?.newPositionInCluster;
    if (!seedCluster || clusterSeedHandled.current) return;
    if (!catalog || !queueRef.current) return; // wait for the grid to be ready
    clusterSeedHandled.current = true;
    navigate(location.pathname, { replace: true, state: null });
    addPositions(1, seedCluster);
  }, [location, catalog, navigate, addPositions]);

  /** The checked rows, in the order the grid is showing them. */
  const selectedRows = useCallback((): PositionRow[] => {
    if (selectedIds.length === 0) return [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const checked = new Set(selectedIds);
    return orderedRowIds()
      .filter((id) => checked.has(id))
      .map((id) => byId.get(id))
      .filter((row): row is PositionRow => !!row);
  }, [rows, selectedIds, orderedRowIds]);

  const duplicateRows = useCallback((targets: readonly PositionRow[]) => {
    const currentCatalog = catalogRef.current;
    const queue = queueRef.current;
    if (!currentCatalog || !queue || targets.length === 0) return;

    // Copy the contractual data; the identity (PII) stays blank on the copy.
    // The cluster-position group is deliberately NOT inherited: the copy is a
    // second person, and the backend mints it a group of its own if the
    // duplicated cluster assignment warrants one.
    const copies = targets.map((row) => {
      const copy: PositionRow = { ...row, id: uuidv7(), [CLUSTER_LINK_ROW_KEY]: "" };
      for (const def of currentCatalog.fields) {
        if (def.maskable) copy[def.key] = null;
      }
      queue.enqueueCreate(toCreate(copy, currentCatalog));
      return copy;
    });
    setRows((current) => [...current, ...copies]);
    if (copies.length > 1) setToast(`${copies.length} positions duplicated`);
  }, []);

  /**
   * Drop the rows this user may not write, and say how many went.
   *
   * Silently doing four of six is worse than doing none: the two that vanished
   * are exactly the ones somebody would assume had worked. The count is always
   * reported, and the action still proceeds for the rest — a delegate bulk-
   * selecting across departments should not be stopped from acting on their own.
   */
  const allowedRows = useCallback(
    (targets: readonly PositionRow[]): PositionRow[] => {
      const allowed = targets.filter(rowWritable);
      const skipped = targets.length - allowed.length;
      if (skipped > 0) setToast(refusalReason(skipped));
      return allowed;
    },
    [rowWritable, refusalReason]
  );

  const handleDuplicate = useCallback(
    (row: PositionRow) => duplicateRows(allowedRows([row])),
    [duplicateRows, allowedRows]
  );

  const handleBulkDuplicate = useCallback(
    () => duplicateRows(allowedRows(selectedRows())),
    [duplicateRows, allowedRows, selectedRows]
  );

  // One batch, one Undo — the snackbar restores everything the action removed,
  // so a mis-aimed bulk delete costs a click rather than a re-entry session.
  const deleteRows = useCallback((targets: readonly PositionRow[]) => {
    const queue = queueRef.current;
    if (!queue || targets.length === 0) return;
    const removed = new Set(targets.map((row) => row.id));
    for (const row of targets) queue.enqueueDelete(row.id);
    setRows((current) => current.filter((row) => !removed.has(row.id)));
    // The grid prunes its own selection when rows leave, but the toolbar band
    // reads this mirror — drop them here too so it can't linger on ghosts.
    setSelectedIds((current) => current.filter((id) => !removed.has(id)));
    setUndoRows([...targets]);
  }, []);

  // A clustered row is one person held by several hotels, so deleting it takes
  // their copies too. That is worth a confirm naming them; a batch of purely
  // standalone rows still deletes straight away with the usual Undo.
  const requestDelete = useCallback(
    (targets: readonly PositionRow[]) => {
      if (targets.length === 0) return;
      const clustered = targets.filter((row) => row[CLUSTER_LINK_ROW_KEY]);
      if (clustered.length === 0) {
        deleteRows(targets);
        return;
      }
      setPendingDelete({
        clustered,
        standalone: targets.filter((row) => !row[CLUSTER_LINK_ROW_KEY]),
      });
    },
    [deleteRows]
  );

  const handleDelete = useCallback(
    (row: PositionRow) => requestDelete(allowedRows([row])),
    [requestDelete, allowedRows]
  );

  const handleBulkDelete = useCallback(
    () => requestDelete(allowedRows(selectedRows())),
    [requestDelete, allowedRows, selectedRows]
  );

  const handleUndoDelete = useCallback(() => {
    const queue = queueRef.current;
    if (!queue || !undoRows) return;
    for (const row of undoRows) queue.enqueueRestore(row.id);
    setRows((current) => [...current, ...undoRows]);
    setUndoRows(null);
  }, [undoRows]);

  // ── Column filters ──
  // The panel itself lives inside the grid (MUI anchors it to the headers), so
  // the toolbar button only has to ask for it. A column's three-dots menu opens
  // the same panel with a row for that column already in it.
  const handleOpenFilters = useCallback(() => {
    apiRef.current?.showFilterPanel();
  }, [apiRef]);

  const handleClearFilters = useCallback(() => {
    setUserFilter(EMPTY_FILTER);
    apiRef.current?.hideFilterPanel();
  }, [apiRef]);

  // Items the user has actually finished. A half-built row — a column picked but
  // no value typed yet — filters nothing, so counting it would put a badge on
  // the button before anything is hidden. Operators like `isEmpty` declare they
  // need no value, and those do count.
  const filterCount = useMemo(
    () =>
      userFilter.items.filter((item) => {
        if (Array.isArray(item.value)) return item.value.length > 0;
        if (item.value !== undefined && item.value !== "") return true;
        return NO_VALUE_OPERATORS.has(item.operator);
      }).length,
    [userFilter]
  );

  // ── Hotel-wide columns ──
  // Adding one is a single catalog row: no schema change, no backfill, and no
  // write to any position. Existing rows read the key as absent from their
  // extra-values blob, which renders as empty, so the cost does not scale with
  // how many positions the hotel has.
  const handleAddField = useCallback(
    (section: SectionId) => setAddFieldSection(section),
    []
  );

  const handleCreateField = useCallback(
    (label: string, dataType: FieldDataType) => {
      const currentCatalog = catalogRef.current;
      const section = addFieldSection;
      if (!currentCatalog || !section || !selectedHotelOu) return;

      setAddingField(true);
      void (async () => {
        try {
          const { catalog: updated, key } = await addSectionField(
            selectedHotelOu,
            currentCatalog,
            section,
            label,
            dataType
          );
          const live = apiRef.current?.exportState();
          setLayoutOverride(
            live ? withNewFieldInLayout(live, updated, section, key) : null
          );
          setCatalog(updated);
          setGridEpoch((epoch) => epoch + 1);
          setAddFieldSection(null);
          setToast(`Added column "${label}"`);
        } catch (err) {
          console.error("Failed to add column:", err);
          setError(err instanceof Error ? err.message : "Could not add that column");
        } finally {
          setAddingField(false);
        }
      })();
    },
    [addFieldSection, selectedHotelOu, apiRef]
  );

  // ── Removing columns ──
  // Soft delete first (reversible), hard purge later (the sweep / Manage). Only
  // user-added columns get here — the grid offers "Remove" for those alone.
  const doRemoveField = useCallback(
    async (key: string, label: string, section: SectionId) => {
      if (!selectedHotelOu) return;
      setRemovingField(true);
      try {
        // Drain any pending edit to this column before the catalog forgets it —
        // a queued patch for a now-unknown key would fail the whole batch.
        await queueRef.current?.flushNow();
        const updated = await removeSectionField(selectedHotelOu, key);
        const live = apiRef.current?.exportState();
        setLayoutOverride(live ? withoutFieldInLayout(live, key) : null);
        setCatalog(updated);
        setGridEpoch((epoch) => epoch + 1);
        setRemoveTarget(null);
        setUndoRemoved({ key, label, section });
      } catch (err) {
        console.error("Failed to remove column:", err);
        setError(err instanceof Error ? err.message : "Could not remove that column");
      } finally {
        setRemovingField(false);
      }
    },
    [selectedHotelOu, apiRef]
  );

  const handleRemoveField = useCallback(
    (key: string) => {
      const currentCatalog = catalogRef.current;
      const def = currentCatalog?.fields.find((field) => field.key === key);
      if (!def) return;
      const label = fieldLabel(def);
      // Data-bearing gets a count-aware confirm; an empty column just goes,
      // with the snackbar as its safety net.
      const valueCount = rows.reduce((count, row) => {
        const value = row[key];
        return value !== null && value !== undefined && value !== "" ? count + 1 : count;
      }, 0);
      if (valueCount === 0) {
        void doRemoveField(key, label, def.section);
        return;
      }
      setRemoveTarget({ key, label, section: def.section, valueCount });
    },
    [rows, doRemoveField]
  );

  const handleUndoRemoveField = useCallback(() => {
    const target = undoRemoved;
    if (!target || !selectedHotelOu) return;
    setUndoRemoved(null);
    void (async () => {
      try {
        const updated = await restoreField(selectedHotelOu, target.key);
        const live = apiRef.current?.exportState();
        setLayoutOverride(
          live ? withNewFieldInLayout(live, updated, target.section, target.key) : null
        );
        setCatalog(updated);
        setGridEpoch((epoch) => epoch + 1);
        setToast(`Restored "${target.label}"`);
      } catch (err) {
        console.error("Failed to restore column:", err);
        setError(err instanceof Error ? err.message : "Could not restore that column");
      }
    })();
  }, [undoRemoved, selectedHotelOu, apiRef]);

  const refreshRemoved = useCallback(async () => {
    if (!selectedHotelOu) return;
    setRemovedLoading(true);
    try {
      setRemovedList(await listRemovedFields(selectedHotelOu));
    } catch (err) {
      console.error("Failed to list removed columns:", err);
      setRemovedList([]);
    } finally {
      setRemovedLoading(false);
    }
  }, [selectedHotelOu]);

  const handleManageColumns = useCallback(() => {
    setManageOpen(true);
    void refreshRemoved();
  }, [refreshRemoved]);

  const handleRestoreFromManage = useCallback(
    (key: string) => {
      if (!selectedHotelOu) return;
      setManageBusyKey(key);
      void (async () => {
        try {
          const updated = await restoreField(selectedHotelOu, key);
          const def = updated.fields.find((field) => field.key === key);
          const live = apiRef.current?.exportState();
          if (def && live) {
            setLayoutOverride(withNewFieldInLayout(live, updated, def.section, key));
          }
          setCatalog(updated);
          setGridEpoch((epoch) => epoch + 1);
          await refreshRemoved();
          setToast("Column restored");
        } catch (err) {
          console.error("Failed to restore column:", err);
          setError(err instanceof Error ? err.message : "Could not restore that column");
        } finally {
          setManageBusyKey(null);
        }
      })();
    },
    [selectedHotelOu, apiRef, refreshRemoved]
  );

  const handlePurgeFromManage = useCallback(
    (key: string) => {
      if (!selectedHotelOu) return;
      setManageBusyKey(key);
      void (async () => {
        try {
          await purgeFields(selectedHotelOu, [key]);
          await refreshRemoved();
          setToast("Column permanently deleted");
        } catch (err) {
          console.error("Failed to purge column:", err);
          setError(err instanceof Error ? err.message : "Could not delete that column");
        } finally {
          setManageBusyKey(null);
        }
      })();
    },
    [selectedHotelOu, refreshRemoved]
  );

  /** A copy rewrote the scenario's rows server-side — reload rather than patch. */
  const handleCopied = useCallback((positions: number) => {
    setReloadToken((token) => token + 1);
    setToast(
      positions === 1 ? "Copied 1 position" : `Copied ${positions} positions`
    );
  }, []);

  /**
   * Bulk activate/deactivate over the checkbox selection. Each row goes through
   * the same patch queue as a cell edit, so the coalescing, retry and status
   * dots all work unchanged.
   */
  const handleBulkActive = useCallback(
    (active: boolean) => {
      const currentCatalog = catalogRef.current;
      const queue = queueRef.current;
      if (!currentCatalog || !queue || selectedIds.length === 0) return;

      const selected = new Set(selectedIds);
      let skipped = 0;
      let changed = 0;
      setRows((current) =>
        current.map((row) => {
          if (!selected.has(row.id) || row.active === active) return row;
          // Activating a position in somebody else's department is still a write
          // to their department, and it would be rejected at publish as
          // DEPARTMENT_OUT_OF_SCOPE. Skip it here, where it can be explained.
          if (!rowWritable(row)) {
            skipped += 1;
            return row;
          }
          changed += 1;
          queue.enqueuePatch(row.id, { positionFields: { active }, piiFields: {} });
          return { ...row, active };
        })
      );
      setToast(
        skipped > 0
          ? refusalReason(skipped)
          : `${changed} position${changed === 1 ? "" : "s"} marked ${
              active ? "active" : "inactive"
            }`
      );
    },
    [selectedIds, rowWritable, refusalReason]
  );

  // ── Blocks: add / edit / delete (with undo) ──
  // Column changes are reactive (the columns memo reads blocksModel), so no
  // grid remount is needed; new bands append after the catalog sections.

  // Stable, because it is handed to the grid, which bakes it into the band
  // headers of the column grouping model. As an inline arrow it re-minted that
  // whole model on every render of this page.
  // Social Security carries its own scheme/accumulation settings, so it opens
  // the NI modal rather than the generic block dialog.
  const handleEditBlock = useCallback((block: BlockDto) => {
    if (block.blockType === "SOCIAL_SECURITY") setNiDialog({ block });
    else setBlockDialog({ mode: "edit", block });
  }, []);

  const handleSaveBlock = useCallback(
    (input: BlockInput) => {
      if (!selectedHotelOu) return;
      setBlockBusy(true);
      void (async () => {
        try {
          // Drain pending edits first so a recompiled definition set can never
          // invalidate an in-flight component-value patch.
          await queueRef.current?.flushNow();
          const response = await saveBlockService(selectedHotelOu, input);
          setBlocksModel(response);
          setBlockDialog(null);
          setToast(input.id ? `Updated "${input.label}"` : `Added block "${input.label}"`);
        } catch (err) {
          console.error("Failed to save block:", err);
          setError(err instanceof Error ? err.message : "Could not save that block");
        } finally {
          setBlockBusy(false);
        }
      })();
    },
    [selectedHotelOu]
  );

  // A "Ready-made" preset — one round-trip that creates every block it
  // describes, because a multi-block preset wires its later steps to the ids of
  // its earlier ones and only main can see those.
  const handleApplyPreset = useCallback(
    (presetId: string) => {
      if (!selectedHotelOu) return;
      const preset = findBlockPreset(presetId);
      setBlockBusy(true);
      void (async () => {
        try {
          await queueRef.current?.flushNow();
          const response = await applyBlockPresetService(selectedHotelOu, presetId);
          setBlocksModel(response);
          setBlockDialog(null);
          const count = preset?.steps.length ?? 0;
          setToast(
            `Added ${preset?.title ?? "blocks"}${count > 1 ? ` (${count} blocks)` : ""}`
          );
        } catch (err) {
          console.error("Failed to apply block preset:", err);
          setError(err instanceof Error ? err.message : "Could not add those blocks");
        } finally {
          setBlockBusy(false);
        }
      })();
    },
    [selectedHotelOu]
  );

  const handleDeleteBlock = useCallback(
    (block: BlockDto) => {
      if (!selectedHotelOu) return;
      setBlockBusy(true);
      void (async () => {
        try {
          await queueRef.current?.flushNow();
          const response = await deleteBlockService(selectedHotelOu, block.id);
          setBlocksModel(response);
          setBlockDialog(null);
          setUndoBlock(block);
        } catch (err) {
          console.error("Failed to delete block:", err);
          setError(err instanceof Error ? err.message : "Could not delete that block");
        } finally {
          setBlockBusy(false);
        }
      })();
    },
    [selectedHotelOu]
  );

  // Configure an NI/SS scheme: save the scheme (brackets/caps/mode/tax year +
  // its contributory base), then attach it + the account to its block —
  // creating the block when adding a new scheme. On create the scheme/block have
  // no id, so the scheme is the one that appears in the refreshed list but was
  // not there before; the block label tracks the scheme name.
  const persistNi = useCallback(
    async (save: SsSchemeDialogSave): Promise<string> => {
      if (!selectedHotelOu || !niDialog) {
        throw new Error("No hotel or scheme selected.");
      }
      await queueRef.current?.flushNow();
      const beforeIds = new Set(
        (blocksModel?.ssSchemes ?? []).map((scheme) => scheme.id as string)
      );
      const schemesResp = await saveSsScheme(selectedHotelOu, save.scheme);
      const schemeId =
        save.scheme.id ??
        schemesResp.schemes.find((scheme) => !beforeIds.has(scheme.id as string))?.id;
      if (!schemeId) throw new Error("Could not resolve the saved scheme.");
      const response = await saveBlockService(selectedHotelOu, {
        id: niDialog.block?.id,
        blockType: "SOCIAL_SECURITY",
        label: save.scheme.label,
        accountCode: save.accountCode,
        accountLocked: true,
        ssSchemeId: schemeId as string,
      });
      setBlocksModel(response);
      return schemeId as string;
    },
    [selectedHotelOu, niDialog, blocksModel]
  );

  const handleSaveNi = useCallback(
    (save: SsSchemeDialogSave) => {
      setBlockBusy(true);
      void (async () => {
        try {
          await persistNi(save);
          setNiDialog(null);
          setToast("National Insurance updated");
        } catch (err) {
          console.error("Failed to save NI configuration:", err);
          setError(err instanceof Error ? err.message : "Could not save National Insurance");
        } finally {
          setBlockBusy(false);
        }
      })();
    },
    [persistNi]
  );

  // Save, then run the opening-balance pre-sim for this scheme and reload rows so
  // the grid reflects the freshly written per-scheme Opening base values.
  const handleRecomputeNi = useCallback(
    (save: SsSchemeDialogSave) => {
      if (!selectedHotelOu || !scenario) return;
      setBlockBusy(true);
      void (async () => {
        try {
          const schemeId = await persistNi(save);
          const { updated } = await recomputeNiOpenings(
            selectedHotelOu,
            scenario.id,
            schemeId
          );
          setNiDialog(null);
          setReloadToken((token) => token + 1);
          setToast(`Opening balances recomputed for ${updated} position${updated === 1 ? "" : "s"}`);
        } catch (err) {
          console.error("Failed to recompute NI opening balances:", err);
          setError(err instanceof Error ? err.message : "Could not recompute opening balances");
        } finally {
          setBlockBusy(false);
        }
      })();
    },
    [persistNi, selectedHotelOu, scenario]
  );

  const handleUndoDeleteBlock = useCallback(() => {
    const target = undoBlock;
    if (!target || !selectedHotelOu) return;
    setUndoBlock(null);
    void (async () => {
      try {
        const response = await restoreBlockService(selectedHotelOu, target.id);
        setBlocksModel(response);
        setToast(`Restored "${target.label}"`);
      } catch (err) {
        console.error("Failed to restore block:", err);
        setError(err instanceof Error ? err.message : "Could not restore that block");
      }
    })();
  }, [undoBlock, selectedHotelOu]);

  const handlePasteStart = useCallback(() => queueRef.current?.setPaused(true), []);
  const handlePasteEnd = useCallback(() => queueRef.current?.setPaused(false), []);

  const gridReady =
    !!selectedHotelOu && !!scenario && !!catalog && restoredState !== undefined;

  const controlsDisabled = !gridReady || loading;

  const secureLocked = queueSnapshot.state === "locked";

  return (
    <Box
      sx={{
        p: 2,
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 64px)",
        minHeight: 0,
      }}
    >
      {!selectedHotelOu && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Select a hotel from the switcher in the top bar to load its positions.
        </Alert>
      )}

      {secureLocked && (
        <Alert severity="error" sx={{ mb: 2 }}>
          The secure store is locked. Sign out and back in to continue — recent
          changes are held in memory until then.
        </Alert>
      )}

      {error && !secureLocked && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Not a locked-department case: there is no department list to show,
          because `/department-ownership` is one of the routes refused outright.
          The grid is read-only via `planLocked`, and this is the only place that
          can say why — the alternative is a page that silently stopped saving. */}
      {planScope.notShared && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>This plan is no longer shared with you</AlertTitle>
          Seeing a hotel no longer means being able to edit every plan in it. You
          can read what is on this computer, and changes are not being saved to
          the server. Anything you have already changed is kept — ask the plan&rsquo;s
          owner to delegate the departments you need, and it will publish as
          normal.
        </Alert>
      )}

      {/* The whole plan is read-only — every row is greyed, so the greying
          cannot be the explanation. Kept for that reason, and for that reason
          only. */}
      {gridReady &&
        !planScope.unpublished &&
        !planScope.notShared &&
        planScope.planLocked && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>This plan is read-only for you</AlertTitle>
            You can see everything and download it, but nothing here can be
            edited. The Sync page explains why.
          </Alert>
        )}

      {/* No banner listing the departments somebody else holds, and no mirror of
          it naming the ones a delegate DOES hold. The grid greys what it cannot
          write, which answers "why will this cell not open?" on the row where
          the question is asked, and the Sync page answers who has it and why.
          A standing info box on the page where the work happens repeats both. */}

      {/* Structure problems (e.g. blocks referencing each other in a loop)
          pause the block totals; everything else keeps working. */}
      {liveSim.errors && liveSim.errors.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Block totals are paused: {liveSim.errors[0]?.message} Edit the block
          configuration to fix this.
        </Alert>
      )}

      {/* One row for controls and save status. The budget year and scenario are
          named in the app bar pickers, so the toolbar no longer repeats them. */}
      <Box sx={{ mb: 1.5 }}>
        <PositionsToolbar
          disabled={controlsDisabled}
          masked={masked}
          groupByDept={groupByDept}
          showInactive={showInactive}
          selectedCount={selectedIds.length}
          quickFilter={quickFilter}
          filterCount={filterCount}
          queueState={queueSnapshot.state}
          pendingRows={queueSnapshot.pendingRows}
          onAddPositions={addPositions}
          canAddPositions={addRefusal === null}
          addBlockedReason={addRefusal}
          onAddBlock={() => setBlockDialog({ mode: "create" })}
          onToggleMask={() => setMasked((value) => !value)}
          onToggleGroup={() => setGroupByDept((value) => !value)}
          onToggleInactive={() => setShowInactive((value) => !value)}
          onBulkActive={handleBulkActive}
          onBulkDuplicate={handleBulkDuplicate}
          onBulkDelete={handleBulkDelete}
          onCopyFrom={() => setCopyOpen(true)}
          onQuickFilter={setQuickFilter}
          onOpenFilters={handleOpenFilters}
          onClearFilters={handleClearFilters}
          onRefreshTotals={refreshTotals}
        />
      </Box>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {/* A scenario with no positions is the January case: the year rolled
            over and nothing has been carried across yet — or it is a fresh
            what-if. Offer the copy rather than an empty grid the user has to
            work out how to fill. */}
        {gridReady && rows.length === 0 && !loading ? (
          <Alert
            severity="info"
            action={
              <Button color="inherit" size="small" onClick={() => setCopyOpen(true)}>
                Copy from…
              </Button>
            }
          >
            No positions in {budgetYear} — {scenario?.label}. Copy them from
            another year or scenario instead of entering them again.
          </Alert>
        ) : null}
        {gridReady && (
          <PositionsGrid
            key={gridEpoch}
            rows={rows}
            catalog={catalog}
            departments={departments}
            accounts={accounts}
            derived={derivedRef}
            hotelClusters={hotelClusters}
            currentOu={selectedHotelOu}
            hotelNames={hotelNames}
            blocks={blocks}
            masked={masked}
            writePolicy={planScope.writePolicy}
            departmentPicks={departmentPicks}
            planLocked={planScope.planLocked}
            lockReasonByDepartment={lockReasonByDepartment}
            onRecheckAccess={recheckAccess}
            structureEditable={planScope.structureEditable}
            groupByDept={groupByDept}
            showInactive={showInactive}
            loading={loading}
            quickFilter={quickFilter}
            filterModel={userFilter}
            onFilterModelChange={setUserFilter}
            statusByRow={queueSnapshot.statusByRow}
            restoredState={layoutOverride ?? restoredState}
            apiRef={apiRef}
            onRowUpdate={handleRowUpdate}
            onRowUpdateError={handleRowUpdateError}
            onSelectionChange={setSelectedIds}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onEditRow={handleEditRow}
            onPasteStart={handlePasteStart}
            onPasteEnd={handlePasteEnd}
            onAddField={handleAddField}
            onRemoveField={handleRemoveField}
            onManageColumns={handleManageColumns}
            onEditBlock={handleEditBlock}
          />
        )}
      </Box>

      <CopyScenarioDialog
        open={copyOpen}
        ou={selectedHotelOu}
        scenarios={allScenarios}
        targetScenarioId={scenario?.id ?? ""}
        targetYear={budgetYear}
        targetLabel={scenario?.label ?? "this scenario"}
        onClose={() => setCopyOpen(false)}
        onCopied={handleCopied}
      />

      <AddFieldDialog
        open={!!addFieldSection}
        sectionLabel={
          catalog?.sections.find((s) => s.id === addFieldSection)?.label ?? "section"
        }
        existingLabels={
          catalog?.fields
            .filter((def) => def.section === addFieldSection)
            .map(fieldLabel) ?? []
        }
        busy={addingField}
        onCancel={() => setAddFieldSection(null)}
        onSubmit={handleCreateField}
      />

      <RemoveFieldDialog
        open={!!removeTarget}
        label={removeTarget?.label ?? ""}
        valueCount={removeTarget?.valueCount ?? 0}
        busy={removingField}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) {
            void doRemoveField(removeTarget.key, removeTarget.label, removeTarget.section);
          }
        }}
      />

      <ManageColumnsDialog
        open={manageOpen}
        loading={removedLoading}
        removed={removedList}
        busyKey={manageBusyKey}
        onRestore={handleRestoreFromManage}
        onPurge={handlePurgeFromManage}
        onClose={() => setManageOpen(false)}
      />

      <BlockDialog
        open={!!blockDialog}
        block={blockDialog?.mode === "edit" ? blockDialog.block : null}
        blocks={blocksModel?.blocks ?? []}
        catalog={catalog}
        kpiDrivers={kpiDrivers.map((entry) => ({
          id: entry.driver.id as string,
          label: entry.driver.label,
        }))}
        accounts={accounts}
        departments={departments}
        saving={blockBusy}
        onClose={() => setBlockDialog(null)}
        onSave={handleSaveBlock}
        onDelete={handleDeleteBlock}
        onApplyPreset={handleApplyPreset}
        onPickSocialSecurity={(preset) => {
          setBlockDialog(null);
          setNiDialog({ block: null, preset });
        }}
      />

      <SsSchemeDialog
        open={!!niDialog}
        niBlock={niDialog?.block ?? null}
        preset={niDialog?.preset}
        schemes={blocksModel?.ssSchemes ?? []}
        blocks={blocksModel?.blocks ?? []}
        accounts={accounts}
        saving={blockBusy}
        onClose={() => setNiDialog(null)}
        onSave={handleSaveNi}
        onRecompute={handleRecomputeNi}
        onDelete={(block) => {
          setNiDialog(null);
          handleDeleteBlock(block);
        }}
      />

      <DeleteClusterPositionDialog
        pending={pendingDelete}
        clusterOf={(row) =>
          hotelClusters.find((cluster) => cluster.id === row[HOTEL_CLUSTER_KEY]) ??
          null
        }
        hotelNames={hotelNames}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          setPendingDelete(null);
          deleteRows([...pendingDelete.clustered, ...pendingDelete.standalone]);
        }}
      />

      {catalog ? (
        <PositionFormDialog
          row={editRow}
          catalog={catalog}
          blocks={blocksModel?.blocks ?? []}
          departments={departments}
          accounts={accounts}
          derived={derivedRef}
          hotelClusters={hotelClusters}
          currentOu={selectedHotelOu}
          hotelNames={hotelNames}
          masked={masked}
          writePolicy={planScope.writePolicy}
          departmentPicks={departmentPicks}
          planLocked={planScope.planLocked}
          status={queueSnapshot.statusByRow.get(editRowId ?? "")}
          initialFocusField={editFocusField}
          index={editIndex}
          count={rows.length}
          onRowUpdate={handleRowUpdate}
          onNavigate={handleEditNavigate}
          onEditBlock={(block) =>
            block.blockType === "SOCIAL_SECURITY"
              ? setNiDialog({ block })
              : setBlockDialog({ mode: "edit", block })
          }
          onClose={() => setEditRowId(null)}
        />
      ) : null}

      <Snackbar
        open={!!clusterNotice}
        autoHideDuration={clusterNotice?.severity === "warning" ? 12000 : 6000}
        onClose={() => setClusterNotice(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={clusterNotice?.severity ?? "info"}
          onClose={() => setClusterNotice(null)}
          sx={{ maxWidth: 560 }}
        >
          {clusterNotice?.message}
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!undoRows}
        autoHideDuration={6000}
        onClose={() => setUndoRows(null)}
        message={
          undoRows && undoRows.length > 1
            ? `${undoRows.length} positions deleted`
            : "Position deleted"
        }
        action={
          <Button color="secondary" size="small" onClick={handleUndoDelete}>
            Undo
          </Button>
        }
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      />
      <Snackbar
        open={!!undoRemoved}
        autoHideDuration={8000}
        onClose={() => setUndoRemoved(null)}
        message={undoRemoved ? `Column "${undoRemoved.label}" removed` : ""}
        action={
          <Button color="secondary" size="small" onClick={handleUndoRemoveField}>
            Undo
          </Button>
        }
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      />
      <Snackbar
        open={!!undoBlock}
        autoHideDuration={8000}
        onClose={() => setUndoBlock(null)}
        message={undoBlock ? `Block "${undoBlock.label}" deleted` : ""}
        action={
          <Button color="secondary" size="small" onClick={handleUndoDeleteBlock}>
            Undo
          </Button>
        }
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      />
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

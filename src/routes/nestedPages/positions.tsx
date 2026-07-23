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
  Box,
  Button,
  Snackbar,
} from "@mui/material";
import { GridInitialState, useGridApiRef } from "@mui/x-data-grid-premium";
import {
  FieldCatalog,
  FieldDataType,
  fieldLabel,
  SectionId,
} from "../../shared/positions/fields";
import {
  changedFieldKeys,
  newDraftRow,
  PositionRow,
  sanitizeRow,
  toCreate,
  toPatch,
  toRow,
  vacationCostById,
} from "../../shared/positions/rowModel";
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
import { runLiveSim } from "../../shared/positions/liveSim";
import {
  deleteBlock as deleteBlockService,
  listBlocks,
  restoreBlock as restoreBlockService,
  saveBlock as saveBlockService,
} from "../../services/blocksService";
import { listKpiDrivers } from "../../services/kpiDriversService";
import { KpiDriverWithSeries } from "../../shared/kpiDrivers/ipc";
import BlockDialog from "../../components/blocks/BlockDialog";
import {
  RemovedFieldDto,
  ScenarioDto,
  SECURE_DB_LOCKED,
} from "../../shared/positions/ipc";
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
  PositionDefaults,
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
import PositionsGrid from "../../components/positions/PositionsGrid";
import PositionsToolbar from "../../components/positions/PositionsToolbar";
import AddFieldDialog from "../../components/positions/AddFieldDialog";
import RemoveFieldDialog from "../../components/positions/RemoveFieldDialog";
import ManageColumnsDialog from "../../components/positions/ManageColumnsDialog";
import CopyScenarioDialog from "../../components/positions/CopyScenarioDialog";
import { uuidv7 } from "../../shared/engine/ids";

/**
 * Splice a freshly created column into the grid's exported layout.
 *
 * Without this the grid appends unknown fields to the far right of the column
 * order, which both hides the new column and splits its section band in two.
 * The new field goes immediately after the last column of its section, and
 * inherits the section's pinning when the whole band is pinned.
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

  const left = next.pinnedColumns?.left;
  if (left && bandKeys.every((band) => left.includes(band))) {
    next.pinnedColumns = { ...next.pinnedColumns, left: insertAfter(left) };
  }

  return next;
}

/**
 * Drop a removed column from the grid's exported layout — the mirror of
 * {@link withNewFieldInLayout}. A key left behind in orderedFields/pinned lists
 * is mostly tolerated by the grid, but a stale pinned key splits its section
 * band into two banners, so it has to be pruned everywhere it can appear.
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

  if (next.pinnedColumns) {
    const pinned = { ...next.pinnedColumns };
    if (pinned.left) pinned.left = pinned.left.filter((field) => field !== key);
    if (pinned.right) pinned.right = pinned.right.filter((field) => field !== key);
    next.pinnedColumns = pinned;
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
  // KPI drivers with cached series: the block dialog's KPI options AND the
  // series feed for KPI-based blocks in the live sim.
  const [kpiDrivers, setKpiDrivers] = useState<KpiDriverWithSeries[]>([]);
  /** Block dialog: closed | create | edit-this-block. */
  const [blockDialog, setBlockDialog] = useState<
    { mode: "create" } | { mode: "edit"; block: BlockDto } | null
  >(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [undoBlock, setUndoBlock] = useState<BlockDto | null>(null);
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
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>(IDLE_SNAPSHOT);
  const [undoRow, setUndoRow] = useState<PositionRow | null>(null);
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

  const queueRef = useRef<PositionsWriteQueue | null>(null);
  const catalogRef = useRef<FieldCatalog | null>(null);
  catalogRef.current = catalog;
  // Blocks mirror, so handleRowUpdate stays a stable callback while the block
  // set changes under it (same pattern as catalogRef).
  const blocksRef = useRef<BlockDto[]>([]);
  blocksRef.current = blocksModel?.blocks ?? [];
  // name -> code, for the Department code auto-fill in the edit/paste path. A
  // ref so handleRowUpdate stays a stable callback while the map updates under
  // it. Names carry the unique code, so the mapping is effectively 1:1; on the
  // rare duplicate name the last department wins.
  const deptCodeByNameRef = useRef<ReadonlyMap<string, string>>(new Map());
  deptCodeByNameRef.current = useMemo(
    () => new Map(departments.map((dept) => [dept.name, dept.code])),
    [departments]
  );
  // Safe defaults for (hotel, budget year) — read only when adding a position,
  // so a ref (not state) is enough; a new row seeds from it and is then
  // independent.
  const defaultsRef = useRef<PositionDefaults | null>(null);

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
        const forYear = scenarios.filter((s) => s.year === budgetYear);
        const resolved =
          forYear.find((s) => s.id === planningScenarioId) ??
          forYear.find((s) => s.label === "Planning") ??
          forYear[0] ??
          null;
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

  // ── Safe defaults for (hotel, budget year): the seed for a new position ──
  useEffect(() => {
    if (!selectedHotelOu) {
      defaultsRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { defaults } = await loadPositionDefaults(selectedHotelOu, budgetYear);
        if (!cancelled) defaultsRef.current = defaults;
      } catch (err) {
        console.error("Failed to load position defaults:", err);
        if (!cancelled) defaultsRef.current = null;
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

  // Engine-simulated vacation cost per row, recomputed as rows or the calendar
  // change. One pass of the same spread math the budget runs — instant for a
  // grid's worth of positions, and never drifts from the authoritative figure.
  const vacationCosts = useMemo(
    () => vacationCostById(rows, calendarCtx, scenario?.id ?? ""),
    [rows, calendarCtx, scenario]
  );

  // ── Live block simulation: the real engine over the live rows ──
  // Recomputed on every committed edit (cell commit, not keystroke) — a full
  // compile + simulate is single-digit milliseconds at grid scale, and the
  // math is the exact code a budget run executes, so totals can never drift.
  const kpiSeriesByDriver = useMemo(() => {
    const map = new Map(kpiDrivers.map((entry) => [entry.driver.id as string, entry.series]));
    return (driverId: string) => map.get(driverId) ?? [];
  }, [kpiDrivers]);

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
    });
    return { results: run.results, errors: run.errors } as const;
  }, [rows, blocksModel, calendarYear, kpiSeriesByDriver, scenario, selectedHotelOu]);

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
      setQueueSnapshot
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
  }, [selectedHotelOu, scenario]);

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
    []
  );

  const handleRowUpdateError = useCallback((err: unknown) => {
    console.error("Position cell update failed:", err);
    setError("Could not apply that change");
  }, []);

  const handleAddPosition = useCallback(() => {
    const currentCatalog = catalogRef.current;
    const queue = queueRef.current;
    if (!currentCatalog || !queue) return;

    // Seed the Contract columns (Yearly Days, Days Off, Public Holidays, Daily
    // Hours) from the hotel-year safe defaults set on the Home page. The seed is
    // a one-time copy — the row is fully independent and editable afterwards.
    const seed: Partial<PositionRow> | undefined = defaultsRef.current
      ? seedInitForPosition(defaultsRef.current)
      : undefined;
    const draft = newDraftRow(currentCatalog, seed);
    queue.enqueueCreate(toCreate(draft, currentCatalog));
    setRows((current) => [...current, draft]);

    // Land the user in the first editable cell of the new row.
    requestAnimationFrame(() => {
      try {
        const rowIndex = apiRef.current?.getRowIndexRelativeToVisibleRows(draft.id);
        if (rowIndex !== undefined && rowIndex >= 0) {
          apiRef.current?.scrollToIndexes({ rowIndex });
        }
        // With PII masked, the first reachable editable cell is the Department
        // picker (Dept Name) — departmentCode is the read-only code mirror now.
        const firstField = masked ? "deptName" : "empNumber";
        apiRef.current?.startCellEditMode({ id: draft.id, field: firstField });
      } catch {
        /* focus is best-effort */
      }
    });
  }, [apiRef, masked]);

  const handleDuplicate = useCallback((row: PositionRow) => {
    const currentCatalog = catalogRef.current;
    const queue = queueRef.current;
    if (!currentCatalog || !queue) return;

    // Copy the contractual data; the identity (PII) stays blank on the copy.
    const copy: PositionRow = { ...row, id: uuidv7() };
    for (const def of currentCatalog.fields) {
      if (def.maskable) copy[def.key] = null;
    }
    queue.enqueueCreate(toCreate(copy, currentCatalog));
    setRows((current) => [...current, copy]);
  }, []);

  const handleDelete = useCallback((row: PositionRow) => {
    const queue = queueRef.current;
    if (!queue) return;
    queue.enqueueDelete(row.id);
    setRows((current) => current.filter((r) => r.id !== row.id));
    setUndoRow(row);
  }, []);

  const handleUndoDelete = useCallback(() => {
    const queue = queueRef.current;
    if (!queue || !undoRow) return;
    queue.enqueueRestore(undoRow.id);
    setRows((current) => [...current, undoRow]);
    setUndoRow(null);
  }, [undoRow]);

  const handleExportCsv = useCallback(() => {
    apiRef.current?.exportDataAsCsv({
      fileName: `positions_${selectedHotelOu ?? "hotel"}_${scenario?.label ?? "scenario"}`,
    });
  }, [apiRef, selectedHotelOu, scenario]);

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

      const targets = new Set(selectedIds);
      setRows((current) =>
        current.map((row) => {
          if (!targets.has(row.id) || row.active === active) return row;
          queue.enqueuePatch(row.id, { positionFields: { active }, piiFields: {} });
          return { ...row, active };
        })
      );
      setToast(
        `${targets.size} position${targets.size === 1 ? "" : "s"} marked ${
          active ? "active" : "inactive"
        }`
      );
    },
    [selectedIds]
  );

  // ── Blocks: add / edit / delete (with undo) ──
  // Column changes are reactive (the columns memo reads blocksModel), so no
  // grid remount is needed; new bands append after the catalog sections.
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

      {/* Structure problems (e.g. blocks referencing each other in a loop)
          pause the block totals; everything else keeps working. */}
      {liveSim.errors && liveSim.errors.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Block totals are paused: {liveSim.errors[0]?.message} Edit the block
          configuration to fix this.
        </Alert>
      )}

      {/* The year/scenario context lives on the toolbar's right edge — one row
          for controls, status and context, so the grid gets the height back. */}
      <Box sx={{ mb: 1.5 }}>
        <PositionsToolbar
          disabled={controlsDisabled}
          budgetYear={budgetYear}
          scenarioLabel={scenario?.label ?? "No scenario"}
          masked={masked}
          groupByDept={groupByDept}
          showInactive={showInactive}
          selectedCount={selectedIds.length}
          quickFilter={quickFilter}
          queueState={queueSnapshot.state}
          pendingRows={queueSnapshot.pendingRows}
          onAddPosition={handleAddPosition}
          onAddBlock={() => setBlockDialog({ mode: "create" })}
          onToggleMask={() => setMasked((value) => !value)}
          onToggleGroup={() => setGroupByDept((value) => !value)}
          onToggleInactive={() => setShowInactive((value) => !value)}
          onBulkActive={handleBulkActive}
          onCopyFromYear={() => setCopyOpen(true)}
          onQuickFilter={setQuickFilter}
          onExportCsv={handleExportCsv}
        />
      </Box>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {/* A scenario with no positions is the January case: the year rolled
            over and nothing has been carried across yet. Offer the copy rather
            than an empty grid the user has to work out how to fill. */}
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
            another year instead of entering them again.
          </Alert>
        ) : null}
        {gridReady && (
          <PositionsGrid
            key={gridEpoch}
            rows={rows}
            catalog={catalog}
            departments={departments}
            accounts={accounts}
            vacationCostById={vacationCosts}
            blocks={blocksModel?.blocks ?? []}
            blockResults={liveSim.results}
            masked={masked}
            groupByDept={groupByDept}
            showInactive={showInactive}
            loading={loading}
            quickFilter={quickFilter}
            statusByRow={queueSnapshot.statusByRow}
            restoredState={layoutOverride ?? restoredState}
            apiRef={apiRef}
            onRowUpdate={handleRowUpdate}
            onRowUpdateError={handleRowUpdateError}
            onSelectionChange={setSelectedIds}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onPasteStart={handlePasteStart}
            onPasteEnd={handlePasteEnd}
            onAddField={handleAddField}
            onRemoveField={handleRemoveField}
            onManageColumns={handleManageColumns}
            onEditBlock={(block) => setBlockDialog({ mode: "edit", block })}
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
        kpiDrivers={kpiDrivers.map((entry) => ({
          id: entry.driver.id as string,
          label: entry.driver.label,
        }))}
        accounts={accounts}
        saving={blockBusy}
        onClose={() => setBlockDialog(null)}
        onSave={handleSaveBlock}
        onDelete={handleDeleteBlock}
      />

      <Snackbar
        open={!!undoRow}
        autoHideDuration={6000}
        onClose={() => setUndoRow(null)}
        message="Position deleted"
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

/**
 * Manual Input page.
 * -----------------------------------------------------------
 * Hand-entered cost lines that don't come from the budget pull or the payroll
 * engine: a description, department, a cost account + a stats account, an optional
 * rate, and 12 months of Stats + Amount. "Stats" are operational units (hours,
 * covers…). When a row has a rate the monthly Amount is derived (stats * rate) and
 * locked; otherwise it's typed directly. Rows persist to the encrypted secure
 * store. The inline spread columns + "Apply spread" fill all 12 months from a base
 * value (flat or days-in-month, with an optional % increase — Amount only — from a
 * chosen month) so the user doesn't retype 12 times — fill-once, cells stay
 * editable afterwards.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import Tooltip from "@mui/material/Tooltip";
import CircularProgress from "@mui/material/CircularProgress";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import AddIcon from "@mui/icons-material/Add";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import { useGridApiRef } from "@mui/x-data-grid-premium";
import {
  usePlanningScenarioId,
  useSelectedHotel,
  useSettingsStore,
} from "../../store/settings";
import { listScenarios } from "../../services/scenarioService";
import { ScenarioDto } from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import { ManualInputRow, ManualInputRowId } from "../../shared/manualInput/ipc";
import {
  deleteManualRows,
  listManualRows,
  saveManualRow,
} from "../../services/manualInputService";
import {
  loadAccounts,
  loadDepartments,
} from "../../services/mappingTablesService";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { usePlanScope } from "../../hooks/usePlanScope";
import { departmentPickList } from "../../shared/positions/departmentPickList";
import { rowDepartmentWritable } from "../../shared/positions/writeScope";
import ManualInputGrid from "../../components/manualInput/ManualInputGrid";
import { ManualViewMode } from "../../components/manualInput/columns";
import {
  applySpread,
  emptyGridRow,
  ManualGridRow,
  toGridRow,
  toInput,
} from "../../components/manualInput/rowModel";

type Toast = { severity: "success" | "error" | "info"; message: string } | null;

export default function ManualInput() {
  const ou = useSelectedHotel();
  const budgetYear = useSettingsStore((s) => s.budgetYear);
  const planningScenarioId = usePlanningScenarioId();
  const apiRef = useGridApiRef();

  const [scenario, setScenario] = useState<ScenarioDto | null>(null);

  const [rows, setRows] = useState<ManualGridRow[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ManualViewMode>("both");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  // A just-added row waiting to be focused once it lands in the grid.
  const pendingFocusId = useRef<string | null>(null);

  // Departments-by-name, for the code auto-fill on a department pick.
  const deptByName = useMemo(() => {
    const map = new Map<string, DepartmentOption>();
    for (const d of departments) map.set(d.name, d);
    return map;
  }, [departments]);

  // Who is creating rows — recorded on save.
  useEffect(() => {
    (window as any)?.authApi
      ?.getStatus?.()
      .then((s: { lastUserEmail?: string | null }) =>
        setUserEmail(s?.lastUserEmail ?? null)
      )
      .catch(() => setUserEmail(null));
  }, []);

  // Reference data for the dropdowns (best-effort; degrades to free text).
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([loadDepartments(), loadAccounts()]).then(
      ([deptResult, acctResult]) => {
        if (cancelled) return;
        setDepartments(
          deptResult.status === "fulfilled" ? deptResult.value : []
        );
        setAccounts(acctResult.status === "fulfilled" ? acctResult.value : []);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Resolve the planning scenario (same healing as the Results page) ──
  // Manual rows post into that scenario's results, so the page has to know
  // which scenario it is editing before it can load anything.
  useEffect(() => {
    if (!ou) {
      setScenario(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const scenarios = await listScenarios(ou, budgetYear);
        if (cancelled) return;
        setScenario(
          resolvePlanningScenario(scenarios, budgetYear, planningScenarioId)
        );
      } catch (error) {
        console.error("Failed to resolve scenario for manual input:", error);
        if (!cancelled) setScenario(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ou, budgetYear, planningScenarioId]);

  // Load the hotel's rows whenever the selection changes.
  useEffect(() => {
    if (!ou || !scenario) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listManualRows(ou, scenario.id)
      .then((result) => {
        if (!cancelled) setRows(result.map(toGridRow));
      })
      .catch((error) => {
        if (!cancelled)
          setToast({ severity: "error", message: (error as Error).message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ou, scenario]);

  const applyServerRows = useCallback((result: ManualInputRow[]) => {
    setRows(result.map(toGridRow));
  }, []);

  /**
   * What the server says this user may write on this plan.
   *
   * This page had no sync awareness at all, which was not a neutral omission:
   * `manual_input_row` is one of the department-scoped published types, so
   * `filterToWriteScope` was already withholding rows typed into a department
   * the user did not hold — with no rejection to notice, so the rows simply were
   * not on the server afterwards. Everything below refuses up front instead.
   *
   * Unrestricted while the plan is unpublished, exactly as before.
   */
  const planScope = usePlanScope(ou, scenario?.id ?? null);

  /**
   * Why a write would be refused, or null when it would not.
   *
   * The same four situations the positions page distinguishes, in the same
   * words: somebody who reads one sentence on one page and a different one on
   * the next has to work out whether they mean the same thing.
   */
  const writeRefusal = useMemo((): string | null => {
    if (planScope.notShared) {
      return (
        "This plan is no longer shared with you. You can read what is here, " +
        "but nothing can be added or changed."
      );
    }
    if (planScope.planLocked) {
      return "An administrator is holding this plan, so nothing can be changed.";
    }
    if (planScope.holdsNoDepartment) {
      return (
        "This plan was shared with you to look at, not to change. Ask its owner " +
        "if you need to edit a department."
      );
    }
    return null;
  }, [planScope.notShared, planScope.planLocked, planScope.holdsNoDepartment]);

  /** The row-level backstop for everything that does not go through a cell. */
  const rowWritable = useCallback(
    (row: ManualGridRow | undefined) =>
      rowDepartmentWritable(row, {
        writePolicy: planScope.writePolicy,
        planLocked: planScope.planLocked,
      }),
    [planScope.writePolicy, planScope.planLocked]
  );

  /** What the Department picker may offer here. See `departmentPickList`. */
  const departmentPicks = useMemo(
    () => departmentPickList(departments, planScope.ownership),
    [departments, planScope.ownership]
  );


  // Once a freshly added row is present in the grid, drop the cursor into its
  // Description cell so you can type straight away instead of hunting for it.
  useEffect(() => {
    const id = pendingFocusId.current;
    if (!id || !rows.some((row) => row.id === id)) return;
    pendingFocusId.current = null;
    requestAnimationFrame(() => {
      try {
        apiRef.current?.setCellFocus(id, "description");
        apiRef.current?.startCellEditMode({ id, field: "description" });
      } catch {
        /* focus is best-effort */
      }
    });
  }, [rows, apiRef]);

  /** Auto-fill the dept code from the picked department; normalize blank rate. */
  const sanitize = useCallback(
    (newRow: ManualGridRow, oldRow: ManualGridRow): ManualGridRow => {
      const next: ManualGridRow = { ...newRow };
      if (departments.length > 0 && newRow.department !== oldRow.department) {
        next.departmentCode = deptByName.get(String(newRow.department))?.code ?? "";
      }
      if ((next.rate as unknown) === "") next.rate = null;
      return next;
    },
    [departments, deptByName]
  );

  /**
   * The save backstop, for everything that does not go through a cell.
   *
   * `isCellEditable` already stops a locked cell opening. This covers the paths
   * that bypass it — Apply spread, Delete, and any future bulk action — and
   * throws rather than returning quietly, so `handleRowUpdate` reverts the cell
   * and the user is told instead of watching an edit disappear.
   */
  const persistRow = useCallback(
    async (row: ManualGridRow) => {
      if (!ou || !scenario) return;
      if (writeRefusal) throw new Error(writeRefusal);
      if (!rowWritable(row)) {
        throw new Error(
          "That row is in a department somebody else is editing. Withdraw the " +
            "delegation on the Sync page to take it back."
        );
      }
      const result = await saveManualRow(ou, scenario.id, toInput(row), userEmail);
      applyServerRows(result);
    },
    [ou, scenario, userEmail, applyServerRows, writeRefusal, rowWritable]
  );

  // Cell edits + pastes flow through here; sanitize, persist, keep the sane row.
  const handleRowUpdate = useCallback(
    async (newRow: ManualGridRow, oldRow: ManualGridRow) => {
      const sane = sanitize(newRow, oldRow);
      try {
        await persistRow(sane);
      } catch (error) {
        setToast({ severity: "error", message: (error as Error).message });
        throw error;
      }
      return sane;
    },
    [sanitize, persistRow]
  );

  const handleRowUpdateError = useCallback((error: unknown) => {
    setToast({ severity: "error", message: (error as Error).message });
  }, []);

  const handleAddRow = useCallback(async () => {
    if (!ou || !scenario) return;
    if (writeRefusal) {
      setToast({ severity: "error", message: writeRefusal });
      return;
    }
    setBusy(true);
    const existing = new Set(rows.map((row) => row.id));
    try {
      // The backend mints the id; send an empty payload and take the refreshed list.
      const result = await saveManualRow(
        ou,
        scenario.id,
        toInput(emptyGridRow("")),
        userEmail
      );
      // The row not present before is the one just minted — queue it for focus.
      pendingFocusId.current =
        result.find((row) => !existing.has(row.id))?.id ?? null;
      applyServerRows(result);
    } catch (error) {
      setToast({ severity: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
    // `scenario` is read above and was missing here, so a hotel switched while
    // the page was open could mint the row into the scenario it replaced.
  }, [ou, scenario, userEmail, rows, applyServerRows, writeRefusal]);

  const handleApplySpread = useCallback(async () => {
    // `scenario` is dereferenced below; guarding only `ou` made a page with no
    // resolved scenario a null-deref rather than a no-op.
    if (!ou || !scenario || selectedIds.length === 0) return;
    if (writeRefusal) {
      setToast({ severity: "error", message: writeRefusal });
      return;
    }
    const selected = new Set(selectedIds);
    const changed = rows.filter(
      (row) => selected.has(row.id) && row.spreadMode !== ""
    );
    if (changed.length === 0) {
      setToast({
        severity: "info",
        message: "Set a spread Mode and Base on the selected rows first.",
      });
      return;
    }
    // Refuse the whole action rather than spreading into the writable half and
    // leaving the rest silently untouched: a partial result nobody asked for is
    // harder to notice than a refusal.
    const locked = changed.filter((row) => !rowWritable(row));
    if (locked.length > 0) {
      setToast({
        severity: "error",
        message: `${locked.length} of those rows ${
          locked.length === 1 ? "is" : "are"
        } in a department somebody else is editing.`,
      });
      return;
    }
    setBusy(true);
    try {
      let last: ManualInputRow[] | null = null;
      for (const row of changed) {
        const filled = applySpread(row, budgetYear);
        last = await saveManualRow(ou, scenario.id, toInput(filled), userEmail);
      }
      if (last) applyServerRows(last);
      setToast({
        severity: "success",
        message: `Spread applied to ${changed.length} row${changed.length === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      setToast({ severity: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [
    ou,
    scenario,
    selectedIds,
    rows,
    budgetYear,
    userEmail,
    applyServerRows,
    writeRefusal,
    rowWritable,
  ]);

  const handleDelete = useCallback(async () => {
    if (!ou || !scenario || selectedIds.length === 0) return;
    if (writeRefusal) {
      setToast({ severity: "error", message: writeRefusal });
      return;
    }
    const selected = new Set(selectedIds);
    const locked = rows.filter((row) => selected.has(row.id) && !rowWritable(row));
    if (locked.length > 0) {
      setToast({
        severity: "error",
        message: `${locked.length} of those rows ${
          locked.length === 1 ? "is" : "are"
        } in a department somebody else is editing.`,
      });
      return;
    }
    if (
      !window.confirm(
        `Delete ${selectedIds.length} row${selectedIds.length === 1 ? "" : "s"}?`
      )
    )
      return;
    setBusy(true);
    try {
      const result = await deleteManualRows(
        ou,
        scenario.id,
        selectedIds as ManualInputRowId[]
      );
      applyServerRows(result);
      setSelectedIds([]);
    } catch (error) {
      setToast({ severity: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [ou, scenario, selectedIds, rows, applyServerRows, writeRefusal, rowWritable]);

  const hasSelection = selectedIds.length > 0;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, height: "100%" }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        {/* Drawing a button whose only outcome is a refusal is the thing the
            scope checks exist to prevent — so the reason is the tooltip and the
            button is off, rather than a toast after the click. */}
        <Tooltip title={writeRefusal ?? ""}>
          <span>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={handleAddRow}
              disabled={!ou || busy || writeRefusal !== null}
            >
              Add row
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={writeRefusal ?? ""}>
          <span>
            <Button
              variant="outlined"
              startIcon={<CallSplitIcon sx={{ transform: "rotate(90deg)" }} />}
              onClick={handleApplySpread}
              disabled={!ou || busy || !hasSelection || writeRefusal !== null}
            >
              Apply spread{hasSelection ? ` (${selectedIds.length})` : ""}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={writeRefusal ?? ""}>
          <span>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteOutlineIcon />}
              onClick={handleDelete}
              disabled={!ou || busy || !hasSelection || writeRefusal !== null}
            >
              Delete{hasSelection ? ` (${selectedIds.length})` : ""}
            </Button>
          </span>
        </Tooltip>
        {(loading || busy) && <CircularProgress size={20} />}
        <Box sx={{ flexGrow: 1 }} />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={viewMode}
          onChange={(_event, next: ManualViewMode | null) => {
            if (next) setViewMode(next);
          }}
          aria-label="Monthly cells to show"
        >
          <ToggleButton value="stats">Stats</ToggleButton>
          <ToggleButton value="amount">Amount</ToggleButton>
          <ToggleButton value="both">Both</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {!ou && (
        <Alert severity="info">
          Select a hotel (top bar) to add and view its manual input rows.
        </Alert>
      )}

      {/* The two whole-plan refusals, in the words the Sync page uses. The
          per-department case gets no banner: the grid greys what it cannot
          write, and the Delegation page answers who holds it and why. */}
      {ou && !planScope.unpublished && planScope.notShared && (
        <Alert severity="warning">
          This plan is no longer shared with you. You can read what is here, but
          nothing can be added or changed. The Sync page explains why.
        </Alert>
      )}
      {ou && !planScope.unpublished && !planScope.notShared && planScope.planLocked && (
        <Alert severity="info">
          This plan is read-only for you — an administrator is holding it. The Sync
          page explains why.
        </Alert>
      )}

      {ou && (
        <Box sx={{ flexGrow: 1, minHeight: 360, height: "calc(100vh - 200px)" }}>
          <ManualInputGrid
            rows={rows}
            departments={departments}
            departmentPicks={departmentPicks}
            accounts={accounts}
            viewMode={viewMode}
            apiRef={apiRef}
            loading={loading}
            writePolicy={planScope.writePolicy}
            planLocked={planScope.planLocked}
            onRowUpdate={handleRowUpdate}
            onRowUpdateError={handleRowUpdateError}
            onSelectionChange={setSelectedIds}
          />
        </Box>
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)}>
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

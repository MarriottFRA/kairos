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
import CircularProgress from "@mui/material/CircularProgress";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import AddIcon from "@mui/icons-material/Add";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import { useGridApiRef } from "@mui/x-data-grid-premium";
import { useSelectedHotel, useSettingsStore } from "../../store/settings";
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
  const apiRef = useGridApiRef();

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

  // Load the hotel's rows whenever the selection changes.
  useEffect(() => {
    if (!ou) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listManualRows(ou)
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
  }, [ou]);

  const applyServerRows = useCallback((result: ManualInputRow[]) => {
    setRows(result.map(toGridRow));
  }, []);

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

  const persistRow = useCallback(
    async (row: ManualGridRow) => {
      if (!ou) return;
      const result = await saveManualRow(ou, toInput(row), userEmail);
      applyServerRows(result);
    },
    [ou, userEmail, applyServerRows]
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
    if (!ou) return;
    setBusy(true);
    const existing = new Set(rows.map((row) => row.id));
    try {
      // The backend mints the id; send an empty payload and take the refreshed list.
      const result = await saveManualRow(ou, toInput(emptyGridRow("")), userEmail);
      // The row not present before is the one just minted — queue it for focus.
      pendingFocusId.current =
        result.find((row) => !existing.has(row.id))?.id ?? null;
      applyServerRows(result);
    } catch (error) {
      setToast({ severity: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [ou, userEmail, rows, applyServerRows]);

  const handleApplySpread = useCallback(async () => {
    if (!ou || selectedIds.length === 0) return;
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
    setBusy(true);
    try {
      let last: ManualInputRow[] | null = null;
      for (const row of changed) {
        const filled = applySpread(row, budgetYear);
        last = await saveManualRow(ou, toInput(filled), userEmail);
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
  }, [ou, selectedIds, rows, budgetYear, userEmail, applyServerRows]);

  const handleDelete = useCallback(async () => {
    if (!ou || selectedIds.length === 0) return;
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
        selectedIds as ManualInputRowId[]
      );
      applyServerRows(result);
      setSelectedIds([]);
    } catch (error) {
      setToast({ severity: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [ou, selectedIds, applyServerRows]);

  const hasSelection = selectedIds.length > 0;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, height: "100%" }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleAddRow}
          disabled={!ou || busy}
        >
          Add row
        </Button>
        <Button
          variant="outlined"
          startIcon={<CallSplitIcon sx={{ transform: "rotate(90deg)" }} />}
          onClick={handleApplySpread}
          disabled={!ou || busy || !hasSelection}
        >
          Apply spread{hasSelection ? ` (${selectedIds.length})` : ""}
        </Button>
        <Button
          variant="outlined"
          color="error"
          startIcon={<DeleteOutlineIcon />}
          onClick={handleDelete}
          disabled={!ou || busy || !hasSelection}
        >
          Delete{hasSelection ? ` (${selectedIds.length})` : ""}
        </Button>
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

      {ou && (
        <Box sx={{ flexGrow: 1, minHeight: 360, height: "calc(100vh - 200px)" }}>
          <ManualInputGrid
            rows={rows}
            departments={departments}
            accounts={accounts}
            viewMode={viewMode}
            apiRef={apiRef}
            loading={loading}
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

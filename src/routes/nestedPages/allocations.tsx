/**
 * Allocations — spread shared costs across departments.
 * -----------------------------------------------------------
 * The user defines allocations (name + spread base + excluded departments); the
 * page shows departments (rows) × allocations (columns), each column normalized
 * to 100. Values are computed in main from the selected hotel + planning
 * scenario's active positions — nothing derived is stored. Reproduces the legacy
 * VBA `Full_Alloc_Recalc`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import { listScenarios } from "../../services/scenarioService";
import {
  listAllocations,
  saveAllocation,
  deleteAllocation,
} from "../../services/allocationsService";
import {
  AllocationDto,
  AllocationInput,
  AllocationsViewResponse,
} from "../../shared/allocations/ipc";
import { ScenarioDto, SECURE_DB_LOCKED } from "../../shared/positions/ipc";
import { resolvePlanningScenario } from "../../shared/positions/scenarioResolve";
import {
  useBudgetYear,
  usePlanningScenarioId,
  useSelectedHotel,
} from "../../store/settings";
import AllocationsGrid from "../../components/allocations/AllocationsGrid";
import AllocationDialog from "../../components/allocations/AllocationDialog";
import { loadAccounts } from "../../services/mappingTablesService";
import { AccountOption } from "../../shared/mappingTables/types";
import { usePlanScope } from "../../hooks/usePlanScope";
import PartialScopeAlert from "../../components/sync/PartialScopeAlert";

const EMPTY: AllocationsViewResponse = { allocations: [], departments: [] };

export default function Allocations() {
  const selectedHotelOu = useSelectedHotel();
  const budgetYear = useBudgetYear();
  const planningScenarioId = usePlanningScenarioId();

  // A delegate holding some of the plan's departments gets confidently wrong
  // numbers here rather than incomplete ones: every column is renormalised to
  // 100%, so a missing department silently inflates everybody else's share.
  // Server-side `scope.kind` is what makes that detectable, and this is the gate.
  const planScope = usePlanScope(selectedHotelOu, planningScenarioId);
  const partialScope = planScope.scopeKind === "PARTIAL";

  const [scenario, setScenario] = useState<ScenarioDto | null>(null);
  const [view, setView] = useState<AllocationsViewResponse>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AllocationDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AllocationDto | null>(null);
  // For the dialog's "post to account" picker. Best-effort, like every other
  // page that offers it: no cache yet just means an empty option list.
  const [accounts, setAccounts] = useState<AccountOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadAccounts()
      .then((result) => {
        if (!cancelled) setAccounts(result);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const surfaceError = useCallback((err: unknown, fallback: string) => {
    const message = err instanceof Error ? err.message : fallback;
    setError(
      message === SECURE_DB_LOCKED
        ? "The secure store is locked — sign out and back in to load allocations."
        : message
    );
  }, []);

  // ── Resolve the planning scenario (same healing as the Results page) ──
  useEffect(() => {
    if (!selectedHotelOu) {
      setScenario(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const scenarios = await listScenarios(selectedHotelOu, budgetYear);
        if (cancelled) return;
        setScenario(
          resolvePlanningScenario(scenarios, budgetYear, planningScenarioId)
        );
      } catch (err) {
        console.error("Failed to resolve scenario for allocations:", err);
        if (!cancelled) setScenario(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu, budgetYear, planningScenarioId]);

  // ── Load the view when the scope changes ──
  const reload = useCallback(async () => {
    if (!selectedHotelOu || !scenario) {
      setView(EMPTY);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setView(await listAllocations(selectedHotelOu, scenario.id));
    } catch (err) {
      console.error("Failed to load allocations:", err);
      surfaceError(err, "Failed to load allocations");
      setView(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [selectedHotelOu, scenario, surfaceError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const deptOptions = useMemo(
    () =>
      view.departments.map((dept) => ({
        code: dept.departmentCode,
        name: dept.departmentName,
      })),
    [view.departments]
  );

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (allocation: AllocationDto) => {
    setEditing(allocation);
    setDialogOpen(true);
  };

  const handleSave = async (input: AllocationInput) => {
    if (!selectedHotelOu || !scenario) return;
    setSaving(true);
    setError(null);
    try {
      setView(await saveAllocation(selectedHotelOu, scenario.id, input));
      setDialogOpen(false);
      setEditing(null);
    } catch (err) {
      console.error("Failed to save allocation:", err);
      surfaceError(err, "Failed to save allocation");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedHotelOu || !scenario || !pendingDelete) return;
    try {
      setView(await deleteAllocation(selectedHotelOu, scenario.id, pendingDelete.id));
    } catch (err) {
      console.error("Failed to delete allocation:", err);
      surfaceError(err, "Failed to delete allocation");
    } finally {
      setPendingDelete(null);
    }
  };

  const hasDepartments = view.departments.length > 0;
  const hasAllocations = view.allocations.length > 0;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", gap: 2 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            Allocations
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Spread shared costs across departments. Each column is normalized to
            100 by its chosen driver{scenario ? ` · ${scenario.label}` : ""}.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          disabled={!scenario || loading || partialScope}
        >
          Add allocation
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}

      {partialScope && (
        <PartialScopeAlert
          surface="allocations"
          departments={planScope.ownership?.departments.map((row) => row.code) ?? null}
        />
      )}

      {!scenario && !loading && !error && (
        <Alert severity="info">
          Select a hotel with a planning scenario to build allocations.
        </Alert>
      )}

      {scenario && !hasDepartments && !loading && (
        <Alert severity="info">
          This scenario has no active positions yet, so there are no departments
          to spread across. Add positions first.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        // The grid itself is withheld, not merely captioned: the whole failure
        // mode of a partial scope here is that the percentages LOOK right.
        hasDepartments &&
        !partialScope && (
          <Box sx={{ flexGrow: 1, minHeight: 320 }}>
            {!hasAllocations && (
              <Alert severity="info" sx={{ mb: 2 }}>
                No allocations yet — use “Add allocation” to create your first
                spread column (e.g. Laundry by Head Count).
              </Alert>
            )}
            <AllocationsGrid
              view={view}
              loading={loading}
              onEdit={openEdit}
              onDelete={setPendingDelete}
            />
          </Box>
        )
      )}

      <AllocationDialog
        open={dialogOpen}
        allocation={editing}
        existing={view.allocations}
        departments={deptOptions}
        accounts={accounts}
        saving={saving}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSave={handleSave}
      />

      <Dialog open={!!pendingDelete} onClose={() => setPendingDelete(null)}>
        <DialogTitle>Delete allocation</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete “{pendingDelete?.name}”? This removes the spread column; the
            department figures behind it are untouched.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

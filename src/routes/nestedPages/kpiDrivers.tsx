/**
 * KPI Drivers page.
 * -----------------------------------------------------------
 * Define reusable budget-driven KPIs for a hotel and inspect their computed
 * series. A driver aggregates the pulled budget (SUM per month) over a
 * department filter + account prefixes, read from a bucket (default 1). Some
 * built-in drivers (e.g. Total Revenue) ship for every hotel; users add their
 * own or duplicate a built-in to customize it. Drivers render as collapsible
 * cards (one open at a time), split into Built-in and Your-drivers sections and
 * filtered by a search box. Values are precalculated and cached in the local
 * store, refreshed on a budget pull or on demand here. Phase 2 wires these into
 * the payroll engine.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import CircularProgress from "@mui/material/CircularProgress";
import TextField from "@mui/material/TextField";
import InputAdornment from "@mui/material/InputAdornment";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import { useSelectedHotel } from "../../store/settings";
import {
  KpiDriver,
  KpiDriverId,
  KpiDriverInput,
  KpiDriverWithSeries,
} from "../../shared/kpiDrivers/ipc";
import { BucketMeta, ImportRowsResult } from "../../shared/budgetImport/ipc";
import {
  deleteKpiDriver,
  listKpiDrivers,
  recalcKpiDrivers,
  saveKpiDriver,
} from "../../services/kpiDriversService";
import { getCurrentBudgetImport } from "../../services/budgetImportService";
import KpiDriverCard from "../../components/kpiDrivers/KpiDriverCard";
import KpiDriverDialog from "../../components/kpiDrivers/KpiDriverDialog";

type Toast = { severity: "success" | "error" | "info"; message: string } | null;

type DialogState = {
  open: boolean;
  driver: KpiDriver | null;
  duplicate: boolean;
};

/** True when the query matches the driver's name, description, or filters. */
function matchesQuery(item: KpiDriverWithSeries, q: string): boolean {
  if (!q) return true;
  const { driver } = item;
  const hay = [
    driver.label,
    driver.description,
    ...driver.deptPatterns,
    ...driver.accountPrefixes,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export default function KpiDrivers() {
  const ou = useSelectedHotel();

  const [items, setItems] = useState<KpiDriverWithSeries[]>([]);
  const [buckets, setBuckets] = useState<BucketMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({
    open: false,
    driver: null,
    duplicate: false,
  });
  const [toast, setToast] = useState<Toast>(null);

  // Who is creating drivers — recorded on save.
  useEffect(() => {
    (window as any)?.authApi
      ?.getStatus?.()
      .then((s: { lastUserEmail?: string | null }) =>
        setUserEmail(s?.lastUserEmail ?? null)
      )
      .catch(() => setUserEmail(null));
  }, []);

  // Load the hotel's drivers + current bucket names whenever the selection
  // changes. Buckets are best-effort (empty until a budget is pulled).
  useEffect(() => {
    if (!ou) {
      setItems([]);
      setBuckets([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listKpiDrivers(ou),
      getCurrentBudgetImport(ou).catch(
        (): ImportRowsResult | null => null
      ),
    ])
      .then(([result, budget]) => {
        if (cancelled) return;
        setItems(result);
        setBuckets(budget?.summary.buckets ?? []);
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

  const openNew = () =>
    setDialog({ open: true, driver: null, duplicate: false });
  const openEdit = (item: KpiDriverWithSeries) =>
    setDialog({ open: true, driver: item.driver, duplicate: false });
  const openDuplicate = (item: KpiDriverWithSeries) =>
    setDialog({ open: true, driver: item.driver, duplicate: true });
  const closeDialog = () => setDialog((d) => ({ ...d, open: false }));

  const handleSave = useCallback(
    async (input: KpiDriverInput) => {
      if (!ou) return;
      setSaving(true);
      try {
        const result = await saveKpiDriver(ou, input, userEmail);
        setItems(result);
        setDialog({ open: false, driver: null, duplicate: false });
        setToast({ severity: "success", message: "KPI driver saved." });
      } catch (error) {
        setToast({ severity: "error", message: (error as Error).message });
      } finally {
        setSaving(false);
      }
    },
    [ou, userEmail]
  );

  const handleDelete = useCallback(
    async (item: KpiDriverWithSeries) => {
      if (!ou) return;
      if (!window.confirm(`Delete KPI driver "${item.driver.label}"?`)) return;
      setBusy(true);
      try {
        const result = await deleteKpiDriver(ou, item.driver.id as KpiDriverId);
        setItems(result);
        setToast({ severity: "success", message: "KPI driver deleted." });
      } catch (error) {
        setToast({ severity: "error", message: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [ou]
  );

  const recalc = useCallback(
    async (driverId?: KpiDriverId) => {
      if (!ou) return;
      setBusy(true);
      try {
        const result = await recalcKpiDrivers(ou, driverId);
        setItems(result);
        setToast({ severity: "success", message: "Recalculated from budget." });
      } catch (error) {
        setToast({ severity: "error", message: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [ou]
  );

  const q = search.trim().toLowerCase();
  const { builtins, userDrivers, total } = useMemo(() => {
    const filtered = items.filter((it) => matchesQuery(it, q));
    return {
      builtins: filtered.filter((it) => it.driver.isBuiltin),
      userDrivers: filtered.filter((it) => !it.driver.isBuiltin),
      total: filtered.length,
    };
  }, [items, q]);

  const renderCard = (item: KpiDriverWithSeries) => (
    <KpiDriverCard
      key={item.driver.id}
      item={item}
      expanded={expandedId === item.driver.id}
      onToggle={() =>
        setExpandedId((cur) =>
          cur === item.driver.id ? null : item.driver.id
        )
      }
      buckets={buckets}
      busy={busy}
      onEdit={openEdit}
      onDuplicate={openDuplicate}
      onDelete={handleDelete}
      onRecalc={(it) => recalc(it.driver.id as KpiDriverId)}
    />
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openNew}
          disabled={!ou}
        >
          New driver
        </Button>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={() => recalc(undefined)}
          disabled={!ou || busy}
        >
          Recalculate all
        </Button>
        <TextField
          size="small"
          placeholder="Search drivers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={!ou}
          sx={{ minWidth: 240 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setSearch("")}>
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
        {(loading || busy) && <CircularProgress size={20} />}
      </Stack>

      {!ou && (
        <Alert severity="info">
          Select a hotel (top bar) to define and view its KPI drivers.
        </Alert>
      )}

      {ou && builtins.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography variant="overline" color="text.secondary">
            Built-in
          </Typography>
          {builtins.map(renderCard)}
        </Box>
      )}

      {ou && userDrivers.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography variant="overline" color="text.secondary">
            Your drivers
          </Typography>
          {userDrivers.map(renderCard)}
        </Box>
      )}

      {ou && !loading && items.length === 0 && (
        <Alert severity="info">No KPI drivers yet. Add one to get started.</Alert>
      )}

      {ou && !loading && items.length > 0 && total === 0 && (
        <Alert severity="info">No drivers match “{search.trim()}”.</Alert>
      )}

      <KpiDriverDialog
        open={dialog.open}
        driver={dialog.driver}
        duplicate={dialog.duplicate}
        buckets={buckets}
        saving={saving}
        onClose={closeDialog}
        onSave={handleSave}
      />

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

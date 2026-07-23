/**
 * Budget Pull page.
 * -----------------------------------------------------------
 * Pull a hotel's Excel "BGT Spread File" straight into the local store and show
 * the data. One action: pick → parse + OU-gate + persist (overwrite) in main,
 * then render every row in a scrollable grid. A pull replaces the hotel's
 * previous data, so there is one current import per hotel; its who/when
 * metadata sits above the grid. Stored reference data only — nothing here feeds
 * the payroll engine (KPIs come later).
 */

import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import Chip from "@mui/material/Chip";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import { useSelectedHotel } from "../../store/settings";
import { ImportRowsResult } from "../../shared/budgetImport/ipc";
import {
  getCurrentBudgetImport,
  pullBudgetFile,
} from "../../services/budgetImportService";
import { bucketLabel } from "../../components/budgetSync/columns";
import BudgetValuesGrid from "../../components/budgetSync/BudgetValuesGrid";

type Toast = { severity: "success" | "error" | "info"; message: string } | null;

export default function BudgetSync() {
  const ou = useSelectedHotel();

  const [pulling, setPulling] = useState(false);
  const [current, setCurrent] = useState<ImportRowsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Who is importing — recorded with each pull.
  useEffect(() => {
    (window as any)?.authApi
      ?.getStatus?.()
      .then((s: { lastUserEmail?: string | null }) =>
        setUserEmail(s?.lastUserEmail ?? null)
      )
      .catch(() => setUserEmail(null));
  }, []);

  // Load the hotel's current import whenever the selection changes.
  useEffect(() => {
    if (!ou) {
      setCurrent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getCurrentBudgetImport(ou)
      .then((result) => {
        if (!cancelled) setCurrent(result);
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

  const handlePull = useCallback(async () => {
    if (!ou) return;
    setPulling(true);
    try {
      const result = await pullBudgetFile(ou, userEmail);
      switch (result.outcome) {
        case "cancelled":
          break;
        case "no_data":
          setToast({
            severity: "error",
            message: `No budget rows found in "${result.sourceFileName}".`,
          });
          break;
        case "ou_mismatch":
          setToast({
            severity: "error",
            message: `"${result.sourceFileName}" is for OU ${result.fileOu}, but the selected hotel is ${result.selectedOu}.`,
          });
          break;
        case "ok":
          setCurrent(result.result);
          setToast({
            severity: "success",
            message: `Imported ${result.result.summary.rowCount.toLocaleString()} rows.`,
          });
          break;
      }
    } catch (error) {
      setToast({ severity: "error", message: (error as Error).message });
    } finally {
      setPulling(false);
    }
  }, [ou, userEmail]);

  const summary = current?.summary;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Button
          variant="contained"
          startIcon={<FileDownloadIcon />}
          onClick={handlePull}
          disabled={!ou || pulling}
        >
          {pulling ? "Importing…" : "Pull from Excel"}
        </Button>
      </Stack>

      {!ou && (
        <Alert severity="info">
          Select a hotel (top bar) to pull and view its budget data.
        </Alert>
      )}

      {ou && summary && (
        <Paper
          variant="outlined"
          sx={{ p: 2, display: "flex", flexDirection: "column" }}
        >
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: "center", flexWrap: "wrap", mb: 1.5 }}
          >
            <Typography variant="subtitle1" sx={{ mr: 1 }}>
              {summary.sourceFileName}
            </Typography>
            {summary.buckets.map((b) => (
              <Chip key={b.index} size="small" label={bucketLabel(b)} />
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Imported {new Date(summary.importedAt).toLocaleString()}
            {summary.importedBy ? ` by ${summary.importedBy}` : ""} ·{" "}
            {summary.rowCount.toLocaleString()} rows
          </Typography>
          <Box sx={{ height: "calc(100vh - 240px)", minHeight: 360, mt: 1.5 }}>
            <BudgetValuesGrid
              rows={current.rows}
              buckets={summary.buckets}
              loading={loading}
              showToolbar
            />
          </Box>
        </Paper>
      )}

      {ou && !summary && !loading && (
        <Alert severity="info">
          No budget data yet for this hotel. Use <strong>Pull from Excel</strong>{" "}
          to import a budget file.
        </Alert>
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

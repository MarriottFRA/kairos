/**
 * Budget Pull page.
 * -----------------------------------------------------------
 * Pull a hotel's Excel "BGT Spread File" straight into the local store and show
 * the data. One action: pick → parse + OU-gate + persist (overwrite) in main,
 * then render every row in a scrollable grid. A pull replaces the hotel's
 * previous data, so there is one current import per hotel; its who/when
 * metadata sits above the grid. Stored reference data only — nothing here feeds
 * the payroll engine (KPIs come later).
 *
 * The file is remembered between pulls, so the routine re-import is one click
 * on a button that names the workbook, with the picker beside it for anything
 * else. That is a shortcut to the file DIALOG only — a remembered path is
 * parsed and OU-gated on every pull, exactly like one chosen by hand, and it is
 * only ever remembered once it has cleared that gate.
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
import Tooltip from "@mui/material/Tooltip";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { useSelectedHotel } from "../../store/settings";
import {
  ImportRowsResult,
  RecentBudgetFile,
} from "../../shared/budgetImport/ipc";
import {
  getCurrentBudgetImport,
  getRecentBudgetFile,
  pullBudgetFile,
} from "../../services/budgetImportService";
import { bucketLabel } from "../../components/budgetSync/columns";
import BudgetValuesGrid from "../../components/budgetSync/BudgetValuesGrid";

type Toast = { severity: "success" | "error" | "info"; message: string } | null;

/** Keep a long workbook name from stretching the button off the row. The
 *  tooltip carries the full path, so nothing is lost by shortening it here. */
function shortName(fileName: string): string {
  return fileName.length > 38 ? `${fileName.slice(0, 37)}…` : fileName;
}

export default function BudgetSync() {
  const ou = useSelectedHotel();

  const [pulling, setPulling] = useState(false);
  const [current, setCurrent] = useState<ImportRowsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  // The workbook this hotel was last pulled from, when it is still on disk.
  const [recent, setRecent] = useState<RecentBudgetFile | null>(null);

  // Who is importing — recorded with each pull.
  useEffect(() => {
    (window as any)?.authApi
      ?.getStatus?.()
      .then((s: { lastUserEmail?: string | null }) =>
        setUserEmail(s?.lastUserEmail ?? null)
      )
      .catch(() => setUserEmail(null));
  }, []);

  // The remembered file, refreshed with the hotel. Main prunes paths that no
  // longer resolve, so a null here means there is genuinely nothing to offer.
  useEffect(() => {
    if (!ou) {
      setRecent(null);
      return;
    }
    let cancelled = false;
    getRecentBudgetFile(ou)
      .then((file) => {
        if (!cancelled) setRecent(file);
      })
      .catch(() => {
        // A shortcut that cannot be read is simply not offered.
        if (!cancelled) setRecent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ou]);

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

  /**
   * Pull a workbook into the store.
   *
   * With no path main shows the file dialog; with one it parses that file
   * directly — the same call, the same OU gate, so the remembered shortcut can
   * never import something the picker would have refused.
   */
  const handlePull = useCallback(
    async (filePath?: string) => {
      if (!ou) return;
      setPulling(true);
      try {
        const result = await pullBudgetFile(ou, userEmail, filePath);
        switch (result.outcome) {
          case "cancelled":
            break;
          case "file_missing":
            setToast({
              severity: "error",
              message:
                `"${result.sourceFileName}" is no longer at ${result.filePath}. ` +
                `Choose the file again and Kairos will remember where it moved to.`,
            });
            setRecent(null);
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
            // Main has just recorded (or replaced) the remembered path, so read
            // it back rather than leaving the button naming the previous file.
            void getRecentBudgetFile(ou)
              .then(setRecent)
              .catch((error) =>
                console.error("Failed to refresh the remembered file:", error)
              );
            break;
        }
      } catch (error) {
        setToast({ severity: "error", message: (error as Error).message });
      } finally {
        setPulling(false);
      }
    },
    [ou, userEmail]
  );

  const summary = current?.summary;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* The known file first, the picker beside it — the routine re-import is
          one click, and choosing a different workbook stays one click away. */}
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        {recent && (
          <Tooltip title={recent.filePath}>
            <span>
              <Button
                variant="contained"
                startIcon={<FileDownloadIcon />}
                onClick={() => void handlePull(recent.filePath)}
                disabled={!ou || pulling}
              >
                {pulling ? "Importing…" : `Pull ${shortName(recent.fileName)}`}
              </Button>
            </span>
          </Tooltip>
        )}
        <Button
          variant={recent ? "outlined" : "contained"}
          startIcon={recent ? <FolderOpenIcon /> : <FileDownloadIcon />}
          onClick={() => void handlePull()}
          disabled={!ou || pulling}
        >
          {recent
            ? "Choose a different file…"
            : pulling
              ? "Importing…"
              : "Pull from Excel"}
        </Button>
        {recent && (
          <Typography variant="caption" color="text.secondary">
            Replaces this hotel&apos;s imported budget data.
          </Typography>
        )}
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

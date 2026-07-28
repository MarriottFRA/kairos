/**
 * StorageCleanupCard — the Settings entry point for purging soft-deleted rows.
 *
 * Deleting anything in Kairos only stamps the row (that is what undo, "Recently
 * removed" columns and block restore read back), so deleted data lingers for the
 * life of the install. This card scans both stores, shows exactly what is still
 * being kept, and — behind a confirmation — removes it for good.
 *
 * The scan is an exact preview: main runs the real purge inside a rolled-back
 * transaction, so the counts here are what will actually go. Self-contained —
 * the whole feature is this card plus main/maintenance.
 */

import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CleaningServicesIcon from "@mui/icons-material/CleaningServices";
import RefreshIcon from "@mui/icons-material/Refresh";

import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";

import {
  AUTO_CLEANUP_CHOICES,
  CLEANUP_GROUPS,
  CleanupScanResponse,
  CleanupTally,
} from "../../shared/maintenance/ipc";
import {
  purgeDeletedData,
  scanDeletedData,
  setAutoCleanupRetention,
} from "../../services/maintenanceService";

/** Bytes as a short human figure — the numbers here span KB to hundreds of MB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Label for a retention window; 0 is the off switch. */
function retentionLabel(days: number): string {
  return days === 0 ? "Never — keep until I clean up" : `After ${days} days`;
}

/** The non-zero categories, in the shared display order. */
function nonZeroGroups(tally: CleanupTally) {
  return CLEANUP_GROUPS.filter((group) => (tally[group.key] || 0) > 0);
}

function TallyChips({ tally }: { tally: CleanupTally }) {
  const groups = nonZeroGroups(tally);
  if (groups.length === 0) return null;
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      {groups.map((group) => (
        <Chip
          key={group.key}
          size="small"
          label={`${tally[group.key].toLocaleString()} ${group.label.toLowerCase()}`}
        />
      ))}
    </Stack>
  );
}

export default function StorageCleanupCard() {
  const [scan, setScan] = useState<CleanupScanResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [message, setMessage] = useState<{
    severity: "info" | "success" | "warning" | "error";
    text: string;
  } | null>(null);

  const loadScan = async () => {
    setScanning(true);
    try {
      setScan(await scanDeletedData());
    } catch (error) {
      console.error("Failed to scan for deleted data:", error);
      setMessage({
        severity: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not check for deleted data.",
      });
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    void loadScan();
  }, []);

  const handleRetentionChange = async (days: number) => {
    // Optimistic: the select is the only writer, and a failed save re-reads.
    setScan((current) =>
      current
        ? { ...current, autoCleanup: { ...current.autoCleanup, retentionDays: days } }
        : current
    );
    try {
      await setAutoCleanupRetention(days);
      await loadScan();
    } catch (error) {
      console.error("Failed to save the cleanup schedule:", error);
      setMessage({
        severity: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not save the cleanup schedule.",
      });
      await loadScan();
    }
  };

  const handlePurge = async () => {
    setPurging(true);
    setMessage(null);
    try {
      const result = await purgeDeletedData();
      setConfirmOpen(false);
      setMessage({
        severity: "success",
        text:
          `Removed ${result.total.toLocaleString()} deleted row` +
          `${result.total === 1 ? "" : "s"}` +
          (result.bytesReclaimed > 0
            ? `, freeing ${formatBytes(result.bytesReclaimed)}.`
            : "."),
      });
      await loadScan();
    } catch (error) {
      console.error("Failed to clean up deleted data:", error);
      setConfirmOpen(false);
      setMessage({
        severity: "error",
        text:
          error instanceof Error ? error.message : "The cleanup failed.",
      });
    } finally {
      setPurging(false);
    }
  };

  const total = scan?.total ?? 0;
  const groups = scan ? nonZeroGroups(scan.tally) : [];

  return (
    <>
      <Card
        variant="outlined"
        sx={{ mt: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}
      >
        <CardContent>
          <Stack
            direction="row"
            sx={{ justifyContent: "space-between", alignItems: "center", mb: 2 }}
          >
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Storage Cleanup
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                startIcon={
                  scanning ? <CircularProgress size={16} /> : <RefreshIcon />
                }
                onClick={loadScan}
                disabled={scanning || purging}
                sx={{ borderRadius: 1, textTransform: "none", px: 2 }}
              >
                {scanning ? "Checking…" : "Re-check"}
              </Button>
              <Button
                variant="outlined"
                color="warning"
                size="small"
                startIcon={<CleaningServicesIcon />}
                onClick={() => {
                  setMessage(null);
                  setConfirmOpen(true);
                }}
                disabled={scanning || purging || total === 0}
                sx={{ borderRadius: 1, textTransform: "none", px: 2 }}
              >
                Clean up…
              </Button>
            </Stack>
          </Stack>
          <Divider sx={{ mb: 2 }} />

          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            Deleting a position, plan, block or column marks the row rather than
            erasing it, so it can be undone or restored. Those rows are swept
            once they pass the retention window below; the button clears the bin
            now instead — everything in it, for every hotel in this install —
            and hands the disk space back.
          </Typography>

          {scan && !scan.secureAvailable && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              The encrypted store is locked, so deleted data cannot be counted or
              cleaned up. Sign in and try again.
            </Alert>
          )}

          {message && (
            <Alert severity={message.severity} sx={{ mb: 2 }}>
              {message.text}
            </Alert>
          )}

          {scan?.secureAvailable && total === 0 && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              Nothing to clean up — no deleted rows are being kept.
            </Typography>
          )}

          {total > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                {total.toLocaleString()} deleted row{total === 1 ? "" : "s"} kept
                across {groups.length} categor{groups.length === 1 ? "y" : "ies"}
              </Typography>
              <TallyChips tally={scan!.tally} />
            </>
          )}

          <Divider sx={{ my: 2 }} />

          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            sx={{ alignItems: { sm: "center" } }}
          >
            <FormControl size="small" sx={{ minWidth: 240 }}>
              <InputLabel id="cleanup-retention-label">
                Delete items in the bin
              </InputLabel>
              <Select
                labelId="cleanup-retention-label"
                label="Delete items in the bin"
                value={scan?.autoCleanup.retentionDays ?? ""}
                disabled={!scan || purging}
                onChange={(event) =>
                  void handleRetentionChange(Number(event.target.value))
                }
              >
                {AUTO_CLEANUP_CHOICES.map((days) => (
                  <MenuItem key={days} value={days}>
                    {retentionLabel(days)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {scan?.autoCleanup.retentionDays
                ? `Runs by itself once a day, and only takes items deleted more than ${scan.autoCleanup.retentionDays} days ago — anything newer stays undoable.`
                : "Nothing is removed automatically; deleted items build up until you clean up here."}
            </Typography>
          </Stack>

          {scan && scan.autoEligible > 0 && (
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", mt: 1, display: "block" }}
            >
              {scan.autoEligible.toLocaleString()} of these are already past the
              window and will go on the next automatic run.
            </Typography>
          )}

          {scan && (
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", mt: 1, display: "block" }}
            >
              Databases currently use {formatBytes(scan.databaseBytes)}
              {scan.autoCleanup.lastRunAt
                ? ` · last automatic cleanup ${new Date(
                    scan.autoCleanup.lastRunAt
                  ).toLocaleString()} (${scan.autoCleanup.lastRunRemoved.toLocaleString()} removed)`
                : " · no automatic cleanup has run yet"}
              .
            </Typography>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={confirmOpen}
        onClose={() => {
          if (!purging) setConfirmOpen(false);
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Clean up deleted data?</DialogTitle>
        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            This permanently removes {total.toLocaleString()} deleted row
            {total === 1 ? "" : "s"} from every hotel in this install. Anything
            still in the bin — recently deleted positions, plans, blocks and
            columns — can no longer be undone or restored afterwards. Live data
            is untouched.
          </DialogContentText>
          {scan && <TallyChips tally={scan.tally} />}
          {scan && scan.tally.scenarios > 0 && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Deleted plans still hold their positions. Cleaning up removes those
              positions and their values too.
            </Alert>
          )}
          <Box sx={{ mt: 2 }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              The databases are compacted afterwards, so this may take a moment.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setConfirmOpen(false)}
            disabled={purging}
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={handlePurge}
            disabled={purging}
            startIcon={
              purging ? <CircularProgress size={16} color="inherit" /> : undefined
            }
            sx={{ textTransform: "none" }}
          >
            {purging ? "Cleaning up…" : "Delete permanently"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

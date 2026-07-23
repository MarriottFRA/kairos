/**
 * CopyScenarioDialog — the roll-forward: bring last year's positions into this
 * one instead of retyping them.
 *
 * Positions are stored per scenario and a scenario belongs to one year, so a
 * new budget year starts empty. This dialog picks a source scenario (any year,
 * newest first) and snapshot-copies it into the currently selected one: fresh
 * position ids, the same lineage_id, fully independent values. Inactive
 * positions come across too — retaining them across years is what the flag is
 * for.
 *
 * The target must be empty; the backend rejects a merge and the reason is
 * shown here rather than swallowed.
 */

import { useMemo, useState } from "react";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  TextField,
} from "@mui/material";
import { ScenarioDto } from "../../shared/positions/ipc";
import { cloneScenario } from "../../services/scenarioService";

export interface CopyScenarioDialogProps {
  open: boolean;
  ou: string | null;
  /** All scenarios for this hotel, across every year. */
  scenarios: ScenarioDto[];
  /** The scenario being copied INTO — the current selection. */
  targetScenarioId: string;
  targetYear: number;
  targetLabel: string;
  onClose: () => void;
  /** Copy landed — the page reloads its rows. */
  onCopied: (positions: number) => void;
}

export default function CopyScenarioDialog({
  open,
  ou,
  scenarios,
  targetScenarioId,
  targetYear,
  targetLabel,
  onClose,
  onCopied,
}: CopyScenarioDialogProps) {
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Newest first: the previous year is nearly always what you want, and it is
  // the entry directly under the current one.
  const sources = useMemo(
    () =>
      scenarios
        .filter((scenario) => scenario.id !== targetScenarioId)
        .sort((a, b) => b.year - a.year || a.label.localeCompare(b.label)),
    [scenarios, targetScenarioId]
  );

  const handleCopy = async () => {
    if (!ou || !sourceId || !targetScenarioId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cloneScenario(ou, sourceId, targetScenarioId);
      onCopied(result.positions);
      setSourceId("");
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to copy the scenario"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Copy positions into {targetLabel}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Every position is copied into {targetYear} — {targetLabel}, including
          ones marked inactive. The copies are independent: editing them will not
          change the year you copied from.
        </DialogContentText>

        <TextField
          select
          fullWidth
          size="small"
          label="Copy from"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          disabled={busy || sources.length === 0}
          helperText={
            sources.length === 0
              ? "There is no other scenario to copy from yet."
              : undefined
          }
        >
          {sources.map((scenario) => (
            <MenuItem key={scenario.id} value={scenario.id}>
              {scenario.year} — {scenario.label}
            </MenuItem>
          ))}
        </TextField>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          startIcon={<ContentCopyIcon />}
          onClick={() => void handleCopy()}
          disabled={busy || !sourceId}
        >
          Copy positions
        </Button>
      </DialogActions>
    </Dialog>
  );
}

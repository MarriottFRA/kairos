/**
 * CopyScenarioDialog — fill an empty scenario from another one instead of
 * retyping it.
 *
 * Two situations, one operation. A new budget year starts empty, so last year's
 * scenario is the source; a what-if wants to start from the plan it varies, so
 * this year's other scenario is the source. Positions are stored per scenario
 * and the year lives on the scenario, so both are just "copy scenario A into
 * scenario B" — the source list spans every year and is grouped by year so a
 * same-year sibling reads as a sibling rather than as a year.
 *
 * The copy is a snapshot: fresh position ids, the same lineage_id, fully
 * independent values. Inactive positions come across too — retaining them is
 * what the flag is for.
 *
 * The target must be empty; the backend rejects a merge and the reason is
 * shown here rather than swallowed. Creating a scenario that is already seeded
 * this way lives on the Manage scenarios dialog's "Start from" field.
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
  TextField,
} from "@mui/material";
import { ScenarioDto } from "../../shared/positions/ipc";
import { cloneScenario } from "../../services/scenarioService";
import {
  hasScenarioSources,
  renderScenarioSourceValue,
  scenarioSourceItems,
} from "./scenarioSourceOptions";

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

  // Grouped by year, newest first: the previous year is nearly always what you
  // want and sits directly under the current one, while this year's other
  // scenarios are visibly available for a what-if.
  const sourceItems = useMemo(
    () =>
      scenarioSourceItems(scenarios, {
        excludeId: targetScenarioId,
        currentYear: targetYear,
      }),
    [scenarios, targetScenarioId, targetYear]
  );
  const anySources = hasScenarioSources(scenarios, targetScenarioId);

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
          change the year or scenario you copied from.
        </DialogContentText>

        <TextField
          select
          fullWidth
          size="small"
          label="Copy from"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          disabled={busy || !anySources}
          slotProps={{
            // Shrunk because displayEmpty means the field always shows text.
            inputLabel: { shrink: true },
            select: {
              displayEmpty: true,
              renderValue: renderScenarioSourceValue(
                scenarios,
                "Choose a year or scenario"
              ),
            },
          }}
          helperText={
            anySources
              ? undefined
              : "There is no other year or scenario to copy from yet."
          }
        >
          {sourceItems}
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

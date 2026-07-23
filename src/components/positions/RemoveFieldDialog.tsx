/**
 * RemoveFieldDialog — confirm removing a user-added column that holds data.
 * -----------------------------------------------------------
 * Only shown for data-bearing columns: an empty column is removed straight
 * away (with an undo snackbar), no dialog. The count is scoped to the loaded
 * scenario — the copy says so — because the removal is reversible and the
 * cross-scenario tail is handled by the purge sweep, not this prompt.
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";

export interface RemoveFieldDialogProps {
  open: boolean;
  label: string;
  /** Positions in the current scenario that hold a value for this column. */
  valueCount: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function RemoveFieldDialog({
  open,
  label,
  valueCount,
  busy,
  onCancel,
  onConfirm,
}: RemoveFieldDialogProps) {
  const positions = valueCount === 1 ? "position" : "positions";

  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Remove “{label}”?</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: "0.875rem" }}>
          {valueCount} {positions} in this scenario {valueCount === 1 ? "has" : "have"}{" "}
          data in this column. Removing it hides the column and the engine stops
          using it. You can restore it from <strong>Manage columns</strong> until
          it is cleaned up.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button color="error" variant="contained" onClick={onConfirm} disabled={busy}>
          Remove column
        </Button>
      </DialogActions>
    </Dialog>
  );
}

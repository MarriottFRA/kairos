/**
 * ManageColumnsDialog — the durable undo for removed columns.
 * -----------------------------------------------------------
 * The delete snackbar is the quick undo; this is the one that outlives it.
 * Every soft-deleted user column stays here — restorable in full, data and
 * all — until it is cleaned up: empty columns go on the next load, columns
 * that still hold data are kept for a grace window (see sweepRemovedFields).
 * Purge is the escape hatch for "gone now, on purpose", behind a per-row
 * confirm because it cannot be undone.
 */

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import RestoreIcon from "@mui/icons-material/Restore";
import { RemovedFieldDto } from "../../shared/positions/ipc";

export interface ManageColumnsDialogProps {
  open: boolean;
  loading: boolean;
  removed: RemovedFieldDto[];
  /** The key currently being restored/purged, so its row shows a spinner. */
  busyKey: string | null;
  onRestore: (key: string) => void;
  onPurge: (key: string) => void;
  onClose: () => void;
}

/** "just now" / "3 days ago" — enough to gauge how long it has left. */
function removedAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "removed";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "removed just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `removed ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `removed ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `removed ${days} day${days === 1 ? "" : "s"} ago`;
}

function usageChip(count: number | null) {
  if (count === null) return <Chip size="small" label="usage unknown" variant="outlined" />;
  if (count === 0) return <Chip size="small" color="success" label="empty" variant="outlined" />;
  return (
    <Chip
      size="small"
      color="warning"
      variant="outlined"
      label={`${count} value${count === 1 ? "" : "s"}`}
    />
  );
}

export default function ManageColumnsDialog({
  open,
  loading,
  removed,
  busyKey,
  onRestore,
  onPurge,
  onClose,
}: ManageColumnsDialogProps) {
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);

  // Reset the inline purge confirmation whenever the dialog reopens or the
  // list changes out from under it.
  useEffect(() => {
    if (!open) setConfirmingKey(null);
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Removed columns</DialogTitle>
      <DialogContent dividers>
        <DialogContentText sx={{ mb: 1.5, fontSize: "0.8125rem" }}>
          Restore a column to bring it back with its data. Empty columns are
          cleaned up automatically; columns that still hold data are kept for 30
          days, then purged.
        </DialogContentText>

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : removed.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: "center" }}>
            No removed columns.
          </Typography>
        ) : (
          <List dense disablePadding>
            {removed.map((field) => {
              const rowBusy = busyKey === field.key;
              const confirming = confirmingKey === field.key;
              return (
                <ListItem
                  key={field.key}
                  divider
                  secondaryAction={
                    confirming ? (
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <Typography variant="caption" color="error">
                          Delete forever?
                        </Typography>
                        <Button
                          size="small"
                          color="error"
                          variant="contained"
                          disabled={rowBusy}
                          onClick={() => onPurge(field.key)}
                        >
                          Yes
                        </Button>
                        <Button
                          size="small"
                          color="inherit"
                          disabled={rowBusy}
                          onClick={() => setConfirmingKey(null)}
                        >
                          No
                        </Button>
                      </Box>
                    ) : (
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <Button
                          size="small"
                          startIcon={
                            rowBusy ? <CircularProgress size={14} /> : <RestoreIcon fontSize="small" />
                          }
                          disabled={rowBusy}
                          onClick={() => onRestore(field.key)}
                        >
                          Restore
                        </Button>
                        <Tooltip title="Delete permanently">
                          <span>
                            <IconButton
                              size="small"
                              edge="end"
                              disabled={rowBusy}
                              onClick={() => setConfirmingKey(field.key)}
                            >
                              <DeleteForeverIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Box>
                    )
                  }
                >
                  <ListItemText
                    primary={
                      <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <span>{field.label}</span>
                        {usageChip(field.valueCount)}
                      </Box>
                    }
                    secondary={removedAgo(field.deletedAt)}
                  />
                </ListItem>
              );
            })}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

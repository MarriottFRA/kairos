/**
 * DeleteClusterPositionDialog — a cluster position exists once per member
 * hotel, and deleting one copy deletes them all (the copies are one person, not
 * three records). Deleting from the grid therefore has to say which hotels it
 * reaches before it happens: the same reasoning as DeleteClusterDialog, at row
 * scale. Ordinary standalone rows never see this — they delete straight away
 * with the usual Undo snackbar.
 *
 * A bulk delete routes through here whenever *any* row in the selection is
 * clustered: the standalone rows in the same batch go along with the confirm
 * rather than deleting behind it, so one Undo covers the whole action.
 */

import { useRef } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import { PositionRow } from "../../shared/positions/rowModel";

export interface PendingPositionDelete {
  /** Rows whose deletion mirrors out to every member hotel. Never empty. */
  clustered: PositionRow[];
  /** Rows in the same batch that only affect this hotel. */
  standalone: PositionRow[];
}

export interface DeleteClusterPositionDialogProps {
  /** The batch awaiting confirmation, or null when closed. */
  pending: PendingPositionDelete | null;
  /** Resolves a row's cluster — names the hotels that lose a row. */
  clusterOf: (row: PositionRow) => HotelClusterDto | null;
  /** OU -> hotel name; falls back to the raw OU when unavailable. */
  hotelNames?: ReadonlyMap<string, string>;
  onCancel: () => void;
  onConfirm: () => void;
}

function rowTitle(row: PositionRow): string {
  return (typeof row.title === "string" && row.title) || "this position";
}

export default function DeleteClusterPositionDialog({
  pending,
  clusterOf,
  hotelNames,
  onCancel,
  onConfirm,
}: DeleteClusterPositionDialogProps) {
  // Retained through MUI's exit transition so the dialog never flashes an
  // empty blast radius on its way out (the DeleteClusterDialog pattern).
  const last = useRef<PendingPositionDelete | null>(null);
  if (pending) last.current = pending;
  const shown = pending ?? last.current;

  const clustered = shown?.clustered ?? [];
  const standaloneCount = shown?.standalone.length ?? 0;

  // One row may sit in a cluster the next one doesn't, so the blast radius is
  // the union of every affected cluster's members.
  const hotels = [
    ...new Set(
      clustered.flatMap((row) =>
        (clusterOf(row)?.members ?? []).map(
          (member) => hotelNames?.get(member.ou) ?? member.ou
        )
      )
    ),
  ];

  const single = clustered.length === 1 && standaloneCount === 0;

  const title = single
    ? `Delete “${rowTitle(clustered[0])}” from every hotel?`
    : `Delete ${clustered.length + standaloneCount} positions?`;

  const sharedImpact = single
    ? hotels.length > 1
      ? `It is shared across ${hotels.length} hotels — ${hotels.join(", ")} — and ` +
        "deleting it here removes every hotel's copy, along with their costs. " +
        "Undo restores all of them."
      : "Deleting it removes every hotel's copy of this cluster position. " +
        "Undo restores all of them."
    : `${clustered.length} of them ${
        clustered.length === 1 ? "is" : "are"
      } shared across hotels${
        hotels.length > 1 ? ` — ${hotels.join(", ")}` : ""
      }, so deleting here removes every hotel's copy along with their costs.`;

  return (
    <Dialog open={!!pending} onClose={onCancel} maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{sharedImpact}</DialogContentText>
        {standaloneCount > 0 && (
          <DialogContentText sx={{ mt: 1.5 }}>
            The other {standaloneCount} affect{standaloneCount === 1 ? "s" : ""}{" "}
            this hotel only. One Undo restores the whole batch.
          </DialogContentText>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="contained"
          color="error"
          disableElevation
          onClick={onConfirm}
        >
          {single ? "Delete everywhere" : "Delete all"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

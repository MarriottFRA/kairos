/**
 * DeleteClusterDialog — deleting a cluster silently changes numbers on every
 * assigned row (they revert to multiplier ×1), so unlike KPI drivers this is
 * a real dialog, not window.confirm: it states the blast radius (how many
 * positions across how many hotels get cleared) before the user commits.
 */

import { useRef } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import {
  ClusterPositionRefDto,
  HotelClusterDto,
} from "../../shared/hotelClusters/ipc";

export interface DeleteClusterDialogProps {
  /** The cluster pending deletion, or null when closed. */
  cluster: HotelClusterDto | null;
  /** Its assigned positions; null = never loaded (locked store). */
  assignments: ClusterPositionRefDto[] | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (cluster: HotelClusterDto) => void;
}

export default function DeleteClusterDialog({
  cluster,
  assignments,
  busy,
  onCancel,
  onConfirm,
}: DeleteClusterDialogProps) {
  // The parent nulls `cluster` to close, but MUI keeps rendering through the
  // exit transition — retain the last real content so the dialog never
  // flashes 'Delete cluster ""?' on its way out.
  const last = useRef<{
    cluster: HotelClusterDto;
    assignments: ClusterPositionRefDto[] | null;
  } | null>(null);
  if (cluster) last.current = { cluster, assignments };
  const shown = cluster ? { cluster, assignments } : last.current;

  const count = shown?.assignments?.length ?? null;
  const hotels = new Set((shown?.assignments ?? []).map((position) => position.ou))
    .size;

  let impact: string;
  if (count === null) {
    impact =
      "Positions assigned to it (if any) will revert to no cluster — " +
      "multiplier ×1 — and their hours and costs will rise accordingly.";
  } else if (count === 0) {
    impact = "No positions are assigned to it.";
  } else {
    impact =
      `${count} position${count === 1 ? "" : "s"} across ` +
      `${hotels} hotel${hotels === 1 ? "" : "s"} ` +
      `${count === 1 ? "is" : "are"} assigned to it. ` +
      `${count === 1 ? "It" : "They"} will revert to no cluster — ` +
      "multiplier ×1 — and their hours and costs will rise accordingly.";
  }

  return (
    <Dialog open={!!cluster} onClose={busy ? undefined : onCancel} maxWidth="xs">
      <DialogTitle>Delete cluster “{shown?.cluster.name}”?</DialogTitle>
      <DialogContent>
        <DialogContentText>{impact}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disableElevation
          onClick={() => cluster && onConfirm(cluster)}
          disabled={busy}
        >
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

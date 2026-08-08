/**
 * Delete a plan from the server.
 *
 * -----------------------------------------------------------
 * One dialog, three situations, because "delete" means something different in
 * each and a single wording would be wrong in two of them. What decides it is
 * the only question the user actually cares about: **what is left on my
 * computer afterwards?**
 *
 * - `keeps` — the plan is on this computer as well. Nothing local changes; the
 *   only loss is everybody else's ability to reach it.
 * - `twin` — this is a cloud-only plan and a DIFFERENT plan of the same name
 *   sits on this computer. Deleting frees the name, which is usually the whole
 *   reason somebody is here: it is the route to publishing their own copy.
 * - `none` — cloud-only and nothing local. This is the one case where deleting
 *   genuinely loses the user their access to the data, so it is the one case
 *   that asks them to type the plan's name.
 *
 * The friction is deliberately proportional to the risk rather than uniform. A
 * typed confirmation on all three would train people to type through it, which
 * is exactly what you do not want by the time they reach the third.
 *
 * ## What is NOT claimed
 *
 * That the plan can be re-published afterwards. `DELETE /plans/{id}` is a soft
 * delete and the rows survive server-side, but whether the same id can be
 * registered again is the server's business and this dialog does not promise
 * it. "Support can restore it" is the accurate version and is what it says.
 */

import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";

/** What this computer still holds once the server's copy is gone. */
export type LocalCopyAfterDelete =
  /** The same plan is on this computer and keeps working. */
  | "keeps"
  /** A different plan of the same name is here; the name becomes free. */
  | "twin"
  /** Nothing. Deleting removes the user's only route to this plan. */
  | "none";

export interface DeletePlanDialogProps {
  open: boolean;
  busy: boolean;
  planLabel: string;
  localCopy: LocalCopyAfterDelete;
  /** The local plan of the same name, for the `twin` case. */
  twinLabel?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export default function DeletePlanDialog({
  open,
  busy,
  planLabel,
  localCopy,
  twinLabel,
  onConfirm,
  onClose,
}: DeletePlanDialogProps) {
  const [typed, setTyped] = useState("");

  // Cleared on every open so a previous confirmation cannot arm the next one.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const mustType = localCopy === "none";
  const armed =
    !mustType || typed.trim().toLowerCase() === planLabel.trim().toLowerCase();

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delete “{planLabel}” from the server?</DialogTitle>
      <DialogContent dividers>
        {localCopy === "keeps" && (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>
              <AlertTitle>Your copy on this computer is not affected</AlertTitle>
              It stays exactly as it is — open it, edit it and work on it from the
              Positions page as normal. Only the server&rsquo;s copy goes.
            </Alert>
            <DialogContentText sx={{ mb: 2 }}>
              What stops working: nobody else can download this plan, and anybody
              you delegated departments to can no longer publish their work back
              to you. What they have already done stays on their own machine.
            </DialogContentText>
          </>
        )}

        {localCopy === "twin" && (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>
              <AlertTitle>
                {twinLabel ? `Your “${twinLabel}”` : "Your plan of the same name"} is a
                different plan and is not affected
              </AlertTitle>
              It stays on this computer untouched. Once the server&rsquo;s copy is
              gone the name is free, and you can publish yours under it.
            </Alert>
            <DialogContentText sx={{ mb: 2 }}>
              Anybody who was working on the server&rsquo;s copy loses the ability
              to download it or publish to it. If colleagues have been entering
              work into it, that work is what you are setting aside.
            </DialogContentText>
          </>
        )}

        {localCopy === "none" && (
          <>
            <Alert severity="error" sx={{ mb: 2 }}>
              <AlertTitle>You do not have this plan on this computer</AlertTitle>
              There is no local copy to fall back on. Deleting it leaves you with
              nothing you can open, and the same is true for everybody else it was
              shared with.
            </Alert>
            <DialogContentText sx={{ mb: 2 }}>
              If you only meant to stop it appearing here, download it first — or
              archive it instead, which hides it without deleting anything.
            </DialogContentText>
          </>
        )}

        <Alert severity="info" sx={{ mb: mustType ? 2 : 0 }}>
          The rows are kept on the server, so support can restore this plan. It is
          not an erasure.
        </Alert>

        {mustType && (
          <TextField
            fullWidth
            autoFocus
            label="Type the plan's name to confirm"
            placeholder={planLabel}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={busy}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={busy || !armed}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
          onClick={onConfirm}
        >
          Delete from the server
        </Button>
      </DialogActions>
    </Dialog>
  );
}

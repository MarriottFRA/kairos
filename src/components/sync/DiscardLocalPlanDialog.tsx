/**
 * Throw away this computer's copy of a plan that is no longer shared.
 *
 * -----------------------------------------------------------
 * Deliberately not a mode of `DeletePlanDialog`. Every reassurance that dialog
 * offers is false here, and the most important one is inverted: it ends with
 * "the rows are kept on the server, so support can restore this plan", which is
 * exactly what cannot happen. The server will not discuss this plan with this
 * user at all — that is why the copy is going — so there is no restore, no
 * support ticket and no second chance.
 *
 * ## Why this dialog exists at all
 *
 * It should almost never be reached. When the server stops sharing a plan, the
 * Sync page purges the local copy without asking: nobody who is not the owner
 * has a reason to keep a colleague's plan on their disk, and there is nothing to
 * ask about when there is nothing to lose.
 *
 * The sweep spares exactly one case — a copy with unpublished local work in it.
 * A withdrawal is frequently temporary, the owner re-grants, and the server
 * stamps `override_base_until` specifically so the returning delegate's
 * held-back writes still land. Destroying that automatically would break a
 * promise the app makes on screen. So the copy survives, frozen, and this is the
 * button for the person who knows they are not going to get access back.
 *
 * Which makes it the one action in the feature that destroys work with no undo
 * anywhere — hence the typed confirmation, and hence the reason to keep the
 * work is stated before the button that discards it.
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

export interface DiscardLocalPlanDialogProps {
  open: boolean;
  busy: boolean;
  planLabel: string;
  /** Unpublished rows about to go with it. The reason this dialog is not a toast. */
  pendingChanges: number;
  /** Who could restore access, if they are still the owner. */
  ownerEmail: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export default function DiscardLocalPlanDialog({
  open,
  busy,
  planLabel,
  pendingChanges,
  ownerEmail,
  onConfirm,
  onClose,
}: DiscardLocalPlanDialogProps) {
  const [typed, setTyped] = useState("");

  // Cleared on every open so a previous confirmation cannot arm the next one.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const armed = typed.trim().toLowerCase() === planLabel.trim().toLowerCase();

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Discard “{planLabel}” from this computer?</DialogTitle>
      <DialogContent dividers>
        <Alert severity="error" sx={{ mb: 2 }}>
          <AlertTitle>
            {pendingChanges === 1
              ? "1 unpublished change goes with it"
              : `${pendingChanges} unpublished changes go with them`}
          </AlertTitle>
          They were never published, so there is no copy anywhere else. This
          cannot be undone by you, by {ownerEmail ?? "the plan's owner"}, or by
          support.
        </Alert>

        {/* The case AGAINST pressing the button, before the button. This copy is
            being kept for a reason and the user may not know what it is. */}
        <DialogContentText sx={{ mb: 2 }}>
          This plan is only still here because of that unpublished work. If{" "}
          {ownerEmail ?? "its owner"} shares it with you again, your changes
          publish as normal and nothing is lost — so the usual answer is to leave
          it alone and ask them.
        </DialogContentText>

        <DialogContentText sx={{ mb: 2 }}>
          Discard it if you know the work was not meant to go, or you are not
          getting access back.
        </DialogContentText>

        <TextField
          fullWidth
          autoFocus
          label="Type the plan's name to confirm"
          placeholder={planLabel}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          disabled={busy}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Keep it
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={busy || !armed}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
          onClick={onConfirm}
        >
          Discard this copy
        </Button>
      </DialogActions>
    </Dialog>
  );
}

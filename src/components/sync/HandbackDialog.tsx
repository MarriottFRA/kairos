/**
 * "I'm finished with this" — and the one ordering that works.
 * ---------------------------------------------------------------------------
 * A handback is not a revocation. It takes the department out of the delegate's
 * WRITE scope and leaves it in their read scope, the grant survives, and the
 * owner can reopen it in one click. Nothing is lost either way.
 *
 * What it does do is remove the ability to publish — which means a publish
 * AFTERWARDS silently withholds exactly the rows the delegate meant to send, and
 * the first anybody hears about it is the owner wondering where Rooms went. So
 * the primary action here is **Publish and hand back**, one button, in that
 * order. Advice to go and press two buttons in the right sequence is not a
 * design.
 *
 * "Hand back anyway" keeps its old meaning and stays available — somebody who
 * was experimenting and does not want the changes to go is a real case — but it
 * is now the quiet option rather than the only one.
 *
 * ## Two forms, one dialog
 *
 * The per-department route does NOT check for unpublished work server-side, on
 * purpose: finishing one department of five with four still open is routine. The
 * bulk route DOES, and answers 409. Both need the same conversation, so the
 * caller supplies `stranded` from a local read for the first and from the 409's
 * context for the second.
 *
 * ## Not atomic, and the copy must not imply it is
 *
 * There is no server transaction spanning publish-then-handback, and there
 * should not be. The guard is the ordering plus a hard stop: a publish that
 * comes back with conflicts or rejections does not proceed to the handback,
 * because handing back on top of a partial publish strands the remainder with no
 * way to retry.
 */

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
import Typography from "@mui/material/Typography";
import { PublishResponse } from "../../shared/kairosSync/ipc";
import PublishResultAlert from "./PublishResultAlert";

export interface HandbackDialogProps {
  open: boolean;
  busy: boolean;
  /** One department, or null for every one at once. */
  department: string | null;
  /** The departments this handback would move. */
  departments: string[];
  /** Unpublished rows this handback would strand, by department. */
  stranded: Record<string, number>;
  /** Everything unpublished on this plan, including departments not moving. */
  pendingTotal: number;
  /**
   * A publish ran and did not come back clean.
   *
   * Rendered in full and the handback is NOT attempted — see the module note.
   */
  publishResult: PublishResponse | null;
  /**
   * A line for the owner, stored against the handback.
   *
   * Plumbed end to end since delegation shipped — through the service, the IPC
   * channel and the HTTP layer — and never once sent, so `handedBackNote` came
   * back null on every record and the Delegation page had nothing to render.
   * Optional on purpose: most handbacks need no explanation and a required field
   * would make the common case slower.
   */
  note: string;
  onNoteChange: (note: string) => void;
  onPublishThenHandBack: () => void;
  onHandBackAnyway: () => void;
  onClose: () => void;
}

export default function HandbackDialog({
  open,
  busy,
  department,
  departments,
  stranded,
  pendingTotal,
  publishResult,
  note,
  onNoteChange,
  onPublishThenHandBack,
  onHandBackAnyway,
  onClose,
}: HandbackDialogProps) {
  const strandedTotal = Object.values(stranded).reduce((sum, n) => sum + n, 0);
  const strandedDepartments = Object.entries(stranded)
    .filter(([, count]) => count > 0)
    .map(([code]) => code);
  const codes = (strandedDepartments.length > 0 ? strandedDepartments : departments).join(
    ", "
  );
  const bulk = department === null;
  const subject = bulk ? "everything" : "this department";

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {strandedTotal > 0
          ? "Publish this first"
          : bulk
            ? "Hand everything back?"
            : `Hand ${department} back?`}
      </DialogTitle>
      <DialogContent dividers>
        {strandedTotal > 0 ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>
              {strandedTotal} {strandedTotal === 1 ? "change has" : "changes have"} not
              been published
            </AlertTitle>
            <Typography variant="body2">
              {strandedDepartments.length > 0 ? <>In <strong>{codes}</strong>. </> : null}
              Handing {subject} back removes your ability to publish{" "}
              {strandedTotal === 1 ? "it" : "them"} — the owner would have to give a
              department back to you first.
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Your work is <strong>not lost</strong> either way. It stays on this
              computer.
            </Typography>
            {pendingTotal > strandedTotal && (
              // Publishing is a whole-plan act, so somebody handing back one
              // department needs to know the button sends the rest too. Anything
              // outside their scope is withheld automatically, which is the
              // reassurance rather than the caveat.
              <Typography variant="body2" sx={{ mt: 1 }}>
                Publishing sends all <strong>{pendingTotal}</strong> of your
                unpublished changes, not only the ones in {codes}. Anything outside
                the departments you hold is withheld automatically.
              </Typography>
            )}
          </Alert>
        ) : (
          <DialogContentText>
            <strong>{departments.join(", ")}</strong>{" "}
            {departments.length === 1 ? "stops" : "stop"} being editable by you. You
            keep being able to see{" "}
            {departments.length === 1 ? "it" : "them"}, and the owner can give any of{" "}
            {departments.length === 1 ? "it" : "them"} back in one click.
          </DialogContentText>
        )}

        {!publishResult && (
          <TextField
            fullWidth
            size="small"
            multiline
            minRows={2}
            sx={{ mt: 2 }}
            label="Anything the owner should know? (optional)"
            placeholder="e.g. Rooms is done bar the two new night porters"
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            disabled={busy}
          />
        )}

        {publishResult && (
          <>
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
              Nothing has been handed back
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The publish did not go through cleanly, so the handback was not
              attempted — handing back on top of a partial publish would strand
              whatever did not land. Sort these out and try again.
            </Typography>
            <PublishResultAlert result={publishResult} />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {strandedTotal > 0 && (
          // Available, and quiet. Somebody who was experimenting and does not
          // want the changes to go is a real case; they are simply not the
          // common one.
          <Button color="warning" onClick={onHandBackAnyway} disabled={busy}>
            Hand back anyway
          </Button>
        )}
        <Button
          variant="contained"
          disabled={busy}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
          onClick={strandedTotal > 0 ? onPublishThenHandBack : onHandBackAnyway}
        >
          {strandedTotal > 0
            ? "Publish and hand back"
            : bulk
              ? "Hand everything back"
              : "Hand it back"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

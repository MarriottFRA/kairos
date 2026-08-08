/**
 * Taking and releasing a support lease.
 * -----------------------------------------------------------
 * A lease is the only path by which an administrator gains write access to a
 * hotel's plan, and both ends of it are consequential enough to be spelled out
 * rather than confirmed.
 *
 * **Acquiring.** The mode choice is the whole decision and it is presented as
 * two labelled options, not a checkbox. `READ_ONLY_SUPPORT` changes nothing
 * about anybody else's access and grants its holder reads only — break-glass
 * personal details included, writes excluded. `EXCLUSIVE` locks the owner out
 * for as long as it is held: their publishes come back 423 and they cannot edit.
 * Somebody who picks the wrong one either cannot do the job or has stopped a
 * hotel working, so the wording says which is which before the choice is made.
 *
 * **Releasing.** Handback bumps the plan's `syncEpoch`, which forces every
 * client at the property to discard its state and re-download. That is correct
 * and it is not free, so the dialog says it will happen and the result reports
 * what actually moved — "812 → 847" is an explanation; a pile of conflicts is
 * not.
 *
 * The `summary` is required for the same reason `reason` is: in March, when
 * somebody asks why the numbers changed, this is the only record of it.
 */

import { useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { LeaseCreate, LeaseMode } from "../../shared/kairosSync/protocol";

/** Per acquisition. The overall ceiling is 1440 minutes across extensions. */
const MIN_MINUTES = 5;
const MAX_MINUTES = 240;
const DEFAULT_MINUTES = 60;

export interface LeaseDialogProps {
  open: boolean;
  busy: boolean;
  planLabel: string;
  onSubmit: (lease: LeaseCreate) => void;
  onClose: () => void;
}

export function AcquireLeaseDialog({
  open,
  busy,
  planLabel,
  onSubmit,
  onClose,
}: LeaseDialogProps) {
  const [mode, setMode] = useState<LeaseMode>("READ_ONLY_SUPPORT");
  const [reason, setReason] = useState("");
  const [ticketRef, setTicketRef] = useState("");
  const [minutes, setMinutes] = useState(String(DEFAULT_MINUTES));

  const parsedMinutes = Number(minutes);
  const minutesValid =
    Number.isFinite(parsedMinutes) &&
    parsedMinutes >= MIN_MINUTES &&
    parsedMinutes <= MAX_MINUTES;
  const valid = reason.trim().length >= 3 && ticketRef.trim().length > 0 && minutesValid;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Take a support lease</DialogTitle>
      <DialogContent dividers>
        <DialogContentText sx={{ mb: 2 }}>
          On <strong>{planLabel}</strong>. Both modes are recorded against your
          account with the reference below.
        </DialogContentText>

        <FormControl sx={{ mb: 2 }}>
          <RadioGroup
            value={mode}
            onChange={(event) => setMode(event.target.value as LeaseMode)}
          >
            <FormControlLabel
              value="READ_ONLY_SUPPORT"
              control={<Radio />}
              label={
                <>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Read only
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    See everything, including employee details. Change nothing.
                    The hotel keeps working exactly as it is.
                  </Typography>
                </>
              }
            />
            <FormControlLabel
              sx={{ mt: 1 }}
              value="EXCLUSIVE"
              control={<Radio />}
              label={
                <>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Exclusive — the only mode that lets you save
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Locks the plan. Its owner cannot edit or publish until you
                    release it, and their attempts are refused rather than
                    queued.
                  </Typography>
                </>
              }
            />
          </RadioGroup>
        </FormControl>

        {mode === "EXCLUSIVE" && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>This locks the hotel out</AlertTitle>
            Anyone editing this plan right now will be unable to save until you
            release the lease. Take the shortest time that will do.
          </Alert>
        )}

        <Stack spacing={2}>
          <TextField
            fullWidth
            required
            label="Ticket reference"
            value={ticketRef}
            onChange={(event) => setTicketRef(event.target.value)}
            helperText="Shown to the hotel, so they can see why their plan is locked."
          />
          <TextField
            fullWidth
            required
            multiline
            minRows={2}
            label="Reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            helperText="Recorded internally and never shown to the hotel."
          />
          <TextField
            required
            type="number"
            label="Minutes"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            error={minutes !== "" && !minutesValid}
            helperText={`${MIN_MINUTES}–${MAX_MINUTES}. You can extend it later.`}
            sx={{ maxWidth: 200 }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={mode === "EXCLUSIVE" ? "warning" : "primary"}
          disabled={busy || !valid}
          onClick={() =>
            onSubmit({
              mode,
              reason: reason.trim(),
              ticketRef: ticketRef.trim(),
              minutes: parsedMinutes,
            })
          }
        >
          {mode === "EXCLUSIVE" ? "Lock and take the lease" : "Take the lease"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface ReleaseLeaseDialogProps {
  open: boolean;
  busy: boolean;
  planLabel: string;
  onSubmit: (summary: string) => void;
  onClose: () => void;
}

export function ReleaseLeaseDialog({
  open,
  busy,
  planLabel,
  onSubmit,
  onClose,
}: ReleaseLeaseDialogProps) {
  const [summary, setSummary] = useState("");

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Release the lease</DialogTitle>
      <DialogContent dividers>
        <DialogContentText sx={{ mb: 2 }}>
          Hands <strong>{planLabel}</strong> back to its owner.
        </DialogContentText>

        <Alert severity="info" sx={{ mb: 2 }}>
          Everyone working on this plan will re-download it from the server the
          next time they sync, and the server&rsquo;s copy wins. That is
          deliberate — it is how they pick up whatever you changed — but any
          unpublished work of theirs from while you held the lease is replaced.
        </Alert>

        <TextField
          fullWidth
          required
          multiline
          minRows={2}
          label="What did you do?"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          helperText="Kept with the plan. This is the answer when somebody asks in three months why the numbers moved."
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || summary.trim().length < 3}
          onClick={() => onSubmit(summary.trim())}
        >
          Release
        </Button>
      </DialogActions>
    </Dialog>
  );
}

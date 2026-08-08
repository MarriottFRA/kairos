/**
 * Both sides changed. Which copy wins?
 * -----------------------------------------------------------
 * Shown when a plan has unpublished work here AND changes on the server that
 * this machine has not downloaded. That happens routinely between colleagues,
 * and it happens by construction the moment a plan changes hands: the incoming
 * owner has their own local file and inherits a server copy somebody else has
 * been publishing to.
 *
 * There is no correct automatic answer, and the protocol deliberately does not
 * pretend otherwise — it has no client-asserted force flag precisely so that
 * overwriting is a decision somebody made. So this asks, once, in the only terms
 * that matter: how much of whose work goes.
 *
 * ## The two branches
 *
 * **Take the server's copy** is an ordinary pull. Local unpublished work is
 * replaced; the review step that follows names exactly what changes, including
 * deletions.
 *
 * **Keep mine** re-reads the server's manifest into the shadow so this client's
 * commit carries the server's own current hashes, and publishes on top. That is
 * the documented two-step overwrite, not a privilege — and two rules survive it
 * either way, because they were never the client's to decide: a server tombstone
 * still beats a live local row (resurrecting a leaver is the one merge that is
 * never harmless), and a delegate's writes still stay inside their departments.
 *
 * ## Why no "merge"
 *
 * There is nothing sensible to offer. These are opaque per-row documents with no
 * field-level provenance; a three-way merge would have to guess, and guessing
 * wrong on a salary is worse than either honest answer.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";

export interface ClaimPlanDialogProps {
  open: boolean;
  busy: boolean;
  planLabel: string;
  /** Unpublished rows on this machine. */
  localChanges: number;
  /** Plan versions this machine has not downloaded. */
  serverChanges: number;
  onTakeServer: () => void;
  onKeepMine: () => void;
  onClose: () => void;
}

export default function ClaimPlanDialog({
  open,
  busy,
  planLabel,
  localChanges,
  serverChanges,
  onTakeServer,
  onKeepMine,
  onClose,
}: ClaimPlanDialogProps) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Two versions of this plan</DialogTitle>
      <DialogContent dividers>
        <DialogContentText sx={{ mb: 2 }}>
          <strong>{planLabel}</strong> has changed in both places since they were
          last the same. Choose which one to keep — the other is replaced.
        </DialogContentText>

        <Stack spacing={2}>
          <Choice
            icon={<CloudDownloadOutlinedIcon color="primary" />}
            title="Take the server's copy"
            cost={
              localChanges === 1
                ? "Your 1 unpublished change here is replaced."
                : `Your ${localChanges} unpublished changes here are replaced.`
            }
            detail="You will be shown exactly what changes, including anything that would be deleted, before it is applied."
            action="Download"
            busy={busy}
            onClick={onTakeServer}
          />

          <Choice
            icon={<CloudUploadOutlinedIcon color="warning" />}
            title="Keep mine and publish over it"
            cost={
              serverChanges === 1
                ? "The 1 change on the server is replaced."
                : `The ${serverChanges} changes on the server are replaced.`
            }
            detail="Whoever made those changes will get your version the next time they download. If they have not published yet, their work is still on their own machine."
            action="Publish over"
            colour="warning"
            busy={busy}
            onClick={onKeepMine}
          />
        </Stack>

        <Alert severity="info" sx={{ mt: 2 }}>
          <AlertTitle>Two things neither choice changes</AlertTitle>
          A position somebody has deleted stays deleted — publishing over will not
          bring a leaver back. And if departments are delegated to you, your
          changes still only apply to those.
        </Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Decide later
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function Choice({
  icon,
  title,
  cost,
  detail,
  action,
  colour,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  cost: string;
  detail: string;
  action: string;
  colour?: "warning";
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Box sx={{ p: 2, border: 1, borderColor: "divider", borderRadius: 2 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
        <Box sx={{ pt: 0.25 }}>{icon}</Box>
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {cost}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {detail}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            color={colour ?? "primary"}
            sx={{ mt: 1.5 }}
            disabled={busy}
            onClick={onClick}
          >
            {action}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}

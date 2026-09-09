/**
 * The gate in front of "include unpushed plan data".
 *
 * The BST is the record: every figure a report shows should be one the BST
 * holds, because that is what the area team, the owner and the auditors
 * read. Reading the plan straight from Kairos is allowed — a hotel mid-way
 * through a budget wants to see where it is landing — but it is a choice
 * made every time, said out loud, and stamped on anything exported.
 */

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";

export interface UnpushedPlanDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function UnpushedPlanDialog({ open, onCancel, onConfirm }: UnpushedPlanDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <WarningAmberIcon color="warning" />
          <span>Report on unpushed plan data?</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <DialogContentText component="div">
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            The BST is the budget of record. Reports read it by default so that every number you share is
            one the BST already holds.
          </Typography>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            This mode lays your Kairos results over the BST figures instead — replacing the payroll,
            hours and headcount lines with what the plan would push. It never adds the two together.
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Every screen and export in this mode is marked UNPUSHED PLAN DATA. Push to the BST and pull
            it back to report on the record.
          </Typography>
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Keep reading the BST</Button>
        <Button onClick={onConfirm} variant="contained" color="warning" disableElevation>
          Include unpushed plan data
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * "These three are yours — and here is how you give them back."
 * ---------------------------------------------------------------------------
 * The mirror image of `LockedDepartmentsBanner`. That one names the departments
 * you cannot edit; this one names the ones you can, and says what to do when you
 * have finished with them.
 *
 * It exists because handing work back had no discoverable route at all. The
 * Delegation page hosts the handback UI, and the only button that led there was
 * gated on `plan:delegate` — which is the GRANTING capability, and false for
 * every delegate. So the people the handback flow was built for could reach it
 * only by typing the URL, while their own relation explainer told them to go
 * there. The Sync page now carries a button too; this is the one on the page
 * where the work actually happens.
 *
 * Deliberately quiet: one line, no collapse, no counts. It is a signpost, not a
 * notification, and a delegate sees it on every visit.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";

export interface DelegateHoldingsBannerProps {
  /** Departments this user holds and may write. */
  departments: string[];
  onHandBack: () => void;
}

export default function DelegateHoldingsBanner({
  departments,
  onHandBack,
}: DelegateHoldingsBannerProps) {
  if (departments.length === 0) return null;

  return (
    <Alert
      severity="info"
      variant="outlined"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={onHandBack}>
          Hand a department back
        </Button>
      }
    >
      <AlertTitle>
        {departments.length === 1
          ? "You are working on one department of this plan"
          : `You are working on ${departments.length} departments of this plan`}
      </AlertTitle>
      <strong>{departments.join(", ")}</strong>. When you have finished with one,
      publish your work and hand it back — you keep being able to see it, and the
      owner can give it back to you in one click.
    </Alert>
  );
}

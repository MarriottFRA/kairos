/**
 * What the server knows that might be worth a look before a BST push.
 * -----------------------------------------------------------
 * `GET /plans/{id}/bst-push/eligibility` used to gate this page. It no longer
 * does, and deliberately: the push is an entirely client-side write into a file
 * the user picks off their own disk, recalculated from the plan they already
 * hold. There is no server state that makes that act wrong. Someone mid-review
 * who has not handed a delegation back, or has not taken one away because the
 * holder is still working, still has the numbers and can still recalculate —
 * blocking them there bought nothing and cost them the push.
 *
 * So the same reasons are rendered as nudges. Every one of them means "your
 * local copy may not be the whole picture", which is a reason to sync first —
 * never a reason to stop. `allowed` is ignored; only the reasons are read.
 *
 * One reason is dropped outright. `NO_BST_IMPORT` is the server saying no
 * workbook has been PUBLISHED, which says nothing about whether this machine has
 * one: a BST Pull writes to the local store, and publishing it is a separate
 * choice the user is entitled not to make. Telling someone who just pulled that
 * they have no workbook is simply wrong, so the local import decides that line.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { BstPushEligibility } from "../../shared/kairosSync/protocol";

const ADVISORIES: Record<string, string> = {
  NOT_PLAN_OWNER:
    "This plan belongs to someone else. Your push writes the numbers in your copy, which may not include their most recent work — a sync first is worth considering.",
  PARTIAL_SCOPE:
    "You hold some of this plan's departments rather than all of them. The push writes every department from your local copy, so the ones you do not hold land as you last received them. Sync if you want other people's latest figures in the file.",
  ADMIN_LEASE_ACTIVE:
    "An administrator is working on this plan at the moment. Anything they have changed is not in your copy yet.",
  NEVER_PUBLISHED:
    "This plan has not been published to the server, so nothing here has been shared. The push works from your local numbers as normal.",
  NO_BST_IMPORT:
    "No budget workbook has been pulled for this hotel yet. The push still works against the file you choose, but pulling one on the BST Pull page keeps Kairos and the workbook in step.",
};

export default function PushAdvisoryAlert({
  eligibility,
  hasLocalImport,
  onDismiss,
}: {
  eligibility: BstPushEligibility | null;
  /** Whether a BST Pull has landed on THIS machine — null while unknown. */
  hasLocalImport: boolean | null;
  onDismiss?: () => void;
}) {
  // Until the local answer is in, say nothing rather than risk saying the wrong
  // thing: the alert appears a beat later, which nobody notices, where a wrong
  // "you have no workbook" is noticed immediately.
  const reasons = (eligibility?.reasons ?? []).filter((reason) =>
    reason === "NO_BST_IMPORT" ? hasLocalImport === false : true
  );
  if (hasLocalImport === null || reasons.length === 0) return null;

  return (
    <Alert severity="info" sx={{ mb: 2 }} onClose={onDismiss}>
      <AlertTitle>You may want to sync before pushing</AlertTitle>
      <Stack spacing={1}>
        {reasons.map((reason) => (
          <Typography key={reason} variant="body2">
            {ADVISORIES[reason] ?? reason}
          </Typography>
        ))}
        <Typography variant="body2" color="text.secondary">
          None of this stops the push — carry on if your numbers are the ones you
          want in the workbook.
        </Typography>
      </Stack>
    </Alert>
  );
}

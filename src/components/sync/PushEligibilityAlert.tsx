/**
 * Why a BST push is or is not allowed.
 * -----------------------------------------------------------
 * `GET /plans/{id}/bst-push/eligibility` answers before the page enables
 * anything, and the reasons are rendered rather than collapsed into a single
 * "not allowed": each one needs a completely different thing from the user.
 * "You hold four of thirty departments" and "an administrator is working on this
 * plan" are not the same problem.
 *
 * The push itself stays entirely client-side — this only decides whether the
 * button is live, and `POST .../bst-push/log` afterwards is the only record that
 * Kairos changed the hotel's real workbook.
 *
 * A plan that was never published has no server-side opinion, so there is
 * nothing to render: the push works exactly as it did before sync existed.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { BstPushEligibility } from "../../shared/kairosSync/protocol";

const REASONS: Record<string, string> = {
  NOT_PLAN_OWNER:
    "Only the plan's owner can push. They know what has been delegated and to whom; a delegate pushing would overwrite departments they cannot see.",
  PARTIAL_SCOPE:
    "You hold only some of this plan's departments. A push clears the rows it is about to write, so it would erase numbers it cannot replace.",
  ADMIN_LEASE_ACTIVE:
    "An administrator is working on this plan. Wait until they hand it back.",
  NEVER_PUBLISHED:
    "This plan has not been published to the server, so there is nothing to check the push against.",
  NO_BST_IMPORT:
    "No budget workbook has been published for this hotel yet. Pull one on the BST Pull page and publish it first.",
};

export default function PushEligibilityAlert({
  eligibility,
}: {
  eligibility: BstPushEligibility | null;
}) {
  if (!eligibility || eligibility.allowed) return null;

  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <AlertTitle>Push is not available</AlertTitle>
      <Stack spacing={1}>
        {eligibility.reasons.map((reason) => (
          <Typography key={reason} variant="body2">
            {REASONS[reason] ?? reason}
          </Typography>
        ))}
      </Stack>
    </Alert>
  );
}

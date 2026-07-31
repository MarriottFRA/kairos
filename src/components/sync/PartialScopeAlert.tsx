/**
 * The banner that goes in front of a surface a partial scope would get wrong.
 * -----------------------------------------------------------
 * `scope.kind === "PARTIAL"` means the user holds some of the plan's departments
 * and not others. That is a hard gate, not a caveat, on exactly three surfaces:
 *
 * - **Allocations** renormalise every column to 100%. A missing department does
 *   not shrink the total — it silently redistributes everybody else's share, so
 *   the numbers are wrong rather than incomplete.
 * - **Results totals** under-report with no indication that anything is absent.
 * - **BST push** zeroes rows before writing them. A partial push destroys good
 *   numbers rather than producing partial ones.
 *
 * This is an accepted product limitation precisely because `scope.kind` makes it
 * detectable. Rendering the surface with a warning would not be equivalent: the
 * failure is that the numbers look right.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Typography from "@mui/material/Typography";

const REASONS = {
  allocations:
    "Allocations spread each cost across every department and rebalance the split to 100%. Without the departments you cannot see, everyone else's share would be inflated — the result would be wrong, not just incomplete.",
  results:
    "Totals here would only cover your departments, with nothing to say the rest are missing.",
  bstPush:
    "A push clears the rows it is about to write. With only some departments, it would clear numbers it cannot replace.",
} as const;

export type PartialScopeSurface = keyof typeof REASONS;

export default function PartialScopeAlert({
  surface,
  departments,
}: {
  surface: PartialScopeSurface;
  departments: string[] | null;
}) {
  const count = departments?.length ?? 0;
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <AlertTitle>Not available with partial access</AlertTitle>
      <Typography variant="body2">{REASONS[surface]}</Typography>
      <Typography variant="body2" sx={{ mt: 1 }}>
        You have been delegated {count} {count === 1 ? "department" : "departments"}
        {count > 0 && departments ? ` (${departments.join(", ")})` : ""}. Ask the
        plan owner for the rest, or hand your departments back and let them run
        this.
      </Typography>
    </Alert>
  );
}

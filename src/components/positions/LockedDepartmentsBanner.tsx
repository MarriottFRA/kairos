/**
 * "Three departments are being edited by someone else."
 * -----------------------------------------------------------
 * The grid locks rows it cannot write, and until now said nothing about why.
 * A locked cell that simply does not open on double-click reads as a broken
 * grid; this is the sentence that turns it into a rule.
 *
 * It renders `PlanScope.lockedDepartments`, which is `/department-ownership`'s
 * own list of departments this user can READ but not WRITE, with the server's
 * reason attached. Nothing is inferred client-side — `writable` IS the predicate
 * a save will use, so what this banner claims and what a save does cannot
 * diverge.
 *
 * Collapsed by default. A delegate holding three of thirty departments would
 * otherwise open the page to a wall of twenty-seven rows they did not ask about.
 */

import { useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { DepartmentOwnershipRow } from "../../shared/kairosSync/protocol";
import { LOCK_REASON } from "../../shared/kairosSync/lockReason";

export interface LockedDepartmentsBannerProps {
  departments: DepartmentOwnershipRow[];
  /** True when the whole plan is read-only — a different message entirely. */
  planLocked?: boolean;
}

export default function LockedDepartmentsBanner({
  departments,
  planLocked,
}: LockedDepartmentsBannerProps) {
  const [open, setOpen] = useState(false);

  if (planLocked) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>This plan is read-only for you</AlertTitle>
        You can see everything and download it, but nothing here can be edited.
        The Sync page explains why.
      </Alert>
    );
  }

  if (departments.length === 0) return null;

  return (
    <Alert
      severity="info"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      <AlertTitle>
        {departments.length === 1
          ? "One department is being edited by somebody else"
          : `${departments.length} departments are being edited by somebody else`}
      </AlertTitle>
      Their rows are visible but locked, so two people cannot change the same
      position at once.
      <Collapse in={open} unmountOnExit>
        <Stack spacing={0.5} sx={{ mt: 1.5 }}>
          {departments.map((row) => {
            const holders = row.assignedTo
              .filter((holder) => holder.state === "ACTIVE")
              .map((holder) => holder.email);
            return (
              <Box key={row.code}>
                <Typography variant="body2">
                  <strong>{row.code}</strong>
                  {holders.length > 0 ? ` — ${holders.join(", ")}` : ""}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {LOCK_REASON[row.reason ?? ""] ?? "Not yours to edit"}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      </Collapse>
    </Alert>
  );
}

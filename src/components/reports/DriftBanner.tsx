/**
 * DriftBanner — the nudge to push.
 *
 * Shown whenever the scenario's results differ from what the BST holds, in
 * BOTH source modes: reading the BST, it says the report is behind the plan;
 * reading the plan, it says the report is ahead of the record. Either way
 * the fix is the same button. Never blocking, never dismissible while the
 * difference stands.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { PlanDrift } from "../../shared/reports/sources";
import type { SourceMode } from "../../shared/reports/columnConfig";
import { formatReportValue } from "./format";

export interface DriftBannerProps {
  drift: PlanDrift;
  mode: SourceMode;
  onGoToPush: () => void;
}

export default function DriftBanner({ drift, mode, onGoToPush }: DriftBannerProps) {
  const parts: string[] = [];
  if (drift.differing) parts.push(`${drift.differing} line${drift.differing === 1 ? "" : "s"} changed`);
  if (drift.onlyInPlan) parts.push(`${drift.onlyInPlan} not yet in the BST`);
  if (drift.onlyInBst) parts.push(`${drift.onlyInBst} the push would clear`);
  const top = drift.top.slice(0, 5);

  return (
    <Alert
      severity={mode === "plan" ? "error" : "warning"}
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={onGoToPush}>
          Go to BST Push
        </Button>
      }
    >
      <AlertTitle>
        {mode === "plan"
          ? "UNPUSHED PLAN DATA — this report is ahead of the BST"
          : "The BST is behind your plan — push before reporting"}
      </AlertTitle>
      <Typography variant="body2">
        {parts.join(", ")}. Total movement {formatReportValue(drift.absDelta[12], "number")} across the year.
        {mode === "plan"
          ? " These figures include Kairos results the BST does not hold yet."
          : " These figures are what the BST holds; the plan in Kairos has moved on."}
      </Typography>
      {top.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.75, flexWrap: "wrap", rowGap: 0.5 }}>
          {top.map((entry) => (
            <Chip
              key={`${entry.dept}|${entry.account}`}
              size="small"
              variant="outlined"
              label={`${entry.dept} · ${entry.account}: ${entry.kind === "onlyInBst" ? "clear" : entry.kind === "onlyInPlan" ? "new" : "Δ"} ${formatReportValue(entry.delta[12], "number")}`}
              sx={{ height: 22, fontSize: "0.6875rem" }}
            />
          ))}
        </Stack>
      )}
    </Alert>
  );
}

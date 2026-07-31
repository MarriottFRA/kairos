/**
 * What a publish actually did.
 * -----------------------------------------------------------
 * A commit answers 200 even when rows conflicted or were rejected, and that is
 * the correct shape: two delegates on different departments are permanently
 * stale relative to each other, so a disagreeing base version is the normal
 * case. **A non-empty `rejected` is not a failed save** — a chunk carrying one
 * illegal row still lands everything else — so this renders a partial result as
 * a partial result rather than an error.
 *
 * Two things it will not let pass silently:
 *
 * - **`overrodeBase`.** A re-granted delegate's write overwrote a row that
 *   changed while they were locked out. That is correct and audited, and the
 *   person who did it should still know they did it.
 * - **Conflicts.** Somebody else changed the same row. The fix is to pull and
 *   re-apply, so the message says that rather than "save failed".
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { PublishResponse } from "../../shared/kairosSync/ipc";
import { TYPE_LABELS } from "./ReviewDialog";

/** What each rejection means to the person who pressed Publish. */
const REJECTION_TEXT: Record<string, string> = {
  UNKNOWN_ENTITY_TYPE:
    "This version of Kairos sent data the server does not recognise. Update the app.",
  DEPARTMENT_OUT_OF_SCOPE:
    "These rows are in departments you are not allowed to edit.",
  DEPARTMENT_MISMATCH:
    "A row's department disagreed with itself. Reopen the row and set the department again.",
  DEPARTMENT_UNASSIGNED:
    "These rows have no department, so only the plan owner can publish them.",
  STRUCTURE_OWNER_ONLY:
    "Columns, blocks and schemes can only be changed by the plan owner.",
  ORPHAN_ENTITY:
    "These rows belong to a position the server does not have yet. Publish again.",
  PII_NOT_PERMITTED:
    "This property does not allow employee personal details to be stored on the server. Everything else was published.",
  PII_KEY_MISMATCH:
    "An employee detail row was keyed incorrectly. Please report this.",
  PAYLOAD_TOO_LARGE: "A row was too large to publish.",
  MISSING_PAYLOAD: "A row was sent with no content.",
};

const CONFLICT_TEXT: Record<string, string> = {
  STALE: "changed by somebody else since you last downloaded",
  ALREADY_EXISTS: "already on the server under a different value",
  DELETED_REMOTELY: "deleted by somebody else — the deletion wins",
};

export default function PublishResultAlert({ result }: { result: PublishResponse }) {
  if (result.noop) {
    return <Alert severity="info">Everything was already published.</Alert>;
  }

  const rejectionsByReason = groupBy(result.rejected, (row) => row.reason);
  const conflictsByReason = groupBy(result.conflicts, (row) => row.reason);
  const clean = result.conflicts.length === 0 && result.rejected.length === 0;

  return (
    <Stack spacing={2}>
      <Alert severity={clean ? "success" : "warning"}>
        <AlertTitle>
          {clean ? "Published" : "Published, with some rows left behind"}
        </AlertTitle>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
          <Chip size="small" color="success" label={`${result.accepted} saved`} />
          {result.unchanged > 0 && (
            <Chip size="small" label={`${result.unchanged} already current`} />
          )}
          {result.purged > 0 && (
            <Chip size="small" label={`${result.purged} deletions recorded`} />
          )}
          {result.withheld > 0 && (
            <Chip size="small" label={`${result.withheld} outside your departments`} />
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
          Plan version {result.committedVersion}
        </Typography>
      </Alert>

      {result.overrodeBase > 0 && (
        // Deliberately its own alert rather than a chip. This is the re-grant
        // override: the server accepted writes that would normally have been
        // stale, because the owner re-delegated after a forced withdrawal.
        // Correct, audited — and it should never be silent.
        <Alert severity="info">
          <AlertTitle>
            {result.overrodeBase} {result.overrodeBase === 1 ? "row" : "rows"}{" "}
            overwrote newer changes
          </AlertTitle>
          Your access to these departments was withdrawn and then granted again.
          Your copy has replaced anything changed while you were locked out. This
          is recorded in the audit log.
        </Alert>
      )}

      {result.conflicts.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>
            {result.conflicts.length}{" "}
            {result.conflicts.length === 1 ? "row was" : "rows were"} not saved
          </AlertTitle>
          {Object.entries(conflictsByReason).map(([reason, rows]) => (
            <Box key={reason} sx={{ mt: 1 }}>
              <Typography variant="body2">
                {rows.length} {rows.length === 1 ? "row" : "rows"} —{" "}
                {CONFLICT_TEXT[reason] ?? reason.toLowerCase()}.
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {summarise(rows)}
              </Typography>
            </Box>
          ))}
          <Typography variant="body2" sx={{ mt: 1 }}>
            Download the latest version, check the rows, then publish again.
          </Typography>
        </Alert>
      )}

      {result.rejected.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>
            {result.rejected.length}{" "}
            {result.rejected.length === 1 ? "row was" : "rows were"} refused
          </AlertTitle>
          {Object.entries(rejectionsByReason).map(([reason, rows]) => (
            <Box key={reason} sx={{ mt: 1 }}>
              <Typography variant="body2">
                {REJECTION_TEXT[reason] ?? reason}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {rows.length} {rows.length === 1 ? "row" : "rows"} — {summarise(rows)}
              </Typography>
            </Box>
          ))}
        </Alert>
      )}
    </Stack>
  );
}

function groupBy<T>(rows: T[], key: (row: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const row of rows) {
    const bucket = key(row);
    (out[bucket] ??= []).push(row);
  }
  return out;
}

/** "Positions, Block inputs" — which kinds of row, not which ids. */
function summarise(rows: Array<{ entityType: string }>): string {
  const types = [...new Set(rows.map((row) => TYPE_LABELS[row.entityType] ?? row.entityType))];
  return types.join(", ");
}

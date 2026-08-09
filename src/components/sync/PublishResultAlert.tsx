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
 * ## Whose problem is it?
 *
 * The reported failure this file exists to fix: a delegate who had edited
 * nothing but ordinary rows, all of which synced, was told "Published, with some
 * rows left behind", that "columns, blocks and schemes can only be changed by
 * the plan owner", and that an employee detail row "was keyed incorrectly.
 * Please report this." Three sentences about things they had not done and could
 * not act on, attached to a publish that worked.
 *
 * Every reason code is therefore sorted into one of three buckets:
 *
 * - **actionable** — the user can fix it, and the sentence says how.
 * - **internal** — a fault in the app or the data, not in what they did. Counted
 *   once, with a copyable diagnostic for support, never explained at them.
 * - **impossible for this caller** — an internal code their role could not have
 *   caused. A delegate does not choose to send structure rows; the client no
 *   longer sends them at all (see `PLAN_WIDE_ENTITY_TYPES` in `collect.ts`), and
 *   anything that slips through is counted, not narrated.
 *
 * `localProblems` is separate again: rows broken on THIS computer that were
 * never sent. The server never saw them, so calling them a refusal is simply
 * untrue.
 *
 * Two things this will not let pass silently:
 *
 * - **`overrodeBase`.** A re-granted delegate's write overwrote a row that
 *   changed while they were locked out. That is correct and audited, and the
 *   person who did it should still know they did it.
 * - **Conflicts.** Somebody else changed the same row. The fix is to pull and
 *   re-apply, so the message says that rather than "save failed".
 */

import { useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { LocalProblem, PublishResponse } from "../../shared/kairosSync/ipc";
import { TYPE_LABELS } from "./ReviewDialog";

type Audience = "actionable" | "internal";

interface RejectionMeta {
  audience: Audience;
  text: string;
  /**
   * True when this caller's role could not have caused the rejection.
   *
   * Counted rather than explained. The alternative is telling somebody they did
   * something they had no way of doing, which is how a working system produces a
   * support ticket.
   */
  impossibleFor?: (result: PublishResponse) => boolean;
}

/** What each rejection means to the person who pressed Publish. */
const REJECTIONS: Record<string, RejectionMeta> = {
  DEPARTMENT_OUT_OF_SCOPE: {
    audience: "actionable",
    text:
      "These rows are in departments you are not allowed to edit. They are still here on " +
      "this computer — ask the plan's owner to delegate the department, or leave them to " +
      "whoever holds it.",
  },
  DEPARTMENT_UNASSIGNED: {
    audience: "actionable",
    text:
      "These rows have no department yet. Give each of them one and publish again — until " +
      "then only the plan's owner can publish them.",
  },
  DEPARTMENT_MISMATCH: {
    audience: "actionable",
    text:
      "A row's department name and code disagreed. Open the row, choose the department " +
      "again, and publish.",
  },
  ORPHAN_ENTITY: {
    audience: "actionable",
    text:
      "These rows hang off a position the server has not got yet. Publish once more — the " +
      "position goes up first and these follow it.",
  },
  PII_NOT_PERMITTED: {
    audience: "actionable",
    text:
      "This property does not store employee personal details on the server. Everything " +
      "else published normally, and the details stay on this computer.",
  },
  PAYLOAD_TOO_LARGE: {
    audience: "actionable",
    text:
      "A row carries more than the server accepts. Clearing a long note or an unused " +
      "custom column on it will let it through.",
  },
  STRUCTURE_OWNER_ONLY: {
    audience: "internal",
    text: "Columns, blocks and schemes can only be changed by the plan's owner.",
    // Somebody with no structure rights did not CHOOSE to send these. The client
    // stops sending them upstream; this stops the leftovers reading as an
    // accusation.
    impossibleFor: (result) => !result.structureEditable,
  },
  UNKNOWN_ENTITY_TYPE: {
    audience: "internal",
    text:
      "This version of Kairos sent something the server does not recognise. Updating the " +
      "app will fix it.",
  },
  PII_KEY_MISMATCH: {
    audience: "internal",
    text: "An employee-details row was keyed to the wrong position.",
  },
  MISSING_PAYLOAD: {
    audience: "internal",
    text: "A row was sent with nothing in it.",
  },
};

const CONFLICT_TEXT: Record<string, string> = {
  STALE: "changed by somebody else since you last downloaded",
  ALREADY_EXISTS: "already on the server under a different value",
  DELETED_REMOTELY: "deleted by somebody else — the deletion wins",
};

/**
 * What to do about each conflict, which is not the same for all three.
 *
 * "Download the latest version, check the rows, then publish again" was printed
 * under every one of them. For `ALREADY_EXISTS` that instruction was not merely
 * unhelpful, it was impossible to follow to a conclusion: the row was one a
 * download does not carry, so the same message came back however many times the
 * user did as they were told.
 */
const CONFLICT_ADVICE: Record<string, string> = {
  STALE: "Download the latest version, check the rows, then publish again.",
  ALREADY_EXISTS:
    "Nothing to do — the app has taken the server's version as the starting " +
    "point, so publishing again sends yours as an ordinary change.",
  DELETED_REMOTELY:
    "These rows were deleted by somebody else and stay deleted. Add them again " +
    "if they should not have been.",
};

const LOCAL_PROBLEM_TEXT: Record<LocalProblem["reason"], string> = {
  ORPHANED_LOCALLY:
    "Details were found for positions that are no longer on this computer, so there was " +
    "nothing on the server to attach them to.",
  EMPTY_KEY:
    "A row has no identifier of its own, so there is nothing on the server for it to be.",
};

export default function PublishResultAlert({ result }: { result: PublishResponse }) {
  const [copied, setCopied] = useState(false);

  if (result.noop) {
    return <Alert severity="info">Everything was already published.</Alert>;
  }

  const conflictsByReason = groupBy(result.conflicts, (row) => row.reason);

  // Three buckets, decided once. `suppressed` is still counted — nothing
  // vanishes silently — it simply is not narrated at somebody who did not do it.
  const actionable = result.rejected.filter(
    (row) => (REJECTIONS[row.reason]?.audience ?? "actionable") === "actionable"
  );
  const internalAll = result.rejected.filter(
    (row) => REJECTIONS[row.reason]?.audience === "internal"
  );
  const suppressed = internalAll.filter((row) =>
    REJECTIONS[row.reason]?.impossibleFor?.(result)
  );
  const internal = internalAll.filter(
    (row) => !REJECTIONS[row.reason]?.impossibleFor?.(result)
  );
  const actionableByReason = groupBy(actionable, (row) => row.reason);

  const localProblems = result.localProblems ?? [];
  const localProblemCount = localProblems.reduce((sum, row) => sum + row.count, 0);

  /**
   * Everything the user asked to send, landed.
   *
   * The old test was `conflicts.length === 0 && rejected.length === 0`, which
   * fired on rows that were never theirs. This asks the question the headline
   * claims to answer.
   */
  /**
   * Every conflict resolved itself, so there is nothing left to do about them.
   *
   * `adopted` counts the `ALREADY_EXISTS` rows whose server hash the client has
   * taken on board; the next publish sends them as ordinary updates. Telling
   * somebody to go and look at rows that will sort themselves out is how a
   * working publish reads as a broken one.
   */
  const settled =
    result.conflicts.length > 0 && result.adopted >= result.conflicts.length;
  const yoursLanded =
    (result.conflicts.length === 0 || settled) && actionable.length === 0;
  const quiet = internal.length === 0 && suppressed.length === 0;

  const headline = yoursLanded
    ? quiet
      ? "Published"
      : "Published — everything of yours is on the server"
    : actionable.length > 0
      ? "Published — some rows still need something from you"
      : "Published — some rows need another look";

  const copyDiagnostics = (): void => {
    const text = [
      `plan ${result.planId} · version ${result.committedVersion} · relation ${
        result.relation ?? "unknown"
      } · structureEditable ${result.structureEditable}`,
      ...internalCounts(internalAll).map(([key, count]) => `${key} × ${count}`),
    ].join("\n");
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Stack spacing={2}>
      <Alert severity={yoursLanded ? "success" : "warning"}>
        <AlertTitle>{headline}</AlertTitle>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
          <Chip size="small" color="success" label={`${result.accepted} saved`} />
          {result.unchanged > 0 && (
            <Chip size="small" label={`${result.unchanged} already current`} />
          )}
          {result.purged > 0 && (
            // Rows the server actually deleted, counted from its reply. It used
            // to count what was SENT — including purges the server refused —
            // which announced deletions to somebody who had deleted nothing.
            <Chip
              size="small"
              label={`${result.purged} ${
                result.purged === 1 ? "row" : "rows"
              } deleted on the server`}
            />
          )}
          {result.withheld > 0 && (
            // "Outside your departments" read as data loss to the people who saw
            // it most. It is the opposite: the rows are safe and still here.
            <Chip
              size="small"
              label={`${result.withheld} not yours — kept on this computer`}
            />
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
        // `info`, not `warning`, when every conflict has already settled itself.
        // Somebody else's copy having got there first is a fact about a shared
        // plan, not a fault in this publish.
        <Alert severity={settled ? "info" : "warning"}>
          <AlertTitle>
            {result.conflicts.length}{" "}
            {result.conflicts.length === 1 ? "row was" : "rows were"} not saved
          </AlertTitle>
          <Typography variant="body2">Everything else published normally.</Typography>
          {Object.entries(conflictsByReason).map(([reason, rows]) => (
            <Box key={reason} sx={{ mt: 1 }}>
              <Typography variant="body2">
                {rows.length} {rows.length === 1 ? "row" : "rows"} —{" "}
                {CONFLICT_TEXT[reason] ?? reason.toLowerCase()}.
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {summarise(rows)}
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {CONFLICT_ADVICE[reason] ?? CONFLICT_ADVICE.STALE}
              </Typography>
            </Box>
          ))}
        </Alert>
      )}

      {localProblemCount > 0 && (
        // Before the rejections, because it is the one the user can actually do
        // something about — and because it is not a refusal at all.
        <Alert severity="warning">
          <AlertTitle>
            {localProblemCount}{" "}
            {localProblemCount === 1 ? "row on this computer" : "rows on this computer"}{" "}
            could not be published
          </AlertTitle>
          {localProblems.map((problem) => (
            <Typography key={`${problem.entityType}:${problem.reason}`} variant="body2" sx={{ mt: 1 }}>
              {LOCAL_PROBLEM_TEXT[problem.reason]}
            </Typography>
          ))}
          <Typography variant="body2" sx={{ mt: 1 }}>
            These are leftovers on this computer, not refusals from the server.
            They were not sent, nothing on the server changed, and everything
            else published normally.
          </Typography>
        </Alert>
      )}

      {actionable.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>
            {actionable.length}{" "}
            {actionable.length === 1
              ? "row still needs something from you"
              : "rows still need something from you"}
          </AlertTitle>
          {Object.entries(actionableByReason).map(([reason, rows]) => (
            <Box key={reason} sx={{ mt: 1 }}>
              <Typography variant="body2">
                {REJECTIONS[reason]?.text ?? reason}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {rows.length} {rows.length === 1 ? "row" : "rows"} — {summarise(rows)}
              </Typography>
            </Box>
          ))}
        </Alert>
      )}

      {internalAll.length > 0 && (
        // One quiet line for every code the user did not cause and cannot fix.
        // Counted, so nothing disappears; not narrated, so nothing accuses.
        <Alert severity="info">
          <AlertTitle>Nothing for you to do</AlertTitle>
          <Typography variant="body2">
            The app also sent {internalAll.length}{" "}
            {internalAll.length === 1 ? "row" : "rows"} the server keeps for the
            plan's owner. Your own work is unaffected. If this keeps happening,
            send the details to support.
          </Typography>
          {internal.length > 0 && (
            // Only the ones this caller's role could plausibly have caused get a
            // sentence; the rest stay in the count and in the copied diagnostic.
            <Box sx={{ mt: 1 }}>
              {[...new Set(internal.map((row) => row.reason))].map((reason) => (
                <Typography
                  key={reason}
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block" }}
                >
                  {REJECTIONS[reason]?.text ?? reason}
                </Typography>
              ))}
            </Box>
          )}
          <Button size="small" sx={{ mt: 1 }} onClick={copyDiagnostics}>
            {copied ? "Copied" : "Copy details for support"}
          </Button>
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

/** `reason · entityType` → count. Ids are of no use to whoever reads this. */
function internalCounts(
  rows: Array<{ reason: string; entityType: string }>
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.reason} · ${row.entityType}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()];
}

/** "Positions, Block inputs" — which kinds of row, not which ids. */
function summarise(rows: Array<{ entityType: string }>): string {
  const types = [...new Set(rows.map((row) => TYPE_LABELS[row.entityType] ?? row.entityType))];
  return types.join(", ");
}

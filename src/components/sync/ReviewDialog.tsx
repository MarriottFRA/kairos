/**
 * The review step in front of a pull or a publish.
 * -----------------------------------------------------------
 * Both directions get one: a pull can overwrite unpublished local work, and a
 * publish can carry a deletion the user did not mean to propagate. Neither is
 * recoverable by pressing the button again, so both name what is about to change
 * before it changes.
 *
 * Deletions are listed separately from everything else rather than folded into a
 * per-type count. "14 positions" reads as routine; "12 positions, 2 deletions"
 * is the one that makes somebody stop and look.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { UNCLASSIFIED_DEPARTMENT } from "../../shared/kairosSync/ipc";

/** Above this the chip row stops being scannable and becomes a wall. */
const DEPARTMENT_CHIP_LIMIT = 8;

/**
 * The bucket for rows carrying no department, spelled out.
 *
 * The plan's own row, calculation metadata, and the personal-details sidecar,
 * which inherits its parent's department server-side. Rendered rather than
 * hidden so the chips add up to the total — a breakdown that quietly does not
 * sum invites the reader to wonder where the rest went.
 */
function departmentLabel(code: string): string {
  return code === UNCLASSIFIED_DEPARTMENT ? "No department" : code;
}

/** Plain-English names for the entity types. Nobody should see `buyout_row`. */
export const TYPE_LABELS: Record<string, string> = {
  scenario: "Plan details",
  position: "Positions",
  position_pii: "Employee details",
  component_value: "Block inputs",
  buyout_row: "Manual overrides",
  manual_input_row: "Manual input lines",
  engine_run: "Calculation metadata",
};

export interface ReviewDialogProps {
  open: boolean;
  title: string;
  direction: "pull" | "publish";
  busy: boolean;
  byType: Record<string, number>;
  deletedByType?: Record<string, number>;
  total: number;
  deleted?: number;
  /** Rows outside the caller's write scope — publish only. */
  withheld?: number;
  /** Rows with no department: owner-only and never delegatable. */
  unclassified?: number;
  chunks?: number;
  /** Types this client build does not understand — the server is ahead of us. */
  skippedTypes?: string[];
  /** A support lease was handed back; the whole plan is being re-downloaded. */
  reset?: boolean;
  /**
   * Incoming rows that would land on local work that has never been published —
   * pull only.
   *
   * Zero is worth saying out loud, not just worth not-warning-about. The
   * situation it settles is common the moment delegation is in use: the owner
   * edits F&B, their delegate publishes Rooms, and the plan now reads as
   * DIVERGED with a two-way review in front of it. Those two sets cannot touch,
   * because a delegate writes only inside their own departments — so the honest
   * thing to show is "this overwrites nothing of yours", not a choice between
   * versions that was never a choice.
   */
  collides?: number;
  /** Departments the colliding rows are in, so the warning can name them. */
  collidingDepartments?: string[];
  /** Local rows not yet published, for phrasing the no-collision reassurance. */
  pendingChanges?: number;
  /**
   * Incoming rows by department — WHERE the download lands.
   *
   * The question an owner collecting a delegate's finished work is actually
   * asking, and the one a per-type count cannot answer. Rows with no department
   * of their own are bucketed under `UNCLASSIFIED_DEPARTMENT` and rendered as
   * "No department", so the chips always sum to `total`.
   */
  byDepartment?: Record<string, number>;
  /** Departments this machine has unpublished work in, for contrasting them. */
  pendingDepartments?: string[];
  /**
   * Departments to lead with, listed before the rest and picked out in colour.
   *
   * Set when the download was started from one delegate's card. The pull itself
   * is always whole-plan — the server has no per-delegate feed, `/changes` takes
   * only `since` and a cursor — so these are sorted to the front and the
   * remainder is still shown, never filtered away. Hiding the rest would make
   * the dialog lie about what is arriving.
   */
  highlightDepartments?: string[];
  /**
   * Offered instead of forcing an overwrite, when something WOULD be overwritten.
   *
   * Publishing first is very often what the user actually wants and there was no
   * way to get there from here without cancelling and hunting for the button.
   */
  onPublishFirst?: () => void;
  /**
   * Offer the button even when there is nothing to transfer.
   *
   * Set for a plan this computer does not hold. "Nothing to download" and
   * "nothing to do" are different things there: the download is also what puts
   * the plan in the local list, and a plan whose rows have all arrived before —
   * or which nobody has published into yet — otherwise gets a dialog with no
   * button on it and can never be brought onto this machine at all.
   */
  allowEmpty?: boolean;
  /**
   * The local plan this download takes the name of.
   *
   * Named here rather than only on the card, because the confirmation is the
   * last screen before a plan stops being listed — and by this point the user
   * has clicked past the card and is reading row counts.
   */
  replacesLabel?: string | null;
  /**
   * Override the plain-English names for the keys in `byType`.
   *
   * The hotel-setup diff comes back keyed by document section rather than by
   * entity type, and it deserves the same review step as a plan pull — it can
   * also overwrite work — so the dialog takes its vocabulary as a parameter
   * instead of hard-coding one domain's.
   */
  labels?: Record<string, string>;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ReviewDialog(props: ReviewDialogProps) {
  const {
    open,
    title,
    direction,
    busy,
    byType,
    deletedByType = {},
    total,
    deleted = 0,
    withheld = 0,
    unclassified = 0,
    chunks,
    skippedTypes = [],
    reset = false,
    collides = 0,
    collidingDepartments = [],
    pendingChanges = 0,
    byDepartment,
    pendingDepartments = [],
    highlightDepartments = [],
    onPublishFirst,
    allowEmpty = false,
    replacesLabel = null,
    labels = TYPE_LABELS,
    onConfirm,
    onClose,
  } = props;

  const entries = Object.entries(byType).filter(([, count]) => count > 0);
  const nothing = total === 0;

  // Highlighted departments first, then biggest first as before. The owner
  // opened this from somebody's card and is looking for their departments; the
  // rest still has to be visible, because it is also arriving.
  const highlighted = new Set(highlightDepartments);
  const departmentEntries = Object.entries(byDepartment ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => {
      const lead = Number(highlighted.has(b[0])) - Number(highlighted.has(a[0]));
      return lead !== 0 ? lead : b[1] - a[1];
    });

  /**
   * The verdict, decided once and used for both the banner and the button.
   *
   * "Download" had one label whatever it was about to do, so the safe case and
   * the destructive one looked identical — which made owners hesitate over the
   * one action that collects their delegate's finished work. `collides` is the
   * fact that separates them, and it is already computed from the actual rows.
   */
  const verdict: "additive" | "overwrites" | "quiet" =
    direction !== "pull" || pendingChanges === 0
      ? "quiet"
      : collides > 0
        ? "overwrites"
        : "additive";

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        {reset && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>Full re-download</AlertTitle>
            An administrator worked on this plan and has handed it back. The
            server&apos;s copy is authoritative, so everything is being downloaded
            again rather than merged.
          </Alert>
        )}

        {/* Only ever asked on a pull, and only worth answering when there IS
            unpublished work to be anxious about. */}
        {total > 0 && verdict === "overwrites" && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>
              {collides === 1
                ? "1 of these replaces a change of yours"
                : `${collides} of these replace changes of yours`}
            </AlertTitle>
            {collidingDepartments.length > 0 && (
              <>
                In <strong>{collidingDepartments.join(", ")}</strong>.{" "}
              </>
            )}
            The server&apos;s version of those {collides === 1 ? "rows" : "rows"}{" "}
            wins.
            {/* The clause that was missing, and the reason a partial collision
                read as though the whole plan were at risk. */}
            {pendingChanges > collides && (
              <>
                {" "}
                Your other{" "}
                {pendingChanges - collides === 1
                  ? "unpublished change is"
                  : `${pendingChanges - collides} unpublished changes are`}{" "}
                untouched.
              </>
            )}{" "}
            Publish yours first if you want to keep them.
          </Alert>
        )}

        {total > 0 && verdict === "additive" && (
          // The safe case, said as a verdict rather than as the absence of a
          // warning. This is the routine shape once delegation is in use: an
          // owner editing F&B collecting a delegate's Rooms, where the two sets
          // cannot touch by construction.
          <Alert severity="success" sx={{ mb: 2 }}>
            <AlertTitle>This adds to your work — it does not replace it</AlertTitle>
            {total} {total === 1 ? "row is" : "rows are"} arriving
            {departmentEntries.length > 0 && departmentEntries.length <= 4 && (
              <>
                , in{" "}
                <strong>
                  {departmentEntries
                    .map(([code]) => departmentLabel(code))
                    .join(", ")}
                </strong>
              </>
            )}
            . You have {pendingChanges === 1 ? "1 change" : `${pendingChanges} changes`}{" "}
            waiting to be published
            {pendingDepartments.length > 0 && (
              <>
                , in <strong>{pendingDepartments.map(departmentLabel).join(", ")}</strong>
              </>
            )}
            , and not one of the rows arriving is a row you have changed. Download
            now and publish yours afterwards as normal.
          </Alert>
        )}

        {replacesLabel && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>This replaces a plan on this computer</AlertTitle>
            <strong>{replacesLabel}</strong> is a different plan with the same
            name. After this download it stops being listed, along with anything
            in it that was never published.
          </Alert>
        )}

        {nothing ? (
          allowEmpty ? (
            <Alert severity="info">
              <AlertTitle>There are no rows to bring down</AlertTitle>
              The server holds this plan but has nothing in it for you that this
              computer does not already have — usually because nobody has
              published into it yet. Downloading still puts the plan on this
              computer, so it can be opened on the Positions page and published
              from here.
            </Alert>
          ) : (
            <Typography color="text.secondary">
              {direction === "pull"
                ? "Nothing has changed on the server since your last download."
                : "Everything here has already been published."}
            </Typography>
          )
        ) : (
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                {direction === "pull" ? "Will be downloaded" : "Will be sent"}
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                {entries.map(([type, count]) => (
                  <Chip
                    key={type}
                    size="small"
                    label={`${labels[type] ?? type}: ${count}`}
                    variant="outlined"
                  />
                ))}
              </Stack>

              {direction === "pull" && departmentEntries.length > 0 && (
                // Where, not just how much. An owner collecting a handed-back
                // department wants to recognise it by name.
                <Box sx={{ mt: 1.5 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mb: 0.5 }}
                  >
                    By department
                  </Typography>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                    {departmentEntries.slice(0, DEPARTMENT_CHIP_LIMIT).map(([code, count]) => (
                      <Chip
                        key={code}
                        size="small"
                        variant="outlined"
                        // The one distinction that matters on this list: which of
                        // these lands on something of mine. A collision outranks
                        // the highlight — it is the one that can cost work.
                        color={
                          collidingDepartments.includes(code)
                            ? "warning"
                            : highlighted.has(code)
                              ? "primary"
                              : "default"
                        }
                        label={`${departmentLabel(code)}: ${count}`}
                      />
                    ))}
                    {departmentEntries.length > DEPARTMENT_CHIP_LIMIT && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`+${departmentEntries.length - DEPARTMENT_CHIP_LIMIT} more`}
                      />
                    )}
                  </Stack>
                  {highlightDepartments.length > 0 && (
                    // Said plainly, because the button was pressed on one
                    // person's card and the rest of the plan arriving with it
                    // would otherwise be a surprise.
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: "block", mt: 1 }}
                    >
                      Downloading brings the whole plan, not just their departments.
                    </Typography>
                  )}
                </Box>
              )}
            </Box>

            {deleted > 0 && (
              <Alert severity="warning">
                <AlertTitle>
                  {deleted} {deleted === 1 ? "row will be deleted" : "rows will be deleted"}
                </AlertTitle>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
                  {Object.entries(deletedByType)
                    .filter(([, count]) => count > 0)
                    .map(([type, count]) => (
                      <Chip
                        key={type}
                        size="small"
                        color="warning"
                        label={`${labels[type] ?? type}: ${count}`}
                      />
                    ))}
                </Stack>
              </Alert>
            )}

            {withheld > 0 && (
              <Alert severity="info">
                {withheld} {withheld === 1 ? "row is" : "rows are"} outside the
                departments you can edit and will not be sent. They stay on this
                machine.
              </Alert>
            )}

            {unclassified > 0 && (
              // Worth its own line: these rows are legitimate but can never be
              // delegated, so a hotel wondering why a department cannot be
              // handed over needs to find them.
              <Alert severity="warning">
                {unclassified} {unclassified === 1 ? "row has" : "rows have"} no
                department. They can only ever be edited by the plan owner and
                cannot be delegated — set a department to change that.
              </Alert>
            )}

            {skippedTypes.length > 0 && (
              <Alert severity="warning">
                The server sent data this version of Kairos does not understand
                ({skippedTypes.join(", ")}). It has been skipped. Update the app
                to pick it up.
              </Alert>
            )}

            {chunks !== undefined && chunks > 1 && (
              <Typography variant="caption" color="text.secondary">
                Sent in {chunks} batches.
              </Typography>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {nothing && !allowEmpty ? "Close" : "Cancel"}
        </Button>
        {/* The way out that was missing. Somebody told their work is about to be
            replaced almost always wants to publish it first, and had to cancel
            and go looking for the button to do it. */}
        {verdict === "overwrites" && onPublishFirst && (
          <Button variant="outlined" onClick={onPublishFirst} disabled={busy}>
            Publish mine first
          </Button>
        )}
        {(!nothing || allowEmpty) && (
          <Button
            variant="contained"
            onClick={onConfirm}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
            color={deleted > 0 || verdict === "overwrites" ? "warning" : "primary"}
          >
            {direction !== "pull"
              ? "Publish"
              : nothing
                ? "Add to this computer"
                : verdict === "overwrites"
                  ? `Download and replace ${collides} ${collides === 1 ? "row" : "rows"}`
                  : verdict === "additive"
                    ? "Add these changes"
                    : "Download and apply"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

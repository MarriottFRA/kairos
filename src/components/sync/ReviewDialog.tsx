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
    labels = TYPE_LABELS,
    onConfirm,
    onClose,
  } = props;

  const entries = Object.entries(byType).filter(([, count]) => count > 0);
  const nothing = total === 0;

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

        {nothing ? (
          <Typography color="text.secondary">
            {direction === "pull"
              ? "Nothing has changed on the server since your last download."
              : "Everything here has already been published."}
          </Typography>
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
          {nothing ? "Close" : "Cancel"}
        </Button>
        {!nothing && (
          <Button
            variant="contained"
            onClick={onConfirm}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
            color={deleted > 0 ? "warning" : "primary"}
          >
            {direction === "pull" ? "Download and apply" : "Publish"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

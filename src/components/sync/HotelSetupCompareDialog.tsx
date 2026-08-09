/**
 * What is different between this computer's hotel setup and the hotel's.
 * ---------------------------------------------------------------------------
 * The card can only ever say "Columns: 2". This says WHICH two, and what about
 * them — the question anybody looking at a divergence is actually asking, and
 * the one no screen in the app could answer before.
 *
 * ## Why one screen for both directions
 *
 * The setup diverges in two directions at once and they are not independent
 * problems: a colleague renamed a column while you added one, and what you want
 * is neither "download" nor "publish" on its own. Splitting them across a card
 * and a confirmation dialog made that state unreadable — the counts sat side by
 * side with no way to see what either was about, and the only button in front of
 * the download was a generic review dialog that showed the same counts again.
 *
 * ## Why the columns never swap
 *
 * "This computer" is always the left column and "the hotel" always the right,
 * whichever direction the row belongs to. `mergeStructureDoc` is run both ways
 * round, so its `base`/`incoming` mean the opposite thing in the two lists —
 * that is unpicked here, once, rather than left for the reader. A diff whose
 * columns change places halfway down the list is worse than no diff.
 */

import { useMemo, useState } from "react";
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
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { StructureChange } from "../../shared/kairosSync/structureDoc";
import { STRUCTURE_LABELS, fieldLabel } from "./HotelSetupCard";

/** Above this a section becomes a wall; the rest is one click away. */
const ROWS_PER_SECTION = 25;

/**
 * Which side of the divergence a row came from.
 *
 * `download` is the hotel's copy differing from this one; `local` is this one
 * differing from the hotel's. The same row can appear on both.
 */
type Side = "download" | "local";

type Filter = "both" | "download" | "local";

interface CompareRow {
  change: StructureChange;
  side: Side;
}

export interface HotelSetupCompareDialogProps {
  open: boolean;
  /** What downloading would change here. */
  incoming: StructureChange[];
  /** What publishing would change for everybody else. */
  outgoing: StructureChange[];
  busy: boolean;
  /** Owns a plan at this hotel, so `PUT /ou/{ou}/structure` will not 403. */
  canPublish: boolean;
  onDownload: () => void;
  onPublish: () => void;
  /** Download, then publish the result. Offered only when both sides differ. */
  onSyncBoth: () => void;
  onClose: () => void;
}

/**
 * What a change means, in the direction it was found.
 *
 * `added` and `removed` say opposite things on the two sides and the card used
 * to word them identically — "Adds Columns — Overtime" is true of a colleague's
 * new column and of your own unpublished one, and they need entirely different
 * responses.
 */
function kindLabel(change: StructureChange, side: Side): string {
  if (side === "download") {
    return change.kind === "added"
      ? "New at this hotel"
      : change.kind === "removed"
        ? "Deleted at this hotel"
        : "Changed at this hotel";
  }
  return change.kind === "added"
    ? "Only on this computer"
    : change.kind === "removed"
      ? "You deleted this"
      : "Changed on this computer";
}

/** The one-line explanation for a row that has no field-by-field comparison. */
function wholeRowNote(change: StructureChange, side: Side): string | null {
  if (change.kind === "updated") return null;
  if (side === "download") {
    return change.kind === "added"
      ? "Not on this computer yet. Downloading adds it."
      : "Removed at this hotel. Downloading removes it here too.";
  }
  return change.kind === "added"
    ? "Not on the server yet. Publishing adds it for everybody."
    : "Deleted here but still on the server. Publishing removes it for everybody.";
}

export default function HotelSetupCompareDialog({
  open,
  incoming,
  outgoing,
  busy,
  canPublish,
  onDownload,
  onPublish,
  onSyncBoth,
  onClose,
}: HotelSetupCompareDialogProps) {
  const [filter, setFilter] = useState<Filter>("both");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo<CompareRow[]>(
    () => [
      ...incoming.map((change) => ({ change, side: "download" as const })),
      ...outgoing.map((change) => ({ change, side: "local" as const })),
    ],
    [incoming, outgoing]
  );

  const visible = useMemo(
    () =>
      filter === "both"
        ? rows
        : rows.filter((row) => (filter === "download" ? row.side === "download" : row.side === "local")),
    [rows, filter]
  );

  /** Grouped by section, in the document's own section order. */
  const sections = useMemo(() => {
    const grouped = new Map<string, CompareRow[]>();
    for (const row of visible) {
      const bucket = grouped.get(row.change.section);
      if (bucket) bucket.push(row);
      else grouped.set(row.change.section, [row]);
    }
    return [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [visible]);

  const bothWays = incoming.length > 0 && outgoing.length > 0;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>What&apos;s different</DialogTitle>
      <DialogContent dividers>
        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", mb: 2 }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={filter}
            onChange={(_event, next: Filter | null) => next && setFilter(next)}
          >
            <ToggleButton value="both">Both</ToggleButton>
            <ToggleButton value="download">To download ({incoming.length})</ToggleButton>
            <ToggleButton value="local">Only here ({outgoing.length})</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {bothWays && filter === "both" && (
          // The state the card could describe but never resolve: a colleague
          // changed the hotel's copy while this machine changed its own, and
          // neither button on its own gets to a setup that has both.
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>Both copies have changed</AlertTitle>
            This hotel&apos;s setup and this computer&apos;s have each moved on
            since they last agreed.{" "}
            {canPublish
              ? "Bring both together downloads the hotel's changes and then publishes the result, so nothing on either side is lost."
              : "Downloading brings the hotel's changes here and keeps your own — nothing of yours is discarded."}
          </Alert>
        )}

        {visible.length === 0 ? (
          <Typography color="text.secondary">
            Your setup matches the hotel&apos;s copy.
          </Typography>
        ) : (
          <Stack spacing={2} divider={<Divider flexItem />}>
            {sections.map(([section, sectionRows]) => {
              const showAll = expanded.has(section);
              const shown = showAll
                ? sectionRows
                : sectionRows.slice(0, ROWS_PER_SECTION);
              const hidden = sectionRows.length - shown.length;

              return (
                <Box key={section}>
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>
                    {STRUCTURE_LABELS[section] ?? section}{" "}
                    <Typography component="span" variant="caption" color="text.secondary">
                      ({sectionRows.length})
                    </Typography>
                  </Typography>

                  <Stack spacing={1.5}>
                    {shown.map((row) => (
                      <ChangeRow
                        key={`${row.side}:${row.change.section}:${row.change.key}`}
                        row={row}
                      />
                    ))}
                  </Stack>

                  {hidden > 0 && (
                    <Button
                      size="small"
                      sx={{ mt: 1 }}
                      onClick={() =>
                        setExpanded((current) => new Set(current).add(section))
                      }
                    >
                      Show {hidden} more
                    </Button>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}

        {visible.length > 0 && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 2 }}
          >
            Everything not listed here is the same on both.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        {incoming.length > 0 && (
          <Button
            variant={bothWays && canPublish ? "outlined" : "contained"}
            onClick={onDownload}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
          >
            Download
          </Button>
        )}
        {canPublish && (
          <Button
            variant={bothWays ? "outlined" : "contained"}
            color="warning"
            onClick={onPublish}
            disabled={busy}
          >
            Publish mine
          </Button>
        )}
        {/* Offered only when it does something neither neighbour does. With
            one-sided drift it IS Download, or it IS Publish, and a third button
            that duplicates one of them is worse than no button. */}
        {canPublish && bothWays && (
          <Button variant="contained" color="warning" onClick={onSyncBoth} disabled={busy}>
            Bring both together
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** One divergent row: what it is, which way it goes, and field by field why. */
function ChangeRow({ row }: { row: CompareRow }) {
  const { change, side } = row;
  const note = wholeRowNote(change, side);

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {change.label}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          color={side === "download" ? "info" : "warning"}
          icon={side === "download" ? <ArrowBackIcon /> : <ArrowForwardIcon />}
          label={kindLabel(change, side)}
        />
      </Stack>

      {note ? (
        <Typography variant="caption" color="text.secondary">
          {note}
        </Typography>
      ) : (
        <Box
          sx={{
            mt: 0.5,
            display: "grid",
            // The label column is fixed so the two value columns line up down
            // the whole list, which is what makes it scannable.
            gridTemplateColumns: "minmax(120px, 0.8fr) 1fr 1fr",
            columnGap: 1.5,
            rowGap: 0.25,
            alignItems: "baseline",
          }}
        >
          <Typography variant="caption" color="text.secondary" />
          <Typography variant="caption" color="text.secondary">
            This computer
          </Typography>
          <Typography variant="caption" color="text.secondary">
            The hotel
          </Typography>

          {(change.fields ?? []).map((diff) => {
            // `base` is whichever document the merge started from, so it is the
            // local copy in the download list and the hotel's in the other. The
            // columns stay put; only the source swaps.
            const mine = side === "download" ? diff.base : diff.incoming;
            const theirs = side === "download" ? diff.incoming : diff.base;
            return (
              <Box key={diff.field} sx={{ display: "contents" }}>
                <Typography variant="caption" color="text.secondary">
                  {fieldLabel(diff.field)}
                </Typography>
                <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
                  {mine}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ wordBreak: "break-word", fontWeight: 500 }}
                >
                  {theirs}
                </Typography>
              </Box>
            );
          })}

          {change.moreFields ? (
            <Typography variant="caption" color="text.secondary" sx={{ gridColumn: "1 / -1" }}>
              …and {change.moreFields} more{" "}
              {change.moreFields === 1 ? "field" : "fields"}.
            </Typography>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

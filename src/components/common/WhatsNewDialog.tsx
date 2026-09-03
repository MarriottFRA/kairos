/**
 * The "What's new" note itself.
 * -----------------------------------------------------------
 * Content comes from shared/updates/releases.ts; this file is only how it
 * reads. Every colour is a theme token (`text.secondary`, `divider`,
 * `action.hover`, `primary.main`) rather than a literal, so the note follows
 * the app's light/dark setting like every other surface — a hardcoded panel
 * would be the one white rectangle in a dark app.
 *
 * No build number anywhere on purpose: notes are numbered, not versioned (see
 * releases.ts), and the app's own version rolls on a different cadence. The
 * date is what a reader wants — "is this the thing I was told about last week".
 *
 * The newest note is shown open and every older one is kept below it, collapsed
 * behind its date. Notes are the only place a feature is ever announced, so a
 * note that scrolled off the end would take its features with it — and "already
 * there, nobody knew" is the problem this whole feature exists to fix.
 */

import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import {
  LATEST_UPDATE,
  UPDATE_NOTES,
  UpdateItem,
  UpdateNote,
} from "../../shared/updates/releases";

export interface WhatsNewDialogProps {
  open: boolean;
  onClose: () => void;
}

/** "2026-09-02" -> "2 September 2026". Falls back to the raw string. */
function formatNoteDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Section heading — quiet, uppercase, with a rule running to the edge. */
function SectionHeading({ children, first }: { children: string; first?: boolean }) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ alignItems: "center", mt: first ? 0.5 : 3, mb: 1.5 }}
    >
      <Typography
        variant="overline"
        sx={{ color: "text.secondary", letterSpacing: ".08em", lineHeight: 1 }}
      >
        {children}
      </Typography>
      <Divider sx={{ flexGrow: 1 }} />
    </Stack>
  );
}

/** A headline change: name, the "New" tag, where it lives, what it does. */
function NewItemCard({ item }: { item: UpdateItem }) {
  return (
    <Box
      sx={{
        p: 1.75,
        borderRadius: 1.5,
        border: 1,
        borderColor: "divider",
        bgcolor: "action.hover",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "baseline", flexWrap: "wrap", rowGap: 0.5 }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {item.title}
        </Typography>
        <Chip
          label="New"
          size="small"
          color="primary"
          sx={{
            height: 18,
            fontSize: "0.625rem",
            fontWeight: 700,
            letterSpacing: ".04em",
            "& .MuiChip-label": { px: 0.75 },
          }}
        />
        {!!item.where && (
          <Typography variant="caption" sx={{ color: "text.disabled" }}>
            {item.where}
          </Typography>
        )}
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.75 }}>
        {item.body}
      </Typography>
    </Box>
  );
}

/**
 * One note's three sections. Every one of them is optional and any of them can
 * lead: a note may be a single improvement with no headline feature behind it,
 * and an empty section would otherwise draw its heading over nothing. `first`
 * only trims the top margin, so it belongs to whichever section actually shows
 * up first rather than permanently to New.
 */
function NoteSections({ note }: { note: UpdateNote }) {
  const noNew = note.new.length === 0;
  return (
    <>
      {!noNew && (
        <>
          <SectionHeading first>New</SectionHeading>
          <Stack spacing={1.25}>
            {note.new.map((item) => (
              <NewItemCard key={item.title} item={item} />
            ))}
          </Stack>
        </>
      )}

      {note.improved.length > 0 && (
        <>
          <SectionHeading first={noNew}>Improved</SectionHeading>
          <Stack spacing={1.5}>
            {note.improved.map((item) => (
              <Box key={item.title}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  {item.title}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {item.body}
                </Typography>
              </Box>
            ))}
          </Stack>
        </>
      )}

      {note.fixes.length > 0 && (
        <>
          <SectionHeading first={noNew && note.improved.length === 0}>
            Fixes &amp; optimisations
          </SectionHeading>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {note.fixes.map((fix) => (
              <Typography
                key={fix}
                component="li"
                variant="body2"
                sx={{ color: "text.secondary", mb: 0.5 }}
              >
                {fix}
              </Typography>
            ))}
          </Box>
        </>
      )}
    </>
  );
}

export default function WhatsNewDialog({ open, onClose }: WhatsNewDialogProps) {
  const note = LATEST_UPDATE;
  // Everything ever announced, still reachable. A note is only "latest" for as
  // long as the next one takes to arrive, and a one-line improvement pushing ten
  // features out of the app for good is not what the bell is for. Collapsed, so
  // the note the bell is actually about is still the thing you see.
  const earlier = UPDATE_NOTES.slice(1);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: 2 } } }}
      aria-labelledby="whats-new-title"
    >
      <DialogTitle
        id="whats-new-title"
        sx={{ display: "flex", alignItems: "flex-start", gap: 1.5, pb: 1.5 }}
      >
        <AutoAwesomeOutlinedIcon fontSize="small" sx={{ color: "primary.main", mt: 0.5 }} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h6" component="div" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
            What&rsquo;s new
          </Typography>
          <Typography variant="caption" sx={{ color: "text.disabled" }}>
            {formatNoteDate(note.date)}
          </Typography>
        </Box>
        <IconButton
          onClick={onClose}
          size="small"
          aria-label="Close"
          sx={{ color: "text.secondary", mt: -0.5, mr: -0.5 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <NoteSections note={note} />

        {earlier.length > 0 && (
          <>
            <SectionHeading>Earlier updates</SectionHeading>
            {earlier.map((old) => (
              <Accordion
                key={old.id}
                // Per note, so an older release that still deserves reading is
                // open on arrival rather than folded away behind a date nobody
                // clicks. See UpdateNote.startOpen.
                defaultExpanded={old.startOpen ?? false}
                disableGutters
                elevation={0}
                square
                sx={{
                  bgcolor: "transparent",
                  "&:before": { display: "none" },
                  borderTop: 1,
                  borderColor: "divider",
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon fontSize="small" />}
                  sx={{ px: 0, minHeight: 0, "& .MuiAccordionSummary-content": { my: 1 } }}
                >
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {formatNoteDate(old.date)}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0, pt: 0, pb: 2 }}>
                  <NoteSections note={old} />
                </AccordionDetails>
              </Accordion>
            ))}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} variant="contained" disableElevation size="small">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

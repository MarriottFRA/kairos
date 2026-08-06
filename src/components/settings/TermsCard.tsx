/**
 * TermsCard — the Settings entry point for the terms of use.
 *
 * Shows the acceptance on record for this install (version, who, when) and
 * reopens the same text read-only. The acceptance itself is made once in the
 * shell's gate; this card never re-asks, it only lets someone check what they
 * agreed to.
 */

import { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import GavelIcon from "@mui/icons-material/Gavel";

import { TERMS_TITLE, TERMS_VERSION } from "../../shared/legal/terms";
import { SETTINGS_KEYS, settingsService } from "../../services/settingsService";
import TermsContent from "../legal/TermsContent";

/** "2 August 2026, 14:31" — a record line, not a data field, so keep it plain. */
function formatAccepted(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function TermsCard() {
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<{
    version: string;
    by: string;
    at: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    settingsService
      .getSettings(
        SETTINGS_KEYS.TERMS_ACCEPTED_VERSION,
        SETTINGS_KEYS.TERMS_ACCEPTED_BY,
        SETTINGS_KEYS.TERMS_ACCEPTED_AT
      )
      .then((s) => {
        if (cancelled) return;
        setRecord({
          version: s[SETTINGS_KEYS.TERMS_ACCEPTED_VERSION],
          by: s[SETTINGS_KEYS.TERMS_ACCEPTED_BY],
          at: s[SETTINGS_KEYS.TERMS_ACCEPTED_AT],
        });
      })
      .catch((err) => console.error("Failed to read terms acceptance:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      variant="outlined"
      sx={{ borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}
    >
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", mb: 1 }}
        >
          <GavelIcon fontSize="small" sx={{ color: "text.secondary" }} />
          <Typography variant="h6">Terms of use</Typography>
        </Stack>

        <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
          Kairos is provided as is. You control the inputs and remain
          responsible for reviewing every figure it produces before it is used
          or relied upon.
        </Typography>

        <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 2 }}>
          {record?.version
            ? `Accepted by ${record.by || "unknown user"} on ${formatAccepted(record.at)} (version ${record.version}${
                record.version === TERMS_VERSION ? "" : `, current version is ${TERMS_VERSION}`
              }).`
            : "No acceptance recorded on this device yet."}
        </Typography>

        <Button
          variant="outlined"
          onClick={() => setOpen(true)}
          sx={{ textTransform: "none" }}
        >
          Review terms
        </Button>
      </CardContent>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 700 }}>{TERMS_TITLE}</DialogTitle>
        <DialogContent dividers>
          <TermsContent />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} sx={{ textTransform: "none" }}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

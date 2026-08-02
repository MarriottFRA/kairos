/**
 * TermsAcceptanceGate — the one-time "read this before you use the numbers"
 * modal, mounted once in the signed-in shell so it appears over whatever page
 * the user lands on.
 *
 * Acceptance is recorded in the local settings store as a (version, user,
 * timestamp) triple. It re-prompts when either half of the pair moves:
 *   - TERMS_VERSION changes — the terms were re-worded and need re-reading;
 *   - a different account signs in on this install — responsibility for
 *     reviewing output is personal, so one colleague cannot accept for another.
 *
 * The dialog is deliberately hard to dismiss: no backdrop click, no Escape, no
 * close icon. The only ways out are Accept (recorded) or Decline (signs out) —
 * an acknowledgement that can be waved away with Escape is not one.
 */

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import {
  TERMS_ACKNOWLEDGEMENT,
  TERMS_INTRO,
  TERMS_TITLE,
  TERMS_VERSION,
} from "../../shared/legal/terms";
import { SETTINGS_KEYS, settingsService } from "../../services/settingsService";
import TermsContent from "./TermsContent";

interface Props {
  /** Signed-in user's email. The gate stays shut until this resolves. */
  userEmail: string;
  /** Invoked when the user declines — the shell signs them out. */
  onDecline: () => void;
}

export default function TermsAcceptanceGate({ userEmail, onDecline }: Props) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Decide once per signed-in user. Without an email we cannot record who
  // accepted, so we hold off rather than prompt anonymously.
  useEffect(() => {
    if (!userEmail) return;
    let cancelled = false;

    const check = async () => {
      try {
        const accepted = await settingsService.getSettings(
          SETTINGS_KEYS.TERMS_ACCEPTED_VERSION,
          SETTINGS_KEYS.TERMS_ACCEPTED_BY
        );
        if (cancelled) return;
        const current =
          accepted[SETTINGS_KEYS.TERMS_ACCEPTED_VERSION] === TERMS_VERSION &&
          accepted[SETTINGS_KEYS.TERMS_ACCEPTED_BY] === userEmail;
        if (!current) setOpen(true);
      } catch (err) {
        // A settings read failure should not lock the user out of the app.
        console.error("Failed to read terms acceptance:", err);
      }
    };

    check();
    return () => {
      cancelled = true;
    };
  }, [userEmail]);

  const handleAccept = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await settingsService.setSettings({
        [SETTINGS_KEYS.TERMS_ACCEPTED_VERSION]: TERMS_VERSION,
        [SETTINGS_KEYS.TERMS_ACCEPTED_BY]: userEmail,
        [SETTINGS_KEYS.TERMS_ACCEPTED_AT]: new Date().toISOString(),
      });
      setOpen(false);
    } catch (err) {
      console.error("Failed to record terms acceptance:", err);
      setError(
        "Your acceptance could not be saved. Please try again — if this keeps " +
          "happening, report it through Help & Support."
      );
    } finally {
      setSaving(false);
    }
  }, [userEmail]);

  const handleDecline = useCallback(() => {
    setOpen(false);
    onDecline();
  }, [onDecline]);

  return (
    <Dialog
      open={open}
      // Modal by design: a no-op onClose swallows both the backdrop click and
      // Escape, so Accept and Decline are the only exits.
      onClose={() => undefined}
      maxWidth="sm"
      fullWidth
      aria-labelledby="terms-acceptance-title"
    >
      <DialogTitle id="terms-acceptance-title" sx={{ fontWeight: 700, pb: 1 }}>
        {TERMS_TITLE}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {TERMS_INTRO}
          </Typography>
          <Divider />
          <TermsContent />
        </Stack>
      </DialogContent>
      {/* Outside DialogContent on purpose: a second content block would share
          the scroll area's flex sizing and shrink as the terms grow. The
          acknowledgement must stay pinned above the buttons. */}
      <Box sx={{ px: 3, pt: 2 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              sx={{ alignSelf: "flex-start", pt: 0 }}
            />
          }
          label={
            <Typography variant="body2">{TERMS_ACKNOWLEDGEMENT}</Typography>
          }
          sx={{ alignItems: "flex-start", mr: 0 }}
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </Box>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          onClick={handleDecline}
          disabled={saving}
          sx={{ textTransform: "none" }}
        >
          Decline and sign out
        </Button>
        <Button
          variant="contained"
          onClick={handleAccept}
          disabled={!checked || saving}
          sx={{ textTransform: "none" }}
        >
          Accept and continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}

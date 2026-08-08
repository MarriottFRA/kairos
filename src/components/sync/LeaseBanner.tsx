/**
 * "Support is working on this plan."
 * -----------------------------------------------------------
 * Shown to the hotel, not only to the administrator holding the lease. An owner
 * whose publish just came back 423 needs to know who has it, under what
 * reference, and until when — otherwise the failure is inexplicable and the
 * obvious response is to keep pressing the button.
 *
 * The stored `reason` never travels; it can name a defect, a customer, or
 * another property. Only `ticketRef` does, which is exactly enough to ask about.
 *
 * A `READ_ONLY_SUPPORT` lease is deliberately styled as information rather than
 * a warning: it changes nothing about what the hotel may do, and dressing it as
 * an alarm would teach people to ignore the one that is.
 */

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Lease } from "../../shared/kairosSync/protocol";

export interface LeaseBannerProps {
  lease: Lease;
  /** True when the signed-in user is the one holding it. */
  mine: boolean;
  busy?: boolean;
  onExtend?: () => void;
  onRelease?: () => void;
}

export default function LeaseBanner({
  lease,
  mine,
  busy,
  onExtend,
  onRelease,
}: LeaseBannerProps) {
  const exclusive = lease.mode === "EXCLUSIVE";

  return (
    <Alert severity={exclusive ? "warning" : "info"} sx={{ mt: 2 }}>
      <AlertTitle>
        {mine
          ? exclusive
            ? "You hold this plan"
            : "You are reading this plan under a lease"
          : exclusive
            ? "Support is working on this plan"
            : "Support is looking at this plan"}
      </AlertTitle>

      <Typography variant="body2">
        {lease.adminEmail}
        {lease.ticketRef ? ` · ${lease.ticketRef}` : ""} · until{" "}
        {formatUntil(lease.expiresAt)}.
      </Typography>

      <Typography variant="body2" sx={{ mt: 0.5 }}>
        {exclusive
          ? mine
            ? "Nobody at the hotel can edit or publish while you hold this. Release it as soon as you are done."
            : "You cannot edit or publish this plan until it is released. Nothing you have already saved on this machine is lost."
          : "Nothing about your access has changed — this is recorded so that reading your data is never anonymous."}
      </Typography>

      {mine && (onExtend || onRelease) && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          {onExtend && (
            <Button size="small" disabled={busy} onClick={onExtend}>
              Extend
            </Button>
          )}
          {onRelease && (
            <Button size="small" variant="outlined" disabled={busy} onClick={onRelease}>
              Release
            </Button>
          )}
        </Stack>
      )}
    </Alert>
  );
}

function formatUntil(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "an unknown time";
  return new Date(parsed).toLocaleString();
}

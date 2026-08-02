/**
 * BetaNotice — the "we are still building this" panel on Home
 * -----------------------------------------------------------
 * Sits under the calendar card, deliberately after the work rather than above
 * it: a hotel opens Home to key numbers in, not to read us. It is a message
 * from the team, so it is styled as a quiet tinted panel rather than a banner
 * or an Alert — the app already uses Alert for things that need acting on, and
 * borrowing that vocabulary here would make an introduction look like a fault.
 */

import { ReactNode } from "react";
import { Box, Button, Chip, Link, Paper, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import EmailOutlinedIcon from "@mui/icons-material/EmailOutlined";
import LightbulbOutlinedIcon from "@mui/icons-material/LightbulbOutlined";
import BugReportOutlinedIcon from "@mui/icons-material/BugReportOutlined";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";

// The EMEA reporting inbox the rest of the tool already points at (see
// Help & Support). One address, so a reply never depends on which screen the
// user happened to be on when they wrote in.
const SUPPORT_EMAIL = "emeapowerBIsupport@marriott.com";

const MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Kairos — feedback")}`;

/** One of the three things worth writing in about. */
function Point({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ flex: "1 1 220px", minWidth: 220 }}>
      <Box
        sx={{
          flexShrink: 0,
          width: 32,
          height: 32,
          borderRadius: 1.5,
          display: "grid",
          placeItems: "center",
          color: "primary.main",
          bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
        }}
      >
        {icon}
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.4 }}>
          {title}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {children}
        </Typography>
      </Box>
    </Stack>
  );
}

export default function BetaNotice() {
  return (
    <Paper
      elevation={0}
      sx={{
        mt: 3,
        p: 3,
        borderRadius: 3,
        border: 1,
        borderColor: "divider",
        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.03),
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
        <Chip
          size="small"
          label="Beta"
          color="primary"
          sx={{ height: 22, fontWeight: 700, letterSpacing: "0.04em" }}
        />
        {/* Build-time define, same one the login footer and Settings show — the
            version is what makes "shipping most days" checkable rather than a
            claim, so it sits in the header line and not in the small print. */}
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
        >
          v{__APP_VERSION__}
        </Typography>
        <Box sx={{ width: 3, height: 3, borderRadius: "50%", bgcolor: "text.disabled" }} />
        {/* A live dot, not an animation: the point is that the tool is moving,
            and a pulsing element next to body copy is a distraction on a page
            people sit on for a long time. */}
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
          <Box
            sx={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              bgcolor: "success.main",
            }}
          />
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            In active development
          </Typography>
        </Stack>
      </Stack>

      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
        Built in-house by the EMEA FR&amp;A team
      </Typography>

      <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 760, mb: 1.25 }}>
        Kairos is one of the first tools we have taken on end to end ourselves, and it is
        still early. We are shipping improvements most days — new capability, refinements
        to what is already here, and fixes for the things you tell us are wrong.
      </Typography>

      <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 760, mb: 2.5 }}>
        We would rather hear from you than not. Feature requests, a workflow that fights
        you, or a number that does not look right — write to us. It is read by the people
        building the tool, and it is what decides what we work on next.
      </Typography>

      <Stack direction="row" sx={{ flexWrap: "wrap", gap: 2.5, mb: 2.5 }}>
        <Point icon={<LightbulbOutlinedIcon fontSize="small" />} title="Requests & ideas">
          Tell us what the tool should do next, or what it should stop doing.
        </Point>
        <Point icon={<BugReportOutlinedIcon fontSize="small" />} title="Bugs & odd numbers">
          A figure that looks wrong is always worth an email. So is a screen that feels wrong.
        </Point>
        <Point icon={<ShieldOutlinedIcon fontSize="small" />} title="Data-safe updates">
          The Excel tools before this never destroyed your work across an update. Kairos
          holds that line, and aims to raise it: updates migrate your data forward, never
          over it.
        </Point>
      </Stack>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1.5}
        sx={{ alignItems: { sm: "center" } }}
      >
        <Button
          variant="contained"
          disableElevation
          startIcon={<EmailOutlinedIcon />}
          href={MAILTO}
          sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 600, px: 2.5 }}
        >
          Email the team
        </Button>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          <Link href={MAILTO} underline="hover">
            {SUPPORT_EMAIL}
          </Link>
        </Typography>
      </Stack>

      <Typography
        variant="caption"
        sx={{ display: "block", color: "text.disabled", mt: 2.5, fontStyle: "italic" }}
      >
        Thank you for using it this early, and for telling us what it still needs.
        — EMEA FR&amp;A
      </Typography>
    </Paper>
  );
}

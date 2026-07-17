/**
 * SessionGate — the app entry ("/").
 * -----------------------------------------------------------
 * Decides where a launching/returning user lands, so a valid session-holder is
 * NEVER forced back through the Microsoft entrance. The broker gate is only for
 * minting a NEW session (login/register); resume is device/refresh-token based
 * and Microsoft-free.
 *
 * Routing (in priority order):
 *   - Signed in (Level 2, device-verified)         -> straight into the app.
 *   - Resume in flight (token MIGHT be valid)      -> optimistic "restoring"
 *     splash with a "Sign in instead" escape hatch (never a hard freeze). The
 *     fast LOCAL pre-check means a provably-dead token skips this entirely.
 *   - No resumable session (or resume finished unauthenticated) -> Landing with
 *     the Microsoft entrance.
 */

import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import authService from "../services/auth";
import { useAuthStatus } from "../hooks/useAuthStatus";
import Landing from "./landing";

/** Reveal the "Sign in instead" escape hatch after this long (ms). */
const ESCAPE_HATCH_DELAY_MS = 2500;

const RestoringSplash: React.FC<{ onSignInInstead: () => void }> = ({
  onSignInInstead,
}) => {
  const [showEscape, setShowEscape] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowEscape(true), ESCAPE_HATCH_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        height: "100vh",
        display: "grid",
        placeItems: "center",
        bgcolor: "background.default",
      }}
    >
      <Stack alignItems="center" spacing={3}>
        <CircularProgress size={48} thickness={2} sx={{ color: "#8b5cf6" }} />
        <Typography variant="body1" color="text.secondary">
          Welcome back — restoring your session…
        </Typography>
        {showEscape && (
          <Button
            variant="text"
            size="small"
            onClick={onSignInInstead}
            sx={{ textTransform: "none" }}
          >
            Sign in instead
          </Button>
        )}
      </Stack>
    </Box>
  );
};

const SessionGate: React.FC = () => {
  const { status, resumable } = useAuthStatus();
  const resolved = authService.isResumeResolved();
  const [bailed, setBailed] = useState(false);

  // Signed in this run (device-verified) -> straight into the app.
  if (status.securityLevel >= 2) {
    return <Navigate to="/signed-in-landing/home" replace />;
  }

  // Resume still in flight and the user hasn't bailed -> optimistic splash.
  if (resumable && !resolved && !bailed) {
    return <RestoringSplash onSignInInstead={() => setBailed(true)} />;
  }

  // No resumable session, resume failed, or the user chose to sign in now.
  return <Landing />;
};

export default SessionGate;

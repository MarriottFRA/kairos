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
import authService from "../services/auth";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { useThemeMode } from "../store/settings";
import Landing from "./landing";
import "../styles/auth.css";

/** Reveal the "Sign in instead" escape hatch after this long (ms). */
const ESCAPE_HATCH_DELAY_MS = 2500;

/**
 * Restoring-session splash. Uses the same clean auth-card layout as the
 * device-verification screen so the pre-app surfaces feel like one product.
 */
const RestoringSplash: React.FC<{ onSignInInstead: () => void }> = ({
  onSignInInstead,
}) => {
  const isDark = useThemeMode() === "dark";
  const [showEscape, setShowEscape] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowEscape(true), ESCAPE_HATCH_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className={`auth-container${isDark ? " theme-dark" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="auth-card device-verify">
        <div className="device-icon verifying">
          <div className="device-animation">
            <svg
              width="80"
              height="80"
              viewBox="0 0 80 80"
              fill="none"
              className="device-shield"
            >
              <path
                d="M40 10L15 22v20c0 13.255 10.745 28 25 28s25-14.745 25-28V22L40 10z"
                stroke="url(#restoreGradient)"
                strokeWidth="2"
                fill="none"
                opacity="0.35"
              />
              <path
                d="M30 40l8 8 16-16"
                stroke="url(#restoreGradient)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <defs>
                <linearGradient id="restoreGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--primary-blue)" />
                  <stop offset="100%" stopColor="var(--primary-purple)" />
                </linearGradient>
              </defs>
            </svg>
            <div className="pulse-ring" />
          </div>
        </div>

        <h2 className="auth-title">Welcome back</h2>
        <p className="auth-subtitle">Restoring your session…</p>

        {showEscape && (
          <button
            type="button"
            onClick={onSignInInstead}
            style={{
              marginTop: 20,
              background: "transparent",
              border: "none",
              color: "var(--primary-blue)",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Sign in instead
          </button>
        )}
      </div>
    </div>
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

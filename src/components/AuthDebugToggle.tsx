/**
 * TEMPORARY sign-in tracing toggle — DELETE WITH `main/auth/authDebug.ts`.
 * -----------------------------------------------------------
 * A deliberately discreet control for the sign-in screens: a small, almost
 * invisible dot in the bottom-left corner. Clicking it (or pressing
 * Ctrl+Shift+Alt+D anywhere on the page) turns on tracing of the Microsoft
 * sign-in window; the dot then goes red and pulses, so it is obvious when
 * tracing is live and nobody leaves it on by accident.
 *
 * Tracing itself lives in the main process — this component only flips the
 * switch and mirrors its state. Nothing is written to disk; the diagnostics
 * window that appears has a "Copy all" button for pasting into Teams/email.
 */

import { useCallback, useEffect, useState } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';

/** Same chord the sign-in window itself listens for. */
const CHORD_LABEL = 'Ctrl+Shift+Alt+D';

type TraceApi = {
  debugTraceGet?: () => Promise<{ on: boolean }>;
  debugTraceSet?: (p?: { on?: boolean }) => Promise<{ on: boolean }>;
  onDebugTraceChanged?: (cb: (state: { on: boolean }) => void) => void;
  offDebugTraceChanged?: (cb: (state: { on: boolean }) => void) => void;
};

function traceApi(): TraceApi | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { authApi?: TraceApi }).authApi as TraceApi) ?? null;
}

export default function AuthDebugToggle() {
  const [on, setOn] = useState(false);

  // Mirror main's state, including changes made from the sign-in window's own
  // chord or by the user closing the diagnostics window.
  useEffect(() => {
    const api = traceApi();
    if (!api?.debugTraceGet) return;

    let alive = true;
    void api.debugTraceGet().then((s) => {
      if (alive) setOn(Boolean(s?.on));
    }).catch((): void => { /* best-effort */ });

    const handler = (state: { on: boolean }) => setOn(Boolean(state?.on));
    api.onDebugTraceChanged?.(handler);
    return () => {
      alive = false;
      api.offDebugTraceChanged?.(handler);
    };
  }, []);

  const toggle = useCallback(() => {
    const api = traceApi();
    if (!api?.debugTraceSet) return;
    void api
      .debugTraceSet()
      .then((s) => setOn(Boolean(s?.on)))
      .catch((): void => { /* best-effort */ });
  }, []);

  // The keyboard route, for when talking someone through it over a call is
  // easier than "find the small dot in the corner".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.altKey && (e.key || '').toLowerCase() === 'd') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <Tooltip
      title={
        on
          ? `Sign-in tracing ON — reproduce the sign-in, then use “Copy all” (${CHORD_LABEL} to stop)`
          : `Sign-in tracing (${CHORD_LABEL})`
      }
      placement="right"
    >
      <Box
        onClick={toggle}
        role="button"
        aria-label="Toggle sign-in tracing"
        sx={{
          position: 'fixed',
          bottom: 8,
          // Bottom-LEFT: the right edge is where a scrollbar lands, and the two
          // fight over the same few pixels.
          left: 10,
          zIndex: 1400,
          display: 'flex',
          // Dot outermost, label inboard of it.
          flexDirection: 'row-reverse',
          alignItems: 'center',
          gap: 0.75,
          cursor: 'pointer',
          userSelect: 'none',
          // Off: barely there. On: unmistakable.
          opacity: on ? 1 : 0.14,
          transition: 'opacity 160ms ease',
          '&:hover': { opacity: on ? 1 : 0.45 },
        }}
      >
        {on && (
          <Typography
            sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: '#ef4444' }}
          >
            TRACING
          </Typography>
        )}
        <Box
          sx={{
            width: on ? 9 : 7,
            height: on ? 9 : 7,
            borderRadius: '50%',
            backgroundColor: on ? '#ef4444' : 'text.disabled',
            boxShadow: on ? '0 0 0 0 rgba(239,68,68,0.7)' : 'none',
            animation: on ? 'kairosTracePulse 1.6s infinite' : 'none',
            '@keyframes kairosTracePulse': {
              '0%': { boxShadow: '0 0 0 0 rgba(239,68,68,0.7)' },
              '70%': { boxShadow: '0 0 0 7px rgba(239,68,68,0)' },
              '100%': { boxShadow: '0 0 0 0 rgba(239,68,68,0)' },
            },
          }}
        />
      </Box>
    </Tooltip>
  );
}

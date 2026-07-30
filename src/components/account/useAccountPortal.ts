import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCOUNT_PORTAL_URL } from '../../config';

/** How long the "Copied" confirmation stays up before reverting. */
const COPIED_RESET_MS = 2000;

export interface AccountPortal {
  /** The portal URL — render it as text too, so this is never a dead end. */
  url: string;
  /** Launch the system default browser at the portal. */
  open: () => Promise<void>;
  /** Copy the URL to the clipboard. */
  copy: () => Promise<void>;
  /** True for a couple of seconds after a successful copy. */
  copied: boolean;
  /** Set when opening the browser failed — nudge the user toward Copy. */
  failed: boolean;
}

/**
 * Shared behaviour behind every "go to the account portal" affordance.
 *
 * Opening goes through the main process rather than `window.open`: the
 * sandboxed renderer gets a null handle either way, so only the IPC round-trip
 * can tell us whether the browser actually launched.
 */
export function useAccountPortal(): AccountPortal {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const open = useCallback(async () => {
    try {
      await window.ipcApi.sendIpcRequest('app:open-external', ACCOUNT_PORTAL_URL);
      setFailed(false);
    } catch (err) {
      console.error('Could not open the account portal:', err);
      setFailed(true);
    }
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ACCOUNT_PORTAL_URL);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch (err) {
      console.error('Could not copy the account portal link:', err);
    }
  }, []);

  return { url: ACCOUNT_PORTAL_URL, open, copy, copied, failed };
}

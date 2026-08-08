/**
 * useAdminTools — whether to render the administrator surface, and may we.
 * -----------------------------------------------------------
 * Two separate questions, deliberately kept separate:
 *
 * - **`enabled`** is a stored preference. The user turned "Support tools" on in
 *   Settings and wants those controls visible.
 * - **`isAdmin`** is the server's answer, obtained by making a request only an
 *   administrator may make and reading the status code.
 *
 * `visible` is both. Turning the preference on without the role shows nothing,
 * and holding the role without turning the preference on also shows nothing —
 * an administrator working on their own hotel's budget should not have delete
 * and take-over sitting next to Publish all day.
 *
 * ## Why the role is probed rather than known
 *
 * This client has no `/me`. The renderer knows the signed-in user's email and
 * nothing else about their access; every other permission decision in the app is
 * a per-plan `relation` handed down by the server. So "am I an administrator" is
 * answered the only honest way available, and that has a useful property: the
 * answer expires. An administrator whose role is removed fails the next probe
 * and loses the surface, rather than keeping an unlocked screen until they sign
 * out.
 *
 * None of this is a security boundary and it is not trying to be. Every action
 * behind the switch is authorised server-side on every request. This decides
 * what to draw.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { adminProbe } from "../services/kairosSyncService";
import { syncFailed } from "../shared/kairosSync/ipc";
import { useAdminToolsEnabled, useSettingsStore } from "../store/settings";

export interface AdminTools {
  /** The stored preference: the user asked for these controls. */
  enabled: boolean;
  /** The server's answer. Null until the first probe resolves. */
  isAdmin: boolean | null;
  /** Render admin controls: wanted AND permitted. */
  visible: boolean;
  probing: boolean;
  /**
   * Turn the preference on or off.
   *
   * Turning it ON probes first and refuses if the server says no, so the switch
   * cannot be left in a state that promises something it will not deliver.
   * Resolves to what the switch ended up as.
   */
  setEnabled: (next: boolean) => Promise<boolean>;
  /** Re-ask the server. Cheap, and the only way the answer ever goes stale. */
  refresh: () => Promise<void>;
}

export function useAdminTools(): AdminTools {
  const enabled = useAdminToolsEnabled();
  const setAdminToolsEnabled = useSettingsStore((s) => s.setAdminToolsEnabled);

  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [probing, setProbing] = useState(false);

  // Held in a ref rather than read from state so `probe` has no dependency on
  // its own result — otherwise the effect below would re-run every time the
  // answer arrived, and probe again.
  const lastAnswer = useRef<boolean | null>(null);

  const probe = useCallback(async (): Promise<boolean> => {
    setProbing(true);
    const result = await adminProbe();
    setProbing(false);
    // Offline is not "you are not an administrator". Keeping the previous
    // answer keeps a working surface working on a flaky link; the requests
    // behind it fail on their own terms if the link is really down.
    if (syncFailed(result)) return lastAnswer.current === true;
    lastAnswer.current = result.data.isAdmin;
    setIsAdmin(result.data.isAdmin);
    return result.data.isAdmin;
  }, []);

  // Only probed when the preference is on. A hotel user who never opens the
  // switch never makes the request, so the surface costs them nothing.
  useEffect(() => {
    if (!enabled) {
      lastAnswer.current = null;
      setIsAdmin(null);
      return;
    }
    void probe();
  }, [enabled, probe]);

  const setEnabled = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (!next) {
        await setAdminToolsEnabled(false);
        setIsAdmin(null);
        return false;
      }
      const allowed = await probe();
      if (!allowed) return false;
      await setAdminToolsEnabled(true);
      return true;
    },
    [probe, setAdminToolsEnabled]
  );

  return {
    enabled,
    isAdmin,
    visible: enabled && isAdmin === true,
    probing,
    setEnabled,
    refresh: async () => {
      await probe();
    },
  };
}

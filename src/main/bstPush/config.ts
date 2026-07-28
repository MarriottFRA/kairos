/**
 * Persisted BST Push configuration.
 *
 * Two things survive between sessions:
 *
 *   - The CLEAR RULES. Which accounts the clear pass zeroes used to be a
 *     hardcoded predicate, which meant it was also an unexaminable assumption
 *     about which accounts this tool generates. Nobody knows every hotel's
 *     chart, so it is now a rule set the user can see, extend and correct.
 *   - The MONTH PLAN. A hotel pushing month after month repeats almost the same
 *     selection each time; making them rebuild it every visit would be the
 *     single most annoying thing about the page.
 *
 * Lives in `user_settings` (the plaintext store) alongside the app's other
 * preferences, so it survives a secure-store rebuild and is readable before
 * unlock. Install-wide rather than per-OU: the rules describe what this TOOL
 * writes, not what a particular hotel's chart contains.
 *
 * Read defensively and never throws — a corrupt value costs the user their
 * customization, never their ability to push.
 */

import { getUserSettings, setUserSettings } from "../../local_db";
import {
  BstPushConfig,
  DEFAULT_BST_PUSH_CONFIG,
  normalizeClearPrefixes,
  normalizeMonthPlan,
} from "../../shared/bstPush/ipc";

const PREFIX_KEY = "bstPushClearPrefixes";
const MONTHS_KEY = "bstPushMonthPlan";
const BACKUP_KEY = "bstPushBackup";

export async function readBstPushConfig(): Promise<BstPushConfig> {
  try {
    const settings = JSON.parse(await getUserSettings()) as Record<
      string,
      unknown
    >;
    const backup = settings[BACKUP_KEY];
    return {
      // An absent key means "never configured", which must land on the
      // defaults; an empty saved list means "the user deleted every rule" and
      // must stay empty, or clearing could never be switched off.
      clearPrefixes:
        settings[PREFIX_KEY] === undefined
          ? [...DEFAULT_BST_PUSH_CONFIG.clearPrefixes]
          : normalizeClearPrefixes(settings[PREFIX_KEY] ?? []),
      months: normalizeMonthPlan(settings[MONTHS_KEY]),
      backup:
        typeof backup === "boolean" ? backup : DEFAULT_BST_PUSH_CONFIG.backup,
    };
  } catch (error) {
    console.warn("[BST Push] Could not read the saved configuration:", error);
    return {
      clearPrefixes: [...DEFAULT_BST_PUSH_CONFIG.clearPrefixes],
      months: [...DEFAULT_BST_PUSH_CONFIG.months],
      backup: DEFAULT_BST_PUSH_CONFIG.backup,
    };
  }
}

/**
 * Persist whichever keys the caller supplied and return the whole config as it
 * now stands. A partial patch is the normal case — the rules card saves rules,
 * the month strip saves months, and neither should clobber the other.
 */
export async function writeBstPushConfig(raw: unknown): Promise<BstPushConfig> {
  const patch = (raw ?? {}) as Partial<BstPushConfig>;
  const updates: Record<string, unknown> = {};

  if (patch.clearPrefixes !== undefined) {
    updates[PREFIX_KEY] = normalizeClearPrefixes(patch.clearPrefixes ?? []);
  }
  if (patch.months !== undefined) {
    updates[MONTHS_KEY] = normalizeMonthPlan(patch.months);
  }
  if (typeof patch.backup === "boolean") {
    updates[BACKUP_KEY] = patch.backup;
  }

  if (Object.keys(updates).length > 0) {
    await setUserSettings(updates);
  }
  return readBstPushConfig();
}

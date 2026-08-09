/**
 * The two questions somebody hesitates over before pressing Download or Publish.
 * ---------------------------------------------------------------------------
 * "If I download, does it wipe what I've been doing?" and "if I publish, does it
 * wipe what my colleague has been doing?". Both are answered honestly inside
 * `ReviewDialog` — but only after the click, which is one click too late for the
 * person who is hesitating. This produces the one quiet line that goes on the
 * card, before the click.
 *
 * Pure and separately tested, same constraints as `planState.ts`: no Electron,
 * no DOM, protocol types only.
 *
 * ## What it must never say
 *
 * **"Nothing of yours is replaced."** The card cannot know that. A download is a
 * per-row merge keyed on stable server ids, and the count of rows it would
 * actually replace (`collides`) is computed by the preview, not here. So the
 * download line promises the REVIEW, not the outcome.
 *
 * **"Publishing cannot touch their work"** on the strength of a delegation
 * existing. It is true only while the delegation is ACTIVE: `filterToWriteScope`
 * withholds the owner's rows in a delegated department because the server
 * reports the owner non-writable there. The moment a department is handed back
 * or the grant withdrawn, the owner regains write and an ordinary publish WILL
 * overwrite what the delegate published. That is why this reads
 * `summary.delegatedOut` and never `summary.handedBack` — a handed-back
 * department dropping out of the sentence is the correct behaviour, not a bug.
 */

import { PlanSyncStatus } from "./ipc";
import { PlanDelegationSummary } from "./delegationSummary";
import { canDelegate } from "./relations";

/** Beyond this the line stops being a line. */
const NAMED_LIMIT = 2;

export interface SyncAssurance {
  /** Under the Download button, or null when there is nothing to be anxious about. */
  download: string | null;
  /** Under the Publish button, or null. */
  publish: string | null;
}

/** "Rooms", "Rooms and F&B", "Rooms, F&B and 2 more". */
function listCodes(codes: string[]): string {
  if (codes.length === 0) return "";
  if (codes.length === 1) return codes[0];
  if (codes.length <= NAMED_LIMIT) return `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
  return `${codes.slice(0, NAMED_LIMIT).join(", ")} and ${codes.length - NAMED_LIMIT} more`;
}

export function syncAssurance(
  plan: PlanSyncStatus,
  summary: PlanDelegationSummary | null
): SyncAssurance {
  return {
    download: downloadLine(plan),
    publish: publishLine(plan, summary),
  };
}

function downloadLine(plan: PlanSyncStatus): string | null {
  // Nothing unpublished here, so there is nothing a download could land on.
  // Saying "your work is safe" to somebody with no work in progress is noise.
  if (plan.pendingChanges === 0) return null;
  // Withheld on a plan that cannot be downloaded at all — the card has already
  // said why in its headline.
  if (!plan.published || !plan.readable) return null;

  return (
    "Downloading merges with your work. " +
    "You will see anything of yours it would replace before it happens."
  );
}

function publishLine(
  plan: PlanSyncStatus,
  summary: PlanDelegationSummary | null
): string | null {
  // The button is withheld for a view-only share, so the line beneath it would
  // be explaining something that is not on screen.
  const viewOnly = plan.relation === "DELEGATE" && plan.writeScope === "NONE";
  if (viewOnly || !plan.published) return null;

  if (canDelegate(plan.relation)) {
    // `stale` means /department-ownership has never run, so an empty
    // `delegatedOut` is UNKNOWN rather than "nobody holds anything". Say
    // nothing rather than imply the plan is undelegated.
    if (!summary || summary.stale) return null;

    const held = Array.from(
      new Set(summary.delegatedOut.map((entry) => entry.code))
    ).sort();
    if (held.length === 0) return null;

    return (
      `Publishing sends your departments only; ${listCodes(held)} ` +
      `${held.length === 1 ? "stays" : "stay"} theirs until handed back.`
    );
  }

  if (plan.relation === "DELEGATE") {
    return "Publishing sends your departments only. Nothing else in the plan is touched.";
  }

  return null;
}

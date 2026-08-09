/**
 * What is this delegation's situation, in one sentence?
 * -----------------------------------------------------------
 * The Delegation page used to spread a single delegation across three regions:
 * who held which department (the Departments table), when they handed it back
 * (also the table, in a caption), whether they were working right now (a
 * separate "Working on this now" block), and what the grant permitted (the
 * delegation row itself). Answering "what is Bob's situation?" meant reading
 * three places and joining them by eye. This collapses the same facts into one
 * state and one sentence, the way `planState.ts` does for a plan.
 *
 * Pure and separately tested, because the interesting cases are the ones that
 * are awkward to reach by hand: a delegate who handed back one of three
 * departments, a grant that stopped being effective while someone was mid-edit,
 * a view-only grant that has nothing to say for itself.
 *
 * ## Order matters
 *
 * The checks run most-consequential first. A grant that is not in effect says so
 * whatever else is true of it — telling the owner "working now" about a
 * delegation the server is refusing would be worse than useless, because the
 * work being described can never arrive. Handback outranks presence for the
 * same reason: "they have finished and you can collect it" is a thing to do,
 * where "they are typing" is a thing to know.
 *
 * ## A handback is a state; collecting is an event
 *
 * `HANDED_BACK` survives until the owner reopens the department — it means "this
 * is mine again", not "there is a parcel waiting". So a card built from the
 * handback alone offered "Get their work" for ever: download it, and the button
 * came back, because nothing about the delegation had changed. Pressing it again
 * produced a review dialog saying nothing had changed on the server and no way
 * forward, which is the worst answer a call to action can give.
 *
 * `context.serverAhead` is the missing half. It is the plan's own watermark
 * against the server's version — advanced by a pull and by nothing else, so
 * false means every published row is already here. With it, "ready to download"
 * becomes a fact about the server rather than a fact about the grant, and once
 * the work is collected the card says so and stops asking.
 *
 * ## What is deliberately NOT here
 *
 * A last-published time. `ActivityEntry.seenAt` is a presence ping written while
 * the delegate's app is open — it stops the moment they close Kairos and has no
 * relationship to publishing. There is no per-delegate publish timestamp on the
 * wire at all. What the owner actually needs before withdrawing is
 * `dirtyEntities`: work that exists and cannot be downloaded yet. That is what
 * the headline reports.
 */

import { ActivityEntry, Delegation } from "./protocol";

/** Why a grant the owner made is not doing anything. */
export const INEFFECTIVE_REASON: Record<string, string> = {
  OU_ACCESS_REVOKED: "Their access to this hotel was removed",
  DEPARTMENT_ACCESS_SHRUNK: "Their department access has narrowed",
  EXPIRED: "This delegation has expired",
  NO_OVERLAP: "They have none of these departments",
};

export type DelegationTone = "neutral" | "good" | "attention" | "blocked";

export interface DelegationCardState {
  /** Colour the card's status dot. `attention` is the one that draws. */
  tone: DelegationTone;
  /** One sentence: the whole situation. */
  headline: string;
  /**
   * They have finished with something and the owner should collect it.
   *
   * Drives the card's only contained button, so it has to mean "there is work
   * sitting on the server for you", not "something happened once".
   */
  collectable: boolean;
}

/** What the delegation itself cannot say: is anything actually waiting? */
export interface DelegationContext {
  /**
   * Does the server hold rows this computer has not downloaded?
   *
   * Omitted when the caller genuinely does not know — a card that has not been
   * told falls back to the old behaviour and offers the download, which is the
   * safe way to be wrong: the review dialog will say plainly that there is
   * nothing to bring down. Passing `false` is a claim, so only pass it from the
   * plan's own watermark.
   */
  serverAhead?: boolean;
}

/** "Rooms", "Rooms and F&B", "Rooms, F&B and 2 more". */
function listCodes(codes: string[]): string {
  if (codes.length === 0) return "";
  if (codes.length === 1) return codes[0];
  if (codes.length === 2) return `${codes[0]} and ${codes[1]}`;
  if (codes.length === 3) return `${codes[0]}, ${codes[1]} and ${codes[2]}`;
  return `${codes[0]}, ${codes[1]} and ${codes.length - 2} more`;
}

export function delegationCardState(
  delegation: Delegation,
  presence: ActivityEntry | null,
  context: DelegationContext = {}
): DelegationCardState {
  const handedBack = delegation.departments
    .filter((department) => department.state === "HANDED_BACK")
    .map((department) => department.code);
  // Handed back AND already downloaded. Still their work, still their handback —
  // just nothing left to fetch, so it stops being an action and becomes a fact.
  const collected = handedBack.length > 0 && context.serverAhead === false;
  const collectable = handedBack.length > 0 && !collected;

  // Nothing below can happen if the server is not honouring the grant, so this
  // outranks everything — including a handback, which in this state is the last
  // thing that got through rather than a live invitation to collect.
  if (!delegation.effective) {
    return {
      tone: "blocked",
      headline: INEFFECTIVE_REASON[delegation.reason ?? ""] ?? "This delegation is not in effect",
      collectable,
    };
  }

  if (collectable && handedBack.length === delegation.departments.length) {
    return {
      tone: "attention",
      headline: "Handed everything back — ready to download",
      collectable,
    };
  }

  if (collectable) {
    return {
      tone: "attention",
      headline: `Handed back ${listCodes(handedBack)} — ready to download`,
      collectable,
    };
  }

  // Presence is advisory and never a lock: an offline-capable desktop client
  // cannot hold one honestly. It is still the difference between withdrawing a
  // delegation and stranding somebody's afternoon.
  if (presence && presence.dirtyEntities > 0) {
    return {
      tone: "attention",
      headline: `Working now · ${presence.dirtyEntities} unpublished ${
        presence.dirtyEntities === 1 ? "change" : "changes"
      }`,
      collectable,
    };
  }

  if (presence) {
    return { tone: "good", headline: "Working now", collectable };
  }

  // Below presence on purpose. A handback whose work is already here is not a
  // thing to do, so anything the delegate is doing NOW outranks it — and when
  // there is nothing else to say, this is the sentence that stops the owner
  // wondering whether they missed a download.
  if (collected) {
    return {
      tone: "neutral",
      headline:
        handedBack.length === delegation.departments.length
          ? "Handed everything back — you already have their work"
          : `Handed back ${listCodes(handedBack)} — you already have their work`,
      collectable,
    };
  }

  if (!delegation.canEdit) {
    return { tone: "neutral", headline: "Can look, cannot change anything", collectable };
  }

  return { tone: "good", headline: "Editing", collectable };
}

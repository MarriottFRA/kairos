/**
 * What state is this plan in, and what should the user do about it?
 * -----------------------------------------------------------
 * The Sync page used to show five counters — server version, your version,
 * unpublished changes, last published, last pulled — and leave the reader to
 * work out what they meant. "Server version 42 / You have 40" is precise and
 * tells a hotel finance manager nothing. This collapses the same facts into one
 * state, one sentence, and one thing to press.
 *
 * Pure and separately tested, because the interesting cases are the ones that
 * are awkward to reach by hand: both sides ahead at once, a plan locked by
 * support, an owner whose access lapsed mid-year.
 *
 * ## Order matters
 *
 * The checks run most-blocking first. A plan under a support lease is LOCKED
 * whatever else is true of it, because nothing else the user could do will work
 * until the lease is released — telling them they have 162 changes to publish
 * would be true and useless. Same for a withdrawn delegation.
 *
 * CLOUD_ONLY sits directly under those two: a plan this computer does not hold
 * has no local copy to be ahead or behind, so every counter below it is
 * meaningless and the only move is to download.
 */

import { PlanSyncStatus } from "./ipc";
import { Lease } from "./protocol";
import { canRead, canWrite } from "./relations";

export type PlanStateKind =
  /**
   * The server holds it and will not show it to you.
   *
   * Access to the hotel is not access to a colleague's plan. You can see that it
   * exists and who owns it; every read endpoint answers 403. Above CLOUD_ONLY,
   * because "download it" is the one thing that cannot happen here.
   */
  | "NOT_SHARED"
  /** The server has it; this computer does not. A new machine, or a delegation. */
  | "CLOUD_ONLY"
  /** Unpublished, and a plan of the same name is already on the server. */
  | "NAME_TAKEN"
  /** Never published. The copy on this machine is the only copy. */
  | "LOCAL_ONLY"
  /** Published, and both sides agree. */
  | "UP_TO_DATE"
  /** Local changes not yet published. */
  | "LOCAL_AHEAD"
  /** The server has changes this machine has not downloaded. */
  | "SERVER_AHEAD"
  /** Both. Neither side is simply right, so the user has to look. */
  | "DIVERGED"
  /** This user cannot write this plan at all. */
  | "READ_ONLY"
  /** An administrator holds an exclusive lease; nobody else can save. */
  | "LOCKED"
  /** A delegation was withdrawn. The work survives but cannot be published. */
  | "REVOKED";

export type PlanAction =
  | "publish"
  | "pull"
  | "review"
  | "register"
  | "download"
  /** Ask the owner for a delegation. The only move on a plan you cannot read. */
  | "request"
  | null;

export interface PlanState {
  kind: PlanStateKind;
  /** One sentence, addressed to the user, in their words rather than ours. */
  headline: string;
  /** What to do about it, or why there is nothing to do. */
  detail: string;
  action: PlanAction;
  /** Colour the card's status dot. `attention` is the only one that draws. */
  tone: "neutral" | "good" | "attention" | "blocked";
  /** True when this plan should stay expanded in a list of several. */
  needsAttention: boolean;
}

export function planState(plan: PlanSyncStatus, lease?: Lease | null): PlanState {
  const behind = plan.published ? Math.max(0, plan.serverVersion - plan.watermark) : 0;
  const ahead = plan.pendingChanges;

  if (plan.revoked) {
    return {
      kind: "REVOKED",
      headline: "Your access to this plan was withdrawn",
      detail:
        "Everything you did is still on this machine and is not lost. It cannot be " +
        "published unless the plan's owner delegates to you again.",
      action: null,
      tone: "blocked",
      needsAttention: true,
    };
  }

  // A lease held by SOMEBODY ELSE. The holder's own client resolves as
  // ADMIN_LEASE and is not blocked by it.
  if (lease?.mode === "EXCLUSIVE" && plan.relation !== "ADMIN_LEASE") {
    return {
      kind: "LOCKED",
      headline: "Support is working on this plan",
      detail:
        `${lease.adminEmail}${lease.ticketRef ? ` · ${lease.ticketRef}` : ""} holds it ` +
        "until " +
        formatWhen(lease.expiresAt) +
        ". You can look, but saving and publishing are refused until it is released.",
      action: null,
      tone: "blocked",
      needsAttention: true,
    };
  }

  // Above CLOUD_ONLY, because the counters are not merely meaningless here —
  // they are withheld. The server sends null for version, epoch and scope on a
  // plan it will not show you, and offering "download" would be offering a 403.
  //
  // Deliberately neutral and not attention-worthy. A colleague's plan you were
  // never meant to open is not a problem with your Sync page; colouring it as
  // one makes the "needs attention" count permanently non-zero at any hotel
  // with two budget owners, which is most of them.
  if (plan.relation !== null && !canRead(plan.relation)) {
    // A copy still on this computer only survives the sweep when it has
    // unpublished work in it. That work is the whole story on this card, and it
    // is a different story from a colleague's plan you have simply noticed.
    if (plan.onThisComputer && ahead > 0) {
      return {
        kind: "NOT_SHARED",
        headline: "This plan is no longer shared with you",
        detail:
          `${count(ahead, "change")} of yours are still on this computer and are ` +
          "not lost. You cannot download updates or publish while " +
          `${plan.ownerEmail ?? "its owner"} has not delegated to you. If they ` +
          "delegate again, these will publish normally.",
        action: null,
        tone: "blocked",
        needsAttention: true,
      };
    }
    return {
      kind: "NOT_SHARED",
      headline: "Not shared with you",
      detail: plan.ownerEmail
        ? `${plan.ownerEmail} owns this plan and has not given you access to it. ` +
          "They can share it read-only and carry on working on it themselves."
        : "This plan's owner has not given you access to it. Ask them to " +
          "delegate the departments you need.",
      action: "request",
      tone: "neutral",
      needsAttention: false,
    };
  }

  // Nothing else can be said about a plan this computer does not hold: there is
  // no local copy to be ahead, behind or level with. Downloading is the only
  // move, and it is the same move whether you own it or hold one department.
  if (!plan.onThisComputer) {
    return {
      kind: "CLOUD_ONLY",
      headline: "On the server, not on this computer",
      detail: plan.twinPlanId
        ? "You already have a plan with this name here, and it is a different plan. " +
          "Downloading makes this one the plan of that name and removes the other."
        : "Nothing on this computer changes until you download it.",
      action: "download",
      tone: "attention",
      needsAttention: true,
    };
  }

  // Unpublished, and the server already has a plan of this name that this
  // machine did not produce. Publishing would put a second one beside it — the
  // usual cause being a plan rebuilt by hand after moving machine.
  if (!plan.published && plan.twinPlanId) {
    return {
      kind: "NAME_TAKEN",
      headline: "A plan with this name is already on the server",
      detail: plan.twinReadable
        ? "Publishing this copy would create a second plan of the same name. Download " +
          "the server's copy instead — it replaces this one — or rename this plan to " +
          "publish it alongside."
        : // The clashing plan belongs to somebody else and is not shared, so
          // "download it instead" is advice that cannot be followed. Renaming is
          // the only way out, and saying so beats sending them to a locked tile.
          "It belongs to a colleague and has not been shared with you, so you cannot " +
          "download it. Rename this plan to publish it alongside theirs.",
      action: null,
      tone: "blocked",
      needsAttention: true,
    };
  }

  if (!plan.published) {
    return {
      kind: "LOCAL_ONLY",
      headline: "Only on this computer",
      detail:
        ahead > 0
          ? `${count(ahead, "row")} that nobody else can see. Publishing lets colleagues ` +
              "you delegate to work on their own departments."
          : "Nothing has been sent to the server. Kairos works perfectly well like this.",
      action: "register",
      tone: "neutral",
      needsAttention: false,
    };
  }

  // Read-only is checked after publication state so a reader still learns
  // whether what they are looking at is current.
  //
  // Two ways to land here, and they are told apart by `writeScope` rather than
  // by the relation: an administrator without a lease, and a delegate whose
  // grant was made with `canEdit: false`. The second resolves as a plain
  // DELEGATE on the wire — the server strips the write capabilities underneath —
  // so the relation alone would offer them a Publish button that only ever 403s.
  const readOnlyRelation = plan.relation !== null && !canWrite(plan.relation);
  const readOnlyGrant = plan.relation === "DELEGATE" && plan.writeScope === "NONE";
  if (readOnlyRelation || readOnlyGrant) {
    return {
      kind: "READ_ONLY",
      headline: readOnlyGrant ? "Shared with you to look at" : readOnlyHeadline(plan.relation),
      detail:
        behind > 0
          ? `The server has moved on by ${count(behind, "change")}. Download them to ` +
              "see what changed."
          : readOnlyGrant
            ? "The owner is still working on this plan. You can read it and download " +
              "updates; changing it is theirs to do."
            : "You can see this plan and download it, but not change it.",
      action: behind > 0 ? "pull" : null,
      tone: "neutral",
      needsAttention: false,
    };
  }

  if (ahead > 0 && behind > 0) {
    return {
      kind: "DIVERGED",
      headline: "You and the server have both changed things",
      detail:
        `${count(ahead, "change")} here, ${count(behind, "change")} there. Download ` +
        "first — you will be shown exactly what it would overwrite before anything happens.",
      action: "review",
      tone: "attention",
      needsAttention: true,
    };
  }

  if (behind > 0) {
    return {
      kind: "SERVER_AHEAD",
      headline: `${count(behind, "change")} waiting for you`,
      detail: "Colleagues have published work you do not have yet.",
      action: "pull",
      tone: "attention",
      needsAttention: true,
    };
  }

  if (ahead > 0) {
    return {
      kind: "LOCAL_AHEAD",
      headline: `${count(ahead, "change")} not published yet`,
      detail:
        "Only on this computer. Publishing sends them to the server; nobody loses " +
        "anything, and colleagues see them next time they download.",
      action: "publish",
      tone: "attention",
      needsAttention: true,
    };
  }

  return {
    kind: "UP_TO_DATE",
    headline: "Everything is published",
    detail: "This computer and the server agree.",
    action: null,
    tone: "good",
    needsAttention: false,
  };
}

function readOnlyHeadline(relation: string | null): string {
  if (relation === "GLOBAL_ADMIN") return "Read only — you are not this plan's owner";
  return "Read only";
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function formatWhen(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "an unknown time";
  return new Date(parsed).toLocaleString();
}

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
 */

import { PlanSyncStatus } from "./ipc";
import { Lease, Relation } from "./protocol";

export type PlanStateKind =
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

export type PlanAction = "publish" | "pull" | "review" | "register" | null;

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

/** Relations that can write at least one department of the plan. */
const CAN_WRITE = new Set<Relation>([
  "OWNER",
  "OWNER_DEGRADED",
  "DELEGATE",
  "ADMIN_LEASE",
]);

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

  // Read-only is checked after publication state so an OU_MEMBER still learns
  // whether what they are looking at is current.
  if (plan.relation !== null && !CAN_WRITE.has(plan.relation)) {
    return {
      kind: "READ_ONLY",
      headline: readOnlyHeadline(plan.relation),
      detail:
        behind > 0
          ? `The server has moved on by ${count(behind, "change")}. Download them to ` +
              "see what changed."
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

function readOnlyHeadline(relation: Relation): string {
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

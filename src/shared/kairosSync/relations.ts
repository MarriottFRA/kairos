/**
 * What a relation lets you do, in one table.
 * -----------------------------------------------------------
 * The server resolves every caller to exactly one relation on a given plan and
 * asserts a named capability from there. The client used to mirror that with
 * scattered string comparisons — `relation === "OWNER" || relation ===
 * "ADMIN_LEASE"` in five files, three separate copies of the human wording, and
 * a `CAN_WRITE` set in `planState`. A relation the client had never heard of
 * degraded differently in each one.
 *
 * That stopped being survivable when `OU_MEMBER` became `OU_VISITOR`. The old
 * relation carried `plan:read`, and the arithmetic behind that was worse than it
 * looked: owning a plan requires ALL departments at a property, so every hotel
 * admin there necessarily held every department — and could therefore download
 * every other hotel admin's plan in full. The server now hands hotel access
 * `plan:discover` alone: you see that a plan exists, what it is called and who
 * owns it, and nothing else.
 *
 * The server renamed rather than redefined the relation precisely so a client
 * that treats the old string as readable cannot carry on doing so by accident.
 * This module is where that lands.
 *
 * ## Fails closed
 *
 * `capabilities()` answers "nothing" for a string it does not know, matching the
 * server's own rule that an unknown relation resolves to the empty capability
 * set. A future relation therefore arrives read-only-and-invisible rather than
 * inheriting whatever the nearest branch happened to allow.
 *
 * ## Only the capabilities the client acts on
 *
 * The server's matrix has thirty entries. Most are enforced server-side and the
 * client never has to predict them — it just makes the call. These seven are the
 * ones that decide whether a button is drawn at all, and drawing a button whose
 * only outcome is a 403 is the thing this table exists to prevent.
 */

/** What the caller is on a given plan. Told to us; never sent. */
export type Relation =
  | "OWNER"
  | "OWNER_DEGRADED"
  | "DELEGATE"
  | "ADMIN_LEASE"
  | "GLOBAL_ADMIN"
  /**
   * Access to the hotel, on a plan that is not theirs and not delegated to them.
   *
   * Sees that it exists and who owns it; NO plan data. Every read endpoint
   * answers 403 `kairos_plan_not_shared`, and the plan's `version`, `syncEpoch`,
   * `structureVersion`, `entityCount` and `scopeKind` all arrive null.
   */
  | "OU_VISITOR";

/** The subset of the server's capability matrix that decides what we draw. */
export interface Capabilities {
  /** `plan:read` — pull, manifest, version, activity, PII summary, artifacts. */
  read: boolean;
  /** `position:write` — can write at least one department. */
  write: boolean;
  /** `structure:write` — the columns/blocks/schemes/allocations/KPI editors. */
  structure: boolean;
  /** `plan:delegate` — the Delegation page's granting half. */
  delegate: boolean;
  /** `plan:delete` — remove the server's copy. */
  deletePlan: boolean;
  /** `plan:transfer` — hand the plan to a new owner. */
  transfer: boolean;
  /** `bst:push` — rewrite the hotel's workbook. Full scope is checked separately. */
  bstPush: boolean;
}

const NOTHING: Capabilities = {
  read: false,
  write: false,
  structure: false,
  delegate: false,
  deletePlan: false,
  transfer: false,
  bstPush: false,
};

/**
 * Transcribed from the capability matrix in KAIROS_CLIENT_GUIDE.md §3.
 *
 * Two rows are worth reading twice. `OWNER_DEGRADED` keeps its departments and
 * loses everything plan-wide — that is the whole point of the relation, and it
 * is why `write` and `structure` are separate columns. `GLOBAL_ADMIN` reads
 * everything and writes nothing: an administrator's route to write is a support
 * lease, which is a recorded decision rather than a side effect of being an
 * administrator.
 */
const TABLE: Record<Relation, Capabilities> = {
  OWNER: {
    read: true,
    write: true,
    structure: true,
    delegate: true,
    deletePlan: true,
    transfer: true,
    bstPush: true,
  },
  OWNER_DEGRADED: { ...NOTHING, read: true, write: true },
  DELEGATE: { ...NOTHING, read: true, write: true },
  ADMIN_LEASE: {
    read: true,
    write: true,
    structure: true,
    delegate: true,
    deletePlan: true,
    transfer: true,
    bstPush: true,
  },
  GLOBAL_ADMIN: { ...NOTHING, read: true },
  // `plan:discover` and `bst:pull` only. The workbook is a property resource and
  // never involves a plan, so it survived the tightening; nothing here does.
  OU_VISITOR: { ...NOTHING },
};

/**
 * What this relation may do. Unknown or absent resolves to nothing.
 *
 * Takes a plain string rather than `Relation` on purpose: the value arrives off
 * the wire, and the whole point of failing closed is that a string TypeScript
 * has never seen still gets an answer.
 */
export function capabilities(relation: string | null | undefined): Capabilities {
  // A copy, never the row itself. Handing out the table's own objects means one
  // careless caller can widen or narrow a relation for the whole process — and a
  // permission table that any consumer can edit in place is not a permission
  // table. The allocation is nothing; this is not on a per-cell path.
  return { ...(relation ? TABLE[relation as Relation] ?? NOTHING : NOTHING) };
}

export function canRead(relation: string | null | undefined): boolean {
  return capabilities(relation).read;
}

export function canWrite(relation: string | null | undefined): boolean {
  return capabilities(relation).write;
}

export function canWriteStructure(relation: string | null | undefined): boolean {
  return capabilities(relation).structure;
}

export function canDelegate(relation: string | null | undefined): boolean {
  return capabilities(relation).delegate;
}

export function canDeletePlan(relation: string | null | undefined): boolean {
  return capabilities(relation).deletePlan;
}

/** Human wording for each relation, in the second person. */
export const RELATION_LABEL: Record<string, string> = {
  OWNER: "You own this plan",
  OWNER_DEGRADED: "You own this plan, but your access has lapsed",
  DELEGATE: "Delegated to you",
  ADMIN_LEASE: "You hold a support lease",
  GLOBAL_ADMIN: "Administrator — read only",
  OU_VISITOR: "Not shared with you",
};

/**
 * What each relation means for this user, in the second person.
 *
 * The chip on its own is a dead end — "Administrator — read only" states a fact
 * and leaves the reader to guess its consequences and whether it is a mistake.
 * These are the consequences.
 */
export interface RelationExplainer {
  can: string;
  cannot: string;
  next: string;
}

export const RELATION_EXPLAINER: Record<string, RelationExplainer> = {
  OWNER: {
    can: "Edit every department, publish, delegate, transfer the plan and push it to the budget workbook.",
    cannot: "Edit a department while it is delegated to somebody else.",
    next: "To take one back, withdraw the delegation on the Delegation page.",
  },
  OWNER_DEGRADED: {
    can: "Edit your departments and publish them.",
    cannot:
      "Change the plan's columns, blocks, schemes, allocations or KPI drivers — that needs full access to the hotel.",
    next: "Your administrator can restore it by granting you all departments and write access to this hotel.",
  },
  DELEGATE: {
    can: "Edit and publish the departments you were given, and download the whole plan.",
    cannot:
      "Edit other departments, change the plan's structure, delegate onwards, or push to the budget workbook.",
    next: "When you have finished a department, hand it back on the Delegation page.",
  },
  ADMIN_LEASE: {
    can: "Everything the owner can, for as long as the lease lasts.",
    cannot: "Hold it indefinitely — it expires, and the hotel is locked out meanwhile.",
    next: "Release it as soon as you are done, with a note of what you changed.",
  },
  GLOBAL_ADMIN: {
    can: "See this plan, including its numbers, and download it.",
    cannot: "Change anything, publish, or push to the budget workbook.",
    next:
      "If you expected to own this plan, the server does not agree — check who it is " +
      "registered to. To change something on somebody else's plan, take a support lease.",
  },
  // Access to the hotel is not access to the plan. This one has to explain a
  // rule the reader has probably never been told, and end with the way out.
  OU_VISITOR: {
    can: "See that this plan exists, who owns it, and ask them for access.",
    cannot: "Open it, download it, or see any of its numbers.",
    next:
      "Ask its owner to delegate the departments you need. They can share it " +
      "read-only and carry on working on it themselves.",
  },
};

/**
 * A read-only delegation: the departments are readable and none is writable.
 *
 * `canEdit: false` strips every write capability server-side while leaving the
 * relation plainly `DELEGATE`, so the relation alone cannot answer this. The
 * authoritative signal is `/department-ownership`, whose `writable` field IS the
 * predicate a save will use.
 */
export type WriteScopeKind = "FULL" | "PARTIAL" | "NONE" | "UNKNOWN";

/** How each relation reads to somebody who is not holding the API guide. */
export const RELATION_PLAIN: Record<string, string> = {
  OWNER: "the owner of this plan",
  OWNER_DEGRADED: "the owner, but with lapsed access",
  DELEGATE: "a delegate on this plan",
  ADMIN_LEASE: "the holder of a support lease",
  GLOBAL_ADMIN: "an administrator with read-only access",
  OU_VISITOR: "somebody with access to this hotel, but not to this plan",
};

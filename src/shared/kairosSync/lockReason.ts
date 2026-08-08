/**
 * Why a department this user can see is not theirs to edit.
 * -----------------------------------------------------------
 * Shared rather than duplicated because two screens explain the same three
 * server reasons — the Delegation page's ownership table and the positions
 * grid's locked-departments banner — and a user who reads one wording in one
 * place and a different one in the other has to work out whether they mean the
 * same thing.
 *
 * The keys are `NotWritableReason` from `/department-ownership`. Kept as a plain
 * record with a fallback at the call site so a reason added server-side degrades
 * to its own code rather than to an empty string.
 */

export const LOCK_REASON: Record<string, string> = {
  DELEGATED: "Delegated — withdraw it to edit this yourself",
  HANDED_BACK: "Handed back to the owner",
  NOT_IN_WRITE_SCOPE: "Not yours to edit",
};

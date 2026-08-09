/**
 * The capability table, and the one property that matters most about it.
 *
 * This module replaced five hard-coded copies of the relation enum with three
 * separate sets of wording. The thing that made that worth doing is not tidiness
 * — it is that a relation string nobody anticipated used to degrade differently
 * in each place, and one of those defaults was permissive.
 */

import { describe, expect, it } from "vitest";
import {
  canDelegate,
  canDeletePlan,
  canRead,
  canWrite,
  canWriteStructure,
  capabilities,
  Relation,
  RELATION_EXPLAINER,
  RELATION_LABEL,
  RELATION_PLAIN,
} from "../relations";

const ALL: Relation[] = [
  "OWNER",
  "OWNER_DEGRADED",
  "DELEGATE",
  "ADMIN_LEASE",
  "GLOBAL_ADMIN",
  "OU_VISITOR",
];

describe("capabilities", () => {
  it("fails closed on a relation it has never heard of", () => {
    // The server's own rule. A relation added server-side must arrive here
    // inert, not inherit whichever branch it happens to fall into.
    const unknown = capabilities("OU_SOMETHING_NEW");
    expect(Object.values(unknown).every((allowed) => allowed === false)).toBe(true);
  });

  it("fails closed on null and undefined", () => {
    // `relation` is null before the first server answer. That must not read as
    // "an unknown relation with unknown rights" in either direction here — the
    // callers that need permissiveness before the first answer decide that for
    // themselves; the table never grants anything it was not told about.
    expect(canRead(null)).toBe(false);
    expect(canWrite(undefined)).toBe(false);
  });

  it("never returns the same object twice, so a caller cannot poison the table", () => {
    const first = capabilities("OWNER");
    first.read = false;
    expect(canRead("OWNER")).toBe(true);
  });
});

describe("the relations that can read a plan", () => {
  // The whole point of the change: hotel access alone no longer confers read.
  it("is everybody except a visitor", () => {
    expect(ALL.filter(canRead)).toEqual([
      "OWNER",
      "OWNER_DEGRADED",
      "DELEGATE",
      "ADMIN_LEASE",
      "GLOBAL_ADMIN",
    ]);
  });

  it("excludes OU_VISITOR, which is the entire security change", () => {
    expect(canRead("OU_VISITOR")).toBe(false);
    expect(capabilities("OU_VISITOR").write).toBe(false);
  });

  it("does not resurrect the old relation name", () => {
    // The server renamed rather than redefined it precisely so a client that
    // still treats the old string as readable is forced to notice.
    expect(canRead("OU_MEMBER")).toBe(false);
  });
});

describe("write, structure and ownership", () => {
  it("lets a degraded owner keep their departments and lose the structure", () => {
    expect(canWrite("OWNER_DEGRADED")).toBe(true);
    expect(canWriteStructure("OWNER_DEGRADED")).toBe(false);
  });

  it("gives a delegate rows but never the field catalog", () => {
    expect(canWrite("DELEGATE")).toBe(true);
    expect(canWriteStructure("DELEGATE")).toBe(false);
  });

  it("gives a bare administrator reads and nothing else", () => {
    // Their route to write is a support lease, which is a recorded decision.
    expect(canRead("GLOBAL_ADMIN")).toBe(true);
    expect(canWrite("GLOBAL_ADMIN")).toBe(false);
    expect(canDeletePlan("GLOBAL_ADMIN")).toBe(false);
  });

  it("keeps delegating and deleting to the owner and the lease holder", () => {
    expect(ALL.filter(canDelegate)).toEqual(["OWNER", "ADMIN_LEASE"]);
    expect(ALL.filter(canDeletePlan)).toEqual(["OWNER", "ADMIN_LEASE"]);
  });

  it("does not let a delegate sub-delegate", () => {
    // The single most important containment property in the feature.
    expect(canDelegate("DELEGATE")).toBe(false);
  });
});

describe("the wording", () => {
  it("has a label, an explainer and a plain form for every relation", () => {
    // A missing entry degrades to the raw enum on screen, which is how a user
    // ends up reading "OU_VISITOR".
    for (const relation of ALL) {
      expect(RELATION_LABEL[relation], relation).toBeTruthy();
      expect(RELATION_EXPLAINER[relation], relation).toBeTruthy();
      expect(RELATION_PLAIN[relation], relation).toBeTruthy();
    }
  });

  it("tells a visitor who to ask rather than only what they cannot do", () => {
    expect(RELATION_EXPLAINER.OU_VISITOR.next).toContain("read-only");
  });
});

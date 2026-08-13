/**
 * resolveHotelClusterWeight — the effective-multiplier spec, pinned. Both
 * engine input paths (loadScenarioInput and runLiveSim) call this, so these
 * cases ARE the product rules: no cluster → 1; dangling → 1 + warning;
 * non-member hotel → 1 + warning (an override never rescues a broken
 * assignment); single-member cluster honors a valid override; multi-member
 * clusters ignore it.
 */

import { describe, expect, it } from "vitest";
import { HotelClusterDto } from "../ipc";
import { clusterMapById, resolveHotelClusterWeight } from "../resolve";

const HOTEL_A = "OU11111";
const HOTEL_B = "OU22222";

function cluster(
  id: string,
  members: Array<{ ou: string; weight: number }>
): HotelClusterDto {
  return {
    id,
    name: `Cluster ${id}`,
    members,
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const PAIR = cluster("pair", [
  { ou: HOTEL_A, weight: 0.25 },
  { ou: HOTEL_B, weight: 0.75 },
]);
const SOLO = cluster("solo", [{ ou: HOTEL_A, weight: 0.6 }]);
const MAP = clusterMapById([PAIR, SOLO]);

describe("resolveHotelClusterWeight", () => {
  it("no cluster assigned → weight 1, NONE", () => {
    for (const id of ["", null, undefined]) {
      const resolved = resolveHotelClusterWeight(HOTEL_A, id, null, MAP);
      expect(resolved).toEqual({ weight: 1, source: "NONE", clusterName: "" });
    }
  });

  it("unknown / deleted cluster → weight 1, DANGLING warning", () => {
    const resolved = resolveHotelClusterWeight(HOTEL_A, "gone", 0.5, MAP);
    expect(resolved.weight).toBe(1);
    expect(resolved.source).toBe("DANGLING");
    expect(resolved.warning).toBe("DANGLING");
  });

  it("member hotel → the member's weight, CLUSTER", () => {
    expect(resolveHotelClusterWeight(HOTEL_A, "pair", null, MAP)).toEqual({
      weight: 0.25,
      source: "CLUSTER",
      clusterName: "Cluster pair",
    });
    expect(resolveHotelClusterWeight(HOTEL_B, "pair", null, MAP).weight).toBe(
      0.75
    );
  });

  it("non-member hotel → weight 1, NOT_MEMBER — and it beats an override", () => {
    const resolved = resolveHotelClusterWeight(HOTEL_B, "solo", 0.4, MAP);
    expect(resolved.weight).toBe(1);
    expect(resolved.source).toBe("NOT_MEMBER");
    expect(resolved.warning).toBe("NOT_MEMBER");
    expect(resolved.clusterName).toBe("Cluster solo");
  });

  it("single-member cluster honors a valid override", () => {
    const resolved = resolveHotelClusterWeight(HOTEL_A, "solo", 0.4, MAP);
    expect(resolved).toEqual({
      weight: 0.4,
      source: "OVERRIDE",
      clusterName: "Cluster solo",
    });
  });

  it("single-member cluster ignores an invalid override (0, >1, NaN, null)", () => {
    for (const override of [0, -0.5, 1.5, Number.NaN, null, undefined]) {
      const resolved = resolveHotelClusterWeight(HOTEL_A, "solo", override, MAP);
      expect(resolved.weight, String(override)).toBe(0.6);
      expect(resolved.source).toBe("CLUSTER");
    }
  });

  it("multi-member cluster ignores the override — the weights ARE the spread", () => {
    const resolved = resolveHotelClusterWeight(HOTEL_A, "pair", 0.9, MAP);
    expect(resolved.weight).toBe(0.25);
    expect(resolved.source).toBe("CLUSTER");
  });

  it("normalizes OU casing/whitespace on both sides", () => {
    const resolved = resolveHotelClusterWeight(" ou11111 ", "pair", null, MAP);
    expect(resolved.weight).toBe(0.25);
  });

  it("unknown cluster + travelling snapshot → the snapshot, SNAPSHOT, no warning", () => {
    // A downloaded plan on a machine without the definitions: the row carries
    // the owner-resolved ratio and name, and the engine uses them instead of
    // the ×1 fallback.
    const resolved = resolveHotelClusterWeight(HOTEL_A, "gone", null, MAP, {
      weight: 0.4,
      name: "Lakeside pair",
    });
    expect(resolved).toEqual({
      weight: 0.4,
      source: "SNAPSHOT",
      clusterName: "Lakeside pair",
    });
  });

  it("a definition this machine holds beats the snapshot", () => {
    // The snapshot exists for machines that cannot resolve at all — never as
    // a second opinion where they can.
    const resolved = resolveHotelClusterWeight(HOTEL_A, "pair", null, MAP, {
      weight: 0.9,
      name: "Stale",
    });
    expect(resolved.weight).toBe(0.25);
    expect(resolved.source).toBe("CLUSTER");
  });

  it("an invalid snapshot falls through to DANGLING", () => {
    for (const weight of [0, -1, 1.5, Number.NaN, null, undefined]) {
      const resolved = resolveHotelClusterWeight(HOTEL_A, "gone", null, MAP, {
        weight,
        name: "Broken",
      });
      expect(resolved.source, String(weight)).toBe("DANGLING");
      expect(resolved.weight, String(weight)).toBe(1);
    }
  });
});

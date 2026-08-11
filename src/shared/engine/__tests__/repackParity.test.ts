/**
 * A reused structure must produce EXACTLY what a fresh compile would.
 * -----------------------------------------------------------
 * compileStructure() is cached across edits and packPlan() re-run per edit. The
 * failure mode that justifies this file: a structure reused when it should not
 * have been does not throw — it books a line to the wrong department, quietly,
 * for the rest of the session.
 *
 * So this fuzzes edits against the invariant that makes the whole scheme sound:
 *
 *   structureKey unchanged  ⟹  packPlan(edited, cachedStructure)
 *                              is BIT-IDENTICAL to compile(edited)
 *
 * and its contrapositive, which is the half that catches a key missing a field:
 *
 *   structure actually changed  ⟹  structureKey changed
 *
 * The second is checked by re-deriving the structure and comparing it to the
 * cached one whenever the key says "reuse". If the key ever says reuse while the
 * structure differs, that is the silent-wrong-money bug, and it fails here.
 */

import { describe, expect, it } from "vitest";
import { compile, compileStructure, packPlan } from "../compile";
import type { CompiledPlan } from "../compile";
import { structureKey, describeStructureDrift } from "../structureKey";
import { simulate } from "../simulate";
import { MONTHS, ScenarioInput } from "../types";
import { randomScenario, rng } from "./fixtures";

/** Byte-exact digest of every typed array on a plan, plus the dimensions. */
function planFingerprint(plan: CompiledPlan): string {
  const arrays: Array<Uint8Array | Uint32Array | Float64Array> = [
    plan.op,
    plan.outLine,
    plan.arg0,
    plan.paramOfs,
    plan.paramPool,
    plan.positionInstrStart,
    plan.lineAggRow,
    plan.positionStatRow,
    plan.countScaled,
    plan.seasonality,
    plan.daysPerMonth,
    plan.realDays,
    plan.holidayDays,
    plan.posHeadcount,
    plan.posFte,
    plan.posWeight,
    plan.buyoutAggRow,
    plan.buyoutValues,
  ];
  const parts = arrays.map((array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${array.length}:${hash.toString(16)}`;
  });
  parts.push(plan.aggKeys.map((k) => `${k.dept}|${k.account}`).join(","));
  parts.push(plan.statKeys.map((k) => `${k.cluster}|${k.jobTypeCode}`).join(","));
  parts.push(plan.componentDefs.map((d) => d.id as string).join(","));
  parts.push(plan.positionIds.join(","));
  parts.push(String(plan.lineCount));
  return parts.join("§");
}

/** Deep-ish clone of the parts an edit touches, so edits never alias. */
function cloneInput(input: ScenarioInput): ScenarioInput {
  return {
    ...input,
    definitions: input.definitions.map((def) => ({ ...def })),
    positions: input.positions.map((position) => ({
      ...position,
      seasonality: [...position.seasonality],
      additionalMonthlyCosts: [...position.additionalMonthlyCosts],
      vacationMonthlyWeights: [...position.vacationMonthlyWeights],
    })),
    componentValues: input.componentValues.map((value) => ({
      ...value,
      monthlyValues: value.monthlyValues ? [...value.monthlyValues] : undefined,
    })),
    buyouts: input.buyouts.map((row) => ({ ...row, monthlyValues: [...row.monthlyValues] })),
  };
}

type Edit = { name: string; apply: (input: ScenarioInput, rand: () => number) => void };

/**
 * Edits a user can actually make. The first group is value-only (the cache
 * SHOULD hold); the second changes the plan's shape or its dimensions (the
 * cache MUST drop). The test does not assert which group an edit is in — it
 * asserts the key and the structure agree about it, which is the real property.
 */
const EDITS: Edit[] = [
  {
    name: "retype a salary",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      position.monthlyBaseSalary = Math.round(rand() * 9000);
    },
  },
  {
    name: "change a rate",
    apply: (input, rand) => {
      const withRate = input.componentValues.filter((v) => v.rate !== undefined);
      if (withRate.length === 0) return;
      withRate[Math.floor(rand() * withRate.length)].rate = Math.round(rand() * 5000) / 10000;
    },
  },
  {
    name: "change a yearly amount",
    apply: (input, rand) => {
      const withYearly = input.componentValues.filter((v) => v.yearlyValue !== undefined);
      if (withYearly.length === 0) return;
      withYearly[Math.floor(rand() * withYearly.length)].yearlyValue = Math.round(rand() * 20000);
    },
  },
  {
    name: "switch a month off in seasonality",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      position.seasonality[Math.floor(rand() * MONTHS)] = rand() < 0.5 ? 0 : 1;
    },
  },
  {
    name: "change vacation days",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      position.vacationDays = Math.floor(rand() * 30);
    },
  },
  {
    name: "change the merit increase",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      position.meritIncreasePct = Math.round(rand() * 1000) / 10000;
      position.increaseMonth = 1 + Math.floor(rand() * 13);
    },
  },
  {
    name: "change headcount",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      position.headcount = 1 + Math.floor(rand() * 4);
    },
  },
  {
    name: "change a buyout amount",
    apply: (input, rand) => {
      if (input.buyouts.length === 0) return;
      const row = input.buyouts[Math.floor(rand() * input.buyouts.length)];
      row.monthlyValues[Math.floor(rand() * MONTHS)] = Math.round(rand() * 5000);
    },
  },
  // ---- these change the SHAPE or the DIMENSIONS ----
  {
    name: "move a row to another department",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      position.departmentCode = rand() < 0.5 ? "1010" : "9999";
    },
  },
  {
    name: "set or clear a per-row department override",
    apply: (input, rand) => {
      const value = input.componentValues[Math.floor(rand() * input.componentValues.length)];
      value.departmentCode = rand() < 0.5 ? undefined : rand() < 0.5 ? "1910" : "2020";
    },
  },
  {
    name: "set or clear a per-row account override",
    apply: (input, rand) => {
      const value = input.componentValues[Math.floor(rand() * input.componentValues.length)];
      value.accountCode = rand() < 0.5 ? undefined : "699999";
    },
  },
  {
    name: "flip a row between hourly and salaried",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      if (position.hourlyRate > 0) {
        position.hourlyRate = 0;
        position.monthlyBaseSalary = 2000;
        position.payType = "SALARIED";
      } else {
        position.hourlyRate = 5 + Math.round(rand() * 20);
        position.monthlyBaseSalary = 0;
        position.payType = "HOURLY";
      }
    },
  },
  {
    name: "reassign a cluster or job type",
    apply: (input, rand) => {
      const position = input.positions[Math.floor(rand() * input.positions.length)];
      if (rand() < 0.5) position.cluster = rand() < 0.5 ? "" : "North";
      else position.jobTypeCode = rand() < 0.5 ? "A1" : "Z9";
    },
  },
  {
    name: "soft-delete a position",
    apply: (input, rand) => {
      const live = input.positions.filter((p) => p.deletedAt === null);
      if (live.length <= 2) return;
      live[Math.floor(rand() * live.length)].deletedAt = "2027-06-01T00:00:00Z";
    },
  },
  {
    name: "change a definition's account",
    apply: (input, rand) => {
      const def = input.definitions[Math.floor(rand() * input.definitions.length)];
      def.accountCode = rand() < 0.5 ? "600001" : def.accountCode;
    },
  },
  {
    name: "reorder definitions by sortOrder",
    apply: (input, rand) => {
      const def = input.definitions[Math.floor(rand() * input.definitions.length)];
      def.sortOrder = Math.round(rand() * 40);
    },
  },
];

describe("repack parity — a cached structure equals a fresh compile", () => {
  it("holds across 400 fuzzed edits", () => {
    const rand = rng(20260811);
    let input = cloneInput(randomScenario(11, 40));

    let cachedKey = structureKey(input);
    const firstStructure = compileStructure(input);
    if ("errors" in firstStructure) throw new Error("fixture failed to compile");
    let cached = firstStructure.structure;

    let reuses = 0;
    let rebuilds = 0;

    for (let step = 0; step < 400; step++) {
      const edit = EDITS[Math.floor(rand() * EDITS.length)];
      input = cloneInput(input);
      edit.apply(input, rand);

      const key = structureKey(input);
      const fresh = compileStructure(input);
      if ("errors" in fresh) {
        // An edit made the plan invalid; re-seed and carry on — validity is
        // compile.test's subject, not this file's.
        input = cloneInput(randomScenario(11, 40));
        cachedKey = structureKey(input);
        const reseeded = compileStructure(input);
        if ("errors" in reseeded) throw new Error("reseed failed");
        cached = reseeded.structure;
        continue;
      }

      if (key === cachedKey) {
        // THE load-bearing assertion. The key says "reuse"; prove the structure
        // really is unchanged, or we would be booking to stale aggregate rows.
        const drift = describeStructureDrift(cached, fresh.structure);
        expect(
          drift,
          `structureKey said "reuse" after "${edit.name}" (step ${step}) but the structure moved: ${drift}`
        ).toBeNull();

        // And the plan built on the cached structure must be bit-identical to a
        // full compile of the same input.
        const viaCache = packPlan(input, cached);
        const viaCompile = compile(input);
        if (!("plan" in viaCompile)) throw new Error("fresh compile failed");
        expect(
          planFingerprint(viaCache),
          `cached plan diverged from a fresh compile after "${edit.name}" (step ${step})`
        ).toBe(planFingerprint(viaCompile.plan));

        // Belt and braces: the numbers the user would actually see.
        const a = simulate(viaCache);
        const b = simulate(viaCompile.plan);
        expect(Array.from(a.state.aggValues)).toEqual(Array.from(b.state.aggValues));
        reuses++;
      } else {
        cached = fresh.structure;
        cachedKey = key;
        rebuilds++;
      }
    }

    // The test is worthless if the cache never hit, or never missed.
    expect(reuses, "no cache hits — the fuzz never exercised the fast path").toBeGreaterThan(50);
    expect(rebuilds, "no cache misses — the key never noticed a shape change").toBeGreaterThan(20);
  });

  it("notices every structural edit in the list", () => {
    // Each structural edit, applied on its own, must move the key. Weaker than
    // the fuzz above (it cannot catch an edit nobody thought of) but it names
    // the culprit when one regresses.
    const structural = [
      "move a row to another department",
      "set or clear a per-row department override",
      "set or clear a per-row account override",
      "reassign a cluster or job type",
      "soft-delete a position",
      "reorder definitions by sortOrder",
    ];
    for (const name of structural) {
      const edit = EDITS.find((candidate) => candidate.name === name);
      if (!edit) throw new Error(`no edit named ${name}`);
      // Several tries: some edits are randomized and can be a no-op (setting a
      // department to the one it already had).
      let moved = false;
      for (let attempt = 0; attempt < 40 && !moved; attempt++) {
        const base = cloneInput(randomScenario(5 + attempt, 12));
        const before = structureKey(base);
        const after = cloneInput(base);
        edit.apply(after, rng(1000 + attempt));
        if (structureKey(after) !== before) moved = true;
      }
      expect(moved, `"${name}" never changed the structure key`).toBe(true);
    }
  });

  it("does not rebuild on a pure value edit", () => {
    // The other side of the contract: if this ever fails, the cache is correct
    // but useless.
    const input = cloneInput(randomScenario(3, 25));
    const before = structureKey(input);
    const edited = cloneInput(input);
    edited.positions[0].monthlyBaseSalary += 137;
    edited.positions[1].vacationDays = 17;
    if (edited.componentValues[0].rate !== undefined) edited.componentValues[0].rate = 0.123;
    expect(structureKey(edited)).toBe(before);
  });
});

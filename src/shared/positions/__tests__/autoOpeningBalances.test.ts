/**
 * applyAutoOpeningBalances — the worked-out opening balance of a movement
 * block: the same plan shadow-run for LAST year (last year's service from the
 * hiring date, this year's pay before any increase, everything else as this
 * year), read at last year's last worked month, per person; someone hired
 * this year starts at 0. Derived in BOTH loaders (liveSimParity pins the two;
 * this suite pins the helper's own contract).
 */

import { describe, expect, it } from "vitest";
import { BlockDto } from "../../blocks/ipc";
import { compileStructure } from "../../engine/compile";
import { compile, simulate } from "../../engine/simulate";
import {
  BaseSelector,
  ComponentValue,
  CostComponentDefinition,
  MONTHS,
  Position,
  ScenarioInput,
} from "../../engine/types";
import {
  FIXTURE_YEAR,
  defId,
  makeDef,
  makeInput,
  makePosition,
  makeValue,
  posId,
} from "../../engine/__tests__/fixtures";
import {
  applyAutoOpeningBalances,
  autoOpeningBlocks,
  AutoOpeningResult,
} from "../autoOpeningBalances";
import { serviceDaysFor } from "../serviceDays";

const CHARGE = "def-charge";
const BALANCE = "def-balance";
const HIRE = "2019-06-01";
const FULL_YEAR = new Array<number>(MONTHS).fill(1);
/** A running balance typed as twelve monthly values: 100 growing to 1200. */
const RUNNING = Array.from({ length: MONTHS }, (_, m) => 100 * (m + 1));

function block(overrides: Partial<BlockDto> = {}): BlockDto {
  return {
    id: "b1",
    ou: "0410",
    blockType: "MULTIPLIER",
    label: "Provision Charge",
    accountCode: "628990",
    accountLocked: true,
    statsAccountCode: "",
    statsAccountLocked: true,
    base: { kind: "BASE_SALARY" },
    movement: true,
    useRowRate: false,
    spread: "ACTIVE_MONTHS",
    increaseAware: false,
    departmentMode: "POSITION",
    sortOrder: 0,
    updatedAt: "",
    costDefId: CHARGE,
    ...overrides,
  } as BlockDto;
}

/** One position, a charge booking the movement of `balance` at `rate`. */
function chargeInput(opts: {
  balance: BaseSelector;
  rate?: number;
  position?: Partial<Position>;
  extraDefs?: CostComponentDefinition[];
  extraValues?: ComponentValue[];
  chargeValue?: Partial<ComponentValue> | null;
}): ScenarioInput {
  return makeInput({
    definitions: [
      makeDef({ id: "def-base", kind: "BASE_SALARY", label: "Base Salary", accountCode: "610000" }),
      ...(opts.extraDefs ?? []),
      makeDef({
        id: CHARGE,
        spreadMethod: "PERCENT_OF",
        label: "Provision Charge",
        accountCode: "628990",
        sortOrder: 9,
        movement: true,
        baseSelector: opts.balance,
      }),
    ],
    positions: [makePosition({ id: "pos-1", seasonality: FULL_YEAR, ...opts.position })],
    componentValues: [
      ...(opts.extraValues ?? []),
      ...(opts.chargeValue === null
        ? []
        : [makeValue("pos-1", CHARGE, { rate: opts.rate ?? 1, ...opts.chargeValue })]),
    ],
  });
}

/** A DIRECT_MONTHLY balance def and its value — the hand-checkable chain. */
const runningBalanceDef = () =>
  makeDef({ id: BALANCE, spreadMethod: "DIRECT_MONTHLY", label: "Provision Balance", accountCode: "628980", sortOrder: 1 });
const runningBalanceValue = (months = RUNNING) =>
  makeValue("pos-1", BALANCE, { monthlyValues: months });

function opening(out: AutoOpeningResult, positionId = "pos-1", def = CHARGE): number | undefined {
  return out.openings.get(positionId)?.get(def);
}

function chargeMonths(input: ScenarioInput, positionId = "pos-1"): number[] {
  const compiled = compile(input);
  if (!("plan" in compiled)) throw new Error(JSON.stringify(compiled.errors));
  const line = simulate(compiled.plan)
    .positionLines(posId(positionId))
    .find((l) => l.component.id === defId(CHARGE))!;
  return Array.from(line.months);
}

function sum(months: number[]): number {
  return months.reduce((total, value) => total + value, 0);
}

const hiredLongAgo = () => HIRE;

describe("autoOpeningBlocks", () => {
  it("picks movement multipliers unless the opening is typed per row", () => {
    const auto = block();
    const explicit = block({ id: "b2", autoOpeningBalance: true });
    const typed = block({ id: "b3", autoOpeningBalance: false });
    const plain = block({ id: "b4", movement: undefined });
    const fixed = block({ id: "b5", blockType: "FLAT_MONTHLY" });
    expect(autoOpeningBlocks([auto, explicit, typed, plain, fixed])).toEqual([auto, explicit]);
  });
});

describe("applyAutoOpeningBalances", () => {
  it("reads last year's closing at this year's pay before the increase", () => {
    // 1200 a month, a 10% rise from January: the balance this year is 1320,
    // last year's closing 1200 — so January books the rise and nothing else.
    const input = chargeInput({
      balance: { kind: "BASE_SALARY" },
      position: { monthlyBaseSalary: 1200, meritIncreasePct: 0.1, increaseMonth: 1 },
    });
    const out = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(out)).toBeCloseTo(1200, 9);

    const months = chargeMonths({ ...input, componentValues: out.componentValues });
    expect(months[0]).toBeCloseTo(120, 9);
    expect(sum(months)).toBeCloseTo(120, 9);
  });

  it("uses last year's length of service, so January books one month's accrual", () => {
    const thisYear = serviceDaysFor(HIRE, FIXTURE_YEAR);
    const prior = serviceDaysFor(HIRE, FIXTURE_YEAR - 1);
    const input = chargeInput({
      balance: { kind: "SERVICE", mode: "TOTAL" },
      rate: 0.01,
      position: { serviceDaysPerMonth: thisYear.perMonth, serviceDaysOpening: thisYear.opening },
    });
    const out = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo });
    // Service to the end of last December, not to the end of this January.
    expect(opening(out)).toBeCloseTo(0.01 * (prior.opening + sum(prior.perMonth)), 9);

    const months = chargeMonths({ ...input, componentValues: out.componentValues });
    for (let m = 0; m < MONTHS; m++) {
      expect(months[m], `month ${m + 1}`).toBeCloseTo(0.01 * thisYear.perMonth[m], 9);
    }
  });

  it("is per person: the count × cluster-weight tail is divided back out", () => {
    const thisYear = serviceDaysFor(HIRE, FIXTURE_YEAR);
    const single = chargeInput({
      balance: { kind: "SERVICE", mode: "TOTAL" },
      rate: 0.01,
      position: { serviceDaysPerMonth: thisYear.perMonth, serviceDaysOpening: thisYear.opening },
    });
    const shared = chargeInput({
      balance: { kind: "SERVICE", mode: "TOTAL" },
      rate: 0.01,
      position: {
        serviceDaysPerMonth: thisYear.perMonth,
        serviceDaysOpening: thisYear.opening,
        headcount: 2,
        hotelClusterWeight: 0.5,
      },
    });
    const one = applyAutoOpeningBalances({ input: single, blocks: [block()], hiringDateOf: hiredLongAgo });
    const two = applyAutoOpeningBalances({ input: shared, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(two)).toBeCloseTo(opening(one)!, 9);
  });

  it("keeps a balance built on the headcount stat at its pre-tail figure", () => {
    // 10 per head on the HEADCOUNT stat, three heads: the balance the engine
    // measures January against is 30 (the stat already carries the count), and
    // the tail then books it ×3. Pinning the count to 1 in the shadow would
    // have read 10 and booked a phantom 20 rise in January.
    const input = chargeInput({
      balance: { kind: "COMPONENTS", componentIds: [defId("def-hc")] },
      rate: 10,
      position: { headcount: 3 },
      extraDefs: [
        makeDef({ id: "def-hc", kind: "STAT", statKind: "HEADCOUNT", label: "Headcount", accountCode: "972000", sortOrder: 1 }),
      ],
    });
    const out = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(out)).toBeCloseTo(30, 9);
    const months = chargeMonths({ ...input, componentValues: out.componentValues });
    for (let m = 0; m < MONTHS; m++) expect(months[m], `month ${m + 1}`).toBeCloseTo(0, 9);
  });

  it("reads a count-exempt line whole — a KPI-style balance is not per head", () => {
    const input = chargeInput({
      balance: { kind: "COMPONENTS", componentIds: [defId(BALANCE)] },
      position: { headcount: 3 },
      extraDefs: [{ ...runningBalanceDef(), countExempt: true }],
      extraValues: [runningBalanceValue()],
    });
    // The charge itself is a ratio of an exempt line and exempt in turn.
    input.definitions.find((def) => def.id === defId(CHARGE))!.countExempt = true;
    const out = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(out)).toBeCloseTo(1200, 9);
  });

  it("starts someone hired this year at 0; no hiring date means already staffed", () => {
    const input = chargeInput({
      balance: { kind: "BASE_SALARY" },
      position: { monthlyBaseSalary: 1200 },
    });
    const blocks = [block()];
    expect(
      opening(applyAutoOpeningBalances({ input, blocks, hiringDateOf: () => `${FIXTURE_YEAR}-03-15` }))
    ).toBe(0);
    // The boundary: 1 January of the plan year is this year.
    expect(
      opening(applyAutoOpeningBalances({ input, blocks, hiringDateOf: () => `${FIXTURE_YEAR}-01-01` }))
    ).toBe(0);
    expect(
      opening(applyAutoOpeningBalances({ input, blocks, hiringDateOf: () => `${FIXTURE_YEAR - 1}-12-31` }))
    ).toBeCloseTo(1200, 9);
    expect(opening(applyAutoOpeningBalances({ input, blocks, hiringDateOf: () => null }))).toBeCloseTo(1200, 9);
    expect(
      opening(applyAutoOpeningBalances({ input, blocks, hiringDateOf: () => undefined }))
    ).toBeCloseTo(1200, 9);
  });

  it("reads the balance at last year's last worked month — the hold policy", () => {
    const dark = (...months: number[]) => FULL_YEAR.map((v, m) => (months.includes(m) ? 0 : v));
    const input = (seasonality: number[]) =>
      chargeInput({
        balance: { kind: "COMPONENTS", componentIds: [defId(BALANCE)] },
        position: { seasonality },
        extraDefs: [runningBalanceDef()],
        extraValues: [runningBalanceValue()],
      });
    const blocks = [block()];
    expect(opening(applyAutoOpeningBalances({ input: input(FULL_YEAR), blocks, hiringDateOf: hiredLongAgo }))).toBeCloseTo(1200, 9);
    // December dark: November's 1100 is what January measures against.
    expect(opening(applyAutoOpeningBalances({ input: input(dark(11)), blocks, hiringDateOf: hiredLongAgo }))).toBeCloseTo(1100, 9);
    // A mid-year gap changes nothing about the closing.
    expect(opening(applyAutoOpeningBalances({ input: input(dark(4, 5)), blocks, hiringDateOf: hiredLongAgo }))).toBeCloseTo(1200, 9);
    // Never in the plan: nothing to bring forward.
    expect(
      opening(applyAutoOpeningBalances({ input: input(new Array(MONTHS).fill(0)), blocks, hiringDateOf: hiredLongAgo }))
    ).toBe(0);
  });

  it("brings nothing forward when the year does not start with a balance", () => {
    // Nothing, nothing, then 1,000 growing by 100 a month. Last year's
    // imagined closing would leave March booking a sliver; a balance that
    // starts from nothing books its whole first month, and the real
    // difference from then on.
    const series = [0, 0, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900];
    const input = chargeInput({
      balance: { kind: "COMPONENTS", componentIds: [defId(BALANCE)] },
      extraDefs: [runningBalanceDef()],
      extraValues: [runningBalanceValue(series)],
    });
    const out = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(out)).toBe(0);
    const months = chargeMonths({ ...input, componentValues: out.componentValues });
    expect(months[0]).toBe(0);
    expect(months[1]).toBe(0);
    expect(months[2]).toBeCloseTo(1000, 9);
    for (let m = 3; m < MONTHS; m++) expect(months[m], `month ${m + 1}`).toBeCloseTo(100, 9);

    // A post that opens in March — out of the plan until then — reads the
    // same way, whatever the balance would have been.
    const opens = chargeInput({
      balance: { kind: "COMPONENTS", componentIds: [defId(BALANCE)] },
      position: { seasonality: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
      extraDefs: [runningBalanceDef()],
      extraValues: [runningBalanceValue()],
    });
    const outOpens = applyAutoOpeningBalances({ input: opens, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(outOpens)).toBe(0);
    const opensMonths = chargeMonths({ ...opens, componentValues: outOpens.componentValues });
    expect(opensMonths[0]).toBe(0);
    expect(opensMonths[1]).toBe(0);
    expect(opensMonths[2]).toBeCloseTo(300, 9);
    expect(opensMonths[3]).toBeCloseTo(100, 9);
  });

  it("uses a figure typed on the row as it is — 0 says nothing brought forward", () => {
    const withTyped = (ssOpeningBase: number) =>
      chargeInput({
        balance: { kind: "COMPONENTS", componentIds: [defId(BALANCE)] },
        extraDefs: [runningBalanceDef()],
        extraValues: [runningBalanceValue()],
        chargeValue: { ssOpeningBase },
      });
    const ledger = withTyped(700);
    const out = applyAutoOpeningBalances({ input: ledger, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(out)).toBe(700);
    // Nothing to fill: the rows are the caller's own objects.
    expect(out.componentValues[0]).toBe(ledger.componentValues[0]);
    expect(out.componentValues[1]).toBe(ledger.componentValues[1]);
    expect(chargeMonths({ ...ledger, componentValues: out.componentValues })[0]).toBeCloseTo(100 - 700, 9);

    // A typed 0 beats the worked-out 1200 and beats the hiring date.
    const nothing = withTyped(0);
    const outNothing = applyAutoOpeningBalances({ input: nothing, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(opening(outNothing)).toBe(0);
    expect(chargeMonths({ ...nothing, componentValues: outNothing.componentValues })[0]).toBeCloseTo(100, 9);
  });

  it("keeps a typed opening, fills a blank one, synthesizes a missing row, leaves other rows alone", () => {
    const input = chargeInput({
      balance: { kind: "COMPONENTS", componentIds: [defId(BALANCE)] },
      extraDefs: [runningBalanceDef()],
      extraValues: [runningBalanceValue()],
      chargeValue: { ssOpeningBase: 999 },
    });
    input.positions.push(
      makePosition({ id: "pos-2", seasonality: FULL_YEAR }),
      makePosition({ id: "pos-3", seasonality: FULL_YEAR })
    );
    input.componentValues.push(
      makeValue("pos-3", BALANCE, { monthlyValues: RUNNING }),
      makeValue("pos-3", CHARGE, { rate: 1 })
    );
    const before = input.componentValues.slice();
    const out = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo });

    // A NEW array; the caller's rows are untouched.
    expect(out.componentValues).not.toBe(input.componentValues);
    expect(input.componentValues).toEqual(before);
    // pos-1 typed 999: its rows are the very same objects, and 999 stands.
    expect(out.componentValues[0]).toBe(before[0]);
    expect(out.componentValues[1]).toBe(before[1]);
    expect(opening(out)).toBe(999);
    // pos-3 blank: worked out onto a clone; the caller's row is still blank.
    expect(out.componentValues[2]).toBe(before[2]);
    expect(out.componentValues[3]).toMatchObject({ positionId: "pos-3", componentDefId: CHARGE, rate: 1, ssOpeningBase: 1200 });
    expect(before[3].ssOpeningBase).toBeUndefined();
    expect(opening(out, "pos-3")).toBe(1200);
    // pos-2 has no charge row (and so no rate — a 0 line, nothing to bring
    // forward): one is synthesized so the real run reads the figure, stamped
    // like the position.
    expect(out.componentValues[4]).toEqual({
      positionId: "pos-2",
      componentDefId: CHARGE,
      ssOpeningBase: 0,
      updatedAt: input.positions[1].updatedAt,
      deletedAt: null,
    });
    expect(opening(out, "pos-2")).toBe(0);
  });

  it("returns the input untouched when no block qualifies or the plan does not compile", () => {
    const input = chargeInput({ balance: { kind: "BASE_SALARY" } });
    for (const blocks of [
      [],
      [block({ autoOpeningBalance: false })],
      [block({ movement: undefined })],
      [block({ blockType: "FLAT_MONTHLY" })],
    ]) {
      const out = applyAutoOpeningBalances({ input, blocks, hiringDateOf: hiredLongAgo });
      expect(out.componentValues).toBe(input.componentValues);
      expect(out.openings.size).toBe(0);
    }

    // A base that does not exist: phase A refuses it, and so does the shadow —
    // the caller's own compile is where that gets reported.
    const broken = chargeInput({ balance: { kind: "COMPONENTS", componentIds: [defId("def-nope")] } });
    expect("errors" in compileStructure(broken)).toBe(true);
    const out = applyAutoOpeningBalances({ input: broken, blocks: [block()], hiringDateOf: hiredLongAgo });
    expect(out.componentValues).toBe(broken.componentValues);
    expect(out.openings.size).toBe(0);
  });

  it("gives the same figures on a caller-supplied structure as on its own", () => {
    const thisYear = serviceDaysFor(HIRE, FIXTURE_YEAR);
    const input = chargeInput({
      balance: { kind: "SERVICE", mode: "TOTAL" },
      rate: 0.01,
      position: { serviceDaysPerMonth: thisYear.perMonth, serviceDaysOpening: thisYear.opening, headcount: 2 },
    });
    const built = compileStructure(input);
    if ("errors" in built) throw new Error("compile failed");
    const own = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo });
    const given = applyAutoOpeningBalances({ input, blocks: [block()], hiringDateOf: hiredLongAgo, structure: built.structure });
    expect(opening(given)).toBe(opening(own));
    expect(given.componentValues).toEqual(own.componentValues);
  });
});

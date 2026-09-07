/**
 * Automatic opening balances for movement blocks.
 * -----------------------------------------------------------
 * A MULTIPLIER that books the movement measures January against a per-row
 * opening balance (ComponentValue.ssOpeningBase). By default that opening is
 * not typed but WORKED OUT here, in both loaders, from a shadow run of the
 * same plan for LAST year:
 *
 *   last year's service days from the hiring date (serviceDaysFor(date,
 *   year − 1)), this year's pay before any increase (merit and manual
 *   increase stripped), everything else as this year — read at last year's
 *   last worked month, per person.
 *
 * There is no real prior-year data in the tool, so this is the same trade the
 * NI opening-balance pre-sim makes (main/socialSecurity/openingBalances.ts):
 * an estimate from this year's inputs. Unlike that one it is never persisted —
 * it is derived at input-build time like applyRateRules and applyPinnedRowRates,
 * so the grid and the persisted budget can never disagree (liveSimParity pins
 * the two loaders to this one implementation).
 *
 * NOTHING BROUGHT FORWARD. An opening only means something against a balance
 * that is there in January. A row whose balance is zero in January — not in
 * the plan yet, or a calculation that starts from nothing — has nothing
 * brought forward: its opening is 0, so the first non-zero month books the
 * whole balance rather than the sliver left after an imagined closing. That
 * is read off a BASE run of this year's plan with the openings zeroed:
 * January's movement against 0 IS January's balance, and 0 when the row is
 * out of the plan in January. The trade: a seasonal worker on a continuing
 * contract, out of the plan in January with a balance carried over the
 * off-season, re-books the whole balance in the first month — type the figure
 * on the row for those. A hiring date in the plan year is the same verdict
 * reached another way and is honoured when present; none is required.
 *
 * TYPED ON THE ROW. A figure in the row's Opening balance cell is used as it
 * is — 0 says nothing brought forward, a ledger figure says exactly that;
 * blank is worked out. The slot is on the row in both modes, so both loaders
 * read a typed figure the same way and this helper only fills the blanks.
 *
 * WHY THE RUNS ARE CHEAP. The engine's MOVEMENT_LINE overwrites the block's
 * line with the movement and never materialises the balance — but with the
 * opening zeroed the line TELESCOPES: Σ months = balance at the last active
 * month (inactive months book 0 and do not advance the previous balance —
 * the hold policy, pinned by engine/__tests__/invariants). So both runs keep
 * `movement` on, zero the opening, and read the balance back off the block's
 * own line: January's value in the base run, the sum in the shadow. Nothing
 * about the plan's SHAPE changes (structureKey excludes merit, service and the
 * opening), so the real PlanStructure is reused: two extra packPlan +
 * simulate, never a compileStructure.
 *
 * PER PERSON. The count × cluster-weight tail runs AFTER MOVEMENT_LINE, and the
 * opening is compared pre-tail, so a scaled line is divided by headcount ×
 * weight on the way back (a balance built on the HEADCOUNT stat multiplies by
 * the count BEFORE the tail, which is why the shadow does not simply pin the
 * count to 1). A count-exempt line (DIRECT_ABS / a ratio) is a whole-line
 * figure, which is exactly the opening's own semantics there — read as is.
 *
 * KNOWN LIMITS, both estimates rather than errors: a movement block whose own
 * base chain contains another movement block reads that block's MOVEMENT (with
 * its opening zeroed if worked out, typed if typed), and a KPI base uses this
 * year's KPI series as last year's.
 *
 * Runs LAST — after applyPositionAccounts — because it needs every value the
 * real run will see (the vacation-cost head's rate included). Returns the input
 * array itself when no block qualifies, a NEW array otherwise, with the blank
 * openings of the worked-out blocks filled in (a row with a typed figure is
 * the very same object).
 */

import { BlockDto } from "../blocks/ipc";
import { compileStructure, packPlan } from "../engine/compile";
import type { PlanStructure } from "../engine/compile";
import { simulate } from "../engine/simulate";
import {
  ComponentDefId,
  ComponentValue,
  MONTHS,
  ScenarioInput,
} from "../engine/types";
import { parseIsoDayUtc, serviceDaysFor } from "./serviceDays";

/** The movement multipliers whose blank opening balances are worked out. */
export function autoOpeningBlocks(blocks: readonly BlockDto[]): BlockDto[] {
  return blocks.filter(
    (block) =>
      block.blockType === "MULTIPLIER" &&
      block.movement === true &&
      block.autoOpeningBalance !== false
  );
}

export interface AutoOpeningResult {
  /** The input array itself when no block qualifies or the structure does not
   *  compile (the caller's own compile reports that); a new array otherwise. */
  componentValues: ComponentValue[];
  /** positionId → costDefId → the opening the real run measures January
   *  against: the row's typed figure where it has one, the worked-out one
   *  otherwise. Empty on the early-outs. The grid shows the worked-out ones
   *  muted in the blank cells. */
  openings: Map<string, Map<string, number>>;
}

export function applyAutoOpeningBalances(args: {
  /** Fully resolved — AFTER applyPositionAccounts, immediately before the pack. */
  input: ScenarioInput;
  blocks: readonly BlockDto[];
  /** The stored hiring date of a position ("YYYY-MM-DD"), an extra hint when
   *  present: hired in the plan year = nothing brought forward. Optional. */
  hiringDateOf: (positionId: string) => string | null | undefined;
  /** The plan's compiled structure when the caller already has it (the live
   *  sim's cached one); omitted, the helper compiles phase A itself. */
  structure?: PlanStructure;
}): AutoOpeningResult {
  const { input, blocks, hiringDateOf } = args;
  const openings = new Map<string, Map<string, number>>();
  const untouched: AutoOpeningResult = { componentValues: input.componentValues, openings };

  const auto = autoOpeningBlocks(blocks);
  if (auto.length === 0) return untouched;

  let structure = args.structure;
  if (!structure) {
    const built = compileStructure(input);
    if ("errors" in built) return untouched;
    structure = built.structure;
  }

  const autoDefIds = new Set(auto.map((block) => block.costDefId));
  // The calendar's year is the compiler's authority (never Scenario.year);
  // both loaders build the two from the same record, so they agree here too.
  const year = input.calendar.year;
  const yearStart = Date.UTC(year, 0, 1);

  // Openings zeroed on the worked-out blocks so their lines telescope to the
  // balance in both runs; a figure typed on the row is remembered and stands.
  const typedByKey = new Map<string, number>();
  const zeroed = input.componentValues.map((value) => {
    if (!autoDefIds.has(value.componentDefId as string) || value.ssOpeningBase === undefined) {
      return value;
    }
    typedByKey.set(`${value.positionId}|${value.componentDefId}`, value.ssOpeningBase);
    return { ...value, ssOpeningBase: 0 };
  });

  // The base: this year as it is — January's line is January's balance.
  const basePlan = packPlan({ ...input, componentValues: zeroed }, structure);
  const base = simulate(basePlan);

  // The shadow: last year's service, this year's pay before any increase.
  const shadowPositions = input.positions.map((position) => {
    const service = serviceDaysFor(hiringDateOf(position.id as string), year - 1);
    return {
      ...position,
      meritIncreasePct: 0,
      manualYearlyIncrease: 0,
      serviceDaysPerMonth: service.perMonth,
      serviceDaysOpening: service.opening,
    };
  });
  const shadowPlan = packPlan(
    { ...input, positions: shadowPositions, componentValues: zeroed },
    structure
  );
  const shadow = simulate(shadowPlan);

  for (const position of input.positions) {
    if (position.deletedAt !== null) continue;
    const id = position.id as string;
    const p = shadowPlan.positionIndex.get(id);
    if (p === undefined) continue;
    const hired = parseIsoDayUtc(hiringDateOf(id));
    const hiredThisYear = hired !== null && hired >= yearStart;
    const coeff = shadowPlan.posHeadcount[p] * shadowPlan.posWeight[p];
    // positionLines returns one line per def in componentDefs order — the
    // same index countScaled is keyed by, and the same in both plans.
    const baseLines = base.positionLines(position.id);
    const shadowLines = shadow.positionLines(position.id);
    const perDef = new Map<string, number>();
    for (let di = 0; di < shadowLines.length; di++) {
      const defIdStr = shadowLines[di].component.id as string;
      if (!autoDefIds.has(defIdStr)) continue;
      const typed = typedByKey.get(`${id}|${defIdStr}`);
      if (typed !== undefined) {
        perDef.set(defIdStr, typed);
        continue;
      }
      // January's movement against 0 is January's balance — and 0 when the
      // row is out of the plan in January (the hold policy books nothing).
      const startsWithBalance = baseLines[di].months[0] !== 0;
      let closing = 0;
      for (let m = 0; m < MONTHS; m++) closing += shadowLines[di].months[m];
      const opening =
        hiredThisYear || !startsWithBalance
          ? 0
          : shadowPlan.countScaled[di] === 1
            ? coeff === 0
              ? 0
              : closing / coeff
            : closing;
      perDef.set(defIdStr, opening);
    }
    openings.set(id, perDef);
  }

  // Write-back for the blanks, the applyPinnedRowRates idiom: shallow-clone a
  // stored row (its rate, account and department overrides survive),
  // synthesize one for a position that has none. A typed row is left as it is.
  const out = input.componentValues.slice();
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    indexByKey.set(`${out[i].positionId}|${out[i].componentDefId}`, i);
  }
  for (const position of input.positions) {
    const perDef = openings.get(position.id as string);
    if (!perDef) continue;
    for (const [defIdStr, opening] of perDef) {
      const key = `${position.id}|${defIdStr}`;
      if (typedByKey.has(key)) continue;
      const index = indexByKey.get(key);
      if (index !== undefined) {
        out[index] = { ...out[index], ssOpeningBase: opening };
      } else {
        out.push({
          positionId: position.id,
          componentDefId: defIdStr as ComponentDefId,
          ssOpeningBase: opening,
          updatedAt: position.updatedAt,
          deletedAt: null,
        });
      }
    }
  }
  return { componentValues: out, openings };
}

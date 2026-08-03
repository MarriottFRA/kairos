/**
 * Block presets — the "Ready-made" tab on the Add-block dialog.
 *
 * A preset is nothing more than one or more ordinary BlockInputs with the
 * fiddly parts already filled in. Applying one runs them through the same
 * saveBlock as the hand-built path, so everything afterwards — the cog, the
 * edit dialog, delete + undo, cluster sync — behaves exactly as it would for a
 * block the user assembled themselves. There is no "preset block" at rest: the
 * catalogue is a starting point, not a type.
 *
 * Two things a preset deliberately CANNOT carry:
 *
 *  - per-row values. A MULTIPLIER's rate lives in component_values, keyed by
 *    position, so a preset lands an empty column band; the card copy says so
 *    rather than pretending the numbers arrive with it.
 *  - a GL account that suits every property. The three presets the business
 *    specified ship literal codes; everything else leaves accountCode blank
 *    ("calculation only — not included in output" until the user picks one).
 *
 * Multi-block presets wire later steps to earlier ones through a placeholder:
 * `{ kind: "BLOCK", blockId: "$otHours" }` means "whatever id the step keyed
 * otHours ended up with". main/blocks/presets.ts resolves those as it inserts.
 * The catalogue is server-authoritative — the renderer sends a preset id, never
 * a block graph.
 */

import type { BlockBaseRef, BlockInput } from "./ipc";
import { POOL_MONTHS } from "./ipc";

/** Marks a blockId as a reference to another step of the same preset. */
export const PRESET_REF_PREFIX = "$";

/** True when a BLOCK base ref points at a sibling step rather than a real id. */
export function isPresetRef(blockId: string): boolean {
  return blockId.startsWith(PRESET_REF_PREFIX);
}

/** The step key a `$ref` names. */
export function presetRefKey(blockId: string): string {
  return blockId.slice(PRESET_REF_PREFIX.length);
}

/** Which section of the Ready-made tab a preset sits under. */
export type BlockPresetGroup = "PAY" | "ALLOWANCE" | "STATUTORY" | "RATIO";

export const BLOCK_PRESET_GROUP_LABELS: Record<BlockPresetGroup, string> = {
  PAY: "Pay & premiums",
  ALLOWANCE: "Allowances & benefits",
  STATUTORY: "Statutory contributions & levies",
  RATIO: "Ratios",
};

export interface BlockPresetStep {
  /** Local to this preset; later steps reference it as `$key`. */
  key: string;
  /** Exactly what saveBlock receives, bar the resolved base refs and label. */
  block: Omit<BlockInput, "id">;
  /** One line under the step on the card — what the user has to type, usually. */
  note?: string;
}

export interface BlockPreset {
  id: string;
  group: BlockPresetGroup;
  title: string;
  blurb: string;
  steps: BlockPresetStep[];
}

/**
 * Rewrite a base's `$key` block refs to the real ids created so far. Walks
 * COMBINE sides and COMPOSITE members, because a ref can hide in either.
 * Pure — main/blocks/presets.ts owns the id map, this owns the shape.
 */
export function resolvePresetRefs(
  base: BlockBaseRef | undefined,
  idByKey: ReadonlyMap<string, string>
): BlockBaseRef | undefined {
  if (!base) return undefined;
  switch (base.kind) {
    case "BLOCK": {
      if (!isPresetRef(base.blockId)) return base;
      const key = presetRefKey(base.blockId);
      const id = idByKey.get(key);
      if (!id) {
        throw new Error(`Preset step "${key}" is referenced before it is created.`);
      }
      return { kind: "BLOCK", blockId: id };
    }
    case "COMPOSITE":
      return {
        ...base,
        blockIds: base.blockIds.map((blockId) => {
          if (!isPresetRef(blockId)) return blockId;
          const key = presetRefKey(blockId);
          const id = idByKey.get(key);
          if (!id) {
            throw new Error(`Preset step "${key}" is referenced before it is created.`);
          }
          return id;
        }),
      };
    case "COMBINE":
      return {
        ...base,
        left: resolvePresetRefs(base.left, idByKey) as BlockBaseRef,
        right: resolvePresetRefs(base.right, idByKey) as BlockBaseRef,
      };
    default:
      return base;
  }
}

/** Every step key a preset's bases reference, in the order they are reached. */
export function presetRefKeys(base: BlockBaseRef | undefined): string[] {
  if (!base) return [];
  switch (base.kind) {
    case "BLOCK":
      return isPresetRef(base.blockId) ? [presetRefKey(base.blockId)] : [];
    case "COMPOSITE":
      return base.blockIds.filter(isPresetRef).map(presetRefKey);
    case "COMBINE":
      return [...presetRefKeys(base.left), ...presetRefKeys(base.right)];
    default:
      return [];
  }
}

const BASE_SALARY: BlockBaseRef = { kind: "BASE_SALARY" };
const EMPTY_POT = Array<number>(POOL_MONTHS).fill(0);

/** A one-block MULTIPLIER on gross basic salary — the commonest shape by far. */
function percentOfSalary(
  key: string,
  label: string,
  accountCode: string,
  note?: string
): BlockPresetStep {
  return {
    key,
    block: {
      blockType: "MULTIPLIER",
      label,
      accountCode,
      accountLocked: true,
      base: BASE_SALARY,
    },
    note,
  };
}

/** A one-block FLAT_MONTHLY with no account chosen yet. */
function flatMonthly(key: string, label: string, note?: string): BlockPresetStep {
  return {
    key,
    block: {
      blockType: "FLAT_MONTHLY",
      label,
      accountCode: "",
      accountLocked: true,
      increaseAware: false,
    },
    note,
  };
}

export const BLOCK_PRESETS: readonly BlockPreset[] = [
  // ── Pay & premiums ──────────────────────────────────────────────────────
  {
    id: "pension",
    group: "PAY",
    title: "Pension",
    blurb:
      "Employer pension contribution as a percentage of gross basic salary. Type each position's rate in the column — 0.05 is 5%.",
    steps: [percentOfSalary("pension", "Pension", "A565003")],
  },
  {
    id: "overtime",
    group: "PAY",
    title: "Overtime",
    blurb:
      "Hours typed month by month, priced at each position's own hourly rate — annual salary divided by annual hours paid.",
    steps: [
      {
        key: "otHours",
        block: {
          blockType: "CUSTOM_MONTHLY",
          label: "Overtime Hours",
          accountCode: "A988306",
          accountLocked: true,
          // Deliberately off. The merit uplift reaches the cost once, through
          // the rate leg's basic salary; applying it to the hours as well would
          // compound the increase from the merit month onward.
          increaseAware: false,
        },
        note: "Type the overtime hours for each month.",
      },
      {
        key: "otRate",
        block: {
          blockType: "MULTIPLIER",
          label: "Overtime Hourly Rate",
          // No account: an intermediate figure the cost block reads, not a
          // line anybody wants in the output.
          accountCode: "",
          accountLocked: true,
          base: {
            kind: "COMBINE",
            op: "DIV",
            left: BASE_SALARY,
            right: { kind: "STAT", stat: "HOURS_PAID" },
          },
          useRowRate: true,
          // A ratio: the same figure whether the row stands for one person or
          // five, so it opts out of the headcount post-pass.
          ratioNoHeadcount: true,
        },
        note: "Type 1 for plain time, 1.5 for time-and-a-half.",
      },
      {
        key: "otCost",
        block: {
          blockType: "MULTIPLIER",
          label: "Overtime Cost",
          accountCode: "A521001",
          accountLocked: true,
          base: {
            kind: "COMBINE",
            op: "MUL",
            left: { kind: "BLOCK", blockId: "$otHours" },
            right: { kind: "BLOCK", blockId: "$otRate" },
          },
          useRowRate: true,
          // NOT a ratio: a row standing for three people works three lots of
          // overtime, so this line does scale with headcount.
          ratioNoHeadcount: false,
        },
        note: "Type 1 — this column is a second premium factor on top of the rate.",
      },
    ],
  },
  {
    id: "bonus",
    group: "PAY",
    title: "Bonus",
    blurb:
      "A percentage of gross basic salary, accrued across the year. Type each position's rate — 0.1 is 10%.",
    steps: [percentOfSalary("bonus", "Bonus", "A540204")],
  },
  {
    id: "thirteenthMonth",
    group: "PAY",
    title: "13th month / Christmas bonus",
    blurb:
      "The extra month's pay that is contractual across much of southern Europe, accrued evenly rather than booked in one hit.",
    steps: [
      percentOfSalary(
        "thirteenthMonth",
        "13th Month",
        "",
        "Type 0.0833 to accrue one extra month evenly across the year."
      ),
    ],
  },
  {
    id: "servicePool",
    group: "PAY",
    title: "Service charge / tronc pool",
    blurb:
      "One pot a month, divided among the positions that earn it. Type the pot, then a share weight on each participating row.",
    steps: [
      {
        key: "servicePool",
        block: {
          blockType: "POOL_SPREAD",
          label: "Service Charge",
          accountCode: "",
          accountLocked: true,
          poolSource: "MANUAL",
          poolMonthlyAmounts: EMPTY_POT,
          poolSpreadBase: "HEADCOUNT",
          poolEligibilityMode: "MANUAL",
        },
        note: "Set the monthly pot in the cog; any row with a weight above zero is in the pool.",
      },
    ],
  },
  {
    id: "agencyLabour",
    group: "PAY",
    title: "Agency & casual labour",
    blurb:
      "Bought-in cover typed month by month — the spread is entirely manual because agency spend rarely follows the roster.",
    steps: [
      {
        key: "agencyLabour",
        block: {
          blockType: "CUSTOM_MONTHLY",
          label: "Agency Labour",
          accountCode: "",
          accountLocked: true,
          increaseAware: false,
        },
      },
    ],
  },

  // ── Allowances & benefits ───────────────────────────────────────────────
  {
    id: "housing",
    group: "ALLOWANCE",
    title: "Housing allowance",
    blurb:
      "A fixed amount booked every working month. Standard across the Gulf, where it is often a set fraction of basic pay.",
    steps: [flatMonthly("housing", "Housing Allowance")],
  },
  {
    id: "transport",
    group: "ALLOWANCE",
    title: "Transport allowance",
    blurb: "A fixed monthly travel or car allowance.",
    steps: [flatMonthly("transport", "Transport Allowance")],
  },
  {
    id: "dutyMeals",
    group: "ALLOWANCE",
    title: "Duty meals",
    blurb:
      "Meals a year × the cost of a meal, spread across the months by day count so a long month costs more than a short one.",
    steps: [
      {
        key: "dutyMeals",
        block: {
          blockType: "COUNT_RATE",
          label: "Duty Meals",
          accountCode: "",
          accountLocked: true,
          statsAccountCode: "",
          spread: "DAYS",
          increaseAware: false,
        },
        note: "Count = meals a year, rate = cost per meal.",
      },
    ],
  },
  {
    id: "uniform",
    group: "ALLOWANCE",
    title: "Uniform & laundry",
    blurb: "A fixed monthly amount per position for uniform issue and cleaning.",
    steps: [flatMonthly("uniform", "Uniform & Laundry")],
  },
  {
    id: "medical",
    group: "ALLOWANCE",
    title: "Private medical insurance",
    blurb:
      "The employer's monthly premium per position — mandatory for staff in much of the Middle East.",
    steps: [flatMonthly("medical", "Private Medical Insurance")],
  },

  // ── Statutory contributions & levies ────────────────────────────────────
  {
    id: "eosGratuity",
    group: "STATUTORY",
    title: "End of service gratuity",
    blurb:
      "The Gulf end-of-service benefit, accrued monthly against basic salary instead of landing when someone leaves.",
    steps: [
      percentOfSalary(
        "eosGratuity",
        "End of Service Gratuity",
        "",
        "Type 0.0583 for 21 days a year (the statutory minimum), 0.0833 for a full month."
      ),
    ],
  },
  {
    id: "trainingLevy",
    group: "STATUTORY",
    title: "Training levy",
    blurb:
      "A payroll levy charged as a flat percentage of gross basic salary.",
    steps: [
      percentOfSalary(
        "trainingLevy",
        "Training Levy",
        "",
        "UK Apprenticeship Levy 0.005; Ireland NTF and France formation professionnelle differ."
      ),
    ],
  },

  // ── Ratios ──────────────────────────────────────────────────────────────
  {
    id: "costPerHour",
    group: "RATIO",
    title: "Cost per man-hour",
    blurb:
      "Basic salary divided by hours worked — an analysis line, not a cost. Stays a per-person figure however many people a row stands for.",
    steps: [
      {
        key: "costPerHour",
        block: {
          blockType: "MULTIPLIER",
          label: "Cost Per Man-Hour",
          accountCode: "",
          accountLocked: true,
          base: {
            kind: "COMBINE",
            op: "DIV",
            left: BASE_SALARY,
            right: { kind: "STAT", stat: "HOURS" },
          },
          useRowRate: true,
          ratioNoHeadcount: true,
        },
        note: "Type 1 unless you want the ratio scaled.",
      },
    ],
  },
];

export function findBlockPreset(presetId: string): BlockPreset | undefined {
  return BLOCK_PRESETS.find((preset) => preset.id === presetId);
}

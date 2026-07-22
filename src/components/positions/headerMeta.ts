/**
 * Header presentation — the display layer for column headers.
 * -----------------------------------------------------------
 * A header cell has ~150px and two lines to answer three questions: *what* is
 * this, *in what unit*, and *is it mine to edit*. That is more than a single
 * string can carry, so this module splits it:
 *
 *   short   the big line — as few words as possible, distinct within its group
 *   unit    the small line — days / hrs / % / account / the month family tag
 *   hint    the hover tooltip — the full sentence, incl. how it is derived
 *
 * `headerName` stays the long unambiguous name: it is what CSV export, the
 * column menu, and column-picker search read, where there is no group header
 * overhead to lean on.
 *
 * Deliberately renderer-only and keyed by field key — no schema column, no
 * seed bump, and user-created fields fall through to sensible defaults.
 */

import { FieldDef, fieldLabel } from "../../shared/positions/fields";
import { MONTH_LABELS } from "../../shared/calendar";

export interface HeaderPresentation {
  short: string;
  unit: string | null;
  hint: string | null;
}

/** Per-field overrides. Anything absent falls back to the rules below. */
const OVERRIDES: Readonly<
  Record<string, { short?: string; unit?: string; hint?: string }>
> = {
  // ── Employee ──────────────────────────────────────────────────────
  active: {
    short: "Active",
    unit: "yes / no",
    hint:
      "Unchecked keeps the position on file — it still copies into next year — " +
      "but excludes it from the budget entirely.",
  },
  empNumber: { unit: "id", hint: "Payroll employee number." },
  hiringDate: { hint: "Start date. Drives pro-rating in the first budget year." },
  departmentCode: { unit: "code", hint: "Department the position is budgeted under." },
  deptName: { short: "Dept Name", unit: "text" },
  jobTypeCode: { unit: "category", hint: "Manager / Supervisor / Hourly / Casual." },
  title: { unit: "text", hint: "Job title as it appears on the contract." },

  // ── Contract ──────────────────────────────────────────────────────
  contractYearlyDays: {
    unit: "days / yr",
    hint: "Calendar days the contract covers in the year — normally 365.",
  },
  contractDaysOff: {
    unit: "days / yr",
    hint: "Weekend and rest days per year that are not worked.",
  },
  contractPubHolidays: {
    unit: "days / yr",
    hint: "Public holidays per year that are not worked but are paid.",
  },
  dailyContractHours: {
    unit: "hrs / day",
    hint: "Contracted hours in a working day. Feeds the payroll engine.",
  },
  yearlyManhoursPaid: {
    unit: "hrs / yr",
    hint: "Hours paid across the year, including holidays and vacation.",
  },
  yearlyHoursWorked: {
    unit: "hrs / yr",
    hint: "Hours actually worked across the year. Feeds the payroll engine.",
  },
  headcount: { unit: "count", hint: "Number of people on this position line." },
  fte: { unit: "ratio", hint: "Full-time equivalent — 1.00 is a full-time position." },
  cluster: { unit: "group", hint: "Reporting cluster used to roll positions up." },
  payType: {
    unit: "basis",
    hint: "Salaried uses a 30/360 month; Hourly uses real calendar days.",
  },

  // ── Working months ────────────────────────────────────────────────
  totalWorkingMonths: {
    unit: "= sum",
    hint: "Derived: the twelve monthly factors added up. Read-only.",
  },

  // ── Basic salary ──────────────────────────────────────────────────
  monthlyBaseSalary: {
    unit: "amount / mo",
    hint: "Gross monthly basic salary before increases and additional costs.",
  },
  fullYearWage: {
    unit: "= derived",
    hint: "Derived: monthly basic across the working months of the year. Read-only.",
  },
  meritIncreasePct: {
    unit: "% of basic",
    hint: "Merit or other increase, applied from the increase month onward.",
  },
  manualYearlyIncrease: {
    unit: "amount / yr",
    hint: "Flat yearly amount added on top of the merit increase.",
  },
  increaseMonth: {
    unit: "month",
    hint: "Month the increase takes effect. None = no increase this year.",
  },
  budgetYearBasicSalary: {
    unit: "= derived",
    hint: "Derived: the basic salary cost booked for the budget year. Read-only.",
  },

  // ── Vacation ──────────────────────────────────────────────────────
  vacationDays: {
    unit: "days / yr",
    hint: "Vacation entitlement per year under the contract.",
  },
  dailyVacationCost: {
    unit: "amount / day",
    hint: "Cost of one vacation day for this position.",
  },
  accrualDaysPerMonth: {
    unit: "days / mo",
    hint: "Vacation days accrued each month.",
  },
  accrualCostPerDay: {
    unit: "amount / day",
    hint: "Cost booked per accrued vacation day.",
  },
  vacationWeightsTotal: {
    unit: "must = 1",
    hint: "Derived: the twelve vacation weights must add up to 1.00. Read-only.",
  },
  vacationEstimate: {
    unit: "= derived",
    hint: "Derived: estimated vacation cost for the budget year. Read-only.",
  },
};

/** Sub-line tag for the exploded 12-month families. */
const VECTOR_UNITS: Readonly<Record<string, string>> = {
  seasonality: "0–1 worked",
  additionalMonthlyCosts: "add. cost",
  vacationMonthlyWeights: "vac. weight",
};

const VECTOR_HINTS: Readonly<Record<string, string>> = {
  seasonality:
    "Share of the month the position is worked — 1 is a full month, 0 is closed.",
  additionalMonthlyCosts: "One-off cost added to this month on top of basic salary.",
  vacationMonthlyWeights:
    "Share of the yearly vacation cost booked in this month. The twelve weights must add up to 1.00.",
};

/** Fallback sub-line when a field has no override — never invents a unit it
 *  cannot know, only ones the data type guarantees. */
function unitFromType(def: FieldDef): string | null {
  if (def.storage === "COMPUTED") return "= derived";
  switch (def.dataType) {
    case "PERCENT":
      return "%";
    case "ACCOUNT_CODE":
      return "account";
    case "DATE":
      return "date";
    default:
      return null;
  }
}

export function headerPresentation(def: FieldDef): HeaderPresentation {
  const full = fieldLabel(def);
  const override = OVERRIDES[def.key];

  // Month columns carry the month as the big line; the family tag disambiguates
  // the three Jan..Dec runs from each other.
  if (def.vector && def.monthIndex) {
    return {
      short: MONTH_LABELS[def.monthIndex - 1],
      unit: VECTOR_UNITS[def.vector] ?? null,
      hint: `${full} — ${VECTOR_HINTS[def.vector] ?? ""}`.trim(),
    };
  }

  // A user rename is the user's own wording: show it verbatim, don't shorten it.
  const renamed = !!def.customLabel && !def.locked;

  return {
    short: renamed ? full : (override?.short ?? full),
    unit: override?.unit ?? unitFromType(def),
    hint: override?.hint ? `${full} — ${override.hint}` : full,
  };
}

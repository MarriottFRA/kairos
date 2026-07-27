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
  jobTypeCode: {
    unit: "grade",
    hint: "Post classification (grade) — Manager, Supervisor, Associate, Casual, etc. Pay basis is separate (see Pay Basis).",
  },
  title: {
    unit: "local wording",
    hint:
      "Job title in the hotel's own words — as it appears on the contract. " +
      "Free text on purpose; the Standard Title beside it is what the post " +
      "reports under.",
  },
  standardJobTitle: {
    short: "Standard Title",
    unit: "group list",
    hint:
      "The group-wide job title this post rolls up under, picked from a fixed " +
      "list so the same role reads the same way across hotels. Leaves the local " +
      "Job Title beside it untouched.",
  },
  payType: {
    unit: "basis",
    hint: "Salaried uses a 30/360 month; Hourly uses real calendar days.",
  },
  cluster: {
    unit: "staff sharing",
    hint:
      "Hotel cluster this position is shared across. This hotel's weight in the " +
      "cluster flexes the row's hours, costs and statistics down — headcount " +
      "stays whole. Manage clusters on the Clusters tab.",
  },
  clusterMultiplierOverride: {
    short: "Multiplier",
    unit: "× hours & costs",
    hint:
      "The share of this position the hotel carries — the assigned cluster's " +
      "weight for this hotel. Editable only when the cluster has a single " +
      "hotel; scales every cost, hours and FTE line, never the headcount.",
  },
  headcount: {
    unit: "count",
    hint: "Number of identical positions on this line — every cost is multiplied by it.",
  },
  headCountAccount: {
    unit: "A9… account",
    hint:
      "Statistics account the Count posts to. Leave blank and the headcount is " +
      "still calculated but not reported under an account of its own — the " +
      "permanent HC Stats head still books it.",
  },
  headcountStatsAccount: {
    short: "HC Stats",
    unit: "= always",
    hint:
      "The account every position's Count is ALWAYS booked to, whatever the " +
      "Headcount account beside it says — so heads can never go unreported. " +
      "Read-only: this is where the A972540 rows on the Results page come from.",
  },

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
    unit: "= derived",
    hint: "Derived: (Yearly Days − Days Off) × Daily Hours. Read-only.",
  },
  yearlyHoursWorked: {
    unit: "hrs / yr",
    hint: "Auto-calculated: (calendar productive days − vacation days) × daily hours. Feeds the payroll engine. Type a value to override.",
  },
  workingHoursAccount: {
    unit: "A9… account",
    hint:
      "Statistics account the worked hours post to. Blank means the hours are " +
      "still calculated (and still usable as a block base) but are not reported.",
  },
  fte: {
    unit: "= derived",
    hint:
      "Full-time equivalent — 1.00 is a full-time position. Derived: this " +
      "post's worked hours (Yearly Days − Vacation − Days Off − Public " +
      "Holidays, × Daily Hours, prorated by working months) over what a " +
      "full-timer at this hotel works — the Yearly Days / Days Off / Public " +
      "Holidays and Weekly Hours set on the Home page. Read-only.",
  },

  // ── Working months ────────────────────────────────────────────────
  totalWorkingMonths: {
    short: "Total Months",
    unit: "= sum",
    hint:
      "Derived: the twelve monthly factors added up — 12.00 for a post worked " +
      "all year. The monthly columns are folded in behind this one — use the " +
      "chevron to open them up and close a month. Read-only.",
  },

  // ── Basic salary ──────────────────────────────────────────────────
  salaryEntryMode: {
    short: "Salary Entry",
    unit: "typed as",
    hint:
      "Which basic-salary figure you type — the other is derived and locked. " +
      "Annual is the figure on the contract; Monthly is what the budget spreads.",
  },
  annualBaseSalary: {
    short: "Annual Basic",
    unit: "amount / yr",
    hint:
      "Gross yearly basic salary from the contract, before increases and " +
      "additional costs. Divided by the row's working months to give Monthly " +
      "Basic — a nine-month contract states nine months' pay (see Annual Basis).",
  },
  annualDivisorBasis: {
    short: "Annual Basis",
    unit: "÷ divisor",
    hint:
      "How Annual Basic converts to Monthly Basic: by the months this position " +
      "actually works (the default — the contract covers only those months), or " +
      "by a flat 12 for a full-year rate.",
  },
  monthlyBaseSalary: {
    unit: "amount / mo",
    hint:
      "Gross monthly basic salary before increases and additional costs — the " +
      "figure the budget spreads. Derived from Annual Basic unless Salary Entry " +
      "is Monthly. Pay by the hour instead via Pay Basis — only one applies.",
  },
  hourlyRate: {
    unit: "rate / hr",
    hint:
      "Hourly pay rate. When set, it derives the basic salary from hours worked " +
      "(rate × daily hours × productive days) and locks Monthly Basic — only one applies.",
  },
  additionalCostsTotal: {
    short: "Add. Costs",
    unit: "= sum / yr",
    hint:
      "One-off costs added on top of basic salary, added up across the year. " +
      "The twelve monthly columns are folded in behind this one — use the " +
      "chevron to open them up and enter a month. Read-only.",
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
  salaryAccountCode: {
    unit: "A5… account",
    hint:
      "Account the basic salary posts to, net of the vacation taken. Blank means " +
      "the salary is still calculated (and still feeds any block based on it) but " +
      "does not appear on the Results page.",
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
  accrualDaysPerMonth: {
    unit: "days / mo",
    hint: "Vacation days accrued each month. Valued by the engine at this position's daily base pay.",
  },
  accrualAccount: {
    unit: "A5… account",
    hint:
      "Account the accrual MOVEMENT posts to — what was accrued less what was " +
      "taken, so a position that takes exactly its entitlement nets to zero. " +
      "Blank means the movement is calculated but not posted.",
  },
  benefitsAccountCode: {
    unit: "A5… account",
    hint:
      "Account the vacation actually TAKEN posts to — the amount deducted from " +
      "the basic salary line. Blank means the cost is calculated but not posted, " +
      "and the salary line stays net of it either way.",
  },
  vacationWeightsTotal: {
    unit: "must = 100%",
    hint: "Derived: the twelve vacation percentages must add up to 100%. Read-only.",
  },
  vacationEstimate: {
    unit: "= simulated",
    hint: "Simulated: full-year vacation cost from the engine — days valued at daily base pay, weighted across the year and priced against the merit increase. Read-only.",
  },
};

/** Sub-line tag for the exploded 12-month families. */
const VECTOR_UNITS: Readonly<Record<string, string>> = {
  seasonality: "0–1 worked",
  additionalMonthlyCosts: "add. cost",
  vacationMonthlyWeights: "% of yr",
};

const VECTOR_HINTS: Readonly<Record<string, string>> = {
  seasonality:
    "Share of the month the position is worked — 1 is a full month, 0 is closed.",
  additionalMonthlyCosts: "One-off cost added to this month on top of basic salary.",
  vacationMonthlyWeights:
    "Share of the yearly vacation cost booked in this month. The twelve percentages must add up to 100%.",
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

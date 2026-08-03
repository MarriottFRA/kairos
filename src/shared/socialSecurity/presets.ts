/**
 * Social Security country presets — the statutory rows on the "Ready-made" tab.
 *
 * Unlike a block preset these do NOT insert on click: picking one opens the
 * normal SS scheme dialog with the bands, caps and account already filled in,
 * so someone reviews the numbers before they reach a budget. Statutory rates
 * move every year and vary by company size, headcount band and exonerations —
 * the presets are a correctly-shaped starting point, not tax advice.
 *
 * EMPLOYER SIDE ONLY. Employee deductions never reach a payroll budget.
 *
 * Modelling notes that decide the numbers below:
 *
 *  - Rates are FRACTIONS (0.15, not 15). SsSchemeDialog is the only place that
 *    converts to percent for display.
 *  - Every entry is PER_PERIOD, so `upTo` and `monthlyCap` are MONTHLY figures
 *    and each month is taxed on its own. That matches how the statutory
 *    ceilings below are actually published, and it sidesteps the opening-balance
 *    recompute that a CUMULATIVE scheme with a non-January year needs.
 *  - Bands are MARGINAL (execute.ssTax). Where a jurisdiction uses a cliff
 *    instead — Ireland — the preset says so and picks the rate that fits most
 *    hotel staff rather than encoding something the engine cannot express.
 *  - Thresholds are bare numbers in the property's own currency. Nothing in the
 *    model carries a currency, so a GBP threshold on a EUR property is simply
 *    wrong; that is what the review step is for.
 *  - Max 7 bands (SS_MAX_BRACKETS). A country whose full contribution stack
 *    does not fit one scheme is split into several presets — one block each,
 *    which is how the SS block was designed to be used.
 *
 * Rates researched August 2026 from:
 *   UK      https://employerscalculator.co.uk/guides/employer-ni-rates-2026-27
 *   Ireland https://www.citizensinformation.ie/en/social-welfare/irish-social-welfare-system/social-insurance-prsi/paying-social-insurance/
 *   Germany https://www.osborneclarke-arbeitsrecht.de/article/increased-contribution-assessment-ceilings-and-calculation-parameters-in-social-security-2026/
 *   France  https://hayot-expertise.fr/en/blog/french-social-security-ceiling-pass-2026
 *   Spain   https://www.garrigues.com/en_GB/new/spain-order-social-security-contributions-spain-2026-has-been-published
 *   Italy   https://taxsummaries.pwc.com/italy/individual/other-taxes
 *   NL      https://taxsummaries.pwc.com/netherlands/individual/other-taxes
 *   UAE     https://www.zoho.com/en-ae/payroll/academy/compliance/gpssa-and-adpf-pension.html
 *   Saudi   https://mercans.com/resources/statutory-alerts/saudi-arabia-gosi-contribution-rates-saned-unemployment-fund-2026/
 */

import type { SsSchemeInput } from "./ipc";

/** The GL account a new statutory contribution block posts to by default. */
export const DEFAULT_SOCIAL_SECURITY_ACCOUNT = "A560897";

/** Shown once above the statutory rows, and again inside the scheme dialog. */
export const SS_PRESET_DISCLAIMER =
  "Employer rates as researched in August 2026. Check them against your payroll provider before budgeting — statutory rates change yearly and vary by company size and exemptions.";

export interface SsCountryPreset {
  id: string;
  /** Flag emoji, for the row. */
  flag: string;
  /** Groups the rows; several schemes per country is normal. */
  country: string;
  /** Row title — usually the same as the scheme label. */
  title: string;
  /** What it covers and, where it matters, what it deliberately leaves out. */
  blurb: string;
  defaultAccountCode: string;
  /** Everything the scheme dialog seeds from. baseComponentIds is per-OU, so a
   *  preset cannot carry it — the user ticks the contributory base afterwards. */
  scheme: Omit<SsSchemeInput, "id" | "baseComponentIds">;
}

/** Fields every preset shares — per-period, no year mechanics, salary+vacation base. */
const COMMON: Pick<
  SsCountryPreset["scheme"],
  | "yearlyCap"
  | "accumulationMode"
  | "taxYearStartMonth"
  | "includeBaseSalary"
  | "includeVacation"
> = {
  yearlyCap: null,
  accumulationMode: "PER_PERIOD",
  taxYearStartMonth: 1,
  includeBaseSalary: true,
  includeVacation: true,
};

export const SS_COUNTRY_PRESETS: readonly SsCountryPreset[] = [
  {
    id: "uk-employer-ni",
    flag: "🇬🇧",
    country: "United Kingdom",
    title: "Employer NI (Class 1 secondary)",
    blurb:
      "15% on earnings above the £417 monthly Secondary Threshold. The 0% first band IS the threshold.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "UK — Employer NI",
      monthlyCap: null,
      brackets: [
        { upTo: 417, rate: 0 },
        { upTo: null, rate: 0.15 },
      ],
    },
  },
  {
    id: "ie-employer-prsi",
    flag: "🇮🇪",
    country: "Ireland",
    title: "Employer PRSI (Class A)",
    blurb:
      "11.25% including the National Training Fund levy. PRSI is a cliff rather than marginal bands — above €552 a week the higher rate applies to the whole wage — so this uses the higher rate flat. Change it to 9% if your staff earn below that.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Ireland — Employer PRSI",
      monthlyCap: null,
      brackets: [{ upTo: null, rate: 0.1125 }],
    },
  },
  {
    id: "de-pension-unemp",
    flag: "🇩🇪",
    country: "Germany",
    title: "Pension & unemployment (employer)",
    blurb:
      "9.3% pension + 1.3% unemployment, capped at the €8,450 monthly Beitragsbemessungsgrenze. Health and care sit under a different ceiling — add that scheme too.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Germany — Pension & Unemployment",
      monthlyCap: 8450,
      brackets: [{ upTo: null, rate: 0.106 }],
    },
  },
  {
    id: "de-health-care",
    flag: "🇩🇪",
    country: "Germany",
    title: "Health & long-term care (employer)",
    blurb:
      "7.3% health + 1.45% (half the 2.9% average supplement) + 1.8% care, capped at the €5,812.50 monthly ceiling. The supplement varies by Krankenkasse.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Germany — Health & Care",
      monthlyCap: 5812.5,
      brackets: [{ upTo: null, rate: 0.1055 }],
    },
  },
  {
    id: "fr-uncapped",
    flag: "🇫🇷",
    country: "France",
    title: "Employer contributions (uncapped)",
    blurb:
      "A blended ~30% for the déplafonnée stack — maladie, allocations familiales, chômage, retraite complémentaire T1, FNAL, CSA. Rates vary with headcount, salary level and exonerations; treat as a starting point.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "France — Employer (uncapped)",
      monthlyCap: null,
      brackets: [{ upTo: null, rate: 0.3 }],
    },
  },
  {
    id: "fr-capped",
    flag: "🇫🇷",
    country: "France",
    title: "Employer contributions (capped to PMSS)",
    blurb:
      "8.55% vieillesse plafonnée on earnings up to the €4,005 monthly ceiling (PASS €48,060). Normally run alongside the uncapped scheme.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "France — Employer (capped)",
      monthlyCap: 4005,
      brackets: [{ upTo: null, rate: 0.0855 }],
    },
  },
  {
    id: "es-employer-ss",
    flag: "🇪🇸",
    country: "Spain",
    title: "Employer Social Security (general regime)",
    blurb:
      "29.9% — 23.6% common contingencies, 5.5% unemployment, 0.2% FOGASA and 0.6% vocational training — capped at the €5,101.20 monthly base máxima. Excludes the hospitality AT/EP occupational rate, which varies by CNAE.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Spain — Employer Social Security",
      monthlyCap: 5101.2,
      brackets: [{ upTo: null, rate: 0.299 }],
    },
  },
  {
    id: "it-employer-inps",
    flag: "🇮🇹",
    country: "Italy",
    title: "Employer INPS",
    blurb:
      "A blended 30% employer contribution. The exact rate depends on the CCNL and company size; there is a contribution ceiling only for employees first insured after 1996.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Italy — Employer INPS",
      monthlyCap: null,
      brackets: [{ upTo: null, rate: 0.3 }],
    },
  },
  {
    id: "nl-employer",
    flag: "🇳🇱",
    country: "Netherlands",
    title: "Employer premiums",
    blurb:
      "A blended 20% for AOF, Awf, Zvw and the sector premiums, capped at the €6,322 monthly maximum premium wage. Awf depends on whether the contract is permanent.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Netherlands — Employer Premiums",
      monthlyCap: 6322,
      brackets: [{ upTo: null, rate: 0.2 }],
    },
  },
  {
    id: "ae-gpssa",
    flag: "🇦🇪",
    country: "United Arab Emirates",
    title: "GPSSA pension (UAE nationals)",
    blurb:
      "15% employer pension contribution, UAE nationals only — expatriate staff attract none. Abu Dhabi nationals fall under ADPF at a different rate.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "UAE — GPSSA (nationals)",
      monthlyCap: null,
      brackets: [{ upTo: null, rate: 0.15 }],
    },
  },
  {
    id: "sa-gosi-national",
    flag: "🇸🇦",
    country: "Saudi Arabia",
    title: "GOSI (Saudi nationals, new system)",
    blurb:
      "12.75% employer from July 2026, on basic salary plus housing, capped at SAR 45,000 a month. Employees registered before 3 July 2024 stay at 11.75%.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Saudi Arabia — GOSI (nationals)",
      monthlyCap: 45000,
      brackets: [{ upTo: null, rate: 0.1275 }],
    },
  },
  {
    id: "sa-gosi-expat",
    flag: "🇸🇦",
    country: "Saudi Arabia",
    title: "GOSI occupational hazards (non-Saudi)",
    blurb:
      "2% employer occupational-hazards cover — the only GOSI charge on expatriate staff. Same SAR 45,000 monthly ceiling.",
    defaultAccountCode: DEFAULT_SOCIAL_SECURITY_ACCOUNT,
    scheme: {
      ...COMMON,
      label: "Saudi Arabia — GOSI (non-Saudi)",
      monthlyCap: 45000,
      brackets: [{ upTo: null, rate: 0.02 }],
    },
  },
];

export function findSsCountryPreset(
  presetId: string
): SsCountryPreset | undefined {
  return SS_COUNTRY_PRESETS.find((preset) => preset.id === presetId);
}

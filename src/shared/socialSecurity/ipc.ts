/**
 * Social Security / National Insurance — shared types + IPC channel names.
 *
 * A scheme is the progressive contribution model (rate bands + optional
 * monthly/yearly caps) the engine already knows how to run
 * (src/shared/engine: SocialSecurityScheme, compile.validateScheme,
 * execute.ssTax). This module is the WRITE half the engine never had: the
 * payload the configurator sends and the channels it travels on. Schemes are
 * OU-scoped reference data in the PLAINTEXT structure store (ss_schemes /
 * ss_brackets) — same class as block configs, so these channels ARE OU-gated.
 *
 * The engine attaches a scheme to positions via a cost-component definition of
 * kind SOCIAL_SECURITY (a permanent "NI" block, Phase 2b); this contract only
 * covers authoring the scheme itself.
 */

import {
  SocialSecurityScheme,
  SsAccumulationMode,
  SsBracket,
  SS_MAX_BRACKETS,
} from "../engine/types";

/** The payload the configurator sends to create/update a scheme. */
export interface SsSchemeInput {
  /** Omit to create; present to update an existing scheme. */
  id?: string;
  label: string;
  /** Cap on each month's contribution base before accumulation. Null = none. */
  monthlyCap: number | null;
  /** Cap on the cumulative yearly contribution base. Null = none. */
  yearlyCap: number | null;
  /** Ascending by upTo; 1..SS_MAX_BRACKETS; only the last may be unbounded. A
   *  tax-free band is the first bracket with rate 0. */
  brackets: SsBracket[];
  /** Defaults to CUMULATIVE when absent. */
  accumulationMode?: SsAccumulationMode;
  /** Tax-year start month 1–12; defaults to 1 (January). */
  taxYearStartMonth?: number;
  /** Contributory base: include the NET base-salary line. Defaults to true. */
  includeBaseSalary?: boolean;
  /** Contributory base: include the vacation series. Defaults to true. */
  includeVacation?: boolean;
  /** Contributory base: cost-def ids of the custom blocks in this scheme's base. */
  baseComponentIds?: string[];
}

/** Every mutation returns the refreshed list (one round-trip, blocks idiom). */
export interface SsSchemesListResponse {
  schemes: SocialSecurityScheme[];
}

/** Result of a recompute-openings run. */
export interface RecomputeOpeningsResponse {
  updated: number;
}

export const SOCIAL_SECURITY_CHANNELS = {
  /** All non-deleted schemes (with brackets) for the OU. */
  list: "socialSecurity:list",
  /** Create or update a scheme; returns the refreshed list. */
  save: "socialSecurity:save",
  /** Soft-delete a scheme; returns the refreshed list. */
  delete: "socialSecurity:delete",
  /** Run the opening-balance pre-sim for a scenario and persist the results. */
  recomputeOpenings: "socialSecurity:recompute-openings",
} as const;

/**
 * Shared bracket/caps validation — throws a user-facing message. Mirrors the
 * engine compiler's validateScheme (compile.ts) so the write path can never
 * persist a scheme the engine would reject at compile, and adds UX guardrails
 * the engine is lenient about (rate in [0,1], non-negative caps). Used by the
 * repo before writing and available to the configurator for pre-submit checks.
 */
export function validateSsSchemeInput(input: SsSchemeInput): void {
  const label = (input.label ?? "").trim();
  if (!label) throw new Error("Give the scheme a name.");

  if (
    input.accumulationMode !== undefined &&
    input.accumulationMode !== "CUMULATIVE" &&
    input.accumulationMode !== "PER_PERIOD"
  ) {
    throw new Error("Unknown accumulation mode.");
  }
  if (input.taxYearStartMonth !== undefined) {
    const month = input.taxYearStartMonth;
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("Tax-year start month must be between 1 and 12.");
    }
  }
  if (input.baseComponentIds !== undefined && !Array.isArray(input.baseComponentIds)) {
    throw new Error("Base components must be a list.");
  }

  for (const [name, cap] of [
    ["Monthly", input.monthlyCap],
    ["Yearly", input.yearlyCap],
  ] as const) {
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
      throw new Error(`${name} cap must be a positive amount, or empty for none.`);
    }
  }

  const brackets = input.brackets ?? [];
  if (brackets.length < 1 || brackets.length > SS_MAX_BRACKETS) {
    throw new Error(`A scheme needs 1 to ${SS_MAX_BRACKETS} rate bands.`);
  }

  let prev = 0;
  brackets.forEach((bracket, index) => {
    if (!Number.isFinite(bracket.rate) || bracket.rate < 0 || bracket.rate > 1) {
      throw new Error("Each rate must be between 0 and 1 (e.g. 0.12 for 12%).");
    }
    const isLast = index === brackets.length - 1;
    if (bracket.upTo === null) {
      if (!isLast) {
        throw new Error("Only the top rate band can be unbounded (no upper limit).");
      }
    } else {
      if (!Number.isFinite(bracket.upTo) || bracket.upTo <= prev) {
        throw new Error(
          "Rate bands must ascend — each upper limit above the previous (and above 0)."
        );
      }
      prev = bracket.upTo;
    }
  });
}

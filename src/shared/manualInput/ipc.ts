/**
 * Manual input — shared types + IPC channel names.
 *
 * A manual-input row is a hand-entered cost line (description, department, a cost
 * account + a stats account, optional rate) with 12 months of Stats + Amount.
 * "Stats" are the operational units (hours, covers, room nights…); when a rate is
 * set the monthly Amount is derived (stats * rate); with no rate the monthly
 * Amount is typed directly. The spread_* / increase_* fields persist the inline
 * "fill 12 months from a base" helper so it round-trips — a separate Stats base
 * and Amount base; the increase escalates only the Amount side. Rows live in the
 * encrypted secure store. This module is the single contract imported by both the
 * renderer service and the main-process repo/handler.
 */

/** Number of month periods on a row (Jan..Dec). */
export const MANUAL_INPUT_PERIOD_COUNT = 12;

/** Sentinel increase_month meaning "no increase". */
export const MANUAL_INPUT_NO_INCREASE_MONTH = 13;

export type ManualInputRowId = string & { readonly __brand: "ManualInputRowId" };

/** How a base value is distributed across the 12 months by the Apply-spread action. */
export type SpreadMode = "flat" | "daysInMonth";

/** A manual-input row as seen by the renderer. */
export interface ManualInputRow {
  id: ManualInputRowId;
  ou: string;
  /** The planning scenario this row belongs to. Rows post into the persisted
   *  results, which are per (ou, scenario), so a what-if scenario can carry
   *  different manual numbers. '' = not yet healed from a pre-scoping store. */
  scenarioId: string;
  description: string;
  /** Department NAME (carries the code); mirrors the positions convention. */
  department: string;
  /** Auto-filled from the picked department. */
  departmentCode: string;
  /** base_account code for the dollar (Amount) side. */
  costAccount: string;
  /** base_account code for the statistical (Stats) side. */
  statsAccount: string;
  /** NULL => monthly amounts are typed; set => monthly amounts are derived. */
  rate: number | null;
  /** length MANUAL_INPUT_PERIOD_COUNT, Jan..Dec. Operational units (hours, covers…). */
  stats: number[];
  /** length MANUAL_INPUT_PERIOD_COUNT; authoritative only when rate === null. */
  amounts: number[];
  /** null = spread not configured. */
  spreadMode: SpreadMode | null;
  /** Base spread into the 12 Stats cells; null when unset. */
  spreadBaseStats: number | null;
  /** Base spread into the 12 Amount cells; null when unset (ignored if rate-driven). */
  spreadBaseAmount: number | null;
  /** Fractional increase, e.g. 0.05 for +5%. */
  increasePct: number;
  /** 1..12 = apply from that month; 13 = none. */
  increaseMonth: number;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The payload the renderer sends to create/update a row. */
export interface ManualInputRowInput {
  /** Omit to create; present to update an existing row. */
  id?: ManualInputRowId;
  description: string;
  department: string;
  departmentCode: string;
  costAccount: string;
  statsAccount: string;
  rate: number | null;
  stats: number[];
  amounts: number[];
  spreadMode: SpreadMode | null;
  spreadBaseStats: number | null;
  spreadBaseAmount: number | null;
  increasePct: number;
  increaseMonth: number;
}

/** A length-12 vector of zeros — a fresh row's month values. */
export function emptyMonthVector(): number[] {
  return new Array<number>(MANUAL_INPUT_PERIOD_COUNT).fill(0);
}

/** Coerce anything to a well-formed length-12 numeric vector (finite, else 0). */
export function normalizeMonthVector(value: unknown): number[] {
  const out = emptyMonthVector();
  if (Array.isArray(value)) {
    for (let i = 0; i < MANUAL_INPUT_PERIOD_COUNT; i++) {
      const n = Number(value[i]);
      out[i] = Number.isFinite(n) ? n : 0;
    }
  }
  return out;
}

export const MANUAL_INPUT_CHANNELS = {
  /** All rows for the selected hotel, in sort order. */
  list: "manualInput:list",
  /** Create or update a row; returns the refreshed list. */
  save: "manualInput:save",
  /** Soft-delete a row (or several); returns the refreshed list. */
  delete: "manualInput:delete",
} as const;

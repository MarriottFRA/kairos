/**
 * Blocks — shared types + IPC channel names.
 *
 * A "block" is the user-facing configuration for a cost/stat calculation the
 * positions grid renders as a column band. Saving a block COMPILES it into
 * 1..n engine cost-component definitions (deterministic ids `<blockId>:cost`
 * and, for dual-output blocks, `<blockId>:stat`) in the plaintext structure
 * store — the engine itself only ever sees CostComponentDefinition rows.
 * Per-position inputs stay in the encrypted component_values table.
 *
 * This module is the single contract imported by both the renderer service
 * and the main-process repo.
 */

import type {
  CostComponentDefinition,
  SocialSecurityScheme,
  SpreadMethod,
} from "../engine/types";

/** The user-facing block palette. */
export type BlockType =
  | "MULTIPLIER" // per-row multiplier × a chosen base series
  | "FLAT_MONTHLY" // per-row absolute amount booked each active month
  | "COUNT_RATE" // per-row count × rate → cost account, count → stats account
  | "CUSTOM_MONTHLY"; // per-row 12 monthly amounts

export const BLOCK_TYPES: readonly BlockType[] = [
  "MULTIPLIER",
  "FLAT_MONTHLY",
  "COUNT_RATE",
  "CUSTOM_MONTHLY",
] as const;

/** How a COUNT_RATE block distributes its yearly figures across months. */
export type BlockSpread =
  | "ACTIVE_MONTHS" // evenly over the position's working months
  | "DAYS" // proportional to working days per month
  | "VACATION_PATTERN"; // following the position's vacation weights

/**
 * What a MULTIPLIER block multiplies against. BASE_SALARY / BLOCK compile to
 * the engine's existing BaseSelector; KPI compiles to the kpi_driver_id path
 * (series × per-row multiplier, resolved at engine load). STAT / CALENDAR /
 * VACATION are stored as a base_ref JSON on the definition and light up with
 * the matching engine BaseSelector extensions.
 */
export type BlockBaseRef =
  | { kind: "BASE_SALARY" }
  | { kind: "BLOCK"; blockId: string }
  | { kind: "KPI"; kpiDriverId: string }
  | { kind: "STAT"; stat: "HOURS" | "HEADCOUNT" | "FTE" }
  | { kind: "CALENDAR"; series: "PAY_DAYS" | "REAL_DAYS" }
  | { kind: "VACATION" };

/** The payload the renderer sends to create/update a block. */
export interface BlockInput {
  /** Omit to create; present to update an existing block. */
  id?: string;
  /** Immutable after create (the input shape and stored values depend on it). */
  blockType: BlockType;
  label: string;
  /** GL account the cost line posts to. "" = calculation only (never output). */
  accountCode: string;
  /** true = same account for every row; false = per-row dropdown. */
  accountLocked: boolean;
  /** COUNT_RATE only: the stats account the count line posts to. */
  statsAccountCode?: string;
  statsAccountLocked?: boolean;
  /** MULTIPLIER only. */
  base?: BlockBaseRef;
  /** COUNT_RATE only; defaults to ACTIVE_MONTHS. */
  spread?: BlockSpread;
  /** Apply the merit increase from the position's increase month onward. */
  increaseAware?: boolean;
  /** Book to each position's own department, or always to a fixed one. */
  departmentMode?: "POSITION" | "FIXED";
  fixedDepartment?: string;
}

/** A block as seen by the renderer. */
export interface BlockDto {
  id: string;
  ou: string;
  blockType: BlockType;
  label: string;
  accountCode: string;
  accountLocked: boolean;
  statsAccountCode: string;
  statsAccountLocked: boolean;
  base?: BlockBaseRef;
  spread: BlockSpread;
  increaseAware: boolean;
  departmentMode: "POSITION" | "FIXED";
  fixedDepartment?: string;
  sortOrder: number;
  updatedAt: string;
  /** Compiled engine definition ids (the grid keys inputs/totals by these). */
  costDefId: string;
  /** Present for dual-output blocks (COUNT_RATE). */
  statDefId?: string;
}

/**
 * The full structure read model for the OU: blocks plus the raw engine
 * definitions (blocks' compiled defs AND any non-block definitions such as
 * BASE_SALARY) and SS schemes — everything the renderer live-sim needs.
 */
export interface BlocksListResponse {
  blocks: BlockDto[];
  definitions: CostComponentDefinition[];
  ssSchemes: SocialSecurityScheme[];
}

/** Deterministic definition ids a block compiles to. */
export function blockCostDefId(blockId: string): string {
  return `${blockId}:cost`;
}
export function blockStatDefId(blockId: string): string {
  return `${blockId}:stat`;
}

/** Engine spread method a BlockSpread maps to (yearly value is synthesized
 *  per row by the block-value resolver: count × rate or count alone). */
export const SPREAD_TO_METHOD: Record<BlockSpread, SpreadMethod> = {
  ACTIVE_MONTHS: "FLAT_PER_ACTIVE_MONTH",
  DAYS: "FLAT_PER_DAY",
  VACATION_PATTERN: "VACATION_WEIGHTED",
};

export const BLOCKS_CHANNELS = {
  /** Blocks + raw definitions + SS schemes for the OU. */
  list: "blocks:list",
  /** Create or update a block (recompiles its definitions); returns the list. */
  save: "blocks:save",
  /** Soft-delete a block (refused while another block uses it as a base). */
  delete: "blocks:delete",
  /** Restore a soft-deleted block. */
  restore: "blocks:restore",
  /** Persist a new display order (also the engine's deterministic tie-break). */
  reorder: "blocks:reorder",
} as const;

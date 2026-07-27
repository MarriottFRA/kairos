/**
 * Blocks repository — user-facing block configs and their compilation into
 * engine cost-component definitions, all in the plaintext store.
 *
 * Saving a block writes the block_configs row AND (re)compiles its
 * cost_component_definitions projection in the same transaction:
 *   - every block owns a `<blockId>:cost` definition;
 *   - COUNT_RATE blocks additionally own `<blockId>:stat` (the count line to
 *     the stats account);
 *   - a MULTIPLIER block's base compiles to the engine BaseSelector (legacy
 *     base_selector_kind/component_base_refs for BASE_SALARY/BLOCK bases,
 *     base_ref JSON for the extended STAT/CALENDAR/VACATION kinds, and the
 *     kpi_driver_id path for KPI bases).
 *
 * Every function takes the Database handle explicitly (vitest runs these
 * against in-memory databases) and an OuScope — scope.ou is the only OU ever
 * bound into SQL.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { uuidv7 } from "../../shared/engine/ids";
import {
  BLOCK_TYPES,
  BlockBaseRef,
  BlockDto,
  BlockInput,
  BlockSpread,
  BlockType,
  POOL_MONTHS,
  POOL_SPREAD_BASES,
  PoolEligibilityMode,
  PoolSource,
  PoolSpreadBase,
  baseSalaryDefId,
  blockCostDefId,
  blockStatDefId,
  holidayAccrualDefId,
  positionCountDefId,
  SPREAD_TO_METHOD,
  systemStatDefId,
  vacationCostDefId,
} from "../../shared/blocks/ipc";
import { POSITION_COUNT_ACCOUNT } from "../../shared/positions/systemAccounts";
import { OuScope } from "../positions/ouScope";
import { prepared } from "../positions/stmtCache";

type Db = InstanceType<typeof Database>;

/** Type-specific config persisted as block_configs.config JSON. */
interface StoredConfig {
  accountCode: string;
  accountLocked: boolean;
  statsAccountCode: string;
  statsAccountLocked: boolean;
  base?: BlockBaseRef;
  spread: BlockSpread;
  increaseAware: boolean;
  departmentMode: "POSITION" | "FIXED";
  fixedDepartment?: string;
  /** SOCIAL_SECURITY only: attached scheme id (undefined = unconfigured). The
   *  scheme owns its own contributory-base membership now. */
  ssSchemeId?: string;
  /** POOL_SPREAD only: the pot, how it divides, and who shares it. */
  poolSource?: PoolSource;
  poolKpiDriverId?: string;
  poolMonthlyAmounts?: number[];
  poolSpreadBase?: PoolSpreadBase;
  poolEligibilityMode?: PoolEligibilityMode;
  poolDepartments?: string[];
  poolJobTypes?: string[];
}

/** Twelve finite amounts, padded/truncated from whatever was supplied. */
function normPoolAmounts(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: POOL_MONTHS }, (_unused, index) => {
    const value = Number(list[index]);
    return Number.isFinite(value) ? value : 0;
  });
}

/** Trimmed, de-duplicated, blank-free codes — the shape both the rule matcher
 *  and the dialog expect. */
function normCodeList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(list.map((entry) => String(entry ?? "").trim()).filter(Boolean)),
  ];
}

interface BlockRow {
  id: string;
  ou: string;
  block_type: string;
  label: string;
  config: string;
  sort_order: number;
  updated_at: string;
  deleted_at: string | null;
}

function rowToDto(row: BlockRow): BlockDto {
  const config = JSON.parse(row.config || "{}") as Partial<StoredConfig>;
  const blockType = row.block_type as BlockType;
  return {
    id: row.id,
    ou: row.ou,
    blockType,
    label: row.label,
    accountCode: config.accountCode ?? "",
    accountLocked: config.accountLocked ?? true,
    statsAccountCode: config.statsAccountCode ?? "",
    statsAccountLocked: config.statsAccountLocked ?? true,
    base: config.base,
    spread: config.spread ?? "ACTIVE_MONTHS",
    increaseAware: config.increaseAware ?? false,
    departmentMode: config.departmentMode ?? "POSITION",
    fixedDepartment: config.fixedDepartment,
    ssSchemeId: config.ssSchemeId,
    ...(blockType === "POOL_SPREAD"
      ? {
          poolSource: config.poolSource ?? "KPI",
          poolKpiDriverId: config.poolKpiDriverId,
          poolMonthlyAmounts: normPoolAmounts(config.poolMonthlyAmounts),
          poolSpreadBase: config.poolSpreadBase ?? "HEADCOUNT",
          poolEligibilityMode: config.poolEligibilityMode ?? "MANUAL",
          poolDepartments: normCodeList(config.poolDepartments),
          poolJobTypes: normCodeList(config.poolJobTypes),
        }
      : {}),
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
    costDefId: blockCostDefId(row.id),
    statDefId: blockType === "COUNT_RATE" ? blockStatDefId(row.id) : undefined,
  };
}

export function listBlocks(db: Db, scope: OuScope): BlockDto[] {
  const rows = prepared(
    db,
    `SELECT id, ou, block_type, label, config, sort_order, updated_at, deleted_at
       FROM block_configs
      WHERE ou = ? AND deleted_at IS NULL
      ORDER BY sort_order, id`
  ).all(scope.ou) as BlockRow[];
  return rows.map(rowToDto);
}

export function nextBlockSortOrder(db: Db, scope: OuScope): number {
  const row = prepared(
    db,
    `SELECT COALESCE(MAX(sort_order), 0) AS top FROM block_configs WHERE ou = ?`
  ).get(scope.ou) as { top: number };
  return row.top + 10;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A block id is usable as a base when it is not this block and still exists. */
function assertUsableBaseBlock(
  db: Db,
  scope: OuScope,
  selfId: string | undefined,
  baseBlockId: string
): void {
  if (baseBlockId === selfId) {
    throw new Error("A block cannot use itself as its base.");
  }
  const exists = prepared(
    db,
    `SELECT 1 FROM block_configs WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(baseBlockId, scope.ou);
  if (!exists) throw new Error("The base block no longer exists.");
}

/** Every block this one would reach through its base chain, plus their labels. */
function walkBaseChain(
  db: Db,
  scope: OuScope,
  startIds: string[]
): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const blockId = queue.shift() as string;
    if (seen.has(blockId)) continue;
    const row = prepared(
      db,
      `SELECT label, config FROM block_configs
        WHERE id = ? AND ou = ? AND deleted_at IS NULL`
    ).get(blockId, scope.ou) as { label: string; config: string } | undefined;
    if (!row) continue;
    seen.set(blockId, row.label);
    const base = (JSON.parse(row.config || "{}") as Partial<StoredConfig>).base;
    if (base?.kind === "BLOCK") queue.push(base.blockId);
    else if (base?.kind === "COMPOSITE") queue.push(...normCodeList(base.blockIds));
  }
  return seen;
}

/** Refuse a base that would (transitively) depend on the block being saved. */
function assertNoBaseCycle(
  db: Db,
  scope: OuScope,
  selfId: string | undefined,
  baseBlockIds: string[]
): void {
  if (!selfId) return; // a brand-new block cannot yet be anyone's base
  const reachable = walkBaseChain(db, scope, baseBlockIds);
  const label = reachable.get(selfId);
  if (label !== undefined) {
    throw new Error(
      `That base loops back to this block (via ${label}). ` +
        `Pick a base that does not depend on it.`
    );
  }
}

function validateInput(db: Db, scope: OuScope, input: BlockInput): void {
  if (!BLOCK_TYPES.includes(input.blockType)) {
    throw new Error(`Unknown block type: ${input.blockType}`);
  }
  if (!String(input.label ?? "").trim()) {
    throw new Error("A block name is required.");
  }

  if (input.blockType === "MULTIPLIER") {
    const base = input.base;
    if (!base) throw new Error("A multiplier block needs a base to multiply.");
    if (base.kind === "BLOCK") {
      assertUsableBaseBlock(db, scope, input.id, base.blockId);
    }
    if (base.kind === "COMPOSITE") {
      const blockIds = normCodeList(base.blockIds);
      if (!base.includeBaseSalary && blockIds.length === 0) {
        throw new Error("Choose at least one thing for the base to add up.");
      }
      for (const blockId of blockIds) assertUsableBaseBlock(db, scope, input.id, blockId);
      // A single base is a straight lookup, but a composite can reach another
      // composite, so a cycle need not involve this block directly. Catch it
      // here with a name the user recognizes rather than letting compile()
      // surface CYCLE at recalc time, long after the save appeared to succeed.
      assertNoBaseCycle(db, scope, input.id, blockIds);
    }
    if (base.kind === "KPI" && !String(base.kpiDriverId ?? "").trim()) {
      throw new Error("A KPI base needs a KPI driver.");
    }
  }

  if (input.blockType === "POOL_SPREAD") {
    const source = input.poolSource ?? "KPI";
    if (source === "KPI" && !String(input.poolKpiDriverId ?? "").trim()) {
      throw new Error("A pooled block needs a KPI to size the pot.");
    }
    if (source === "MANUAL") {
      const amounts = input.poolMonthlyAmounts ?? [];
      if (amounts.length !== POOL_MONTHS) {
        throw new Error(`A manual pot needs ${POOL_MONTHS} monthly amounts.`);
      }
      if (amounts.some((amount) => !Number.isFinite(Number(amount)))) {
        throw new Error("Every monthly pot amount must be a number.");
      }
    }
    if (
      input.poolSpreadBase !== undefined &&
      !POOL_SPREAD_BASES.includes(input.poolSpreadBase)
    ) {
      throw new Error(`Unknown spread basis: ${input.poolSpreadBase}`);
    }
    // A RULE with both filter lists empty is legal and means "everyone" — the
    // simplest way to pool across the whole hotel without ticking every row.
  }

  if (
    input.spread !== undefined &&
    !(input.spread in SPREAD_TO_METHOD)
  ) {
    throw new Error(`Unknown spread choice: ${input.spread}`);
  }
  if (input.departmentMode === "FIXED" && !String(input.fixedDepartment ?? "").trim()) {
    throw new Error("Choose the department the block should book to.");
  }
}

// ---------------------------------------------------------------------------
// Block → definition compilation
// ---------------------------------------------------------------------------

interface DefRow {
  id: string;
  kind: "SPREAD" | "SOCIAL_SECURITY";
  spreadMethod: string | null;
  label: string;
  accountCode: string;
  baseSelectorKind: "BASE_SALARY" | "COMPONENTS" | null;
  baseRefJson: string | null;
  baseRefDefIds: string[];
  kpiDriverId: string | null;
  ssSchemeId: string | null;
  increaseAware: boolean;
}

/** The engine definitions a block compiles to (pure; exported for tests). */
export function compileBlockDefs(
  blockId: string,
  ou: string,
  input: BlockInput
): DefRow[] {
  const common = {
    kind: "SPREAD" as const,
    baseSelectorKind: null as DefRow["baseSelectorKind"],
    baseRefJson: null as string | null,
    baseRefDefIds: [] as string[],
    kpiDriverId: null as string | null,
    ssSchemeId: null as string | null,
  };

  switch (input.blockType) {
    case "SOCIAL_SECURITY": {
      // An NI/SS block. Emits nothing until a scheme is attached — a
      // SOCIAL_SECURITY def with no/invalid scheme fails compile
      // (MISSING_SCHEME), so an unconfigured block must produce no def. The
      // base selector stored here is a placeholder; it is overwritten at engine
      // load with the scheme's own SS_BASE membership (applySocialSecurityBase).
      const schemeId = String(input.ssSchemeId ?? "").trim();
      if (!schemeId) return [];
      return [
        {
          ...common,
          kind: "SOCIAL_SECURITY",
          id: blockCostDefId(blockId),
          spreadMethod: null,
          label: input.label,
          accountCode: input.accountCode ?? "",
          baseSelectorKind: "COMPONENTS",
          ssSchemeId: schemeId,
          increaseAware: false,
        },
      ];
    }
    case "MULTIPLIER": {
      const base = input.base!;
      const def: DefRow = {
        ...common,
        id: blockCostDefId(blockId),
        spreadMethod: "PERCENT_OF",
        label: input.label,
        accountCode: input.accountCode ?? "",
        // PERCENT_OF inherits any merit increase through its base series.
        increaseAware: false,
      };
      if (base.kind === "KPI") {
        // The engine-load path resolves kpi_driver_id → DIRECT_ABS monthly
        // values × the per-row multiplier (ComponentValue.rate).
        def.spreadMethod = "DIRECT_ABS";
        def.kpiDriverId = base.kpiDriverId;
      } else if (base.kind === "BASE_SALARY") {
        def.baseSelectorKind = "BASE_SALARY";
      } else if (base.kind === "BLOCK") {
        def.baseSelectorKind = "COMPONENTS";
        def.baseRefDefIds = [blockCostDefId(base.blockId)];
      } else if (base.kind === "COMPOSITE") {
        // The engine's COMPONENTS selector sums its refs, and reads the
        // BASE_SALARY definition as gross salary rather than recursing into it
        // — so "salary + these blocks" needs no new engine kind, just the right
        // id list. Base salary leads so the compiled order matches how the
        // dialog reads.
        def.baseSelectorKind = "COMPONENTS";
        def.baseRefDefIds = [
          ...(base.includeBaseSalary ? [baseSalaryDefId(ou)] : []),
          ...normCodeList(base.blockIds).map(blockCostDefId),
        ];
      } else if (base.kind === "STAT") {
        // Stat series (hours worked, headcount, FTE) are ordinary engine
        // lines: reference the system stat definition (seeded on save) via
        // the existing COMPONENTS selector.
        def.baseSelectorKind = "COMPONENTS";
        def.baseRefDefIds = [systemStatDefId(ou, base.stat)];
      } else {
        // CALENDAR / VACATION — engine base kinds beyond the legacy CHECK,
        // carried as base_ref JSON (read preference in getComponentDefinitions).
        def.baseRefJson = JSON.stringify(base);
      }
      return [def];
    }
    case "FLAT_MONTHLY": {
      return [
        {
          ...common,
          id: blockCostDefId(blockId),
          spreadMethod: "FLAT_MONTHLY",
          label: input.label,
          accountCode: input.accountCode ?? "",
          increaseAware: input.increaseAware ?? false,
        },
      ];
    }
    case "COUNT_RATE": {
      const method = SPREAD_TO_METHOD[input.spread ?? "ACTIVE_MONTHS"];
      return [
        {
          ...common,
          id: blockCostDefId(blockId),
          spreadMethod: method,
          label: input.label,
          accountCode: input.accountCode ?? "",
          increaseAware: input.increaseAware ?? false,
        },
        {
          ...common,
          id: blockStatDefId(blockId),
          spreadMethod: method,
          label: `${input.label} (count)`,
          accountCode: input.statsAccountCode ?? "",
          // Counts are quantities, never merit-increased.
          increaseAware: false,
        },
      ];
    }
    case "CUSTOM_MONTHLY": {
      return [
        {
          ...common,
          id: blockCostDefId(blockId),
          spreadMethod: "DIRECT_MONTHLY",
          label: input.label,
          accountCode: input.accountCode ?? "",
          increaseAware: input.increaseAware ?? false,
        },
      ];
    }
    case "POOL_SPREAD": {
      // The division happens before compile (engineInput.applyPoolSpread writes
      // each position's share into ComponentValue.monthlyValues), so the engine
      // only ever sees absolute per-month figures. DIRECT_ABS is also what makes
      // the arithmetic right: it is exempt from the headcount × cluster-weight
      // post-pass, and both are already baked into the share weights — applying
      // them twice would break the "shares sum to the pot" guarantee.
      //
      // Deliberately NOT kpiDriverId, even for a KPI-sourced pot: that column
      // is injectKpiSeries' trigger, and it would read the per-row eligibility
      // flag as a multiplier. The driver id lives in the block config alone.
      return [
        {
          ...common,
          id: blockCostDefId(blockId),
          spreadMethod: "DIRECT_ABS",
          label: input.label,
          accountCode: input.accountCode ?? "",
          // A share of a fixed pot; a merit increase would inflate the total.
          increaseAware: false,
        },
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function saveBlock(
  db: Db,
  scope: OuScope,
  input: BlockInput,
  opts: { now: string }
): string {
  validateInput(db, scope, input);

  const existing = input.id
    ? (prepared(
        db,
        `SELECT id, block_type, sort_order FROM block_configs
          WHERE id = ? AND ou = ? AND deleted_at IS NULL`
      ).get(input.id, scope.ou) as
        | { id: string; block_type: string; sort_order: number }
        | undefined)
    : undefined;
  if (input.id && !existing) {
    throw new Error("This block no longer exists.");
  }
  if (existing && existing.block_type !== input.blockType) {
    throw new Error("A block's type cannot change after it is created.");
  }

  const id = existing?.id ?? uuidv7();
  const sortOrder = existing?.sort_order ?? nextBlockSortOrder(db, scope);
  const config: StoredConfig = {
    accountCode: input.accountCode ?? "",
    accountLocked: input.accountLocked ?? true,
    statsAccountCode: input.statsAccountCode ?? "",
    statsAccountLocked: input.statsAccountLocked ?? true,
    base: input.base,
    spread: input.spread ?? "ACTIVE_MONTHS",
    increaseAware: input.increaseAware ?? false,
    departmentMode: input.departmentMode ?? "POSITION",
    fixedDepartment: input.fixedDepartment,
    ssSchemeId: input.ssSchemeId?.trim() ? input.ssSchemeId.trim() : undefined,
    ...(input.blockType === "POOL_SPREAD"
      ? {
          poolSource: input.poolSource ?? "KPI",
          poolKpiDriverId: input.poolKpiDriverId?.trim() || undefined,
          poolMonthlyAmounts: normPoolAmounts(input.poolMonthlyAmounts),
          poolSpreadBase: input.poolSpreadBase ?? "HEADCOUNT",
          poolEligibilityMode: input.poolEligibilityMode ?? "MANUAL",
          poolDepartments: normCodeList(input.poolDepartments),
          poolJobTypes: normCodeList(input.poolJobTypes),
        }
      : {}),
  };
  const defs = compileBlockDefs(id, scope.ou, input);

  db.transaction(() => {
    if (input.blockType === "MULTIPLIER" && input.base?.kind === "STAT") {
      ensureSystemStatDef(db, scope, input.base.stat, opts);
    }
    if (
      input.blockType === "MULTIPLIER" &&
      input.base?.kind === "COMPOSITE" &&
      input.base.includeBaseSalary
    ) {
      // The composite refs it by id, so make sure the head exists even when the
      // block is saved before the structure read model has ever been built.
      ensureBaseSalaryDef(db, scope, opts);
    }
    prepared(
      db,
      `INSERT INTO block_configs (id, ou, block_type, label, config, sort_order, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         config = excluded.config,
         updated_at = excluded.updated_at,
         deleted_at = NULL
       WHERE block_configs.ou = excluded.ou`
    ).run(id, scope.ou, input.blockType, input.label.trim(), JSON.stringify(config), sortOrder, opts.now);

    // Recompile the definition projection: upsert current defs, drop any the
    // new shape no longer owns (a COUNT_RATE edited never changes type, but a
    // defensive sweep keeps the projection exact), and replace base refs.
    const currentIds = defs.map((def) => def.id);
    prepared(
      db,
      `DELETE FROM cost_component_definitions
        WHERE ou = ? AND block_id = ? AND id NOT IN (${currentIds.map(() => "?").join(",")})`
    ).run(scope.ou, id, ...currentIds);

    for (const def of defs) {
      prepared(
        db,
        `INSERT INTO cost_component_definitions (
           id, ou, kind, spread_method, stat_kind, label, account_code,
           department_mode, fixed_department, increase_aware, sort_order,
           base_selector_kind, ss_scheme_id, kpi_driver_id, block_id, base_ref,
           updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           spread_method = excluded.spread_method,
           label = excluded.label,
           account_code = excluded.account_code,
           department_mode = excluded.department_mode,
           fixed_department = excluded.fixed_department,
           increase_aware = excluded.increase_aware,
           sort_order = excluded.sort_order,
           base_selector_kind = excluded.base_selector_kind,
           ss_scheme_id = excluded.ss_scheme_id,
           kpi_driver_id = excluded.kpi_driver_id,
           base_ref = excluded.base_ref,
           updated_at = excluded.updated_at,
           deleted_at = NULL
         WHERE cost_component_definitions.ou = excluded.ou`
      ).run(
        def.id,
        scope.ou,
        def.kind,
        def.spreadMethod,
        def.label,
        def.accountCode,
        config.departmentMode,
        config.departmentMode === "FIXED" ? config.fixedDepartment ?? null : null,
        def.increaseAware ? 1 : 0,
        sortOrder,
        def.baseSelectorKind,
        def.ssSchemeId,
        def.kpiDriverId,
        id,
        def.baseRefJson,
        opts.now
      );

      prepared(
        db,
        `DELETE FROM component_base_refs WHERE component_def_id = ?`
      ).run(def.id);
      def.baseRefDefIds.forEach((refId, index) => {
        prepared(
          db,
          `INSERT INTO component_base_refs (component_def_id, referenced_def_id, sort_order)
           VALUES (?, ?, ?)`
        ).run(def.id, refId, index);
      });
    }
  })();

  return id;
}

/**
 * Blocks (labels) whose defs reference any of this block's defs as a base.
 * Used to refuse deletion while something would break.
 */
export function referencingBlockLabels(
  db: Db,
  scope: OuScope,
  blockId: string
): string[] {
  const rows = prepared(
    db,
    `SELECT DISTINCT b.label
       FROM component_base_refs r
       JOIN cost_component_definitions d ON d.id = r.component_def_id
       JOIN block_configs b ON b.id = d.block_id
      WHERE d.ou = ? AND d.deleted_at IS NULL AND b.deleted_at IS NULL
        AND d.block_id != ?
        AND r.referenced_def_id IN (?, ?)`
  ).all(scope.ou, blockId, blockCostDefId(blockId), blockStatDefId(blockId)) as Array<{
    label: string;
  }>;
  return rows.map((row) => row.label);
}

export function deleteBlock(
  db: Db,
  scope: OuScope,
  blockId: string,
  opts: { now: string }
): void {
  const referencedBy = referencingBlockLabels(db, scope, blockId);
  if (referencedBy.length > 0) {
    throw new Error(
      `This block is used as a base by: ${referencedBy.join(", ")}. ` +
        `Change those blocks first, then delete this one.`
    );
  }
  db.transaction(() => {
    prepared(
      db,
      `UPDATE block_configs SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND ou = ? AND deleted_at IS NULL`
    ).run(opts.now, opts.now, blockId, scope.ou);
    prepared(
      db,
      `UPDATE cost_component_definitions SET deleted_at = ?, updated_at = ?
        WHERE block_id = ? AND ou = ? AND deleted_at IS NULL`
    ).run(opts.now, opts.now, blockId, scope.ou);
  })();
}

export function restoreBlock(
  db: Db,
  scope: OuScope,
  blockId: string,
  opts: { now: string }
): void {
  db.transaction(() => {
    prepared(
      db,
      `UPDATE block_configs SET deleted_at = NULL, updated_at = ?
        WHERE id = ? AND ou = ? AND deleted_at IS NOT NULL`
    ).run(opts.now, blockId, scope.ou);
    prepared(
      db,
      `UPDATE cost_component_definitions SET deleted_at = NULL, updated_at = ?
        WHERE block_id = ? AND ou = ? AND deleted_at IS NOT NULL`
    ).run(opts.now, blockId, scope.ou);
  })();
}

/** Persist a new display order; mirrored onto the defs so the engine's
 *  deterministic (sortOrder, id) tie-break follows the user's order. */
export function reorderBlocks(
  db: Db,
  scope: OuScope,
  orderedIds: string[],
  opts: { now: string }
): void {
  db.transaction(() => {
    orderedIds.forEach((blockId, index) => {
      const sortOrder = (index + 1) * 10;
      prepared(
        db,
        `UPDATE block_configs SET sort_order = ?, updated_at = ?
          WHERE id = ? AND ou = ? AND deleted_at IS NULL`
      ).run(sortOrder, opts.now, blockId, scope.ou);
      prepared(
        db,
        `UPDATE cost_component_definitions SET sort_order = ?, updated_at = ?
          WHERE block_id = ? AND ou = ? AND deleted_at IS NULL`
      ).run(sortOrder, opts.now, blockId, scope.ou);
    });
  })();
}

/**
 * The engine mandates exactly one BASE_SALARY definition per scenario; hotels
 * that have never configured one get a system row so the component graph is
 * always compilable. Idempotent (fixed id per OU). The base-salary line's
 * account wiring lands with the outputs phase.
 */
export function ensureBaseSalaryDef(
  db: Db,
  scope: OuScope,
  opts: { now: string }
): void {
  prepared(
    db,
    `INSERT INTO cost_component_definitions (
       id, ou, kind, spread_method, stat_kind, label, account_code,
       department_mode, fixed_department, increase_aware, sort_order,
       base_selector_kind, ss_scheme_id, kpi_driver_id, block_id, base_ref,
       updated_at, deleted_at
     ) VALUES (?, ?, 'BASE_SALARY', NULL, NULL, 'Base Salary', '',
               'POSITION', NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, NULL)
     ON CONFLICT(id) DO NOTHING`
  ).run(baseSalaryDefId(scope.ou), scope.ou, opts.now);
}

/**
 * The universal "position count" head — VBA Engine §21 "Stats Position Count".
 * Unlike the per-position Headcount account (which the user sets per row and may
 * leave blank), this head is ALWAYS booked, to a fixed account, so a scenario can
 * never silently fail to report its heads. It is a plain STAT/HEADCOUNT line —
 * same math as any headcount (emit Count in each active month, never flexed by
 * hotel-cluster weight, zero where Count is 0) — differing only in that its
 * account is pinned and it is seeded permanently rather than on demand.
 *
 * Defined in shared/ because the renderer's field seed surfaces it as the
 * read-only "HC Stats" column; re-exported here so main-side call sites keep
 * reading it from the module that owns the definition it pins.
 */
export {
  POSITION_COUNT_ACCOUNT,
  baseSalaryDefId,
  holidayAccrualDefId,
  positionCountDefId,
  systemStatDefId,
  vacationCostDefId,
};

/**
 * Idempotently seed the permanent position-count head. Always present (fixed id
 * per OU) so every scenario books its heads to POSITION_COUNT_ACCOUNT. Seeded
 * alongside ensureBaseSalaryDef wherever the structure read model is built.
 */
export function ensurePositionCountDef(
  db: Db,
  scope: OuScope,
  opts: { now: string }
): void {
  prepared(
    db,
    `INSERT INTO cost_component_definitions (
       id, ou, kind, spread_method, stat_kind, label, account_code,
       department_mode, fixed_department, increase_aware, sort_order,
       base_selector_kind, ss_scheme_id, kpi_driver_id, block_id, base_ref,
       updated_at, deleted_at
     ) VALUES (?, ?, 'STAT', NULL, 'HEADCOUNT', 'Position Count', ?,
               'POSITION', NULL, 0, 6, NULL, NULL, NULL, NULL, NULL, ?, NULL)
     ON CONFLICT(id) DO NOTHING`
  ).run(positionCountDefId(scope.ou), scope.ou, POSITION_COUNT_ACCOUNT, opts.now);
}

const STAT_DEF_LABELS: Record<"HOURS" | "HEADCOUNT" | "FTE", string> = {
  HOURS: "Hours Worked",
  HEADCOUNT: "Headcount",
  FTE: "FTE",
};

/** Idempotently seed the system stat definition a STAT base references.
 *  Blank account → the line computes (and is base-referenceable) but is
 *  never part of the output. HOURS and HEADCOUNT are additionally seeded
 *  unconditionally (see ensureSystemDefs) because the Positions grid offers a
 *  per-row account for each; FTE is still on-demand only, having no account
 *  field of its own (retired in field seed v13 — FTE is a ratio with no GL
 *  account). */
export function ensureSystemStatDef(
  db: Db,
  scope: OuScope,
  stat: "HOURS" | "HEADCOUNT" | "FTE",
  opts: { now: string }
): void {
  prepared(
    db,
    `INSERT INTO cost_component_definitions (
       id, ou, kind, spread_method, stat_kind, label, account_code,
       department_mode, fixed_department, increase_aware, sort_order,
       base_selector_kind, ss_scheme_id, kpi_driver_id, block_id, base_ref,
       updated_at, deleted_at
     ) VALUES (?, ?, 'STAT', NULL, ?, ?, '',
               'POSITION', NULL, 0, 5, NULL, NULL, NULL, NULL, NULL, ?, NULL)
     ON CONFLICT(id) DO NOTHING`
  ).run(systemStatDefId(scope.ou, stat), scope.ou, stat, STAT_DEF_LABELS[stat], opts.now);
}

/**
 * The holiday-accrual head — VBA §2's holiday account. Books the accrual
 * MOVEMENT: accrualDays × per-working-day pay − the leave actually taken, so a
 * position that takes exactly what it accrues nets to zero. Posts to the row's
 * Accrual account; blank means the line still computes (and can still feed an
 * SS base) but is not output.
 *
 * increase_aware is 0 because it is not consulted: Op.ACCRUAL applies inc[m]
 * unconditionally (compile emits it with no flag), so the accrual is always
 * merit-scaled and the column would only misleadingly suggest otherwise.
 */
export function ensureHolidayAccrualDef(
  db: Db,
  scope: OuScope,
  opts: { now: string }
): void {
  prepared(
    db,
    `INSERT INTO cost_component_definitions (
       id, ou, kind, spread_method, stat_kind, label, account_code,
       department_mode, fixed_department, increase_aware, sort_order,
       base_selector_kind, ss_scheme_id, kpi_driver_id, block_id, base_ref,
       updated_at, deleted_at
     ) VALUES (?, ?, 'HOLIDAY_ACCRUAL', NULL, NULL, 'Vacation Accrual', '',
               'POSITION', NULL, 0, 3, NULL, NULL, NULL, NULL, NULL, ?, NULL)
     ON CONFLICT(id) DO NOTHING`
  ).run(holidayAccrualDefId(scope.ou), scope.ou, opts.now);
}

/**
 * The vacation-cost head — the leave actually taken, which BASE_DEDUCT nets out
 * of the salary line. Without this the money simply disappeared: base salary is
 * reported net of vacation and nothing re-emitted the deduction.
 *
 * Deliberately NOT a new engine kind. It is a PERCENT_OF spread over the
 * existing `{"kind":"VACATION"}` base selector, which resolves to the position's
 * vacation-cost series (compile emits ACC_ADD_VAC; reference.ts mirrors it), with
 * a per-position rate of 1. So this needs no opcode, no ComponentKind, and no
 * migration of the `kind` CHECK constraint. `base_ref` carries the selector as
 * JSON because base_selector_kind's CHECK cannot be widened in SQLite — the same
 * escape hatch the CALENDAR/VACATION block bases already use.
 *
 * increase_aware is 0: the vacation series is already merit-scaled by the
 * VACATION op (it reads inc[m]), so flagging it here would apply the raise twice.
 */
export function ensureVacationCostDef(
  db: Db,
  scope: OuScope,
  opts: { now: string }
): void {
  prepared(
    db,
    `INSERT INTO cost_component_definitions (
       id, ou, kind, spread_method, stat_kind, label, account_code,
       department_mode, fixed_department, increase_aware, sort_order,
       base_selector_kind, ss_scheme_id, kpi_driver_id, block_id, base_ref,
       updated_at, deleted_at
     ) VALUES (?, ?, 'SPREAD', 'PERCENT_OF', NULL, 'Vacation Cost', '',
               'POSITION', NULL, 0, 2, NULL, NULL, NULL, NULL, ?, ?, NULL)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    vacationCostDefId(scope.ou),
    scope.ou,
    JSON.stringify({ kind: "VACATION" }),
    opts.now
  );
}

/**
 * Seed every permanently-present system definition for an OU, idempotently.
 *
 * These are the heads that exist regardless of what blocks the user has built,
 * one for each posting account the Positions grid offers. All but the
 * position-count head seed a BLANK account: the account arrives per position via
 * applyPositionAccounts, so a row that has not picked one computes the line (and
 * can still reference it as a base) without posting it.
 *
 * Call this wherever the structure read model is built — the grid's account
 * columns are inert until the definitions they attach to exist.
 */
export function ensureSystemDefs(
  db: Db,
  scope: OuScope,
  opts: { now: string }
): void {
  ensureBaseSalaryDef(db, scope, opts);
  ensurePositionCountDef(db, scope, opts);
  ensureSystemStatDef(db, scope, "HEADCOUNT", opts);
  ensureSystemStatDef(db, scope, "HOURS", opts);
  ensureHolidayAccrualDef(db, scope, opts);
  ensureVacationCostDef(db, scope, opts);
}

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
  blockCostDefId,
  blockStatDefId,
  SPREAD_TO_METHOD,
} from "../../shared/blocks/ipc";
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
      if (base.blockId === input.id) {
        throw new Error("A block cannot use itself as its base.");
      }
      const exists = prepared(
        db,
        `SELECT 1 FROM block_configs WHERE id = ? AND ou = ? AND deleted_at IS NULL`
      ).get(base.blockId, scope.ou);
      if (!exists) throw new Error("The base block no longer exists.");
    }
    if (base.kind === "KPI" && !String(base.kpiDriverId ?? "").trim()) {
      throw new Error("A KPI base needs a KPI driver.");
    }
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
  kind: "SPREAD";
  spreadMethod: string;
  label: string;
  accountCode: string;
  baseSelectorKind: "BASE_SALARY" | "COMPONENTS" | null;
  baseRefJson: string | null;
  baseRefDefIds: string[];
  kpiDriverId: string | null;
  increaseAware: boolean;
}

/** Fixed id of a system stat definition (blank account → compute-only line
 *  usable as a multiplier base; never output). */
export function systemStatDefId(
  ou: string,
  stat: "HOURS" | "HEADCOUNT" | "FTE"
): string {
  return `sys-stat-${stat.toLowerCase()}:${ou}`;
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
  };

  switch (input.blockType) {
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
  };
  const defs = compileBlockDefs(id, scope.ou, input);

  db.transaction(() => {
    if (input.blockType === "MULTIPLIER" && input.base?.kind === "STAT") {
      ensureSystemStatDef(db, scope, input.base.stat, opts);
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
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           spread_method = excluded.spread_method,
           label = excluded.label,
           account_code = excluded.account_code,
           department_mode = excluded.department_mode,
           fixed_department = excluded.fixed_department,
           increase_aware = excluded.increase_aware,
           sort_order = excluded.sort_order,
           base_selector_kind = excluded.base_selector_kind,
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
  ).run(`sys-base:${scope.ou}`, scope.ou, opts.now);
}

const STAT_DEF_LABELS: Record<"HOURS" | "HEADCOUNT" | "FTE", string> = {
  HOURS: "Hours Worked",
  HEADCOUNT: "Headcount",
  FTE: "FTE",
};

/** Idempotently seed the system stat definition a STAT base references.
 *  Blank account → the line computes (and is base-referenceable) but is
 *  never part of the output. */
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

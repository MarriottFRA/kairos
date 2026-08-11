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
import type { BaseSelector, ComponentDefId } from "../../shared/engine/types";
import {
  BLOCK_TYPES,
  BlockBaseRef,
  BLOCK_COMBINE_OPS,
  BlockDepartmentMode,
  BlockDto,
  BlockInput,
  BlockSpread,
  BlockType,
  POOL_MONTHS,
  POOL_SPREAD_BASES,
  POOL_WEIGHT_DEFAULT,
  POOL_WEIGHT_MAX,
  PoolEligibilityMode,
  PoolSource,
  PoolSpreadBase,
  baseSalaryDefId,
  blockCostDefId,
  blockStatDefId,
  holidayAccrualDefId,
  positionCountDefId,
  SPREAD_TO_METHOD,
  SPREAD_TO_STAT_BASE,
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
  /** MULTIPLIER + COMBINE base only — see BlockInput.useRowRate. */
  useRowRate?: boolean;
  /** MULTIPLIER + COMBINE base only — see BlockInput.ratioNoHeadcount. */
  ratioNoHeadcount?: boolean;
  spread: BlockSpread;
  increaseAware: boolean;
  departmentMode: BlockDepartmentMode;
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
  poolJobTypeWeights?: Record<string, number>;
}

/** Twelve finite amounts, padded/truncated from whatever was supplied. */
function normPoolAmounts(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: POOL_MONTHS }, (_unused, index) => {
    const value = Number(list[index]);
    return Number.isFinite(value) ? value : 0;
  });
}

/**
 * Share weights per job classification, cleaned to what the spread can use:
 * positive, capped, and free of entries that only say "one whole share" — the
 * default — so the stored config stays as small as what the user actually
 * changed and a block hashes the same whether a 1 was typed or left alone.
 */
function normWeightMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(code ?? "").trim();
    if (!key) continue;
    const weight = Number(value);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (weight === POOL_WEIGHT_DEFAULT) continue;
    out[key] = Math.min(weight, POOL_WEIGHT_MAX);
  }
  return out;
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
    // Only meaningful for a compound base; defaults keep every existing block
    // (which has no COMBINE base) reading exactly as before.
    useRowRate: config.useRowRate ?? true,
    ratioNoHeadcount:
      config.ratioNoHeadcount ??
      (config.base?.kind === "COMBINE" && config.base.op === "DIV"),
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
          poolJobTypeWeights: normWeightMap(config.poolJobTypeWeights),
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

/**
 * The BLOCK ids a base references directly, through COMPOSITE members and both
 * sides of a COMBINE. The single source of truth for the cycle walk, the
 * save-time validation and the delete guard — miss a shape here and a block can
 * be deleted out from under a compound that divides by it.
 */
function baseBlockIds(base: BlockBaseRef | undefined): string[] {
  if (!base) return [];
  switch (base.kind) {
    case "BLOCK":
      return [base.blockId];
    case "COMPOSITE":
      return normCodeList(base.blockIds);
    case "COMBINE":
      return [...baseBlockIds(base.left), ...baseBlockIds(base.right)];
    default:
      return [];
  }
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
    queue.push(...baseBlockIds(base));
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
    if (base.kind === "COMBINE") {
      if (!BLOCK_COMBINE_OPS.includes(base.op)) {
        throw new Error(`Unknown operation: ${base.op}`);
      }
      for (const side of [base.left, base.right]) {
        if (!side) throw new Error("A combined block needs both sides filled in.");
        // The VM saves exactly one operand vector, so a side cannot itself be a
        // combination (mirrored by the compiler's own depth check). KPI bases
        // compile to DIRECT_ABS rather than a base series, so they cannot be an
        // operand at all.
        if (side.kind === "COMBINE") {
          throw new Error(
            "A combined block cannot use another combined block as a side — yet."
          );
        }
        if (side.kind === "KPI") {
          throw new Error("A KPI cannot be one side of a combined block.");
        }
        if (side.kind === "COMPOSITE") {
          const ids = normCodeList(side.blockIds);
          if (!side.includeBaseSalary && ids.length === 0) {
            throw new Error("Choose at least one thing for the base to add up.");
          }
        }
      }
      const referenced = baseBlockIds(base);
      for (const blockId of referenced) {
        assertUsableBaseBlock(db, scope, input.id, blockId);
      }
      assertNoBaseCycle(db, scope, input.id, referenced);
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
    for (const [code, weight] of Object.entries(
      input.poolJobTypeWeights ?? {}
    )) {
      // Rejected rather than dropped: a weight of 0 or -1 is someone trying to
      // exclude a classification, and the honest answer is that the rule's own
      // classification filter is where that happens.
      if (!Number.isFinite(Number(weight)) || Number(weight) <= 0) {
        throw new Error(
          `Share weight for "${code}" must be a positive number. To leave a classification out of the pool, remove it from the rule.`
        );
      }
    }
    // A RULE with both filter lists empty is legal and means "everyone" — the
    // simplest way to pool across the whole hotel without weighting every row.
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
  // PER_ROW gives the grid a department column keyed by the block's cost def,
  // which only a MULTIPLIER has as its single output. FIXED stays legal for
  // every type — it is already reachable from the importers and from sync.
  if (input.departmentMode === "PER_ROW" && input.blockType !== "MULTIPLIER") {
    throw new Error(
      "Only a Multiplier block can let each row choose its own department."
    );
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
  /** Ratio blocks opt out of the engine's headcount post-pass. */
  countExempt: boolean;
}

/**
 * Lower one side of a compound base to an engine BaseSelector.
 *
 * Only the kinds a COMBINE side may take are handled — the caller validates
 * that KPI and nested COMBINE never get here (KPI compiles to a wholly
 * different engine path, DIRECT_ABS, and cannot act as a base series).
 */
function toEngineSelector(base: BlockBaseRef, ou: string): BaseSelector {
  switch (base.kind) {
    case "BASE_SALARY":
      return { kind: "BASE_SALARY" };
    case "BLOCK":
      return { kind: "COMPONENTS", componentIds: [blockCostDefId(base.blockId)] as ComponentDefId[] };
    case "COMPOSITE":
      return {
        kind: "COMPONENTS",
        componentIds: [
          ...(base.includeBaseSalary ? [baseSalaryDefId(ou)] : []),
          ...normCodeList(base.blockIds).map(blockCostDefId),
        ] as ComponentDefId[],
      };
    case "STAT":
      return {
        kind: "COMPONENTS",
        componentIds: [systemStatDefId(ou, base.stat)] as ComponentDefId[],
      };
    case "CALENDAR":
      return { kind: "CALENDAR", series: base.series };
    case "SERVICE":
      return { kind: "SERVICE", mode: base.mode };
    case "VACATION":
      return { kind: "VACATION" };
    case "COMBINE":
      return {
        kind: "COMBINE",
        op: base.op,
        left: toEngineSelector(base.left, ou),
        right: toEngineSelector(base.right, ou),
      };
    default:
      throw new Error(`Unsupported base for a combined block: ${base.kind}`);
  }
}

/** Every engine definition id a block base references, through COMBINE sides.
 *  Feeds the component_base_refs projection. */
function collectBlockBaseRefIds(base: BlockBaseRef, ou: string): string[] {
  const out: string[] = [];
  const walk = (node: BlockBaseRef): void => {
    switch (node.kind) {
      case "BLOCK":
        out.push(blockCostDefId(node.blockId));
        break;
      case "COMPOSITE":
        if (node.includeBaseSalary) out.push(baseSalaryDefId(ou));
        for (const blockId of normCodeList(node.blockIds)) out.push(blockCostDefId(blockId));
        break;
      case "STAT":
        out.push(systemStatDefId(ou, node.stat));
        break;
      case "COMBINE":
        walk(node.left);
        walk(node.right);
        break;
      default:
        break; // BASE_SALARY / CALENDAR / SERVICE / VACATION reference no line by id
    }
  };
  walk(base);
  return [...new Set(out)];
}

/** Every system head a base tree needs seeded before its defs are written. */
function seedHeadsForBase(
  db: Db,
  scope: OuScope,
  base: BlockBaseRef,
  opts: { now: string }
): void {
  const walk = (node: BlockBaseRef): void => {
    switch (node.kind) {
      case "STAT":
        ensureSystemStatDef(db, scope, node.stat, opts);
        break;
      case "COMPOSITE":
        // Only a composite refs base salary BY ID; a bare BASE_SALARY base (top
        // level or as a COMBINE side) reads the gross scratch and needs no head.
        if (node.includeBaseSalary) ensureBaseSalaryDef(db, scope, opts);
        break;
      case "COMBINE":
        walk(node.left);
        walk(node.right);
        break;
      default:
        break;
    }
  };
  walk(base);
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
    countExempt: false,
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
        // Stat series (hours worked/paid, headcount, FTE) are ordinary engine
        // lines: reference the system stat definition (seeded on save) via
        // the existing COMPONENTS selector.
        def.baseSelectorKind = "COMPONENTS";
        def.baseRefDefIds = [systemStatDefId(ou, base.stat)];
      } else if (base.kind === "COMBINE") {
        // Compound: lower both sides to engine selectors and carry the whole
        // tree as base_ref JSON — base_selector_kind's CHECK cannot be widened
        // in SQLite, the same reason CALENDAR/VACATION ride the JSON column.
        // No per-row column means no stored value, which would read as rate 0
        // and zero the line — pin the rate to 1 so the block IS the
        // combination. See BaseSelector.COMBINE.rate.
        const selector = toEngineSelector(base, ou);
        if (input.useRowRate === false && selector.kind === "COMBINE") {
          selector.rate = 1;
        }
        def.baseRefJson = JSON.stringify(selector);
        // The nested block refs still go into component_base_refs so the
        // queryable projection stays truthful (the delete guard reads config,
        // but this keeps the two views consistent).
        def.baseRefDefIds = collectBlockBaseRefIds(base, ou);
        def.countExempt = input.ratioNoHeadcount ?? base.op === "DIV";
      } else {
        // CALENDAR / SERVICE / VACATION — engine base kinds beyond the legacy CHECK,
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
      const spread = input.spread ?? "ACTIVE_MONTHS";
      const method = SPREAD_TO_METHOD[spread];
      // WEIGHTED_BY_BASE distributes over whatever its base selector resolves
      // to; the WEIGHTED_* stat spreads just point it at a stat line instead of
      // the default base-salary curve (seeded on save).
      const statBase = SPREAD_TO_STAT_BASE[spread];
      const weighting: Partial<DefRow> = statBase
        ? {
            baseSelectorKind: "COMPONENTS",
            baseRefDefIds: [systemStatDefId(ou, statBase)],
          }
        : {};
      return [
        {
          ...common,
          ...weighting,
          id: blockCostDefId(blockId),
          spreadMethod: method,
          label: input.label,
          accountCode: input.accountCode ?? "",
          increaseAware: input.increaseAware ?? false,
        },
        {
          ...common,
          ...weighting,
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
    ...(input.base?.kind === "COMBINE"
      ? {
          useRowRate: input.useRowRate ?? true,
          ratioNoHeadcount: input.ratioNoHeadcount ?? input.base.op === "DIV",
        }
      : {}),
    spread: input.spread ?? "ACTIVE_MONTHS",
    increaseAware: input.increaseAware ?? false,
    departmentMode: input.departmentMode ?? "POSITION",
    // Dropped unless FIXED, so a stale code can never ride along on a block
    // that has since been switched to POSITION or PER_ROW.
    fixedDepartment:
      input.departmentMode === "FIXED"
        ? input.fixedDepartment?.trim() || undefined
        : undefined,
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
          poolJobTypeWeights: normWeightMap(input.poolJobTypeWeights),
        }
      : {}),
  };
  const defs = compileBlockDefs(id, scope.ou, input);

  db.transaction(() => {
    if (input.blockType === "MULTIPLIER" && input.base) {
      // Any base referencing a system head by id needs that head to exist, even
      // when the block is saved before the structure read model has ever been
      // built. Walks COMBINE sides too.
      seedHeadsForBase(db, scope, input.base, opts);
    }
    if (input.blockType === "COUNT_RATE") {
      // A "spread like hours / like FTE" block weights by a stat line, so that
      // head must exist before the defs referencing it are written.
      const statBase = SPREAD_TO_STAT_BASE[input.spread ?? "ACTIVE_MONTHS"];
      if (statBase) ensureSystemStatDef(db, scope, statBase, opts);
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
           count_exempt, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
           count_exempt = excluded.count_exempt,
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
        // PER_ROW projects as POSITION: the definition only ever has to answer
        // "what does a blank per-row cell fall back to?", and that answer is
        // the position's department. Keeping the compiled column to the two
        // values its CHECK allows avoids a table rebuild (SQLite cannot ALTER
        // a CHECK) and keeps older sync peers able to insert the row.
        config.departmentMode === "FIXED" ? "FIXED" : "POSITION",
        config.departmentMode === "FIXED" ? config.fixedDepartment ?? null : null,
        def.increaseAware ? 1 : 0,
        sortOrder,
        def.baseSelectorKind,
        def.ssSchemeId,
        def.kpiDriverId,
        id,
        def.baseRefJson,
        def.countExempt ? 1 : 0,
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

const STAT_DEF_LABELS: Record<"HOURS" | "HOURS_PAID" | "HEADCOUNT" | "FTE", string> = {
  HOURS: "Hours Worked",
  HOURS_PAID: "Hours Paid",
  HEADCOUNT: "Headcount",
  FTE: "FTE",
};

/** Idempotently seed the system stat definition a STAT base references.
 *  Blank account → the line computes (and is base-referenceable) but is
 *  never part of the output. HOURS and HEADCOUNT are additionally seeded
 *  unconditionally (see ensureSystemDefs) because the Positions grid offers a
 *  per-row account for each; FTE and HOURS_PAID are on-demand only, having no
 *  account field of their own (FTE retired in field seed v13 — a ratio has no
 *  GL account; HOURS_PAID posts through the same working-hours account as
 *  HOURS when a block needs it). */
export function ensureSystemStatDef(
  db: Db,
  scope: OuScope,
  stat: "HOURS" | "HOURS_PAID" | "HEADCOUNT" | "FTE",
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

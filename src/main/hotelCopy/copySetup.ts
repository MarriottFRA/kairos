/**
 * Copy one hotel's setup into another — the cluster "set it up once" flow.
 *
 * Reads the source hotel's structure document (`buildStructureDoc`, the same
 * "what is a hotel's setup" definition sync publishes) and lands it in the
 * target OU in two different ways, because the sections are two different
 * kinds of thing:
 *
 *  - The PLAIN sections — field catalog, NI/SS schemes, KPI drivers,
 *    allocations, calendar, position defaults — are rows. They travel as a
 *    remapped document through `applyStructureDoc`, with every id-keyed row
 *    given a FRESH id first: both hotels live in one database file, so reusing
 *    a source id would make the upsert land on the source row and rewrite its
 *    `ou` — the one catastrophic failure mode here.
 *
 *  - BLOCKS are replayed through `saveBlock` instead of being copied as rows,
 *    so each one recompiles its definition projection against the TARGET:
 *    fresh `<blockId>:cost/:stat` ids, `sys-*:<target>` heads seeded on
 *    demand, and the same validation a hand-built block gets. References
 *    inside a block's config (base blocks, schemes, KPI drivers, rate-rule
 *    outcomes) are rewritten through the id maps before the save; blocks save
 *    in dependency waves so a base always exists before its dependant, the
 *    `applyBlockPreset` discipline.
 *
 * Built-in KPI driver ids (`kpi:builtin:*`) are OU-independent and pass
 * through verbatim. Field-catalog keys are reused verbatim too — the table is
 * keyed `(ou, field_key)`, and keeping the keys is what lets rate rules and
 * stored `extra_values` line up without a translation table.
 *
 * The whole copy is one transaction: a block that fails to validate rolls the
 * lot back rather than leaving half a hotel behind. Deliberately NOT copied:
 * positions and anything scenario-scoped, budget imports, the KPI value cache
 * (recomputed from the target's own budget), engine outputs, sync bookkeeping.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  BlockBaseRef,
  BlockInput,
  BlockType,
} from "../../shared/blocks/ipc";
import {
  RateRulesConfig,
  rateRulesBlockIds,
} from "../../shared/blocks/rateRules";
import { uuidv7 } from "../../shared/engine/ids";
import {
  HotelCopySetupResponse,
  HotelCopySourceDto,
} from "../../shared/hotelCopy/ipc";
import { Row } from "../../shared/kairosSync/entityMap";
import { StructureDoc } from "../../shared/kairosSync/structureDoc";
import { uniqueBlockLabel } from "../blocks/presets";
import { ensureSystemDefs, reorderBlocks, saveBlock } from "../blocks/repo";
import { applyStructureDoc, buildStructureDoc } from "../kairosSync/structure";
import { OuScope, isValidOu } from "../positions/ouScope";
import { prepared } from "../positions/stmtCache";

type Db = InstanceType<typeof Database>;

/** Hotels the target could copy from: any OTHER OU with live blocks locally. */
export function listLocalSetupSources(db: Db, target: OuScope): HotelCopySourceDto[] {
  const rows = prepared(
    db,
    `SELECT ou, COUNT(*) AS n FROM block_configs
      WHERE deleted_at IS NULL GROUP BY ou ORDER BY ou`
  ).all() as Array<{ ou: string; n: number }>;
  return rows
    .filter((row) => row.ou !== target.ou && isValidOu(row.ou))
    .map((row) => ({ ou: row.ou, blockCount: row.n }));
}

function live(rows: Row[] | undefined): Row[] {
  return (rows ?? []).filter((row) => row.deletedAt == null);
}

/** Block ids a base names, COMBINE sides included. */
function baseBlockIds(base: BlockBaseRef | undefined): string[] {
  if (!base) return [];
  switch (base.kind) {
    case "BLOCK":
      return [base.blockId];
    case "COMPOSITE":
      return [...base.blockIds];
    case "COMBINE":
      return [...baseBlockIds(base.left), ...baseBlockIds(base.right)];
    default:
      return [];
  }
}

export function copyHotelSetup(
  db: Db,
  target: OuScope,
  source: OuScope,
  opts: { now: string }
): HotelCopySetupResponse {
  if (source.ou === target.ou) {
    throw new Error("Choose a different hotel to copy from.");
  }
  const targetBlocks = prepared(
    db,
    `SELECT COUNT(*) AS n FROM block_configs WHERE ou = ? AND deleted_at IS NULL`
  ).get(target.ou) as { n: number };
  if (targetBlocks.n > 0) {
    // No merge in v1. Two block sets with colliding labels would also break
    // cluster block matching, which requires exactly one live (type, label).
    throw new Error(
      "This hotel already has blocks — the setup copy only fills a hotel that has none yet."
    );
  }

  const doc = buildStructureDoc(db, source.ou);
  const sourceBlocks = live(doc.blockConfigs).sort(
    (a, b) => Number(a.sortOrder) - Number(b.sortOrder)
  );
  if (sourceBlocks.length === 0) {
    throw new Error("The chosen hotel has no blocks to copy.");
  }

  // Fresh ids, minted up front so every reference can be rewritten before
  // anything is saved. Block ids are the exception — saveBlock mints those —
  // so the map fills as the waves save.
  const schemeIds = new Map<string, string>();
  const driverIds = new Map<string, string>();
  const allocationIds = new Map<string, string>();
  const blockIds = new Map<string, string>();
  for (const row of live(doc.ssSchemes)) schemeIds.set(String(row.id), uuidv7());
  for (const row of live(doc.kpiDrivers)) driverIds.set(String(row.id), uuidv7());
  for (const row of live(doc.allocations)) allocationIds.set(String(row.id), uuidv7());

  // Copied driver → its copy; anything else (the code-defined kpi:builtin:*
  // drivers, which are OU-independent) passes through verbatim.
  const mapDriver = (id: unknown): string | undefined => {
    if (typeof id !== "string" || id.trim() === "") return undefined;
    return driverIds.get(id) ?? id;
  };
  // A scheme id that does not map (a block pointing at a deleted scheme) is
  // DROPPED — the block arrives unconfigured rather than pointing across OUs.
  const mapScheme = (id: unknown): string | undefined => {
    if (typeof id !== "string" || id.trim() === "") return undefined;
    return schemeIds.get(id);
  };
  const mapBlockRef = (id: string): string => {
    const mapped = blockIds.get(id);
    if (!mapped) {
      throw new Error(
        "A block in the source hotel references a block that is deleted or missing — fix it there first."
      );
    }
    return mapped;
  };

  const remapBase = (base: BlockBaseRef | undefined): BlockBaseRef | undefined => {
    if (!base) return undefined;
    switch (base.kind) {
      case "BLOCK":
        return { ...base, blockId: mapBlockRef(base.blockId) };
      case "COMPOSITE":
        return { ...base, blockIds: base.blockIds.map(mapBlockRef) };
      case "KPI":
        return { ...base, kpiDriverId: mapDriver(base.kpiDriverId) ?? base.kpiDriverId };
      case "COMBINE":
        return {
          ...base,
          left: remapBase(base.left) as BlockBaseRef,
          right: remapBase(base.right) as BlockBaseRef,
        };
      default:
        return base;
    }
  };

  const remapRules = (
    rules: RateRulesConfig | undefined
  ): RateRulesConfig | undefined => {
    if (!rules) return undefined;
    return {
      ...rules,
      rules: rules.rules.map((rule) => ({
        ...rule,
        when: rule.when.map((term) =>
          term.source.kind === "KPI"
            ? {
                ...term,
                source: {
                  ...term.source,
                  kpiDriverId:
                    mapDriver(term.source.kpiDriverId) ?? term.source.kpiDriverId,
                },
              }
            : term
        ),
        ...(rule.rateBlockId ? { rateBlockId: mapBlockRef(rule.rateBlockId) } : {}),
      })),
      ...(rules.otherwiseBlockId
        ? { otherwiseBlockId: mapBlockRef(rules.otherwiseBlockId) }
        : {}),
    };
  };

  // Definition ids: `sys-*:<ou>` heads re-derive by swapping the OU suffix;
  // `<blockId>:cost/:stat` go through the block map; anything unresolvable is
  // dropped by the caller rather than carried across hotels.
  const sysSuffix = `:${source.ou}`;
  const mapDefId = (defId: string): string | null => {
    if (defId.endsWith(sysSuffix)) {
      return defId.slice(0, defId.length - source.ou.length) + target.ou;
    }
    const match = /^(.+):(cost|stat)$/.exec(defId);
    if (match) {
      const block = blockIds.get(match[1]);
      return block ? `${block}:${match[2]}` : null;
    }
    return null;
  };

  const configOf = (row: Row): Record<string, unknown> =>
    (row.config && typeof row.config === "object"
      ? row.config
      : {}) as Record<string, unknown>;

  const referencedBlockIds = (row: Row): string[] => {
    const config = configOf(row);
    const rules = config.rateRules as RateRulesConfig | undefined;
    return [
      ...baseBlockIds(config.base as BlockBaseRef | undefined),
      ...(rules ? rateRulesBlockIds(rules) : []),
    ];
  };

  // The stored config blob and BlockInput share their field names by
  // construction (see saveBlock's StoredConfig), so the input is the config
  // with identity and every cross-hotel reference rewritten.
  const blockInputFor = (row: Row): BlockInput => {
    const config = configOf(row);
    return {
      ...(config as Partial<BlockInput>),
      id: undefined,
      blockType: String(row.blockType) as BlockType,
      // Suffixed on collision the way presets are — cluster block matching
      // requires exactly one live (type, label) per OU.
      label: uniqueBlockLabel(db, target, String(row.label)),
      base: remapBase(config.base as BlockBaseRef | undefined),
      rateRules: remapRules(config.rateRules as RateRulesConfig | undefined),
      ssSchemeId: mapScheme(config.ssSchemeId),
      poolKpiDriverId: mapDriver(config.poolKpiDriverId),
    } as BlockInput;
  };

  let calendarYears = 0;

  db.transaction(() => {
    // 1. The plain sections travel as a remapped document through the same
    //    upserts a sync pull uses. Schemes go in with an EMPTY base membership:
    //    base_component_ids name block defs that do not exist yet, so a
    //    post-pass fills them in once the blocks are saved. Calendar years and
    //    position defaults the target already set up are KEPT, additively.
    const hadCalendarYears = new Set(
      (prepared(db, `SELECT year FROM calendar_years WHERE ou = ?`).all(
        target.ou
      ) as Array<{ year: number }>).map((row) => row.year)
    );
    const hadDefaultYears = new Set(
      (prepared(db, `SELECT year FROM position_defaults WHERE ou = ?`).all(
        target.ou
      ) as Array<{ year: number }>).map((row) => row.year)
    );
    const calendars = (doc.calendars ?? []).filter(
      (row) => !hadCalendarYears.has(Number(row.year))
    );
    calendarYears = calendars.length;

    const setupDoc: StructureDoc = {
      docVersion: doc.docVersion,
      ou: target.ou,
      // Tombstones travel too: a system column the source hotel removed should
      // read as removed at the copy, exactly as it does over sync.
      fieldCatalog: (doc.fieldCatalog ?? []).map((row) => ({
        ...row,
        ou: target.ou,
        updatedAt: opts.now,
      })),
      ssSchemes: live(doc.ssSchemes).map((row) => ({
        ...row,
        id: schemeIds.get(String(row.id)),
        ou: target.ou,
        baseComponentIds: [] as string[],
        updatedAt: opts.now,
      })),
      kpiDrivers: live(doc.kpiDrivers).map((row) => ({
        ...row,
        id: driverIds.get(String(row.id)),
        ou: target.ou,
        updatedAt: opts.now,
      })),
      allocations: live(doc.allocations).map((row) => ({
        ...row,
        id: allocationIds.get(String(row.id)),
        ou: target.ou,
        updatedAt: opts.now,
      })),
      calendars: calendars.map((row) => ({
        ...row,
        ou: target.ou,
        updatedAt: opts.now,
      })),
      positionDefaults: (doc.positionDefaults ?? [])
        .filter((row) => !hadDefaultYears.has(Number(row.year)))
        .map((row) => ({ ...row, ou: target.ou, updatedAt: opts.now })),
    };
    applyStructureDoc(db, setupDoc);

    // 2. Blocks, in dependency waves: a block saves only after every block it
    //    references has, so saveBlock's validation always sees real ids.
    const pendingIds = new Set(sourceBlocks.map((row) => String(row.id)));
    let remaining = sourceBlocks;
    while (remaining.length > 0) {
      const ready = remaining.filter((row) =>
        referencedBlockIds(row).every((id) => !pendingIds.has(id))
      );
      if (ready.length === 0) {
        throw new Error(
          "The source hotel's blocks reference each other in a loop — nothing was copied."
        );
      }
      for (const row of ready) {
        const id = saveBlock(db, target, blockInputFor(row), opts);
        blockIds.set(String(row.id), id);
        pendingIds.delete(String(row.id));
      }
      remaining = remaining.filter((row) => pendingIds.has(String(row.id)));
    }

    // 3. Scheme base membership, deferred from step 1. Ids that no longer
    //    resolve are dropped rather than carried across hotels.
    for (const row of live(doc.ssSchemes)) {
      const ids = (Array.isArray(row.baseComponentIds) ? row.baseComponentIds : [])
        .map((defId) => mapDefId(String(defId)))
        .filter((defId): defId is string => defId !== null);
      if (ids.length === 0) continue;
      prepared(
        db,
        `UPDATE ss_schemes SET base_component_ids = ? WHERE id = ? AND ou = ?`
      ).run(JSON.stringify(ids), schemeIds.get(String(row.id)), target.ou);
    }

    // 4. The system heads: seeded for the target, then given the source's
    //    posting accounts — the one piece of sys-def state a hotel configures.
    ensureSystemDefs(db, target, opts);
    for (const def of live(doc.componentDefs)) {
      const id = String(def.id);
      if (!id.endsWith(sysSuffix)) continue;
      prepared(
        db,
        `UPDATE cost_component_definitions
            SET account_code = ?, updated_at = ? WHERE id = ? AND ou = ?`
      ).run(String(def.accountCode ?? ""), opts.now, mapDefId(id), target.ou);
    }

    // 5. Display order, restored from the source (waves saved in dependency
    //    order); reorderBlocks mirrors it onto the defs' sort_order.
    reorderBlocks(
      db,
      target,
      sourceBlocks.map((row) => blockIds.get(String(row.id)) as string),
      opts
    );
  })();

  return {
    blocks: blockIds.size,
    ssSchemes: schemeIds.size,
    kpiDrivers: driverIds.size,
    allocations: allocationIds.size,
    customFields: live(doc.fieldCatalog).filter(
      (row) => String(row.origin) === "USER"
    ).length,
    calendarYears,
  };
}

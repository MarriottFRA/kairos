/**
 * Apply an ImportPlan.
 *
 * The two stores cannot share a transaction (plaintext structure vs. encrypted
 * values — separate connections, deliberately), so this runs in a fixed order
 * and leans on `analyze.ts` having already validated everything: by the time we
 * get here, a failure should mean genuine I/O trouble, not bad data.
 *
 *   1. plaintext — calendar, weekly hours, blocks, allocations
 *   2. re-read the blocks to learn the ids the repo minted
 *   3. encrypted — positions + their block values, then manual-input rows
 *
 * Blocks come first because `positionsRepo.batchWrite` validates every
 * componentDefId against the live definitions and throws on anything it does
 * not recognise. Within step 1, `plan.blocks` is already dependency-ordered, so
 * a block used as another's base always exists before it is referenced.
 */

import type Database from "better-sqlite3-multiple-ciphers";

import { BlockInput } from "../../shared/blocks/ipc";
import {
  CalendarYear,
  buildDefaultCalendar,
  normalizeCalendar,
} from "../../shared/calendar";
import {
  ComponentValuePatch,
  PositionCreate,
} from "../../shared/positions/ipc";
import { LegacyImportReport } from "../../shared/legacyImport/ipc";
import { PositionDefaults } from "../../shared/positionDefaults";
import { saveAllocation } from "../allocations/repo";
import { listBlocks, saveBlock } from "../blocks/repo";
import { saveRow as saveManualRow, nextSortOrder } from "../manualInput/repo";
import { OuScope } from "../positions/ouScope";
import * as positionsRepo from "../positions/positionsRepo";
import { getComponentDefinitions } from "../positions/structureRepo";
import { ImportPlan, PlannedBlockValues } from "./analyze";

type Db = InstanceType<typeof Database>;

/**
 * The store-facing dependencies, injected so the whole commit is testable
 * against in-memory databases without an Electron main process.
 */
export interface CommitDeps {
  localDb: Db;
  secureDb: Db;
  scope: OuScope;
  scenarioId: string;
  year: number;
  now: string;
  newId: () => string;
  /** Field catalog lookup that positionsRepo.batchWrite splits fields with. */
  fieldLookup: Parameters<typeof positionsRepo.batchWrite>[3];
  /** Existing calendar for the OU/year, so we only overwrite the holidays.
   *  Async because the local-store accessors are (see local_db.ts). */
  getCalendar: () => Promise<CalendarYear | null>;
  saveCalendar: (calendar: CalendarYear) => Promise<void>;
  getPositionDefaults: () => Promise<PositionDefaults | null>;
  savePositionDefaults: (defaults: PositionDefaults) => Promise<void>;
}

/** Slot values → the ComponentValuePatch fields the block's slots read. */
function patchFields(
  values: PlannedBlockValues
): ComponentValuePatch["fields"] {
  const fields: ComponentValuePatch["fields"] = {};
  if (values.rate !== undefined) fields.rate = values.rate;
  // FLAT_MONTHLY carries its per-month amount in the yearlyValue slot — see
  // blockRows.blockInputSlots / the engine's FLAT_MONTHLY case.
  if (values.amount !== undefined) fields.yearlyValue = values.amount;
  if (values.qty !== undefined) fields.qty = values.qty;
  if (values.unitRate !== undefined) fields.unitRate = values.unitRate;
  if (values.monthlyValues !== undefined) {
    fields.monthlyValues = values.monthlyValues;
  }
  if (values.accountCode !== undefined) fields.accountCode = values.accountCode;
  if (values.statsAccountCode !== undefined) {
    fields.statsAccountCode = values.statsAccountCode;
  }
  return fields;
}

export async function commitImportPlan(
  plan: ImportPlan,
  deps: CommitDeps
): Promise<LegacyImportReport> {
  const {
    localDb,
    secureDb,
    scope,
    scenarioId,
    year,
    now,
    newId,
    fieldLookup,
  } = deps;

  // ── 1a. Calendar: only the public holidays, which is all the file knows.
  // Calendar days and weekends stay as the app derives them — per the brief,
  // this tool's own weekend handling supersedes the workbook's.
  let calendarMonthsUpdated = 0;
  if (plan.publicHolidaysByMonth) {
    const base =
      (await deps.getCalendar()) ?? buildDefaultCalendar(scope.ou, year);
    const holidays = plan.publicHolidaysByMonth;
    await deps.saveCalendar(
      normalizeCalendar(
        scope.ou,
        year,
        base.weekendMask,
        base.months.map((month, index) => ({
          ...month,
          publicHolidays: holidays[index] ?? month.publicHolidays,
        })),
        base
      )
    );
    calendarMonthsUpdated = holidays.length;
  }

  // ── 1b. Full-time week.
  let weeklyHoursUpdated: number | null = null;
  if (plan.weeklyHours != null && plan.weeklyHours > 0) {
    const existing = await deps.getPositionDefaults();
    if (existing) {
      await deps.savePositionDefaults({
        ...existing,
        weeklyHours: plan.weeklyHours,
      });
      weeklyHoursUpdated = plan.weeklyHours;
    }
  }

  // ── 1c. Blocks, in dependency order, resolving composite bases as we go.
  const blockIdByKey = new Map<string, string>();
  for (const block of plan.blocks) {
    const input: BlockInput = { ...block.input };
    if (input.base?.kind === "COMPOSITE") {
      input.base = {
        kind: "COMPOSITE",
        includeBaseSalary: block.baseIncludesSalary,
        // Every dependency was saved on an earlier pass of this loop.
        blockIds: block.baseBlockKeys
          .map((key) => blockIdByKey.get(key))
          .filter((id): id is string => !!id),
      };
      if (input.base.blockIds.length === 0) {
        input.base = { kind: "BASE_SALARY" };
      }
    }
    blockIdByKey.set(block.key, saveBlock(localDb, scope, input, { now }));
  }

  // ── 1d. Allocations.
  const allocationsCreated: string[] = [];
  for (const allocation of plan.allocations) {
    try {
      saveAllocation(localDb, scope, allocation, { now });
      allocationsCreated.push(allocation.name);
    } catch (error) {
      // A name clash with an allocation the hotel already has is not worth
      // failing a 160-row import over.
      plan.warnings.push(
        `Allocation "${allocation.name}" was not created: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  }

  // ── 2. The ids the repo minted, and the definitions batchWrite validates on.
  const savedBlocks = listBlocks(localDb, scope);
  // Only the cost def takes values: a COUNT_RATE block's stat line is
  // synthesized from qty at engine load (engineInput.resolveBlockValues), so
  // writing to the stat def would double-count it.
  const costDefIdByKey = new Map<string, string>();
  for (const [key, blockId] of blockIdByKey) {
    const saved = savedBlocks.find((candidate) => candidate.id === blockId);
    if (saved) costDefIdByKey.set(key, saved.costDefId);
  }
  const componentDefIds = new Set(
    getComponentDefinitions(localDb, scope).map((definition) => definition.id)
  );

  // ── 3a. Positions, and the block inputs that hang off them.
  const positionIdByRow = new Map<number, string>();
  const creates: PositionCreate[] = plan.positions.map((position) => {
    const id = newId();
    positionIdByRow.set(position.sheetRow, id);
    return { id, fields: position.fields, pii: position.pii };
  });

  const componentValuePatches: ComponentValuePatch[] = [];
  for (const block of plan.blocks) {
    const costDefId = costDefIdByKey.get(block.key);
    if (!costDefId) continue;
    for (const [sheetRow, values] of block.valuesByRow) {
      const positionId = positionIdByRow.get(sheetRow);
      if (!positionId) continue;
      const fields = patchFields(values);
      if (Object.keys(fields).length === 0) continue;
      componentValuePatches.push({ positionId, componentDefId: costDefId, fields });
    }
  }

  positionsRepo.batchWrite(
    secureDb,
    scope,
    // `ou` rides the request shape but the repo binds scope.ou only.
    { ou: scope.ou, scenarioId, creates, componentValuePatches },
    fieldLookup,
    componentDefIds
  );

  // ── 3b. Manual-input rows. One call each — the repo has no bulk path, and at
  // ~130 rows on a local SQLite file that is not worth a new channel.
  let manualInputRowsCreated = 0;
  let sortOrder = nextSortOrder(secureDb, scope.ou, scenarioId);
  for (const row of plan.manualRows) {
    saveManualRow(secureDb, {
      ...row,
      id: newId(),
      ou: scope.ou,
      // Same scenario the positions above landed in: manual rows post into that
      // scenario's results, so an import must not split itself across two.
      scenarioId,
      sortOrder,
      createdBy: null,
      now,
    });
    sortOrder += 1;
    manualInputRowsCreated += 1;
  }

  return {
    sourceFileName: plan.preview.sourceFileName,
    positionsCreated: creates.length,
    blocksCreated: plan.blocks.map((block) => block.preview),
    manualInputRowsCreated,
    allocationsCreated,
    calendarMonthsUpdated,
    weeklyHoursUpdated,
    warnings: plan.warnings,
  };
}

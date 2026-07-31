/**
 * Apply an OracleImportPlan.
 *
 * The two stores cannot share a transaction (plaintext structure vs. encrypted
 * values — separate connections, deliberately), so this runs in a fixed order
 * and leans on `analyze.ts` having already validated everything:
 *
 *   1. plaintext — create only the blocks that have no existing match
 *   2. re-read the blocks to learn the ids the repo minted
 *   3. encrypted — positions and their block values, in ONE batchWrite
 *
 * Blocks come first because `positionsRepo.batchWrite` validates every
 * componentDefId against the live definitions and throws on anything it does
 * not recognise.
 *
 * The importer is APPEND-ONLY by construction — no soft deletes, no position
 * patches, and never `saveBlock` with an existing id (re-saving recompiles a
 * block's definitions and could re-base every position already carrying a rate
 * on it). That is what makes the missing cross-store transaction survivable: if
 * step 3 fails, `batchWrite`'s own transaction rolls the positions back and the
 * worst residue is up to two empty MULTIPLIER blocks, which contribute nothing
 * to a budget and are matched and reused on the next run.
 */

import type Database from "better-sqlite3-multiple-ciphers";

import {
  ComponentValuePatch,
  PositionCreate,
} from "../../shared/positions/ipc";
import { OracleImportReport } from "../../shared/oracleImport/ipc";
import { listBlocks, saveBlock } from "../blocks/repo";
import { OuScope } from "../positions/ouScope";
import * as positionsRepo from "../positions/positionsRepo";
import { getComponentDefinitions } from "../positions/structureRepo";
import { OracleImportPlan } from "./analyze";

type Db = InstanceType<typeof Database>;

/**
 * The store-facing dependencies, injected so the whole commit is testable
 * against in-memory databases without an Electron main process.
 */
export interface OracleCommitDeps {
  localDb: Db;
  secureDb: Db;
  scope: OuScope;
  scenarioId: string;
  now: string;
  newId: () => string;
  /** Field catalog lookup that positionsRepo.batchWrite splits fields with. */
  fieldLookup: Parameters<typeof positionsRepo.batchWrite>[3];
}

export function commitOraclePlan(
  plan: OracleImportPlan,
  deps: OracleCommitDeps
): OracleImportReport {
  const { localDb, secureDb, scope, scenarioId, now, newId, fieldLookup } = deps;

  const warnings = [...plan.warnings];
  const blocksCreated: string[] = [];
  const blocksReused: string[] = [];

  // ── 1. Blocks. Only the ones with no existing match are written; a matched
  // block is a read-only input to this importer.
  const blockIdByBand = new Map<string, string>();
  for (const band of plan.bands) {
    if (band.preview.disposition === "off") continue;
    if (band.existingBlockId) {
      blockIdByBand.set(band.key, band.existingBlockId);
      blocksReused.push(band.preview.label);
      continue;
    }
    if (!band.input) continue;
    blockIdByBand.set(band.key, saveBlock(localDb, scope, band.input, { now }));
    blocksCreated.push(band.preview.label);
  }

  // ── 2. The ids the repo minted, and the definitions batchWrite validates on.
  // Only the COST def takes values — a block's stat line is synthesized at
  // engine load, so writing to it would double-count.
  const savedBlocks = listBlocks(localDb, scope);
  const costDefIdByBand = new Map<string, string>();
  for (const [bandKey, blockId] of blockIdByBand) {
    const saved = savedBlocks.find((candidate) => candidate.id === blockId);
    if (saved) costDefIdByBand.set(bandKey, saved.costDefId);
  }
  const componentDefIds = new Set(
    getComponentDefinitions(localDb, scope).map((definition) => definition.id)
  );

  // ── 3. Positions, and the band rates that hang off them.
  const creates: PositionCreate[] = plan.positions.map((position) => ({
    id: newId(),
    fields: position.fields,
    pii: position.pii,
  }));

  const componentValuePatches: ComponentValuePatch[] = [];
  for (const band of plan.bands) {
    const costDefId = costDefIdByBand.get(band.key);
    if (!costDefId) continue;
    for (const create of creates) {
      const fields: ComponentValuePatch["fields"] = { rate: band.rate };
      // A locked block discards a stored per-row account, so only send one when
      // the block we matched actually reads it.
      if (band.perRowAccountCode !== undefined) {
        fields.accountCode = band.perRowAccountCode;
      }
      componentValuePatches.push({
        positionId: create.id,
        componentDefId: costDefId,
        fields,
      });
    }
  }

  positionsRepo.batchWrite(
    secureDb,
    scope,
    // `ou` rides the request shape but the repo binds scope.ou only.
    { ou: scope.ou, scenarioId, creates, componentValuePatches },
    fieldLookup,
    componentDefIds
    // No structureDb: imported rows carry no cluster, so cluster sync has
    // nothing to do, and passing it would fan this write across other hotels.
  );

  return {
    sourceFileName: plan.preview.sourceFileName,
    positionsCreated: creates.length,
    skipped: plan.preview.skipped,
    bands: plan.bands.map((band) => band.preview),
    blocksCreated,
    blocksReused,
    warnings,
  };
}

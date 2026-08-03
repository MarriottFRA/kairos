/**
 * Blocks IPC handlers.
 *
 * CRUD over user-facing block configs in the plaintext local store; saving a
 * block recompiles its cost-component definition projection (see
 * src/main/blocks/repo.ts). Every channel is OU-gated (registered with
 * ouScopeMiddleware in ipc/index.ts) and re-brands the OU via resolveOuScope.
 * Mutations return the full structure read model (blocks + raw definitions +
 * SS schemes) so the renderer refreshes in one round-trip — the definitions
 * feed the grid's live simulation directly.
 */

import { IpcHandler, IpcResult } from "../types";
import { localDbHandle } from "../../local_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import {
  deleteBlock,
  ensureSystemDefs,
  listBlocks,
  reorderBlocks,
  restoreBlock,
  saveBlock,
} from "../../main/blocks/repo";
import { applyBlockPreset } from "../../main/blocks/presets";
import {
  getComponentDefinitions,
  getSsSchemes,
} from "../../main/positions/structureRepo";
import {
  BLOCKS_CHANNELS,
  BlockInput,
  BlocksListResponse,
} from "../../shared/blocks/ipc";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

const EMPTY: BlocksListResponse = { blocks: [], definitions: [], ssSchemes: [] };

type LocalDb = ReturnType<typeof localDbHandle>;
type Scope = ReturnType<typeof resolveOuScope>;

/** The full structure read model the renderer needs for grid + live sim. */
function readModel(db: LocalDb, scope: Scope): BlocksListResponse {
  // Seed the permanent system definitions: the mandatory BASE_SALARY head (so
  // the component graph is always compilable), the always-booked position-count
  // head, and one head per posting account the Positions grid offers (headcount,
  // hours, vacation cost, vacation accrual) — those are inert columns until the
  // definition they attach to exists. NI/SS blocks stay user-added.
  const now = new Date().toISOString();
  ensureSystemDefs(db, scope, { now });
  const ssSchemes = getSsSchemes(db, scope);
  // Stamp each SS block with whether its scheme carries a prior-year opening
  // base (CUMULATIVE + non-January tax year). This is the single source of the
  // gate for the per-row "Opening base" column — the renderer's grid and live
  // sim both read it off the block, so neither re-joins the scheme.
  const schemeById = new Map(ssSchemes.map((scheme) => [scheme.id as string, scheme]));
  const blocks = listBlocks(db, scope).map((block) => {
    if (block.blockType !== "SOCIAL_SECURITY" || !block.ssSchemeId) return block;
    const scheme = schemeById.get(block.ssSchemeId);
    const cumulativeNonJan =
      !!scheme &&
      (scheme.accumulationMode ?? "CUMULATIVE") === "CUMULATIVE" &&
      (scheme.taxYearStartMonth ?? 1) > 1;
    return { ...block, ssCumulativeNonJan: cumulativeNonJan };
  });
  return {
    blocks,
    definitions: getComponentDefinitions(db, scope),
    ssSchemes,
  };
}

export function createBlocksHandlers(): Record<string, IpcHandler> {
  /** Blocks + raw definitions + SS schemes for the OU. */
  const list: IpcHandler<any, IpcResult<BlocksListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      return ok(readModel(localDbHandle(), scope));
    } catch (error) {
      console.error("Blocks list failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Create or update a block (recompiles its defs); returns the read model. */
  const save: IpcHandler<any, IpcResult<BlocksListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const input = request?.block as BlockInput | undefined;
      if (!input) throw new Error("Missing block payload.");
      const db = localDbHandle();
      saveBlock(db, scope, input, { now: new Date().toISOString() });
      return ok(readModel(db, scope));
    } catch (error) {
      console.error("Blocks save failed:", error);
      return fail(error, EMPTY);
    }
  };

  /**
   * Create every block a "Ready-made" preset describes, in one transaction.
   * The renderer sends a preset id, never a block graph — the catalogue is
   * server-authoritative, and a multi-block preset needs the ids saveBlock
   * hands back to wire its later steps to its earlier ones.
   */
  const applyPreset: IpcHandler<any, IpcResult<BlocksListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const presetId = String(request?.presetId ?? "");
      if (!presetId) throw new Error("Missing presetId.");
      const db = localDbHandle();
      applyBlockPreset(db, scope, presetId, { now: new Date().toISOString() });
      return ok(readModel(db, scope));
    } catch (error) {
      console.error("Blocks preset apply failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Soft-delete a block (refused while it is another block's base). */
  const del: IpcHandler<any, IpcResult<BlocksListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const blockId = String(request?.blockId ?? "");
      if (!blockId) throw new Error("Missing blockId.");
      const db = localDbHandle();
      deleteBlock(db, scope, blockId, { now: new Date().toISOString() });
      return ok(readModel(db, scope));
    } catch (error) {
      console.error("Blocks delete failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Restore a soft-deleted block (the delete snackbar's Undo). */
  const restore: IpcHandler<any, IpcResult<BlocksListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const blockId = String(request?.blockId ?? "");
      if (!blockId) throw new Error("Missing blockId.");
      const db = localDbHandle();
      restoreBlock(db, scope, blockId, { now: new Date().toISOString() });
      return ok(readModel(db, scope));
    } catch (error) {
      console.error("Blocks restore failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Persist a new display order (mirrored onto def sort_order). */
  const reorder: IpcHandler<any, IpcResult<BlocksListResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const orderedIds = request?.orderedIds as string[] | undefined;
      if (!Array.isArray(orderedIds)) throw new Error("Missing orderedIds.");
      const db = localDbHandle();
      reorderBlocks(db, scope, orderedIds.map(String), {
        now: new Date().toISOString(),
      });
      return ok(readModel(db, scope));
    } catch (error) {
      console.error("Blocks reorder failed:", error);
      return fail(error, EMPTY);
    }
  };

  return {
    [BLOCKS_CHANNELS.list]: list,
    [BLOCKS_CHANNELS.save]: save,
    [BLOCKS_CHANNELS.applyPreset]: applyPreset,
    [BLOCKS_CHANNELS.delete]: del,
    [BLOCKS_CHANNELS.restore]: restore,
    [BLOCKS_CHANNELS.reorder]: reorder,
  };
}

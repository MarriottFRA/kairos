/**
 * Blocks Service
 * Renderer-side driver for the positions grid's block bands. Main owns
 * storage and the block→definition compilation; this service relays the
 * selected OU and the edited block config. Every call carries `ou` so the
 * OU-gate middleware can scope it. Mutations return the full refreshed
 * structure read model (blocks + raw engine definitions + SS schemes — the
 * inputs the renderer live-simulation compiles from).
 */

import {
  BLOCKS_CHANNELS,
  BlockInput,
  BlocksListResponse,
} from "../shared/blocks/ipc";

const EMPTY: BlocksListResponse = { blocks: [], definitions: [], ssSchemes: [] };

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Blocks + raw definitions + SS schemes for a hotel. */
export async function listBlocks(ou: string): Promise<BlocksListResponse> {
  const response = await ipc().sendIpcRequest(BLOCKS_CHANNELS.list, { ou });
  return (response.data as BlocksListResponse) ?? EMPTY;
}

/** Create or update a block; returns the refreshed read model. */
export async function saveBlock(
  ou: string,
  block: BlockInput
): Promise<BlocksListResponse> {
  const response = await ipc().sendIpcRequest(BLOCKS_CHANNELS.save, {
    ou,
    block,
  });
  return (response.data as BlocksListResponse) ?? EMPTY;
}

/**
 * Apply a "Ready-made" preset — creates every block it describes in one
 * transaction. Only the preset id travels; main owns the catalogue.
 */
export async function applyBlockPreset(
  ou: string,
  presetId: string
): Promise<BlocksListResponse> {
  const response = await ipc().sendIpcRequest(BLOCKS_CHANNELS.applyPreset, {
    ou,
    presetId,
  });
  return (response.data as BlocksListResponse) ?? EMPTY;
}

/** Soft-delete a block (refused while it is another block's base). */
export async function deleteBlock(
  ou: string,
  blockId: string
): Promise<BlocksListResponse> {
  const response = await ipc().sendIpcRequest(BLOCKS_CHANNELS.delete, {
    ou,
    blockId,
  });
  return (response.data as BlocksListResponse) ?? EMPTY;
}

/** Restore a soft-deleted block (the delete snackbar's Undo). */
export async function restoreBlock(
  ou: string,
  blockId: string
): Promise<BlocksListResponse> {
  const response = await ipc().sendIpcRequest(BLOCKS_CHANNELS.restore, {
    ou,
    blockId,
  });
  return (response.data as BlocksListResponse) ?? EMPTY;
}

/** Persist a new display order for the OU's blocks. */
export async function reorderBlocks(
  ou: string,
  orderedIds: string[]
): Promise<BlocksListResponse> {
  const response = await ipc().sendIpcRequest(BLOCKS_CHANNELS.reorder, {
    ou,
    orderedIds,
  });
  return (response.data as BlocksListResponse) ?? EMPTY;
}

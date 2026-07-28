/**
 * BST Push Service
 * Renderer-side driver for pushing the Results page's numbers into a hotel's
 * Excel BST. Main owns the file dialog, the recalculation, the plan and the
 * write; this service only relays the scope and reads results back.
 *
 * Every call carries `ou`, `year` and `scenarioId` — the OU-gate middleware
 * scopes on the first, and main re-derives everything else from them, so the
 * renderer can never widen what a push touches.
 */

import {
  BST_PUSH_CHANNELS,
  BstPushCommitResult,
  BstPushConfig,
  BstPushOptions,
  BstPushPreviewResult,
} from "../shared/bstPush/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

export interface PushScope {
  ou: string;
  year: number;
  scenarioId: string;
}

/**
 * Pick a BST, recalculate the scenario, and describe exactly what a push would
 * write. Writes nothing.
 */
export async function previewBstPush(
  scope: PushScope,
  options: BstPushOptions,
  /** Re-preview a file already chosen — skips the dialog. */
  filePath?: string
): Promise<BstPushPreviewResult> {
  const response = await ipc().sendIpcRequest(BST_PUSH_CHANNELS.preview, {
    ...scope,
    options,
    ...(filePath ? { filePath } : {}),
  });
  return response.data as BstPushPreviewResult;
}

/**
 * Apply a previously previewed push. Main re-reads the file and rebuilds the
 * plan before writing, so the path is the only thing carried across.
 */
export async function commitBstPush(
  scope: PushScope,
  filePath: string,
  options: BstPushOptions
): Promise<BstPushCommitResult> {
  const response = await ipc().sendIpcRequest(BST_PUSH_CHANNELS.commit, {
    ...scope,
    filePath,
    options,
  });
  return response.data as BstPushCommitResult;
}

/**
 * The saved clear rules and last-used month plan. Main owns this — the renderer
 * displays and edits it, but never carries it into a preview or a commit, so a
 * push can only ever apply rules that were actually saved.
 */
export async function loadBstPushConfig(ou: string): Promise<BstPushConfig> {
  const response = await ipc().sendIpcRequest(BST_PUSH_CHANNELS.config, { ou });
  return response.data as BstPushConfig;
}

/** Save part of that config (rules, months or backup) and read it all back. */
export async function saveBstPushConfig(
  ou: string,
  patch: Partial<BstPushConfig>
): Promise<BstPushConfig> {
  const response = await ipc().sendIpcRequest(BST_PUSH_CHANNELS.setConfig, {
    ou,
    config: patch,
  });
  return response.data as BstPushConfig;
}

/**
 * Show a written file (or its backup) in the OS file manager. Carries `ou` only
 * to satisfy the OU gate every channel in this family is registered behind.
 */
export async function revealBstFile(ou: string, filePath: string): Promise<void> {
  await ipc().sendIpcRequest(BST_PUSH_CHANNELS.reveal, { ou, filePath });
}

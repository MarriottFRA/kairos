/**
 * Legacy Excel Import Service
 * Renderer-side driver for the one-shot migration off the Excel "Payroll Budget
 * Tool". Main owns the file dialog, the parse and every write; this service
 * only relays the selected hotel, plan and options, and reads the result back.
 *
 * Two calls by design: `preview` describes what would happen without writing,
 * so the confirm dialog can show the blocks, the counts and every fidelity
 * warning first. `commit` then re-reads the SAME path — the preview holds no
 * server-side state, so there is no stale token to get wrong.
 */

import {
  LEGACY_IMPORT_CHANNELS,
  LegacyImportCommitResult,
  LegacyImportOptions,
  LegacyImportPreviewResult,
} from "../shared/legacyImport/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Open a file dialog and describe what importing the picked file would do. */
export async function previewLegacyImport(
  ou: string,
  scenarioId: string,
  options: LegacyImportOptions
): Promise<LegacyImportPreviewResult> {
  const response = await ipc().sendIpcRequest(LEGACY_IMPORT_CHANNELS.preview, {
    ou,
    scenarioId,
    options,
  });
  if (response?.success === false) throw new Error(response.error);
  return response.data as LegacyImportPreviewResult;
}

/** Apply a previously previewed file. */
export async function commitLegacyImport(
  ou: string,
  scenarioId: string,
  filePath: string,
  options: LegacyImportOptions
): Promise<LegacyImportCommitResult> {
  const response = await ipc().sendIpcRequest(LEGACY_IMPORT_CHANNELS.commit, {
    ou,
    scenarioId,
    filePath,
    options,
  });
  if (response?.success === false) throw new Error(response.error);
  return response.data as LegacyImportCommitResult;
}

/**
 * Oracle Report Import Service
 * Renderer-side driver for the port of the Excel tool's `Add_New_Rows_Oracle`
 * macro. Main owns the file dialog, the parse and every write; this service
 * only relays the selected hotel, plan and per-band choices, and reads the
 * result back.
 *
 * Two calls by design: `preview` describes what would happen without writing,
 * so the confirm dialog can show the first parsed rows, the skipped rows and
 * the block each percentage lands on first. `commit` then re-reads the SAME
 * path — the preview holds no server-side state, so there is no stale token to
 * get wrong.
 */

import {
  ORACLE_IMPORT_CHANNELS,
  OracleImportCommitResult,
  OracleImportOptions,
  OracleImportPreviewResult,
} from "../shared/oracleImport/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

/** Open a file dialog and describe what importing the picked file would do. */
export async function previewOracleImport(
  ou: string,
  scenarioId: string,
  options: OracleImportOptions
): Promise<OracleImportPreviewResult> {
  const response = await ipc().sendIpcRequest(ORACLE_IMPORT_CHANNELS.preview, {
    ou,
    scenarioId,
    options,
  });
  if (response?.success === false) throw new Error(response.error);
  return response.data as OracleImportPreviewResult;
}

/** Apply a previously previewed file. */
export async function commitOracleImport(
  ou: string,
  scenarioId: string,
  filePath: string,
  options: OracleImportOptions
): Promise<OracleImportCommitResult> {
  const response = await ipc().sendIpcRequest(ORACLE_IMPORT_CHANNELS.commit, {
    ou,
    scenarioId,
    filePath,
    options,
  });
  if (response?.success === false) throw new Error(response.error);
  return response.data as OracleImportCommitResult;
}

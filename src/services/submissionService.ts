/**
 * Submission service — renderer-side driver for the budget submission.
 * Main builds the payload from both stores and talks to the server; this
 * relays the hotel, the plan and the slot tag.
 */

import {
  SUBMISSION_CHANNELS,
  SubmissionBuildRequest,
  SubmissionPreviewResponse,
  SubmissionSendResponse,
  SubmissionStatusRequest,
  SubmissionStatusResponse,
} from "../shared/submission/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) throw new Error("IPC API not available");
  return api;
}

async function request<T>(channel: string, payload: unknown, fallback: string): Promise<T> {
  const response = await ipc().sendIpcRequest(channel, payload);
  if (response && response.success === false) throw new Error(response.error || fallback);
  return response.data as T;
}

/** Build the submission and hand it back — nothing is sent. */
export async function previewSubmission(payload: SubmissionBuildRequest): Promise<SubmissionPreviewResponse> {
  return request(SUBMISSION_CHANNELS.preview, payload, "Failed to build the submission");
}

/** Build the submission again and send it; replaces the hotel's slot on the server. */
export async function sendSubmission(payload: SubmissionBuildRequest): Promise<SubmissionSendResponse> {
  return request(SUBMISSION_CHANNELS.send, payload, "Failed to submit");
}

/** What the server holds for this hotel. */
export async function fetchSubmissionStatus(ou: string): Promise<SubmissionStatusResponse> {
  const payload: SubmissionStatusRequest = { ou };
  return request(SUBMISSION_CHANNELS.status, payload, "Failed to read the submission status");
}

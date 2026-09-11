/**
 * The submission endpoints, on the Kairos surface (KairosClient prefixes
 * `/kairos`, adds the bearer, gzips a body over 1 KiB and retries 429/5xx).
 *
 * PUT, not POST: one OU + slot + year holds ONE submission and sending again
 * replaces it (decided 2026-09-11), which is exactly what PUT means. The
 * submission id doubles as the idempotency key so a retried send of the same
 * build is not two replacements.
 *
 * Contract for the backend team: SUBMISSION_API.md at the repo root.
 */

import type { SubmissionPayload } from "../../shared/submission/schema";
import { submissionHeaderOf } from "../../shared/submission/schema";
import type { SubmissionReceipt, SubmissionStatusResponse } from "../../shared/submission/ipc";
import type { KairosClient } from "../kairosSync/client";

const ou = (value: string) => `/ou/${encodeURIComponent(value)}`;

export function submissionPath(hotelOu: string, slot: string, year: number): string {
  return `${ou(hotelOu)}/submissions/${encodeURIComponent(slot)}/${year}`;
}

export function submissionsListPath(hotelOu: string): string {
  return `${ou(hotelOu)}/submissions`;
}

export async function sendSubmission(
  client: Pick<KairosClient, "put">,
  payload: SubmissionPayload
): Promise<SubmissionReceipt> {
  const header = submissionHeaderOf(payload);
  const hotelOu = String(header.ou);
  const slot = String(header.slot);
  const year = Number(header.year);
  return client.put<SubmissionReceipt>(submissionPath(hotelOu, slot, year), payload, {
    idempotencyKey: String(header.submission_id),
  });
}

export async function fetchSubmissionStatus(
  client: Pick<KairosClient, "get">,
  hotelOu: string
): Promise<SubmissionStatusResponse> {
  const response = await client.get<SubmissionStatusResponse | null>(submissionsListPath(hotelOu));
  return { submissions: Array.isArray(response?.submissions) ? response!.submissions : [] };
}

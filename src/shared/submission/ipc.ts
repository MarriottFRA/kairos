/**
 * Budget submission — IPC channel names and wire shapes.
 *
 * The renderer names a hotel, a plan and a slot tag; main builds the payload
 * (calculating the plan first when its results are missing or out of date),
 * either hands it back for the page to show, or sends it. Status is the
 * server's list of what this hotel has submitted so far.
 *
 * Submission does not need the plan to be published, and anyone who can
 * open the plan can submit it (decided 2026-09-11): HR may own a plan that
 * Finance submits, and a hotel working fully locally is its own owner.
 */

import type { ReportRunInfo } from "../reports/ipc";
import type { ReportWarning } from "../reports/types";
import type { SubmissionPayload } from "./schema";

export const SUBMISSION_CHANNELS = {
  /** Build the payload and return it, with counts and warnings — nothing sent. */
  preview: "submission:preview",
  /** Build the payload again and send it; the server replaces the hotel's slot. */
  send: "submission:send",
  /** What the server holds for this hotel, per slot tag. */
  status: "submission:status",
} as const;

export interface SubmissionBuildRequest {
  ou: string;
  scenarioId: string;
  slot: string;
  year: number;
  /** Server-owned, best effort; the OU stands in when unknown. */
  hotelName?: string;
}

export type SubmissionPreviewRequest = SubmissionBuildRequest;
export type SubmissionSendRequest = SubmissionBuildRequest;

export interface SubmissionCounts {
  positions: number;
  manualRows: number;
  buyoutRows: number;
}

export interface SubmissionPreviewResponse {
  payload: SubmissionPayload;
  counts: SubmissionCounts;
  /** The run the calculated columns come from — never null or stale here,
   *  because the build recalculates first. */
  run: ReportRunInfo | null;
  warnings: ReportWarning[];
}

/** What the server answers a submission with. */
export interface SubmissionReceipt {
  submissionId: string;
  ou: string;
  slot: string;
  year: number;
  /** Server clock. */
  receivedAt: string;
  /** From the bearer token, never from the client. */
  submittedBy: string;
  counts: SubmissionCounts;
  /** True when an earlier submission for the same OU + slot + year was replaced. */
  replaced: boolean;
}

export interface SubmissionSendResponse {
  receipt: SubmissionReceipt;
  counts: SubmissionCounts;
  warnings: ReportWarning[];
}

/** One line of the server's status listing. */
export interface SubmissionStatusEntry {
  submissionId: string;
  slot: string;
  year: number;
  submittedAt: string;
  submittedBy: string;
  scenarioId: string;
  scenarioLabel: string;
  appVersion: string;
  schemaVersion: number;
  counts: SubmissionCounts;
}

export interface SubmissionStatusRequest {
  ou: string;
}

export interface SubmissionStatusResponse {
  submissions: SubmissionStatusEntry[];
}

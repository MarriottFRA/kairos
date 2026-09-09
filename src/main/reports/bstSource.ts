/**
 * The hotel's BST budget import as a ValueSource — the report engine's second
 * source, for figures the engine does not produce (total revenue, rooms sold…).
 *
 * `budget_values` holds the pull long-form (one row per combo × bucket ×
 * month) with codes already canonical and values already scaled to real
 * units, so one grouped read per bucket is all this takes. The bucket is
 * chosen by the scenario year (the buckets are self-describing: type + year
 * from the workbook's Setup Fields) unless the atom or the caller pins one.
 *
 * Headcount accounts are marked LEVEL: the BST stores heads the same way
 * Kairos posts them, as January-plus-changes (toMonthlyDeltas exists to match
 * it), so a report reads the BST's heads as levels too. Which OTHER accounts
 * the BST holds as levels — allocation splits, for one — is not knowable from
 * here; they read as amounts until the user's account lists say otherwise.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  POSITION_COUNT_ACCOUNT,
  WEEKLY_HOURS_STAT_ACCOUNT,
} from "../../shared/positions/systemAccounts";
import { bareAccount } from "../../shared/positions/comboKey";
import type { ReportBstInfo } from "../../shared/reports/ipc";
import { ValueSource, ValueSourceInput, buildValueSource } from "../../shared/reports/sources";
import type { ReportWarning, ValueSourceRef } from "../../shared/reports/types";
import { getCurrentImport } from "../budgetImport/repo";
import { prepared } from "../positions/stmtCache";
import { memo } from "./cache";

type Db = InstanceType<typeof Database>;
type BstRef = Extract<ValueSourceRef, { source: "bst" }>;

export interface BstOverride {
  bucketType?: string;
  bucketIndex?: 1 | 2 | 3;
}

export interface BstSourceLoad {
  source: ValueSource | null;
  info: ReportBstInfo | null;
  warning: ReportWarning | null;
}

// The standard work week (D0410 / A988112) is posted the same way as the
// heads — January only, one fact about the year — so it reads as a level too.
const LEVEL_ACCOUNTS: ReadonlySet<string> = new Set(
  [POSITION_COUNT_ACCOUNT, ...Object.values(HEADCOUNT_ACCOUNT_BY_JOB_TYPE), WEEKLY_HOURS_STAT_ACCOUNT].map(bareAccount)
);

const normalizeType = (value: string | null | undefined) =>
  String(value ?? "").trim().toUpperCase();

function readBucket(localDb: Db, importId: string, bucketIndex: number): ValueSourceInput[] {
  const rows = prepared(
    localDb,
    `SELECT dept, account, period, value FROM budget_values
      WHERE import_id = ? AND bucket_index = ?
      ORDER BY dept, account, period`
  ).all(importId, bucketIndex) as Array<{
    dept: string;
    account: string;
    period: number;
    value: number;
  }>;

  const inputs: ValueSourceInput[] = [];
  let current: { dept: string; account: string; months: number[] } | null = null;
  for (const row of rows) {
    if (!current || current.dept !== row.dept || current.account !== row.account) {
      current = { dept: row.dept, account: row.account, months: new Array<number>(12).fill(0) };
      inputs.push({
        ...current,
        encoding: LEVEL_ACCOUNTS.has(bareAccount(row.account)) ? "LEVEL" : "AMOUNT",
      });
    }
    const m = Number(row.period) - 1;
    if (m >= 0 && m < 12) current.months[m] += Number(row.value) || 0;
  }
  return inputs;
}

export function getBstSource(
  localDb: Db,
  ou: string,
  year: number,
  ref: BstRef,
  override?: BstOverride
): BstSourceLoad {
  let summary;
  try {
    summary = getCurrentImport(localDb, ou);
  } catch {
    summary = null; // no budget_imports table on this install
  }
  if (!summary) {
    return {
      source: null,
      info: null,
      warning: {
        code: "BST_UNAVAILABLE",
        message: "No BST budget import has been pulled for this hotel.",
      },
    };
  }

  const wantedIndex = override?.bucketIndex ?? ref.bucket?.index;
  const wantedType = normalizeType(override?.bucketType ?? ref.bucket?.type);
  const wantedYear = year + (ref.yearOffset ?? 0);

  let bucket = wantedIndex
    ? summary.buckets.find((b) => b.index === wantedIndex)
    : summary.buckets.find(
        (b) => b.year === wantedYear && (!wantedType || normalizeType(b.type) === wantedType)
      );
  // A type given without a year match falls back to the type alone: the
  // workbook rotates its buckets each cycle, and "the BUDGET bucket" is a
  // better answer than nothing when the years are one cycle apart.
  if (!bucket && !wantedIndex && wantedType) {
    bucket = summary.buckets.find((b) => normalizeType(b.type) === wantedType);
  }
  if (!bucket) {
    const asked = wantedIndex
      ? `bucket ${wantedIndex}`
      : `${wantedType || "any"} bucket for ${wantedYear}`;
    const held = summary.buckets.map((b) => `${b.index}: ${b.type || "?"} ${b.year ?? "?"}`).join(", ");
    return {
      source: null,
      info: null,
      warning: {
        code: "BST_BUCKET_NOT_FOUND",
        message: `The BST import holds no ${asked} (it has ${held || "no buckets"}).`,
      },
    };
  }

  const info: ReportBstInfo = {
    importId: summary.id,
    bucketIndex: bucket.index,
    bucketType: bucket.type || null,
    year: bucket.year ?? null,
  };
  const source = memo(
    localDb,
    `reports:bst:${summary.ou}:${bucket.index}`,
    `${summary.id}|${bucket.index}`,
    () => buildValueSource(`bst:${bucket!.index}`, readBucket(localDb, summary!.id, bucket!.index))
  );
  return { source, info, warning: null };
}

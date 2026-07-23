/**
 * Column + grouping builders for the budget-values grid.
 *
 * The 36 monthly cells live on `row.cells` in bucket-major order
 * ([b1m1..b1m12, b2m1..b2m12, b3m1..b3m12]), so each month column reads its
 * value by fixed index. The three buckets become column groups labelled from
 * the import's BucketMeta ("BUDGET 2027", "ACT/FCST 2026", …).
 */

import type {
  GridColDef,
  GridColumnGroupingModel,
} from "@mui/x-data-grid-premium";
import {
  BucketMeta,
  PERIODS_PER_BUCKET,
  WideBudgetRow,
} from "../../shared/budgetImport/ipc";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** A human label for a bucket group, e.g. "BUDGET 2027" (falls back gracefully). */
export function bucketLabel(bucket: BucketMeta): string {
  const type = bucket.type?.trim() || `Set ${bucket.index}`;
  return bucket.year ? `${type} ${bucket.year}` : type;
}

function formatCell(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** field name for the month cell at bucket b (1-based) period p (1-based). */
function cellField(b: number, p: number): string {
  return `c_${b}_${p}`;
}

/** Build the identity columns + 36 month columns, and the bucket grouping. */
export function buildBudgetColumns(buckets: BucketMeta[]): {
  columns: GridColDef<WideBudgetRow>[];
  grouping: GridColumnGroupingModel;
} {
  const columns: GridColDef<WideBudgetRow>[] = [
    { field: "combo", headerName: "Combo", width: 130 },
    { field: "dept", headerName: "Dep", width: 70 },
    { field: "account", headerName: "Account", width: 90 },
  ];

  const grouping: GridColumnGroupingModel = [];

  for (let b = 1; b <= 3; b++) {
    const bucket = buckets[b - 1] ?? { index: b, type: "", year: null };
    const children: { field: string }[] = [];
    for (let p = 1; p <= PERIODS_PER_BUCKET; p++) {
      const field = cellField(b, p);
      const cellIndex = (b - 1) * PERIODS_PER_BUCKET + (p - 1);
      columns.push({
        field,
        headerName: MONTH_ABBR[p - 1],
        width: 78,
        type: "number",
        sortable: false,
        valueGetter: (_value, row) => row.cells[cellIndex] ?? 0,
        valueFormatter: (value) => formatCell(value),
      });
      children.push({ field });
    }
    grouping.push({
      groupId: `bucket_${b}`,
      headerName: bucketLabel(bucket),
      children,
    });
  }

  return { columns, grouping };
}

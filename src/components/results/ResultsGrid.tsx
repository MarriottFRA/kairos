/**
 * ResultsGrid — the dept × account × month output table.
 *
 * Extracted from the Results route when the page grew an inspector: the route
 * now owns scope, loading and selection, and this owns how a result row looks.
 * Same DataGridPremium shape it always had (grouped by department, month
 * aggregation, Year pinned right) plus two things the four-source union needs:
 *
 *   - a Source column, so a hand-entered number is never mistaken for a
 *     calculated one at a glance;
 *   - percent-aware formatting, because an allocation split is a share out of
 *     100 rather than money (see format.ts).
 *
 * The level-valued rows — headcount, position count, allocation splits — read
 * as a January value followed by eleven zeroes. That is not a display trick: it
 * is what the budget generates and what the push writes, because the BST reads
 * such a statistic as the running sum of its months.
 *
 * Clicking any cell selects it — that is the whole inspector interaction. The
 * selected cell is outlined rather than the whole row, because the inspector
 * answers a different question for a month cell than for the Year.
 */

import { useMemo } from "react";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import {
  DataGridPremium,
  GridColDef,
  GridEventListener,
  GridRowId,
} from "@mui/x-data-grid-premium";
import { OutputAggRowDto, OutputValueKind } from "../../shared/positions/ipc";
import { formatResultValue, yearValueOf } from "./format";
import { SourceSummaryCell } from "./sourceMeta";

export const MONTH_SHORT = Array.from({ length: 12 }, (_, m) =>
  new Date(2000, m, 1).toLocaleString("en", { month: "short" })
);

export interface ResultRow extends OutputAggRowDto {
  id: string;
}

/** What the user has clicked — what the inspector should explain. */
export interface ResultSelection {
  dept: string;
  account: string;
  /** 0-based month, or null for the whole year (the Year/account/dept cells). */
  month: number | null;
  /** A department group header rather than a single account row. */
  isDeptGroup: boolean;
}

export interface ResultsGridProps {
  rows: ResultRow[];
  loading?: boolean;
  selection: ResultSelection | null;
  onSelect: (selection: ResultSelection) => void;
}

/** The id convention the route and this grid share. */
export function rowIdOf(row: OutputAggRowDto): string {
  return `${row.dept}|${row.account}`;
}

export default function ResultsGrid({
  rows,
  loading,
  selection,
  onSelect,
}: ResultsGridProps) {
  const columns = useMemo<GridColDef<ResultRow>[]>(() => {
    const numberColumn = (
      field: string,
      headerName: string,
      index?: number
    ): GridColDef<ResultRow> => ({
      field,
      headerName,
      width: field === "total" ? 124 : 96,
      type: "number",
      sortable: field === "total",
      cellClassName: "res-cell--num",
      valueGetter:
        index === undefined
          ? // The Year column: a rate row shows the rate, not a twelve-fold sum.
            (_value, row) => (row?.months ? yearValueOf(row) : null)
          : // Grouping adds auto-generated `dept` rows that carry no months —
            // their value comes from the aggregation model, not this getter.
            (_value, row) => row?.months?.[index] ?? null,
      valueFormatter: (value: number | null | undefined, row) =>
        formatResultValue(
          value,
          (row?.valueKind as OutputValueKind) ?? "currency"
        ),
    });

    return [
      { field: "dept", headerName: "Department", width: 120 },
      {
        field: "account",
        headerName: "Account",
        width: 130,
        renderCell: (params) => (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            <span>{params.value as string}</span>
            {params.row?.isStats && (
              <Chip
                label="stat"
                size="small"
                variant="outlined"
                sx={{ height: 18, fontSize: "0.625rem" }}
              />
            )}
          </Stack>
        ),
      },
      {
        field: "sources",
        headerName: "Source",
        width: 108,
        sortable: false,
        // Grouping rows have no sources of their own; leaving them blank is
        // honest — the group is a sum, not a thing with an origin.
        renderCell: (params) =>
          params.row?.sources ? (
            <Stack
              direction="row"
              sx={{ alignItems: "center", height: "100%" }}
            >
              <SourceSummaryCell sources={params.row.sources} />
            </Stack>
          ) : null,
      },
      ...MONTH_SHORT.map((name, index) =>
        numberColumn(`m${index + 1}`, name, index)
      ),
      numberColumn("total", "Year"),
    ];
  }, []);

  const handleCellClick: GridEventListener<"cellClick"> = (params) => {
    const field = String(params.field);
    // The grouping column and the group rows themselves: explain the whole
    // department rather than one account.
    if (!params.row?.months) {
      const dept = String(
        (params.row as { dept?: unknown })?.dept ?? params.id ?? ""
      ).replace(/^dept\//, "");
      onSelect({ dept, account: "", month: null, isDeptGroup: true });
      return;
    }

    const monthMatch = /^m(\d{1,2})$/.exec(field);
    onSelect({
      dept: params.row.dept,
      account: params.row.account,
      month: monthMatch ? Number(monthMatch[1]) - 1 : null,
      isDeptGroup: false,
    });
  };

  const selectedRowId: GridRowId | null = selection
    ? selection.isDeptGroup
      ? null
      : `${selection.dept}|${selection.account}`
    : null;

  return (
    <DataGridPremium
      rows={rows}
      columns={columns}
      loading={loading}
      rowGroupingModel={["dept"]}
      defaultGroupingExpansionDepth={-1}
      onCellClick={handleCellClick}
      getCellClassName={(params) => {
        if (!selection || params.id !== selectedRowId) return "";
        const monthMatch = /^m(\d{1,2})$/.exec(String(params.field));
        const month = monthMatch ? Number(monthMatch[1]) - 1 : null;
        const isYear = params.field === "total";
        const wholeRow = selection.month === null;
        if (wholeRow ? isYear || month !== null : month === selection.month) {
          return "res-cell--selected";
        }
        return "";
      }}
      initialState={{
        aggregation: {
          model: Object.fromEntries([
            ...MONTH_SHORT.map((_name, index) => [`m${index + 1}`, "sum"]),
            ["total", "sum"],
          ]),
        },
        pinnedColumns: { right: ["total"] },
      }}
      rowHeight={32}
      columnHeaderHeight={40}
      hideFooter
      sx={{
        borderRadius: 2,
        "& .res-cell--num": {
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.8125rem",
        },
        "& .res-cell--selected": {
          backgroundColor: "action.selected",
          fontWeight: 700,
        },
        "& .MuiDataGrid-cell": { cursor: "pointer" },
      }}
    />
  );
}

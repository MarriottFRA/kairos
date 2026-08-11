/**
 * ResultsGrid — the dept × account × month output table.
 *
 * Extracted from the Results route when the page grew an inspector: the route
 * now owns scope, loading and selection, and this owns how a result row looks.
 * Same DataGridPremium shape it always had (grouped by department, month
 * aggregation, Year pinned right) plus what the four-source union needs: a
 * Source column, so a hand-entered number is never mistaken for a calculated
 * one at a glance. Every cell prints the bare number that gets loaded — an
 * allocation split included, so a 6.5% share reads as 6.5 (see format.ts).
 *
 * Nobody reads a chart of accounts from memory, so the codes are backed by
 * their descriptions: a Description column beside the account and the name on
 * the department group header, both governed by one toolbar toggle. The Source
 * column then names the BLOCKS behind a row, because "what made this number" is
 * the question the page is most often asked and the inspector charges a click
 * for the answer. Search covers all of it — codes, descriptions and block
 * names — and deliberately not the money.
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

import { useCallback, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import {
  DataGridPremium,
  GridColDef,
  GridColumnVisibilityModel,
  GridEventListener,
  GridFilterModel,
  GridRowId,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import { OutputAggRowDto, OutputValueKind } from "../../shared/positions/ipc";
import { formatResultValue, yearValueOf } from "./format";
import { BlockChips, SourceSummaryCell } from "./sourceMeta";
import CellSelectionStats, {
  CELL_SELECTION_PERF_SX,
} from "../common/CellSelectionStats";

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
  /** Free-text search over codes, descriptions and block names. */
  quickFilter: string;
  /** Show the account Description column and name the department groups. */
  showDescriptions: boolean;
}

/** The id convention the route and this grid share. */
export function rowIdOf(row: OutputAggRowDto): string {
  return `${row.dept}|${row.account}`;
}

/** A stable empty array — a fresh [] every render would refilter on every keystroke. */
const NO_QUICK_FILTER: string[] = Object.freeze([]) as string[];

/** "m1".."m12" → 0-based month. Replaces a `/^m(\d{1,2})$/` exec that ran per
 *  visible cell per render in getCellClassName, and again on every cell click. */
const MONTH_INDEX_BY_FIELD = new Map(
  MONTH_SHORT.map((_name, index) => [`m${index + 1}`, index])
);

/** Read once, at mount — MUI never reacts to later changes — so it belongs at
 *  module scope rather than being rebuilt in the render body. Not a perf fix:
 *  a fresh literal per render cost one allocation and no grid work. */
const INITIAL_STATE = {
  aggregation: {
    model: Object.fromEntries([
      ...MONTH_SHORT.map((_name, index) => [`m${index + 1}`, "sum"] as const),
      ["total", "sum"] as const,
    ]),
  },
  pinnedColumns: { right: ["total"] },
};

export default function ResultsGrid({
  rows,
  loading,
  selection,
  onSelect,
  quickFilter,
  showDescriptions,
}: ResultsGridProps) {
  const apiRef = useGridApiRef();

  // Quick-filter text per row, cached on the row object itself so a recalc
  // (which produces new rows) invalidates it and nothing else has to.
  const searchTextByRow = useMemo(() => new WeakMap<ResultRow, string>(), []);

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
      // Money must not answer the search box. Without this, typing "500" matches
      // every row with a 500-ish month and the search is worse than useless.
      getApplyQuickFilterFn: () => null,
    });

    return [
      { field: "dept", headerName: "Department", width: 120 },
      // Never shown: it exists so the search box can match a department by name
      // even though the name itself is rendered on the group header rather than
      // in a column of its own. See quickFilterExcludeHiddenColumns below.
      {
        field: "departmentName",
        headerName: "Department name",
        hideable: false,
      },
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
        field: "accountName",
        headerName: "Description",
        width: 260,
        // A row whose account is not in the synced mapping tables gets no
        // description rather than an echo of the code beside it.
        valueGetter: (_value, row) => row?.accountName ?? "",
      },
      {
        field: "sources",
        headerName: "Source",
        width: 300,
        sortable: false,
        // The chips are drawn by renderCell; this is what the search box reads.
        // Both halves of the cell answer it: a block name finds every row that
        // block feeds, and "manual" / "alloc" finds every row of that origin.
        // Cached per row object (the same WeakMap idiom PositionsGrid uses for
        // its action items): two array spreads and a join per visible cell per
        // render is real work for a string that only changes when the row does.
        valueGetter: (_value, row) => {
          if (!row) return "";
          const cached = searchTextByRow.get(row);
          if (cached !== undefined) return cached;
          const text = [...(row.sources ?? []), ...(row.blockLabels ?? [])].join(" ");
          searchTextByRow.set(row, text);
          return text;
        },
        // Grouping rows have no sources of their own; leaving them blank is
        // honest — the group is a sum, not a thing with an origin.
        renderCell: (params) =>
          params.row?.sources ? (
            <Stack
              direction="row"
              spacing={0.5}
              sx={{ alignItems: "center", height: "100%", minWidth: 0 }}
            >
              <SourceSummaryCell sources={params.row.sources} />
              <BlockChips labels={params.row.blockLabels ?? []} />
            </Stack>
          ) : null,
      },
      ...MONTH_SHORT.map((name, index) =>
        numberColumn(`m${index + 1}`, name, index)
      ),
      numberColumn("total", "Year"),
    ];
    // searchTextByRow is a stable WeakMap — listed so the closure is honest,
    // never a reason to rebuild.
  }, [searchTextByRow]);

  /**
   * Department code → description, taken off the rows themselves rather than
   * looked up again: every row already carries its department's name.
   */
  const departmentNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) {
      if (row.departmentName) names.set(row.dept, row.departmentName);
    }
    return names;
  }, [rows]);

  /**
   * The department group header, named.
   *
   * A valueFormatter rather than a renderCell so the expand/collapse toggle and
   * the descendant count keep working — the grouping cell prints the formatted
   * value when there is one and falls back to the raw grouping key otherwise,
   * which is exactly the behaviour wanted for a department with no description.
   */
  const groupingColDef = useMemo(
    () => ({
      headerName: "Department",
      valueFormatter: (value: unknown) => {
        const code = String(value ?? "");
        if (!code) return value; // Leaf rows — the grouping column is blank there.
        const name = showDescriptions ? departmentNames.get(code) : undefined;
        return name ? `${code} · ${name}` : code;
      },
    }),
    [departmentNames, showDescriptions]
  );

  /**
   * The column filters the user built in the filter panel.
   *
   * Held here — and paired with onFilterModelChange below — because MUI
   * registers `filter` as controlled state the moment a model is passed, and a
   * controlled model with no change handler makes the prop win over every write
   * the panel attempts, silently breaking the whole panel rather than just the
   * quick filter.
   */
  const [panelFilters, setPanelFilters] = useState<GridFilterModel>({ items: [] });

  const filterModel = useMemo<GridFilterModel>(
    () => ({
      ...panelFilters,
      quickFilterValues: quickFilter ? quickFilter.split(/\s+/) : NO_QUICK_FILTER,
      // The default is to search visible columns only, which would silently stop
      // descriptions and department names matching the moment the toggle is off
      // (the department name has no visible column at all).
      quickFilterExcludeHiddenColumns: false,
    }),
    [panelFilters, quickFilter]
  );

  /** Whatever the user hid from the column menu, with the two fields this
   *  component owns layered on top. Same controlled-state rule as the filters. */
  const [hiddenColumns, setHiddenColumns] = useState<GridColumnVisibilityModel>({});

  const columnVisibilityModel = useMemo<GridColumnVisibilityModel>(
    () => ({ ...hiddenColumns, accountName: showDescriptions, departmentName: false }),
    [hiddenColumns, showDescriptions]
  );

  const handleCellClick: GridEventListener<"cellClick"> = useCallback(
    (params) => {
      // The grouping column and the group rows themselves: explain the whole
      // department rather than one account.
      if (!params.row?.months) {
        const dept = String(
          (params.row as { dept?: unknown })?.dept ?? params.id ?? ""
        ).replace(/^dept\//, "");
        onSelect({ dept, account: "", month: null, isDeptGroup: true });
        return;
      }

      onSelect({
        dept: params.row.dept,
        account: params.row.account,
        month: MONTH_INDEX_BY_FIELD.get(String(params.field)) ?? null,
        isDeptGroup: false,
      });
    },
    [onSelect]
  );

  const selectedRowId: GridRowId | null = selection
    ? selection.isDeptGroup
      ? null
      : `${selection.dept}|${selection.account}`
    : null;

  // Runs per visible cell per render — seventeen columns × the viewport — so it
  // gets a stable identity and a map lookup rather than an inline arrow that
  // recompiles a regex on every cell.
  const getCellClassName = useCallback(
    (params: { id: GridRowId; field: string }) => {
      if (!selection || params.id !== selectedRowId) return "";
      const month = MONTH_INDEX_BY_FIELD.get(String(params.field)) ?? null;
      const isYear = params.field === "total";
      const wholeRow = selection.month === null;
      return wholeRow
        ? isYear || month !== null
          ? "res-cell--selected"
          : ""
        : month === selection.month
          ? "res-cell--selected"
          : "";
    },
    [selection, selectedRowId]
  );

  // The wrapper anchors the selection readout; the grid itself gains no prop
  // for it and never re-renders on account of it.
  return (
    <Box sx={{ position: "relative", height: "100%", width: "100%" }}>
      <DataGridPremium
        apiRef={apiRef}
        rows={rows}
        columns={columns}
        loading={loading}
        // Ranges, so a quarter of one account — or one month across several — can
        // be totalled in place. The single-cell click that drives the inspector is
        // untouched: onCellClick still fires, cell selection is layered over it.
        cellSelection
        // Without this the same click that selects a cell also selects its whole
        // row, so two highlights compete with the inspector's own.
        disableRowSelectionOnClick
        rowGroupingModel={["dept"]}
        groupingColDef={groupingColDef}
        defaultGroupingExpansionDepth={-1}
        filterModel={filterModel}
        // Non-negotiable while filterModel is passed: without it MUI treats the
        // prop as the only truth and the filter panel stops working entirely.
        onFilterModelChange={setPanelFilters}
        columnVisibilityModel={columnVisibilityModel}
        onColumnVisibilityModelChange={setHiddenColumns}
        onCellClick={handleCellClick}
        getCellClassName={getCellClassName}
        initialState={INITIAL_STATE}
        rowHeight={32}
        columnHeaderHeight={40}
        hideFooter
        sx={{
          borderRadius: 2,
          // Required by cellSelection — see where it is defined.
          ...(CELL_SELECTION_PERF_SX as object),
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
      {/* No footer on this grid — just clear of the horizontal scrollbar. */}
      <CellSelectionStats apiRef={apiRef} bottom={20} />
    </Box>
  );
}

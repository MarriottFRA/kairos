/**
 * ReportGrid — an evaluated report as a table: one row per line, one column
 * group per series or variance, twelve months + Total or the Total alone.
 *
 * Header rows are bands, spacers are short and blank, measure rows indent
 * by their level; the Total of each group is bold. A variance cell is
 * coloured by whether it is good news, which for a cost line is the other
 * way round (the measure's polarity). Clicking any line opens the inspector.
 *
 * VERSUS IN THE CELL. Laid out series-major, a month's variance sits a whole
 * year of columns to the right of the figure it explains. With `versus` on,
 * the primary series' cells carry ONE subordinate line beneath the figure:
 * the difference against one chosen comparison, as an amount or a percent,
 * coloured by polarity — and nothing at all when the difference is zero, so
 * only the exceptions carry ink. The full picture (both figures, both
 * deltas) is a hover away, and the variance column groups, now redundant,
 * fold out of the horizontal spread. The comparison series stay: the
 * figure compared against is still there for whoever scrolls to it.
 */

import { useMemo } from "react";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  DataGridPremium,
  GridColDef,
  GridColumnGroupingModel,
  GridRowClassNameParams,
} from "@mui/x-data-grid-premium";
import type { EvaluatedColumn } from "../../shared/reports/columns";
import { VarianceValue, isSeriesColumn, varianceOf } from "../../shared/reports/columns";
import type { ReportsEvaluateColumnsResponse } from "../../shared/reports/ipc";
import type { Format, Polarity } from "../../shared/reports/types";
import { MONTH_SHORT, formatReportDelta, formatReportValue, scaleForDisplay } from "./format";

/** What the subordinate line under a primary figure shows. */
export type VersusMode = "off" | "abs" | "pct";

export interface ReportGridProps {
  grid: ReportsEvaluateColumnsResponse;
  months: boolean;
  /** Money in thousands; counts, hours, ratios and percentages as they are. */
  thousands?: boolean;
  /** The in-cell difference: off, an amount, or a percent. */
  versus?: VersusMode;
  /** The comparison series the difference is against; the first one when unset. */
  versusAgainst?: string | null;
  loading?: boolean;
  selectedRow: number | null;
  onSelectRow: (index: number) => void;
}

interface GridRow {
  id: number;
  type: "header" | "spacer" | "measure";
  label: string;
  indent: number;
  format: Format;
  polarity?: Polarity;
  invertSign: boolean;
  /** `${columnId}:${slot}` → value. */
  cells: Record<string, number | null>;
  /** `${columnId}` → the variance column's own format for this row, if any. */
  formats: Record<string, Format | null>;
}

const fieldOf = (columnId: string, slot: number) => `${columnId}:${slot}`;

const MEASURE_ROW_HEIGHT = 30;
const MEASURE_ROW_HEIGHT_VERSUS = 42;
const SPACER_ROW_HEIGHT = 12;

/** The series columns a grid can show a difference against: every series but the first. */
export function comparisonColumns(grid: ReportsEvaluateColumnsResponse): EvaluatedColumn[] {
  return grid.columns.filter((c) => isSeriesColumn(c.spec)).slice(1);
}

const favourableFor = (polarity: Polarity | undefined, value: number) =>
  polarity === "cost" ? value < 0 : value > 0;

export default function ReportGrid({
  grid,
  months,
  thousands = false,
  versus = "off",
  versusAgainst = null,
  loading,
  selectedRow,
  onSelectRow,
}: ReportGridProps) {
  const slots = useMemo(() => (months ? Array.from({ length: 13 }, (_, i) => i) : [12]), [months]);

  // The primary series, the one it is compared against, and whether the
  // in-cell difference is actually on (it needs both).
  const seriesColumns = useMemo(() => grid.columns.filter((c) => isSeriesColumn(c.spec)), [grid.columns]);
  const primary = seriesColumns[0] ?? null;
  const compare = useMemo(() => {
    const candidates = seriesColumns.slice(1);
    return candidates.find((c) => c.id === versusAgainst) ?? candidates[0] ?? null;
  }, [seriesColumns, versusAgainst]);
  const versusOn = versus !== "off" && primary !== null && compare !== null;
  const mode: Exclude<VersusMode, "off"> = versus === "pct" ? "pct" : "abs";

  // With the difference in the cell, the variance groups say nothing new.
  const shownColumns = useMemo(
    () => (versusOn ? seriesColumns : grid.columns),
    [versusOn, seriesColumns, grid.columns]
  );

  const rows = useMemo<GridRow[]>(
    () =>
      grid.rows.map((row, index) => {
        const cells: Record<string, number | null> = {};
        const formats: Record<string, Format | null> = {};
        for (const column of grid.columns) {
          const values = column.values[index];
          formats[column.id] = column.rowFormats[index] ?? null;
          for (const slot of slots) {
            const raw = values ? values[slot] : null;
            cells[fieldOf(column.id, slot)] =
              raw === null || raw === undefined ? null : row.invertSign ? -raw : raw;
          }
        }
        return {
          id: index,
          type: row.type,
          label: row.label,
          indent: row.indent,
          format: row.format ?? "number",
          polarity: row.polarity,
          invertSign: row.invertSign === true,
          cells,
          formats,
        };
      }),
    [grid, slots]
  );

  const columns = useMemo<GridColDef<GridRow>[]>(() => {
    const out: GridColDef<GridRow>[] = [
      {
        field: "label",
        headerName: "Line",
        width: 320,
        sortable: false,
        renderCell: (params) => (
          <Box
            component="span"
            sx={{
              pl: params.row.indent * 2,
              fontWeight: params.row.type === "header" || params.row.indent === 0 ? 700 : 400,
              letterSpacing: params.row.type === "header" ? 0.4 : 0,
              fontSize: params.row.type === "header" ? "0.75rem" : undefined,
            }}
          >
            {params.value as string}
          </Box>
        ),
      },
    ];
    const printValue = (row: GridRow, columnId: string, value: number | null) => {
      const format = row.formats[columnId] ?? row.format;
      return formatReportValue(scaleForDisplay(value, format, thousands), format);
    };
    const printDelta = (delta: VarianceValue) =>
      formatReportDelta(scaleForDisplay(delta.value, delta.format, thousands), delta.format);

    for (const column of shownColumns) {
      const variance = !isSeriesColumn(column.spec);
      const withDelta = versusOn && primary !== null && compare !== null && column.id === primary.id;
      for (const slot of slots) {
        const def: GridColDef<GridRow> = {
          field: fieldOf(column.id, slot),
          headerName: slot === 12 ? "Total" : MONTH_SHORT[slot],
          width: slot === 12 ? 112 : 92,
          type: "number",
          sortable: false,
          align: "right",
          headerAlign: "right",
          valueGetter: (_value, row) => row.cells[fieldOf(column.id, slot)],
          valueFormatter: (value: number | null, row) =>
            row.type !== "measure" ? "" : printValue(row, column.id, value),
          cellClassName: (params) => {
            const classes = ["rep-cell--num"];
            if (slot === 12) classes.push("rep-cell--total");
            const value = params.value as number | null;
            if (variance && params.row.type === "measure" && value) {
              classes.push(favourableFor(params.row.polarity, value) ? "rep-cell--good" : "rep-cell--bad");
            }
            return classes.join(" ");
          },
        };
        if (withDelta && primary && compare) {
          const primaryId = primary.id;
          const compareId = compare.id;
          const primaryLabel = primary.label;
          const compareLabel = compare.label;
          def.renderCell = (params) => {
            const row = params.row;
            if (row.type !== "measure") return null;
            const a = row.cells[fieldOf(primaryId, slot)];
            const b = row.cells[fieldOf(compareId, slot)];
            const shown = varianceOf(a, b, mode, row.format);
            const text = printDelta(shown);
            const tone =
              shown.value && text
                ? favourableFor(row.polarity, shown.value)
                  ? "rep-delta--good"
                  : "rep-delta--bad"
                : "";
            const abs = varianceOf(a, b, "abs", row.format);
            const pct = varianceOf(a, b, "pct", row.format);
            const detail = (
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "auto auto",
                  columnGap: 1.5,
                  rowGap: 0.25,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>{primaryLabel}</span>
                <Box component="span" sx={{ textAlign: "right" }}>
                  {printValue(row, primaryId, a) || "–"}
                </Box>
                <span>{compareLabel}</span>
                <Box component="span" sx={{ textAlign: "right" }}>
                  {printValue(row, compareId, b) || "–"}
                </Box>
                <span>Difference</span>
                <Box component="span" sx={{ textAlign: "right" }}>
                  {printDelta(abs) || "–"}
                </Box>
                <span>Difference %</span>
                <Box component="span" sx={{ textAlign: "right" }}>
                  {printDelta(pct) || "–"}
                </Box>
              </Box>
            );
            return (
              <Tooltip title={detail} enterDelay={500} enterNextDelay={300} disableInteractive placement="top">
                <Box className="rep-stack">
                  <span className="rep-stack__value">{params.formattedValue as string}</span>
                  <span className={`rep-stack__delta ${tone}`}>{text}</span>
                </Box>
              </Tooltip>
            );
          };
        }
        out.push(def);
      }
    }
    return out;
  }, [shownColumns, slots, thousands, versusOn, primary, compare, mode]);

  const columnGroupingModel = useMemo<GridColumnGroupingModel>(
    () =>
      shownColumns.map((column: EvaluatedColumn) => {
        const annotated = versusOn && primary !== null && compare !== null && column.id === primary.id;
        const compareLabel = compare?.label ?? "";
        return {
          groupId: column.id,
          headerName: column.label,
          headerAlign: "center" as const,
          children: slots.map((slot) => ({ field: fieldOf(column.id, slot) })),
          ...(annotated
            ? {
                renderHeaderGroup: () => (
                  <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, minWidth: 0 }}>
                    <Typography component="span" variant="body2" sx={{ fontWeight: 700 }} noWrap>
                      {column.label}
                    </Typography>
                    <Typography component="span" variant="caption" color="text.secondary" noWrap>
                      {mode === "pct" ? "% vs" : "vs"} {compareLabel}
                    </Typography>
                  </Box>
                ),
              }
            : {}),
        };
      }),
    [shownColumns, slots, versusOn, primary, compare, mode]
  );

  const getRowClassName = (params: GridRowClassNameParams<GridRow>) => {
    const classes: string[] = [`rep-row--${params.row.type}`];
    if (params.row.id === selectedRow) classes.push("rep-row--selected");
    return classes.join(" ");
  };

  const measureHeight = versusOn ? MEASURE_ROW_HEIGHT_VERSUS : MEASURE_ROW_HEIGHT;

  return (
    <DataGridPremium
      rows={rows}
      columns={columns}
      columnGroupingModel={columnGroupingModel}
      loading={loading}
      hideFooter
      disableColumnMenu
      disableRowSelectionOnClick
      pinnedColumns={{ left: ["label"] }}
      getRowHeight={(params) =>
        (params.model as GridRow).type === "spacer" ? SPACER_ROW_HEIGHT : measureHeight
      }
      getRowClassName={getRowClassName}
      onRowClick={(params) => {
        if ((params.row as GridRow).type === "measure") onSelectRow(params.row.id as number);
      }}
      columnHeaderHeight={36}
      sx={{
        borderRadius: 2,
        "& .rep-cell--num": { fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.8125rem" },
        "& .rep-cell--total": { fontWeight: 700 },
        "& .rep-cell--good": { color: "success.main" },
        "& .rep-cell--bad": { color: "error.main" },
        // The stacked cell: the figure on top, the difference as a quieter
        // second line, both right-aligned so each reads as its own column.
        "& .rep-stack": {
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          lineHeight: 1.2,
        },
        "& .rep-stack__delta": {
          fontSize: "0.6875rem",
          fontWeight: 500,
          minHeight: "0.9rem",
          color: "text.disabled",
        },
        "& .rep-delta--good": { color: "success.main", opacity: 0.9 },
        "& .rep-delta--bad": { color: "error.main", opacity: 0.9 },
        "& .rep-row--header": { bgcolor: "action.hover" },
        "& .rep-row--header .MuiDataGrid-cell": { borderBottom: "none" },
        "& .rep-row--spacer .MuiDataGrid-cell": { borderBottom: "none" },
        "& .rep-row--measure .MuiDataGrid-cell": { cursor: "pointer" },
        "& .rep-row--selected": { bgcolor: "action.selected" },
        "& .MuiDataGrid-columnHeader--filledGroup .MuiDataGrid-columnHeaderTitleContainer": {
          fontWeight: 700,
        },
      }}
    />
  );
}

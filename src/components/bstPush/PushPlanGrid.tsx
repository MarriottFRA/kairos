/**
 * The push plan, as a grid.
 *
 * One row per dept×account combo, grouped by department the same way the
 * Results page groups it — the user is looking at the same numbers, so they
 * must be arranged the same way. Two things make this grid do its job:
 *
 *   1. The month columns show the value EXACTLY as it will sit in the BST cell,
 *      already divided by 1000 for currency. Users otherwise do that conversion
 *      in their head to sanity-check a push, and get it wrong.
 *   2. Status is a first-class, colour-coded column pinned beside the account,
 *      because "what won't land" is the only question this screen really answers.
 */

import { useMemo } from "react";
import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import ErrorOutlinedIcon from "@mui/icons-material/ErrorOutlined";
import HorizontalRuleIcon from "@mui/icons-material/HorizontalRule";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import type { SvgIconComponent } from "@mui/icons-material";
import { DataGridPremium, GridColDef } from "@mui/x-data-grid-premium";

import {
  ComboStatus,
  MonthAction,
  PushComboRow,
  writesValues,
} from "../../shared/bstPush/ipc";
import { MONTH_SHORT } from "../../shared/calendar";
import { MONTH_ACTION_META } from "./MonthPlanBar";

/** Label, colour and explanation for each status — the grid's legend, in one place. */
export const STATUS_META: Record<
  ComboStatus,
  {
    label: string;
    color: "success" | "warning" | "error" | "default";
    hint: string;
    icon: SvgIconComponent;
  }
> = {
  write: {
    label: "Will write",
    color: "success",
    hint: "Matched a row on the department sheet.",
    icon: CheckCircleOutlinedIcon,
  },
  duplicate_row: {
    label: "Duplicate row",
    color: "warning",
    hint:
      "This combo appears on more than one row of the sheet. The first row " +
      "gets the value, matching the old macro.",
    icon: WarningAmberIcon,
  },
  no_row: {
    label: "No account row",
    color: "error",
    hint:
      "The department sheet exists but has no row for this account. Add the " +
      "account in the BST, then push again.",
    icon: ErrorOutlinedIcon,
  },
  no_sheet: {
    label: "No department sheet",
    color: "error",
    hint:
      "This BST has no sheet for the department. Enable it in the BST's " +
      '"Dept Settings", then push again.',
    icon: ErrorOutlinedIcon,
  },
  no_data: {
    label: "No data",
    color: "default",
    hint:
      "Not in this BST, but Kairos has nothing to push here either — " +
      "no need to add it.",
    icon: HorizontalRuleIcon,
  },
  zeroed: {
    label: "Cleared only",
    color: "default",
    hint: "Cleared by the zero pass, with nothing from Kairos to put back.",
    icon: WarningAmberIcon,
  },
};

function StatusCell({ status }: { status: ComboStatus | undefined }) {
  const meta = status ? STATUS_META[status] : undefined;
  // Row grouping generates a department row per sheet. Those rows are real
  // objects — so a `params.row ?` guard does not catch them — but they carry no
  // combo and no status, and must render an empty cell rather than a chip.
  if (!meta) return null;

  const Icon = meta.icon;
  return (
    <Tooltip title={meta.hint}>
      <Chip
        size="small"
        // Only the states that need action get a filled chip; everything else
        // stays an outline so the red ones carry the visual weight.
        variant={meta.color === "error" || meta.color === "warning" ? "filled" : "outlined"}
        color={meta.color}
        icon={<Icon sx={{ fontSize: 15 }} />}
        label={meta.label}
        sx={{ height: 22, fontSize: "0.6875rem", fontWeight: 600 }}
      />
    </Tooltip>
  );
}

export interface PushPlanGridProps {
  rows: PushComboRow[];
  /**
   * The month plan, so a column the user chose not to write reads as inert
   * rather than as a column of zeroes. Without this the grid and the month
   * strip would disagree about what a push does.
   */
  monthActions?: MonthAction[];
  loading?: boolean;
  /** Rendered when `rows` is empty — the caller knows why it is empty. */
  emptyMessage?: string;
}

export default function PushPlanGrid({
  rows,
  monthActions,
  loading = false,
  emptyMessage,
}: PushPlanGridProps) {
  const columns = useMemo<GridColDef<PushComboRow>[]>(() => {
    const monthColumn = (index: number): GridColDef<PushComboRow> => {
      const action = monthActions?.[index];
      const inert = action !== undefined && !writesValues(action);
      return {
        field: `m${index + 1}`,
        headerName: MONTH_SHORT[index],
        description: action
          ? `${MONTH_SHORT[index]} — ${MONTH_ACTION_META[action].label}. ${MONTH_ACTION_META[action].hint}`
          : undefined,
        width: 88,
        type: "number",
        sortable: false,
        cellClassName: inert ? "bst-cell--num bst-cell--inert" : "bst-cell--num",
        headerClassName: inert ? "bst-head--inert" : undefined,
        // Grouping adds auto-generated department rows that carry no months —
        // their value comes from the aggregation model, not this getter.
        valueGetter: (_value, row) => row?.months?.[index] ?? null,
        valueFormatter: (value: number | null | undefined) => {
          // A skipped or cleared column writes nothing, so showing the value
          // Kairos happens to hold would be a lie about what lands in the file.
          if (inert) return action === "clear" ? "0" : "";
          const num = Number(value);
          if (!Number.isFinite(num)) return "";
          if (num === 0) return "–";
          return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
        },
      };
    };

    return [
      {
        field: "sheet",
        headerName: "Sheet",
        width: 84,
        cellClassName: "bst-cell--num",
      },
      {
        field: "departmentName",
        headerName: "Department",
        width: 190,
        valueGetter: (_value, row) => row?.departmentName || row?.dept || "",
      },
      {
        field: "combo",
        headerName: "Combo",
        width: 128,
        cellClassName: "bst-cell--num",
        renderCell: (params) =>
          params.row ? (
            <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
              <span>{params.row.combo}</span>
              {params.row.isStats && (
                <Tooltip title="Statistical account — written in units, not thousands">
                  <Chip
                    label="units"
                    size="small"
                    variant="outlined"
                    sx={{ height: 17, fontSize: "0.5625rem" }}
                  />
                </Tooltip>
              )}
            </Stack>
          ) : null,
      },
      {
        field: "accountName",
        headerName: "Account",
        flex: 1,
        minWidth: 180,
      },
      {
        field: "status",
        headerName: "Status",
        width: 168,
        renderCell: (params) =>
          params.row ? <StatusCell status={params.row.status} /> : null,
      },
      ...MONTH_SHORT.map((_name, index) => monthColumn(index)),
      {
        field: "total",
        headerName: "Year",
        width: 118,
        type: "number",
        cellClassName: "bst-cell--num bst-cell--total",
        valueFormatter: (value: number | null | undefined) => {
          const num = Number(value);
          if (!Number.isFinite(num)) return "";
          return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
        },
      },
    ];
  }, [monthActions]);

  if (rows.length === 0) {
    return (
      <Box
        sx={{
          height: "100%",
          minHeight: 220,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: (theme) => `1px dashed ${theme.palette.divider}`,
          borderRadius: 2,
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {emptyMessage ?? "Nothing to show."}
        </Typography>
      </Box>
    );
  }

  return (
    <DataGridPremium
      rows={rows}
      columns={columns}
      loading={loading}
      rowGroupingModel={["sheet"]}
      defaultGroupingExpansionDepth={-1}
      initialState={{
        aggregation: {
          model: Object.fromEntries([
            ...MONTH_SHORT.map((_name, index) => [`m${index + 1}`, "sum"]),
            ["total", "sum"],
          ]),
        },
        pinnedColumns: { left: ["__row_group_by_columns_group__"], right: ["total"] },
      }}
      getRowClassName={(params) =>
        params.row?.status === "no_row" || params.row?.status === "no_sheet"
          ? "bst-row--problem"
          : params.row?.status === "no_data"
            ? "bst-row--muted"
            : ""
      }
      rowHeight={32}
      columnHeaderHeight={40}
      hideFooter
      sx={{
        borderRadius: 2,
        "& .bst-cell--num": {
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.8125rem",
        },
        "& .bst-cell--total": { fontWeight: 600 },
        "& .bst-cell--inert": { color: "text.disabled" },
        "& .bst-head--inert .MuiDataGrid-columnHeaderTitle": {
          color: "text.disabled",
          fontWeight: 400,
        },
        "& .bst-row--problem": {
          backgroundColor: (theme) => theme.palette.error.main + "0f",
        },
        // A row that is not in the BST and has nothing to push should not
        // call attention to itself — every cell fades, chip included.
        "& .bst-row--muted": { color: "text.disabled", opacity: 0.75 },
      }}
    />
  );
}

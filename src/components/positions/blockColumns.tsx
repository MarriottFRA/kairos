/**
 * Block columns — generates each block's column band for the positions grid.
 * -----------------------------------------------------------
 * A block contributes [input cell(s), Total] under its own tinted group band
 * with an edit cog (the blocks counterpart of columnFactory's catalog-driven
 * sections). Inputs live on the flat row under `blk:<defId>:<slot>` keys
 * (src/shared/positions/blockRows.ts); the Total column is read-only and fed
 * by the live simulation's per-row results — the same engine the budget runs.
 */

import { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import {
  GridColDef,
  GridColumnGroupingModel,
  GridRenderEditCellParams,
  useGridApiContext,
} from "@mui/x-data-grid-premium";
import { BlockDto } from "../../shared/blocks/ipc";
import { AccountOption } from "../../shared/mappingTables/types";
import {
  blockAccountKey,
  blockFieldKey,
  blockInputSlots,
  BlockSlot,
  blockStatsAccountKey,
} from "../../shared/positions/blockRows";
import { BlockResultsById } from "../../shared/positions/liveSim";
import { PositionRow } from "../../shared/positions/rowModel";
import AccountAutocomplete from "../common/AccountAutocomplete";

export interface BlockColumnsContext {
  numberFormat: Intl.NumberFormat;
  /** Whole account cache for the per-row account cells of unlocked blocks;
   *  the user may pick ANY account here (no prefix filter). */
  accounts: AccountOption[];
  /** Per-row live-sim results; null while structure/calendar still load. */
  blockResults: BlockResultsById | null;
}

/**
 * Type-ahead editor for an unlocked block's per-row account cell — same
 * commit-on-pick pattern as columnFactory's AccountEditCell, but unfiltered
 * (a block row may post anywhere).
 */
function BlockAccountEditCell(
  props: GridRenderEditCellParams<PositionRow> & { options: AccountOption[] }
) {
  const { id, field, value, options, hasFocus } = props;
  const apiRef = useGridApiContext();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasFocus) inputRef.current?.focus();
  }, [hasFocus]);

  return (
    <AccountAutocomplete
      options={options}
      value={typeof value === "string" ? value : ""}
      inputRef={inputRef}
      autoFocus
      openOnFocus
      variant="standard"
      sx={{ px: 1 }}
      onChange={(code) => {
        void Promise.resolve(
          apiRef.current.setEditCellValue({ id, field, value: code })
        ).then(() => apiRef.current.stopCellEditMode({ id, field }));
      }}
    />
  );
}

const MONTH_SHORT = Array.from({ length: 12 }, (_, m) =>
  new Date(2000, m, 1).toLocaleString("en", { month: "short" })
);

/** Header text per input slot: the big line + the muted unit tag. */
function slotPresentation(block: BlockDto, slot: BlockSlot): { short: string; unit: string } {
  if (slot === "rate") {
    return { short: "Multiplier", unit: "× base" };
  }
  if (slot === "amount") return { short: "Amount", unit: "per month" };
  if (slot === "qty") return { short: "Count", unit: "per year" };
  if (slot === "unitRate") return { short: "Rate", unit: "per unit" };
  const month = Number(slot.slice(1));
  return { short: MONTH_SHORT[month - 1] ?? slot, unit: "amount" };
}

/** Same two-line header treatment as the catalog columns (columnFactory). */
function renderBlockHeader(short: string, unit: string) {
  return () => (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-end",
        lineHeight: 1.15,
        overflow: "hidden",
        width: "100%",
      }}
    >
      <Box
        component="span"
        sx={{
          fontWeight: 600,
          fontSize: "0.8125rem",
          whiteSpace: "normal",
          textAlign: "right",
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflow: "hidden",
        }}
      >
        {short}
      </Box>
      <Box
        component="span"
        sx={{
          fontSize: "0.625rem",
          fontWeight: 500,
          letterSpacing: "0.04em",
          color: "text.disabled",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "100%",
        }}
      >
        {unit}
      </Box>
    </Box>
  );
}

export function blockTotalKey(block: BlockDto): string {
  return `blk:${block.costDefId}:total`;
}

export function buildBlockColumns(
  blocks: BlockDto[],
  ctx: BlockColumnsContext
): GridColDef<PositionRow>[] {
  const columns: GridColDef<PositionRow>[] = [];

  for (const block of blocks) {
    const slots = blockInputSlots(block);
    slots.forEach((slot, index) => {
      const { short, unit } = slotPresentation(block, slot);
      const key = blockFieldKey(block.costDefId, slot);
      const headerClasses = ["pos-col--blocks"];
      if (index === 0) headerClasses.push("pos-col--sectionStart");
      columns.push({
        field: key,
        headerName: `${block.label} — ${short}`,
        description: `${block.label}: ${short.toLowerCase()} (${unit})`,
        width: slot.startsWith("m") ? 84 : 104,
        type: "number",
        align: "right",
        headerAlign: "right",
        editable: true,
        sortable: true,
        headerClassName: headerClasses.join(" "),
        cellClassName:
          index === 0 ? "pos-cell--num pos-cell--sectionStart" : "pos-cell--num",
        renderHeader: renderBlockHeader(short, unit),
        valueFormatter: (value: number | null | undefined) => {
          if (value === null || value === undefined) return "";
          const num = Number(value);
          return Number.isFinite(num) ? ctx.numberFormat.format(num) : "";
        },
      });
    });

    // Per-row account cells (unlocked blocks): pick any account, blank falls
    // back to the block's configured default (shown muted).
    const accountColumn = (
      key: string,
      short: string,
      defaultAccount: string
    ): GridColDef<PositionRow> => ({
      field: key,
      headerName: `${block.label} — ${short}`,
      description: `${block.label}: this row's ${short.toLowerCase()}. Blank uses the block's default${
        defaultAccount ? ` (${defaultAccount})` : ""
      }.`,
      width: 132,
      editable: true,
      sortable: true,
      headerClassName: "pos-col--blocks",
      renderHeader: renderBlockHeader(short, defaultAccount ? `default ${defaultAccount}` : "default: none"),
      renderEditCell: (params) => (
        <BlockAccountEditCell {...params} options={ctx.accounts} />
      ),
      renderCell: (params) => {
        const override = typeof params.value === "string" ? params.value : "";
        if (override) return <span>{override}</span>;
        return (
          <Box component="span" sx={{ color: "text.disabled" }}>
            {defaultAccount || "—"}
          </Box>
        );
      },
    });
    if (!block.accountLocked) {
      columns.push(accountColumn(blockAccountKey(block.costDefId), "Account", block.accountCode));
    }
    if (block.blockType === "COUNT_RATE" && !block.statsAccountLocked) {
      columns.push(
        accountColumn(
          blockStatsAccountKey(block.costDefId),
          "Stats account",
          block.statsAccountCode
        )
      );
    }

    // The Total: the engine's own figure for this row's line, full year. Blank
    // (not zero) while the position is inactive or the simulation is loading.
    columns.push({
      field: blockTotalKey(block),
      headerName: `${block.label} — Total`,
      description: `${block.label}: full-year total from the simulation${
        block.accountCode ? ` (account ${block.accountCode})` : " (calculation only)"
      }`,
      width: 122,
      type: "number",
      align: "right",
      headerAlign: "right",
      editable: false,
      sortable: true,
      headerClassName: "pos-col--blocks",
      cellClassName: "pos-cell--num pos-cell--derived",
      renderHeader: renderBlockHeader(
        "Total",
        block.accountCode ? `→ ${block.accountCode}` : "calc only"
      ),
      valueGetter: (_value: unknown, row: PositionRow) => {
        if (!row) return null;
        const result = ctx.blockResults?.get(row.id)?.get(block.costDefId);
        return result ? result.total : null;
      },
      valueFormatter: (value: number | null | undefined) => {
        if (value === null || value === undefined) return "";
        const num = Number(value);
        return Number.isFinite(num)
          ? num.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : "";
      },
    });
  }

  return columns;
}

/** The tinted band + edit cog over each block's columns. */
export function buildBlockGroupingEntries(
  blocks: BlockDto[],
  onEditBlock: (block: BlockDto) => void
): GridColumnGroupingModel {
  const swallow = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return blocks.map((block) => ({
    groupId: `blk-band:${block.id}`,
    headerName: block.label,
    headerClassName: "pos-band--blocks pos-band",
    renderHeaderGroup: () => (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 0.75,
          width: "100%",
        }}
      >
        <Box
          component="span"
          sx={{
            minWidth: 0,
            fontWeight: 700,
            fontSize: "0.6875rem",
            letterSpacing: "0.09em",
            textTransform: "uppercase",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {block.label}
        </Box>
        <Tooltip title={`Edit "${block.label}"`}>
          <IconButton
            size="small"
            aria-label={`Edit block ${block.label}`}
            onMouseDown={swallow}
            onClick={(event) => {
              event.stopPropagation();
              onEditBlock(block);
            }}
            sx={{
              flexShrink: 0,
              width: 22,
              height: 22,
              color: "text.secondary",
              border: (theme) => `1px solid ${theme.palette.divider}`,
              borderRadius: 1,
              bgcolor: "background.paper",
            }}
          >
            <SettingsOutlinedIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
    ),
    children: [
      ...blockInputSlots(block).map((slot) => ({
        field: blockFieldKey(block.costDefId, slot),
      })),
      ...(!block.accountLocked ? [{ field: blockAccountKey(block.costDefId) }] : []),
      ...(block.blockType === "COUNT_RATE" && !block.statsAccountLocked
        ? [{ field: blockStatsAccountKey(block.costDefId) }]
        : []),
      { field: blockTotalKey(block) },
    ],
  }));
}

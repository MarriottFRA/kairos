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
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import {
  blockAccountKey,
  blockDepartmentKey,
  blockDepartmentRowKeys,
  blockFieldKey,
  blockInputSlots,
  blockRuleRateKey,
  blockTotalKey,
  POOL_WEIGHT_SLOT,
  BlockSlot,
  blockStatsAccountKey,
} from "../../shared/positions/blockRows";
import {
  clampPoolWeight,
  isPoolEligible,
  poolShareWeight,
  PoolMembershipSpec,
} from "../../shared/positions/poolSpread";
import type { DerivedRowValuesRef } from "../../shared/positions/derivedRowValues";
import { PositionRow } from "../../shared/positions/rowModel";
import AccountAutocomplete from "../common/AccountAutocomplete";
import DepartmentAutocomplete from "../common/DepartmentAutocomplete";
import { makeNumberPasteParser } from "../../shared/positions/pasteParsers";

export interface BlockColumnsContext {
  numberFormat: Intl.NumberFormat;
  /** Whole account cache for the per-row account cells of unlocked blocks;
   *  the user may pick ANY account here (no prefix filter). */
  accounts: AccountOption[];
  /** Whole department cache for the per-row department cells of MULTIPLIER
   *  blocks in PER_ROW mode. Deliberately unrestricted by delegation write
   *  scope: this only moves where a cost REPORTS, and the server resolves a
   *  component value's own permissions from its parent position anyway. */
  departments: DepartmentOption[];
  /**
   * The displayed-but-not-stored per-row values, including this block's live-sim
   * totals. A ref so a re-simulation does NOT rebuild the columns — read
   * `ctx.derived.current` inside the cell callback, never at build time. See
   * shared/positions/derivedRowValues.
   */
  derived: DerivedRowValuesRef;
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

/**
 * Type-ahead editor for a PER_ROW block's department cell. Same commit-on-pick
 * pattern as BlockAccountEditCell, over department CODES.
 */
function BlockDepartmentEditCell(
  props: GridRenderEditCellParams<PositionRow> & { options: DepartmentOption[] }
) {
  const { id, field, value, options, hasFocus } = props;
  const apiRef = useGridApiContext();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasFocus) inputRef.current?.focus();
  }, [hasFocus]);

  return (
    <DepartmentAutocomplete
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

// ── Pooled-block share weights ──────────────────────────────────────────────

/** The block's membership + weighting rules, in the shape poolSpread reads. */
export function poolMembership(block: BlockDto): PoolMembershipSpec {
  return {
    eligibilityMode: block.poolEligibilityMode ?? "MANUAL",
    departments: block.poolDepartments ?? [],
    jobTypes: block.poolJobTypes ?? [],
    jobTypeWeights: block.poolJobTypeWeights ?? {},
  };
}

/** The two row fields the rules look at, read off the flat grid row. */
function poolRowSubject(row: PositionRow) {
  return {
    departmentCode: String(row.departmentCode ?? ""),
    jobTypeCode: String(row.jobTypeCode ?? ""),
  };
}

/** "1", "1.5", "1.25" — never "1.00", so a column of plain shares stays quiet. */
const WEIGHT_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 3,
});

/** Money-ish totals. Module scope for the same reason WEIGHT_FORMAT is: a
 *  `toLocaleString(undefined, {...})` builds a fresh Intl.NumberFormat on every
 *  call, and a valueFormatter runs per visible cell per render. */
const TOTAL_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

/**
 * Weight cells the user must not type into: under a RULE the block config owns
 * who is in the pool, so a weight against somebody it excludes would sit there
 * looking like it did something.
 *
 * Built once per block set and handed to `cellEditable` through the editability
 * context, so the grid and the position form lock the same cell — this is the
 * blocks counterpart of the basic-salary and cluster-multiplier gates already
 * in columnFactory.
 */
export function poolWeightGate(
  blocks: BlockDto[]
): ((row: PositionRow | undefined, field: string) => boolean) | undefined {
  const ruled = blocks.filter(
    (block) =>
      block.blockType === "POOL_SPREAD" && block.poolEligibilityMode === "RULE"
  );
  // Nothing to gate: hand back undefined so cellEditable's hot path skips the
  // call entirely rather than running a Map miss for every rendered cell.
  if (ruled.length === 0) return undefined;

  const specByField = new Map<string, PoolMembershipSpec>(
    ruled.map((block) => [
      blockFieldKey(block.costDefId, POOL_WEIGHT_SLOT),
      poolMembership(block),
    ])
  );
  return (row, field) => {
    const spec = specByField.get(field);
    if (!spec || !row) return true;
    return isPoolEligible(spec, poolRowSubject(row), false);
  };
}

/** Header text per input slot: the big line + the muted unit tag. Exported so
 *  the position form labels the same cell the same way (it is the blocks
 *  counterpart of headerMeta.headerPresentation). */
export function slotPresentation(
  block: BlockDto,
  slot: BlockSlot
): { short: string; unit: string } {
  if (slot === "rate") {
    return { short: "Multiplier", unit: "× base" };
  }
  if (slot === "amount") {
    // A fixed block's amount changes UNIT with its spread: per month for the
    // default, per occurrence for weekdays, a yearly total for the rest — the
    // header is where the user learns which number the cell wants.
    const spread = block.spread ?? "ACTIVE_MONTHS";
    return {
      short: "Amount",
      unit:
        spread === "ACTIVE_MONTHS"
          ? "per month"
          : spread === "WEEKDAYS"
            ? "per occurrence"
            : "per year",
    };
  }
  if (slot === "qty") {
    return {
      short: "Count",
      unit: block.spread === "WEEKDAYS" ? "per occurrence" : "per year",
    };
  }
  if (slot === "unitRate") return { short: "Rate", unit: "per unit" };
  if (slot === "openingBase") return { short: "Opening base", unit: "prior year" };
  if (slot === POOL_WEIGHT_SLOT) {
    return {
      short: "Share weight",
      // The unit has to carry what blank means, because that is the one thing
      // the two modes disagree on: out of the pool, or in on the default share.
      unit:
        block.poolEligibilityMode === "RULE"
          ? "× share · blank = default"
          : "shares · blank = out",
    };
  }
  const month = Number(slot.slice(1));
  return { short: MONTH_SHORT[month - 1] ?? slot, unit: "amount" };
}

/** Plain-English summary of a pooled block's eligibility rule, for the cell
 *  tooltip that explains who the pot goes to. */
function poolRuleSummary(block: BlockDto): string {
  const parts: string[] = [];
  const departments = block.poolDepartments ?? [];
  const jobTypes = block.poolJobTypes ?? [];
  if (departments.length > 0) parts.push(`departments ${departments.join(", ")}`);
  if (jobTypes.length > 0) parts.push(`classifications ${jobTypes.join(", ")}`);
  return parts.length > 0 ? parts.join(" and ") : "every position";
}

/** Month names for the derived-rate tooltip ("first change in June"). */
const RULE_RATE_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

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

export function buildBlockColumns(
  blocks: BlockDto[],
  ctx: BlockColumnsContext
): GridColDef<PositionRow>[] {
  const columns: GridColDef<PositionRow>[] = [];
  // Built once, not per column: the formatted cells below carry the locale's
  // thousands separators, which the grid's default numeric parser reads back
  // as NaN, so a copied amount never pastes without the inverse.
  const parsePastedNumber = makeNumberPasteParser(ctx.numberFormat);
  // Department code → name, built once per column set. The per-row department
  // cell renders the name beside the code, and a linear scan for it inside a
  // renderCell is O(departments) per visible cell per render — with a synced
  // account_maps cache running to thousands of departments (see columnFactory's
  // note on capping the picker), that is tens of thousands of string compares
  // every time the grid repaints.
  const departmentNameByCode = new Map(
    ctx.departments.map((option) => [option.code, option.name])
  );

  for (const block of blocks) {
    const slots = blockInputSlots(block);
    slots.forEach((slot, index) => {
      const { short, unit } = slotPresentation(block, slot);
      const key = blockFieldKey(block.costDefId, slot);
      const headerClasses = ["pos-col--blocks"];
      if (index === 0) headerClasses.push("pos-col--sectionStart");

      if (slot === POOL_WEIGHT_SLOT) {
        // The share weight. One typed number carries two ideas, and which ones
        // depends on the block's eligibility mode:
        //
        //   MANUAL  membership AND size of share. Blank is out of the pool.
        //   RULE    size of share only — the rule owns membership, so a row it
        //           excludes is locked (poolWeightGate) and a member left blank
        //           shows the default it will actually be spread on, muted like
        //           every other derived cell in the grid.
        const ruled = block.poolEligibilityMode === "RULE";
        const spec = poolMembership(block);
        const summary = poolRuleSummary(block);
        // Everything below is loop-invariant — it depends on the block and the
        // slot index, never on the row — so it is built once per column instead
        // of per cell per render. `cellClassName` and `renderCell` are two of
        // the hottest callbacks MUI has.
        const numClass = index === 0 ? "pos-cell--num pos-cell--sectionStart" : "pos-cell--num";
        const mutedClass = `${numClass} pos-cell--derived`;
        const notInPoolTitle = ruled
          ? `Not in this pool. The block shares its pot with ${summary}.`
          : "Not in this pool. Type how many shares this position should take — 1 is a normal share.";
        columns.push({
          field: key,
          headerName: `${block.label} — ${short}`,
          description: ruled
            ? `${block.label}: how many shares of the pot this position takes. Who is in the pool is set by the block — ${summary} — and blank takes the block's default weight for the classification.`
            : `${block.label}: how many shares of the pot this position takes. 1 is a normal share, 2 a double share; blank or 0 leaves the position out of the pool.`,
          width: 104,
          type: "number",
          align: "right",
          headerAlign: "right",
          editable: true,
          sortable: true,
          headerClassName: headerClasses.join(" "),
          // Muted whenever the number shown was not typed on this row — the
          // rule's default, or no share at all.
          cellClassName: (params) =>
            clampPoolWeight(params.value) > 0 ? numClass : mutedClass,
          renderHeader: renderBlockHeader(short, unit),
          renderCell: (params) => {
            const row = params.row as PositionRow | undefined;
            const own = clampPoolWeight(params.value);
            // What the spread will actually use — the row's own weight, the
            // classification default, or nothing because this row is not in.
            const effective = row
              ? poolShareWeight(spec, poolRowSubject(row), own)
              : own;
            if (own > 0) {
              return <span>{WEIGHT_FORMAT.format(own)}</span>;
            }
            const title =
              effective > 0
                ? `Takes ${WEIGHT_FORMAT.format(
                    effective
                  )} share${effective === 1 ? "" : "s"} of the pot — the block's default. Type a number here to give this position more or less.`
                : notInPoolTitle;
            return (
              <Tooltip title={title}>
                <Box component="span" sx={{ color: "text.disabled" }}>
                  {effective > 0 ? WEIGHT_FORMAT.format(effective) : "—"}
                </Box>
              </Tooltip>
            );
          },
        });
        return;
      }

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
        pastedValueParser: parsePastedNumber,
      });
    });

    // Rules-driven multiplier: the read-only derived rate, in the slot the
    // editable rate column vacated (blockInputSlots is empty for these). Read
    // through the derived ref like the Total, so a re-evaluation never
    // rebuilds the columns. A month-varying rate shows "21 → 30" with the
    // step month in the tooltip; a block-valued multiplier shows "× label".
    if (block.blockType === "MULTIPLIER" && block.rateRules) {
      // Labels for block-valued outcomes, resolved at build time (a rules
      // config referencing a block always has that block in this list).
      const labelByBlockId = new Map(blocks.map((entry) => [entry.id, entry.label]));
      columns.push({
        field: blockRuleRateKey(block),
        headerName: `${block.label} — Rate`,
        description: `${block.label}: the multiplier this row's rules resolved to. Edit the rules from the block's cog.`,
        width: 104,
        type: "number",
        align: "right",
        headerAlign: "right",
        editable: false,
        sortable: true,
        headerClassName: "pos-col--blocks pos-col--sectionStart",
        cellClassName: "pos-cell--num pos-cell--sectionStart pos-cell--derived",
        renderHeader: renderBlockHeader("Rate", "by rules"),
        // Sort/filter on the year-end rate — for a mid-year step that is the
        // rate the row settles on; block-valued outcomes sort as blanks.
        valueGetter: (_value: unknown, row: PositionRow) => {
          if (!row) return null;
          const result = ctx.derived.current.ruleRatesById.get(row.id)?.get(block.costDefId);
          if (!result) return null;
          if ("rateBlockId" in result) return null;
          return "rate" in result ? result.rate : result.monthlyRates[11] ?? null;
        },
        renderCell: (params) => {
          const row = params.row as PositionRow | undefined;
          const result = row
            ? ctx.derived.current.ruleRatesById.get(row.id)?.get(block.costDefId)
            : undefined;
          if (!result) return <span />;
          if ("rateBlockId" in result) {
            const name = labelByBlockId.get(result.rateBlockId) ?? "another block";
            return (
              <Tooltip title={`Multiplies the base by "${name}" — that block's monthly value.`}>
                <span>× {name}</span>
              </Tooltip>
            );
          }
          if ("rate" in result) {
            return <span>{ctx.numberFormat.format(result.rate)}</span>;
          }
          const rates = result.monthlyRates;
          const stepAt = rates.findIndex((rate) => rate !== rates[0]);
          const label = `${ctx.numberFormat.format(rates[0])} → ${ctx.numberFormat.format(
            rates[11] ?? 0
          )}`;
          return (
            <Tooltip
              title={`The rules change this row's rate during the year — first change in ${
                RULE_RATE_MONTHS[stepAt] ?? ""
              }.`}
            >
              <span>{label}</span>
            </Tooltip>
          );
        },
      });
    }

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

    // Per-row department cell (MULTIPLIER blocks set to "each row picks"):
    // blank falls back to the row's own department, shown muted.
    if (blockDepartmentRowKeys(block).length > 0) {
      columns.push({
        field: blockDepartmentKey(block.costDefId),
        headerName: `${block.label} — Department`,
        description: `${block.label}: the department this row's cost books to. Blank uses the row's own department.`,
        width: 156,
        editable: true,
        sortable: true,
        headerClassName: "pos-col--blocks",
        renderHeader: renderBlockHeader("Department", "blank = row's own"),
        renderEditCell: (params) => (
          <BlockDepartmentEditCell {...params} options={ctx.departments} />
        ),
        renderCell: (params) => {
          const override = typeof params.value === "string" ? params.value : "";
          if (!override) {
            return (
              <Box component="span" sx={{ color: "text.disabled" }}>
                —
              </Box>
            );
          }
          // Show the name so the cell reads like the grid's own Department
          // column; fall back to the bare code if the maps have not synced.
          const name = departmentNameByCode.get(override);
          return <span>{name ? `${override} — ${name}` : override}</span>;
        },
      });
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
        const result = ctx.derived.current.blockResults.get(row.id)?.get(block.costDefId);
        return result ? result.total : null;
      },
      valueFormatter: (value: number | null | undefined) => {
        if (value === null || value === undefined) return "";
        const num = Number(value);
        return Number.isFinite(num) ? TOTAL_FORMAT.format(num) : "";
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
      ...blockDepartmentRowKeys(block).map((field) => ({ field })),
      { field: blockTotalKey(block) },
    ],
  }));
}

/**
 * Column + grouping builders for the Manual Input grid.
 *
 * Identity columns (pinned left) + two setup bands + 12 month groups, each
 * wrapping a Stats and an Amount cell, + yearly totals. "Stats" are operational
 * units (hours, covers…); the row carries both a Cost Account (dollars) and a
 * Stats Account. Amount is a derived, read-only cell when the row has a rate
 * (stats * rate); otherwise it is typed directly. Departments/accounts get
 * type-ahead editors when the mapping tables are synced, else they degrade to
 * free text.
 *
 * The two setup bands are the authoring zone, and each is tinted and collapsible
 * so it reads as one block rather than a run of loose columns:
 *
 *   Drivers — KPI Driver / Per / Units / Rate: how the row DERIVES. The two
 *             rules compose (Stats = KPI ÷ Per × Units, then Amount = Stats ×
 *             Rate), which is why Rate sits here and no longer back with the
 *             accounts, where it read as an unrelated scalar.
 *   Spread  — Mode / bases / Increase %: how a base FILLS the 12 months.
 *
 * Collapsing is layout, not data: the chevron on a band header drives the grid's
 * own columnVisibilityModel (see BandHeader), the way the positions grid folds a
 * month family away, and the band's first column stays visible as the anchor
 * that carries the chevron back.
 */

import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import InsightsOutlinedIcon from "@mui/icons-material/InsightsOutlined";
import KeyboardDoubleArrowLeftIcon from "@mui/icons-material/KeyboardDoubleArrowLeft";
import KeyboardDoubleArrowRightIcon from "@mui/icons-material/KeyboardDoubleArrowRight";
import {
  gridColumnVisibilityModelSelector,
  useGridApiContext,
  useGridSelector,
} from "@mui/x-data-grid-premium";
import type {
  GridColDef,
  GridColumnGroupingModel,
} from "@mui/x-data-grid-premium";
import { MONTH_LABELS } from "../../shared/calendar";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { AccountFilter } from "../../shared/positions/fields";
import type { DepartmentPickList } from "../../shared/positions/departmentPickList";
import { MANUAL_INPUT_PERIOD_COUNT } from "../../shared/manualInput/ipc";
import {
  AccountEditCell,
  DepartmentEditCell,
  SelectEditCell,
} from "./editors";
import {
  amountForMonth,
  amountKey,
  statForMonth,
  statsKey,
  isKpiStatsDriven,
  isRateDriven,
  ManualGridRow,
  ManualStatsResolver,
  totalAmount,
  totalStats,
} from "./rowModel";

/** Which side of the monthly pair the grid shows; "both" is the default. */
export type ManualViewMode = "stats" | "amount" | "both";

export interface ManualColumnsContext {
  departments: DepartmentOption[];
  /**
   * Which departments the picker may OFFER, and which it shows greyed.
   *
   * Separate from `departments`, which stays the hotel's full reference data:
   * this answers "what may I turn a row into", and the two differ the moment a
   * department is delegated away. Omit for no restriction.
   */
  departmentPicks?: DepartmentPickList;
  accounts: AccountOption[];
  /** Which accounts the Cost Account picker offers; null = all. */
  accountFilter?: AccountFilter | null;
  /** Stats-only / Amount-only / both monthly cells. Defaults to "both". */
  viewMode?: ManualViewMode;
  /** The hotel's KPI drivers for the Stats-from-KPI picker; omit for none. */
  kpiDrivers?: Array<{ id: string; label: string }>;
  /** Cached series for a driver id — lets the month cells show derived Stats. */
  resolveKpiSeries?: ManualStatsResolver;
}

const MONTH_SELECT_OPTIONS = [
  ...MONTH_LABELS.map((label, index) => ({ value: index + 1, label })),
  { value: 13, label: "None" },
];

const SPREAD_MODE_OPTIONS = [
  { value: "", label: "—" },
  { value: "flat", label: "Flat" },
  { value: "daysInMonth", label: "Days in month" },
];

const numberFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

function formatNumber(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return numberFormat.format(n);
}

/** Parse an edited numeric cell to a finite number, or null when blank. */
function numericOrNull(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** A right-aligned numeric column base. */
function numericBase(field: string, headerName: string, width: number): GridColDef<ManualGridRow> {
  return {
    field,
    headerName,
    width,
    type: "number",
    align: "right",
    headerAlign: "right",
    sortable: false,
    valueFormatter: (value) => formatNumber(value),
  };
}

//------------------------------------------------------------------------------
//--- The two setup bands ------------------------------------------------------

/**
 * The band a column belongs to. The class goes on the header AND the cells (see
 * withBandClass), so the tint runs the full height of the block — the same trick
 * the positions grid uses for its sections, and what makes Rate read as part of
 * the derivation rather than as one more identity field.
 */
const BAND_KPI = "man-col--kpi";
const BAND_SPREAD = "man-col--spread";

const BAND_BY_FIELD: Record<string, string> = {
  statsKpiDriverId: BAND_KPI,
  statsKpiDivisor: BAND_KPI,
  statsKpiFactor: BAND_KPI,
  rate: BAND_KPI,
  spreadMode: BAND_SPREAD,
  spreadBaseStats: BAND_SPREAD,
  spreadBaseAmount: BAND_SPREAD,
  increasePct: BAND_SPREAD,
  increaseMonth: BAND_SPREAD,
};

/**
 * What each band folds away — deliberately NOT the band's first column.
 *
 * A group whose every child is hidden loses its header, and the header is where
 * the chevron lives, so folding everything would leave no way back short of the
 * column menu. The anchor column is also the one worth keeping visible: which
 * KPI drives the row, and whether a spread is configured at all.
 */
const KPI_COLLAPSIBLE_FIELDS = ["statsKpiDivisor", "statsKpiFactor", "rate"];
const SPREAD_COLLAPSIBLE_FIELDS = [
  "spreadBaseStats",
  "spreadBaseAmount",
  "increasePct",
  "increaseMonth",
];

/** Paint a column with its band, keeping whatever cell classes it computes. */
function withBandClass(
  column: GridColDef<ManualGridRow>
): GridColDef<ManualGridRow> {
  const band = BAND_BY_FIELD[column.field];
  if (!band) return column;
  const existing = column.cellClassName;
  return {
    ...column,
    headerClassName: band,
    // The derived-cell greys are per-row and the band tint is per-column, so
    // both have to survive — overwriting here would un-grey the locked Stats
    // and Amount bases the moment they were tinted.
    cellClassName:
      typeof existing === "function"
        ? (params) => [existing(params), band].filter(Boolean).join(" ")
        : [existing, band].filter(Boolean).join(" "),
  };
}

/**
 * A band's group header: the chevron that folds the band away, plus its label.
 *
 * Collapsing drives the grid's own columnVisibilityModel, and the expanded state
 * is READ BACK off that same model rather than remembered here — so unhiding one
 * column from the column menu flips the chevron too, because it describes the
 * grid rather than replaying a click. The label shortens when collapsed, since
 * the band is one column wide by then and the long form would only ellipsize.
 */
function BandHeader({
  label,
  shortLabel,
  fields,
}: {
  label: string;
  shortLabel: string;
  fields: string[];
}) {
  const apiRef = useGridApiContext();
  const visibility = useGridSelector(apiRef, gridColumnVisibilityModelSelector);
  // The model only carries explicit entries — an absent key is visible.
  const expanded = fields.some((field) => visibility[field] !== false);
  const title = expanded
    ? `Hide the ${shortLabel} setup columns`
    : `Show the ${shortLabel} setup columns`;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 0.75,
        width: "100%",
        minWidth: 0,
      }}
    >
      <Tooltip title={title}>
        <IconButton
          size="small"
          aria-label={title}
          aria-expanded={expanded}
          // The header cell owns click (group selection) and mousedown (reorder
          // drag); without both stopped, folding the band also drags it.
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            apiRef.current.setColumnVisibilityModel({
              ...visibility,
              ...Object.fromEntries(fields.map((field) => [field, !expanded])),
            });
          }}
          sx={{
            flexShrink: 0,
            width: 20,
            height: 20,
            color: "text.secondary",
            border: (theme) => `1px solid ${theme.palette.divider}`,
            borderRadius: 0.75,
            bgcolor: "background.paper",
          }}
        >
          {expanded ? (
            <KeyboardDoubleArrowLeftIcon sx={{ fontSize: 13 }} />
          ) : (
            <KeyboardDoubleArrowRightIcon sx={{ fontSize: 13 }} />
          )}
        </IconButton>
      </Tooltip>
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
        {expanded ? label : shortLabel}
      </Box>
    </Box>
  );
}

export function buildManualColumns(ctx: ManualColumnsContext): {
  columns: GridColDef<ManualGridRow>[];
  grouping: GridColumnGroupingModel;
} {
  const hasDepartments = ctx.departments.length > 0;
  const hasAccounts = ctx.accounts.length > 0;
  const viewMode = ctx.viewMode ?? "both";
  const showStats = viewMode !== "amount";
  const showAmount = viewMode !== "stats";

  const columns: GridColDef<ManualGridRow>[] = [
    {
      field: "description",
      headerName: "Description",
      width: 220,
      editable: true,
      // A derived side means locked cells — flag it at the row start so the
      // greyed cells read as intentional, not disabled: the calculator icon for
      // a rate-driven Amount (stats*rate), the insights icon for KPI-driven
      // Stats (KPI ÷ Per × Units).
      renderCell: (params) => {
        const text = String(params.value ?? "");
        const rateDriven = params.row ? isRateDriven(params.row) : false;
        const kpiDriven = params.row ? isKpiStatsDriven(params.row) : false;
        if (!rateDriven && !kpiDriven) return text;
        return (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, width: "100%" }}>
            {kpiDriven && (
              <Tooltip title="KPI-driven: monthly Stats = KPI ÷ Per × Units">
                <InsightsOutlinedIcon
                  sx={{ fontSize: 16, color: "primary.main", flexShrink: 0 }}
                />
              </Tooltip>
            )}
            {rateDriven && (
              <Tooltip title="Rate-driven: monthly Amount = Stats × Rate">
                <CalculateOutlinedIcon
                  sx={{ fontSize: 16, color: "primary.main", flexShrink: 0 }}
                />
              </Tooltip>
            )}
            <Box
              component="span"
              sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {text}
            </Box>
          </Box>
        );
      },
    },
    {
      field: "department",
      headerName: "Department",
      width: 180,
      editable: true,
      renderEditCell: hasDepartments
        ? (params) => (
            <DepartmentEditCell
              {...params}
              options={ctx.departments}
              picks={ctx.departmentPicks}
            />
          )
        : undefined,
    },
    {
      field: "departmentCode",
      headerName: "Dept Code",
      width: 100,
      // Auto-filled from the picked department when reference data exists; typeable
      // otherwise, so a code can still be entered with no mapping tables.
      editable: !hasDepartments,
      cellClassName: hasDepartments ? "pos-cell--derived" : undefined,
    },
    {
      field: "costAccount",
      headerName: "Cost Account",
      width: 150,
      editable: true,
      renderEditCell: hasAccounts
        ? (params) => (
            <AccountEditCell
              {...params}
              options={ctx.accounts}
              filter={ctx.accountFilter ?? null}
            />
          )
        : undefined,
    },
    {
      field: "statsAccount",
      headerName: "Stats Account",
      width: 150,
      editable: true,
      // Statistical account for the units side. Offers every account for now
      // (like Cost Account here); a prefix filter can narrow it later.
      renderEditCell: hasAccounts
        ? (params) => (
            <AccountEditCell {...params} options={ctx.accounts} filter={null} />
          )
        : undefined,
    },
  ];

  const grouping: GridColumnGroupingModel = [];

  // The Drivers band — a KPI driver reference plus the per-row rule ("20 hours
  // per 50,000 of revenue" => Units 20, Per 50000), then the Rate that turns
  // those units into money. Monthly Stats are DERIVED from the driver's cached
  // series and re-resolve on every render/recalc, so a fresh budget pull flows
  // through without touching the row — nothing is baked in while the driver is
  // set. Note the driver's own multiplier is already inside its cached series,
  // so Per/Units apply to the final KPI figure.
  //
  // Rate closes the chain: Stats = KPI ÷ Per × Units, then Amount = Stats ×
  // Rate. It is the same column it always was — same field, same lock
  // (isRateLockedField), same rule in shared/manualInput/rowMath.ts — moved next
  // to the driver it multiplies, because over with the accounts it read as an
  // unrelated scalar and hid the fact that the two rules compose.
  const kpiOptions = [
    { value: "", label: "—" },
    ...(ctx.kpiDrivers ?? []).map((driver) => ({
      value: driver.id,
      label: driver.label,
    })),
  ];
  const kpiLabelById = new Map(
    (ctx.kpiDrivers ?? []).map((driver) => [driver.id, driver.label])
  );
  const kpiChildren: { field: string }[] = [];
  columns.push({
    field: "statsKpiDriverId",
    headerName: "KPI Driver",
    description:
      "Derive the monthly Stats from this KPI's series. Department-mode drivers need the row's Dept Code inside their scope; explicit drivers apply everywhere.",
    width: 180,
    editable: true,
    type: "singleSelect",
    valueOptions: kpiOptions,
    renderEditCell: (params) => (
      <SelectEditCell {...params} options={kpiOptions} />
    ),
    renderCell: (params) => {
      const id = String(params.value ?? "");
      if (!id) return "—";
      const label = kpiLabelById.get(id);
      if (label !== undefined) return label;
      // The referenced driver no longer exists (deleted, or not yet synced to
      // this machine) — the row shows its last saved Stats until re-linked.
      return (
        <Tooltip title="This KPI driver no longer exists — showing the last saved Stats.">
          <Box component="span" sx={{ color: "warning.main" }}>
            (missing driver)
          </Box>
        </Tooltip>
      );
    },
  });
  kpiChildren.push({ field: "statsKpiDriverId" });

  columns.push({
    ...numericBase("statsKpiDivisor", "Per", 110),
    description: 'The "per" amount of the KPI — the 50,000 in "20 hours per 50,000".',
    editable: true,
    valueParser: numericOrNull,
  });
  kpiChildren.push({ field: "statsKpiDivisor" });

  columns.push({
    ...numericBase("statsKpiFactor", "Units", 100),
    description: 'Units produced per "Per" of KPI — the 20 in "20 hours per 50,000".',
    editable: true,
    valueParser: numericOrNull,
  });
  kpiChildren.push({ field: "statsKpiFactor" });

  columns.push({
    ...numericBase("rate", "Rate", 110),
    description:
      "Cost per unit — the monthly Amount becomes Stats × Rate, derived and locked. Leave blank to type the Amounts by hand.",
    editable: true,
    valueParser: numericOrNull,
  });
  kpiChildren.push({ field: "rate" });

  grouping.push({
    groupId: "kpi_stats",
    headerName: "Drivers",
    headerClassName: "man-band man-band--kpi",
    renderHeaderGroup: () => (
      <BandHeader
        label="Drivers — Stats = KPI ÷ Per × Units, Amount = Stats × Rate"
        shortLabel="Drivers"
        fields={KPI_COLLAPSIBLE_FIELDS}
      />
    ),
    children: kpiChildren,
  });

  // Spread setup — sits with the identity block, ahead of the 12 months, so the
  // whole authoring zone reads left-to-right (describe → dept → account → rate →
  // how to spread) and the months fill out to the right of it. Editable, so the
  // config copy-pastes / fills-down in bulk; the toolbar's Apply action reads it.
  // A separate Stats base and Amount base — you type into the side you mean; the
  // shared Mode distributes both, and the Increase % escalates only the Amount.
  const spreadChildren: { field: string }[] = [];
  columns.push({
    field: "spreadMode",
    headerName: "Mode",
    width: 140,
    editable: true,
    type: "singleSelect",
    valueOptions: SPREAD_MODE_OPTIONS,
    renderEditCell: (params) => (
      <SelectEditCell {...params} options={SPREAD_MODE_OPTIONS} />
    ),
  });
  spreadChildren.push({ field: "spreadMode" });

  columns.push({
    ...numericBase("spreadBaseStats", "Stats Base", 110),
    // Stats are derived (KPI ÷ Per × Units) for a KPI-driven row, so its Stats
    // base is meaningless there — greyed + locked by the grid's isCellEditable,
    // matching the monthly Stats cells.
    editable: true,
    valueParser: numericOrNull,
    cellClassName: (params) =>
      params.row && isKpiStatsDriven(params.row) ? "pos-cell--derived" : "",
  });
  spreadChildren.push({ field: "spreadBaseStats" });

  columns.push({
    ...numericBase("spreadBaseAmount", "Amount Base", 120),
    // Amount is derived (stats*rate) for a rate-driven row, so its Amount base is
    // meaningless there — greyed + locked by the grid's isCellEditable, matching
    // the monthly Amount cells, so the disabled state reads as intentional.
    editable: true,
    valueParser: numericOrNull,
    cellClassName: (params) =>
      params.row && isRateDriven(params.row)
        ? "pos-cell--num pos-cell--derived"
        : "pos-cell--num",
  });
  spreadChildren.push({ field: "spreadBaseAmount" });

  columns.push({
    field: "increasePct",
    headerName: "Amount Increase %",
    width: 150,
    editable: true,
    type: "number",
    align: "right",
    headerAlign: "right",
    sortable: false,
    // Stored 0..1, shown as "5%". Parser accepts "5", "5%", "0.05".
    valueFormatter: (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      return `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
    },
    valueParser: (value) => {
      const raw = String(value ?? "").replace("%", "").trim();
      const n = Number(raw);
      if (!Number.isFinite(n)) return 0;
      return n > 1 ? n / 100 : n;
    },
  });
  spreadChildren.push({ field: "increasePct" });

  columns.push({
    field: "increaseMonth",
    headerName: "Amount Increase Month",
    width: 170,
    editable: true,
    type: "singleSelect",
    valueOptions: MONTH_SELECT_OPTIONS,
    renderEditCell: (params) => (
      <SelectEditCell {...params} options={MONTH_SELECT_OPTIONS} />
    ),
  });
  spreadChildren.push({ field: "increaseMonth" });

  grouping.push({
    groupId: "spread_config",
    headerName: "Spread",
    headerClassName: "man-band man-band--spread",
    renderHeaderGroup: () => (
      <BandHeader
        label="Spread — fill 12 months from a base"
        shortLabel="Spread"
        fields={SPREAD_COLLAPSIBLE_FIELDS}
      />
    ),
    children: spreadChildren,
  });

  // The 12 monthly cells — Stats and/or Amount per the view toggle. These are the
  // output of the spread, laid out to the right of the setup zone.
  for (let m = 1; m <= MANUAL_INPUT_PERIOD_COUNT; m++) {
    const statField = statsKey(m);
    const amtField = amountKey(m);
    const children: { field: string }[] = [];

    if (showStats) {
      columns.push({
        ...numericBase(statField, "Stats", 88),
        editable: true, // functional lock is the grid's isCellEditable (KPI-driven)
        valueGetter: (_value, row) =>
          row ? statForMonth(row, m, ctx.resolveKpiSeries) : 0,
        cellClassName: (params) =>
          params.row && isKpiStatsDriven(params.row) ? "pos-cell--derived" : "",
      });
      children.push({ field: statField });
    }
    if (showAmount) {
      columns.push({
        ...numericBase(amtField, "Amt", 96),
        editable: true, // functional lock is the grid's isCellEditable (rate-driven)
        valueGetter: (_value, row) =>
          row ? amountForMonth(row, m, ctx.resolveKpiSeries) : 0,
        cellClassName: (params) =>
          params.row && isRateDriven(params.row)
            ? "pos-cell--num pos-cell--derived"
            : "pos-cell--num",
      });
      children.push({ field: amtField });
    }

    grouping.push({
      groupId: `mon_${m}`,
      headerName: MONTH_LABELS[m - 1],
      children,
    });
  }

  // Yearly totals — derived, read-only; pinned right by the grid so they stay in
  // view while the months scroll.
  if (showStats) {
    columns.push({
      ...numericBase("totalStats", "Total Stats", 120),
      valueGetter: (_value, row) =>
        row ? totalStats(row, ctx.resolveKpiSeries) : 0,
      cellClassName: "pos-cell--num pos-cell--derived",
    });
  }
  if (showAmount) {
    columns.push({
      ...numericBase("totalAmount", "Total Amount", 130),
      valueGetter: (_value, row) =>
        row ? totalAmount(row, ctx.resolveKpiSeries) : 0,
      cellClassName: "pos-cell--num pos-cell--derived",
    });
  }

  // The band tints are applied here rather than at each push: one list of which
  // column belongs to which band, instead of the same class threaded through
  // nine definitions that already carry cell classes of their own.
  return { columns: columns.map(withBandClass), grouping };
}

/**
 * Whether a field is locked while the row is rate-driven: the 12 derived monthly
 * Amount cells (stats*rate) and the Amount base that feeds them. The grid's
 * isCellEditable closes typing AND paste on these in one place.
 */
export function isRateLockedField(field: string): boolean {
  return field === "spreadBaseAmount" || /^amt_\d+$/.test(field);
}

/**
 * Whether a field is locked while the row is KPI-driven: the 12 derived monthly
 * Stats cells (KPI ÷ Per × Units) and the Stats base that would overwrite their
 * baked snapshot. Enforced the same way, in the grid's isCellEditable.
 */
export function isKpiLockedField(field: string): boolean {
  return field === "spreadBaseStats" || /^stat_\d+$/.test(field);
}

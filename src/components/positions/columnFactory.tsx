/**
 * Column factory — generates DataGridPremium columns from the field catalog.
 * -----------------------------------------------------------
 * Nothing about the grid's column set is hardcoded: the catalog rows (system
 * seed + user fields) map 1:1 onto GridColDefs here, and the section grouping
 * model is derived the same way, so future "blocks" (pension, indemnity, …)
 * appear as new column groups with zero UI changes.
 *
 * PII masking happens at this layer: when `masked` is true every maskable
 * column's valueFormatter returns dots — which also covers clipboard copy and
 * CSV export, since both read the formatted value. Edit-locking of masked
 * cells is the grid's isCellEditable (see PositionsGrid).
 */

import { useEffect, useRef } from "react";
import Autocomplete, { createFilterOptions } from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import AddIcon from "@mui/icons-material/Add";
import TuneIcon from "@mui/icons-material/Tune";
import {
  GridColDef,
  GridColumnGroupingModel,
  GridRenderEditCellParams,
  useGridApiContext,
} from "@mui/x-data-grid-premium";
import {
  AccountFilter,
  BASIC_SALARY_HOURLY_KEY,
  BASIC_SALARY_MONTHLY_KEY,
  DropdownSource,
  FieldCatalog,
  FieldDef,
  fieldLabel,
  HOTEL_CLUSTER_KEY,
  HOTEL_CLUSTER_MULT_KEY,
  SectionId,
} from "../../shared/positions/fields";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import {
  clusterMapById,
  ResolvedClusterWeight,
  resolveHotelClusterWeight,
} from "../../shared/hotelClusters/resolve";
import { COMPUTES, PositionRow } from "../../shared/positions/rowModel";
import AccountAutocomplete from "../common/AccountAutocomplete";
import { headerPresentation } from "./headerMeta";

export const MASK_TEXT = "••••••";

export interface ColumnFactoryContext {
  /** PII mask state — when true, maskable columns render/copy/export dots. */
  masked: boolean;
  /** Locale-aware thousands separators for numeric cells. */
  numberFormat: Intl.NumberFormat;
  /** Department options for the `departments` dropdown. Empty when the mapping
   *  tables have not been synced — the field then stays free text. */
  departments: DepartmentOption[];
  /** Account options (the whole account_maps cache) for the `accounts`
   *  dropdowns. Each account field narrows this to its own subset (A9…, A5…).
   *  Empty when the mapping tables have not been synced — those fields then stay
   *  free text. */
  accounts: AccountOption[];
  /** Simulated vacation cost per row id, from the engine (reference.ts). Feeds
   *  the read-only Vacation Cost column; empty while the calendar is loading. */
  vacationCostById: ReadonlyMap<string, number>;
  /** Calendar-derived Manhours Worked per row id (net productive days −
   *  vacation × daily hours). Shown when the cell carries no manual override;
   *  empty while the calendar is loading. */
  manhoursWorkedById: ReadonlyMap<string, number>;
  /** Hotel-cluster definitions for the Cluster picker + Multiplier column.
   *  Empty until loaded — the Cluster field then degrades to read-only text,
   *  like an unsynced departments picker. */
  hotelClusters: HotelClusterDto[];
  /** The selected hotel — whose weight inside an assigned cluster is the
   *  row's multiplier. */
  currentOu: string | null;
}

const MONTH_SELECT_OPTIONS = [
  ...Array.from({ length: 12 }, (_, index) => ({
    value: index + 1,
    label: new Date(2000, index, 1).toLocaleString("en", { month: "short" }),
  })),
  { value: 13, label: "None" },
];

// Cap how many options the popup renders: over a few thousand departments an
// unbounded list janks the grid. The user narrows with a keystroke or two, so
// 50 matches is always enough to see the one they mean.
const filterDepartments = createFilterOptions<DepartmentOption>({
  limit: 50,
  stringify: (option) => `${option.code} ${option.name}`,
});

/**
 * Type-ahead editor for the Department (name) cell. Shows department names —
 * which already carry the code — and filters on either. Picking stores the name
 * and commits the edit straight away (setEditCellValue is async, so the commit
 * is chained after it resolves); the sibling code column then auto-fills in the
 * page's row-update path. A stored name no longer in the synced reference data
 * is injected as its own option so it stays visible and re-picking never blanks
 * the cell.
 */
function DepartmentEditCell(
  props: GridRenderEditCellParams<PositionRow> & { options: DepartmentOption[] }
) {
  const { id, field, value, options, hasFocus } = props;
  const apiRef = useGridApiContext();
  const inputRef = useRef<HTMLInputElement>(null);

  const name = typeof value === "string" ? value : "";
  const known = name ? options.find((option) => option.name === name) : null;
  // Legacy/unsynced name: keep it selectable rather than dropping it silently.
  const orphan = name && !known ? { code: "", name } : null;
  const current = known ?? orphan;
  const selectable = orphan ? [orphan, ...options] : options;

  useEffect(() => {
    if (hasFocus) inputRef.current?.focus();
  }, [hasFocus]);

  return (
    <Autocomplete<DepartmentOption>
      options={selectable}
      value={current}
      openOnFocus
      autoHighlight
      fullWidth
      filterOptions={filterDepartments}
      getOptionLabel={(option) => option.name}
      isOptionEqualToValue={(option, picked) => option.name === picked.name}
      renderOption={(optionProps, option) => (
        <Box component="li" {...optionProps} key={option.code || option.name}>
          {option.name}
        </Box>
      )}
      onChange={(_event, picked) => {
        // Commit immediately: without stopCellEditMode the pick sets the edit
        // value but the cell stays open, so processRowUpdate (and the code
        // auto-fill) never runs and the selection looks like it did nothing.
        // setEditCellValue may return void or a Promise, so normalize first.
        void Promise.resolve(
          apiRef.current.setEditCellValue({ id, field, value: picked?.name ?? "" })
        ).then(() => apiRef.current.stopCellEditMode({ id, field }));
      }}
      slotProps={{ paper: { sx: { minWidth: 360 } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          variant="standard"
          placeholder="Search department…"
          sx={{ px: 1 }}
        />
      )}
      sx={{ width: "100%" }}
    />
  );
}

/**
 * Type-ahead editor for an Account cell. Searches accounts by description (the
 * "detail level max") or code but commits the base_account CODE — the cell then
 * reads as its account number. The offered set is narrowed to the field's subset
 * (A9…, A5…) by the dropdown source's filter. Picking commits straight away
 * (setEditCellValue is async, so the commit is chained after it resolves) — the
 * same trap DepartmentEditCell dodges. A stored code no longer in the synced
 * data (or outside the filter) stays visible via AccountAutocomplete's orphan
 * handling, so re-picking never blanks the cell.
 */
function AccountEditCell(
  props: GridRenderEditCellParams<PositionRow> & {
    options: AccountOption[];
    filter?: AccountFilter | null;
  }
) {
  const { id, field, value, options, filter, hasFocus } = props;
  const apiRef = useGridApiContext();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasFocus) inputRef.current?.focus();
  }, [hasFocus]);

  return (
    <AccountAutocomplete
      options={options}
      filter={filter}
      value={typeof value === "string" ? value : ""}
      inputRef={inputRef}
      autoFocus
      openOnFocus
      variant="standard"
      sx={{ px: 1 }}
      onChange={(code) => {
        // Commit immediately: without stopCellEditMode the pick sets the edit
        // value but the cell stays open, so processRowUpdate never runs.
        // setEditCellValue may return void or a Promise, so normalize first.
        void Promise.resolve(
          apiRef.current.setEditCellValue({ id, field, value: code })
        ).then(() => apiRef.current.stopCellEditMode({ id, field }));
      }}
    />
  );
}

/**
 * Commit-on-click editor for the static/month dropdowns (Classification, Pay
 * Basis, Increase Month).
 *
 * The grid's native singleSelect editor sets the edit value on a pick but leaves
 * the cell in edit mode, so processRowUpdate never runs and the choice looks
 * like it did nothing — the same trap DepartmentEditCell was built to dodge.
 * This opens on focus and, on pick, chains stopCellEditMode after
 * setEditCellValue (which may return void or a Promise), so a single click locks
 * the value straight in. Dismissing without a pick (Esc / click-away) cancels
 * the edit rather than leaving the cell stuck open.
 */
function SelectEditCell(
  props: GridRenderEditCellParams<PositionRow> & {
    options: Array<{ value: string | number; label: string }>;
  }
) {
  const { id, field, value, options, hasFocus } = props;
  const apiRef = useGridApiContext();
  const ref = useRef<HTMLDivElement>(null);
  // onChange fires before onClose on a selection; the flag lets onClose tell a
  // real pick apart from a bare dismiss so it doesn't double-stop the edit.
  const pickedRef = useRef(false);

  useEffect(() => {
    if (hasFocus) ref.current?.focus();
  }, [hasFocus]);

  return (
    <Select
      ref={ref}
      value={value ?? ""}
      defaultOpen
      fullWidth
      variant="standard"
      disableUnderline
      onChange={(event) => {
        pickedRef.current = true;
        void Promise.resolve(
          apiRef.current.setEditCellValue({ id, field, value: event.target.value })
        ).then(() => apiRef.current.stopCellEditMode({ id, field }));
      }}
      onClose={() => {
        if (pickedRef.current) return;
        apiRef.current.stopCellEditMode({ id, field, ignoreModifications: true });
      }}
      sx={{ px: 1, fontSize: "0.8125rem", width: "100%" }}
    >
      {options.map((option) => (
        <MenuItem
          key={String(option.value)}
          value={option.value}
          sx={{ fontSize: "0.8125rem" }}
        >
          {option.label}
        </MenuItem>
      ))}
    </Select>
  );
}

function widthFor(def: FieldDef): number {
  // Month columns only ever show "Jan" over a tag, so they can run narrow —
  // which is what lets a whole 12-month family sit on screen at once.
  if (def.monthIndex) return 84;
  switch (def.dataType) {
    case "BOOLEAN":
      return 84;
    case "DATE":
      return 124;
    case "NUMBER":
    case "INTEGER":
    case "PERCENT":
      return 118;
    case "ENUM":
      return 136;
    case "ACCOUNT_CODE":
      return 150;
    default:
      return 150;
  }
}

/**
 * Two-line header: the short name over a muted unit tag.
 *
 * The unit line is what turns a wall of numeric columns into something you can
 * read a row of — "Daily Hours / hrs per day" cannot be confused with "Yearly
 * Days / days per year" the way two columns both reading "CONTRACT ..." can.
 */
function renderHeaderCell(
  def: FieldDef,
  alignRight: boolean
): NonNullable<GridColDef<PositionRow>["renderHeader"]> {
  const { short, unit } = headerPresentation(def);
  return () => (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: alignRight ? "flex-end" : "flex-start",
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
          textAlign: alignRight ? "right" : "left",
          // Two lines, then ellipsis — the tooltip carries the rest.
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflow: "hidden",
        }}
      >
        {short}
      </Box>
      {unit && (
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
      )}
    </Box>
  );
}

function selectOptions(source: DropdownSource | null | undefined) {
  if (!source) return null;
  switch (source.kind) {
    case "static":
      return source.options;
    case "months":
      return MONTH_SELECT_OPTIONS;
    // Accounts, departments and hotel clusters are all handled separately in
    // buildColumn (type-ahead edit cells / the cluster singleSelect), so they
    // never reach this switch as options; with no reference data they degrade
    // to free text.
    case "accounts":
    case "departments":
    case "hotelClusters":
      return null;
  }
}

/**
 * Keys of the columns that mirror a department's code (a `departments` source's
 * `codeField`). They are auto-filled from the picked department and rendered
 * read-only — but only while department options exist. With no reference data
 * the Department field itself degrades to free text, so its code column has to
 * stay typeable or the code could never be entered at all.
 */
function autofilledCodeKeys(
  catalog: FieldCatalog,
  ctx: ColumnFactoryContext
): Set<string> {
  const keys = new Set<string>();
  if (ctx.departments.length === 0) return keys;
  for (const def of catalog.fields) {
    const source = def.dropdownSource;
    if (source?.kind === "departments" && source.codeField) {
      keys.add(source.codeField);
    }
  }
  return keys;
}

export function buildColumns(
  catalog: FieldCatalog,
  ctx: ColumnFactoryContext
): GridColDef<PositionRow>[] {
  const visible = catalog.fields.filter((def) => def.visible);
  const lockedCodeKeys = autofilledCodeKeys(catalog, ctx);
  // The first column of each section carries the divider rule (header + cells),
  // so section boundaries stay visible while you scroll horizontally.
  const seenSections = new Set<string>();
  return visible.map((def) => {
    const isSectionStart = !seenSections.has(def.section);
    seenSections.add(def.section);
    return buildColumn(def, ctx, isSectionStart, lockedCodeKeys.has(def.key));
  });
}

function buildColumn(
  def: FieldDef,
  ctx: ColumnFactoryContext,
  isSectionStart: boolean,
  /** This column mirrors a department code: auto-filled, so read-only + muted. */
  isAutofilledCode: boolean
): GridColDef<PositionRow> {
  const headerClasses = [`pos-col--${def.section}`];
  if (isSectionStart) headerClasses.push("pos-col--sectionStart");

  const column: GridColDef<PositionRow> = {
    field: def.key,
    // Long, unambiguous — CSV export, the column menu, and the column picker
    // all read headerName, where there is no group header to lean on.
    headerName: fieldLabel(def),
    description: headerPresentation(def).hint ?? undefined,
    width: widthFor(def),
    editable: def.editable,
    sortable: true,
    disableColumnMenu: false,
    headerClassName: headerClasses.join(" "),
  };

  const numeric =
    def.dataType === "NUMBER" ||
    def.dataType === "INTEGER" ||
    def.dataType === "PERCENT" ||
    (def.storage === "COMPUTED" && def.dataType !== "TEXT");

  if (numeric) {
    column.type = "number";
    column.align = "right";
    column.headerAlign = "right";
    column.cellClassName = "pos-cell--num";
  }

  switch (def.dataType) {
    case "NUMBER":
    case "INTEGER": {
      const decimals = def.validation?.decimals;
      column.valueFormatter = (value: number | null | undefined) => {
        if (value === null || value === undefined) return "";
        const num = Number(value);
        if (!Number.isFinite(num)) return "";
        return decimals !== undefined
          ? num.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: decimals,
            })
          : ctx.numberFormat.format(num);
      };
      break;
    }
    case "PERCENT": {
      // Stored 0..1, shown as e.g. "5%". The parser accepts "5", "5%", "0.05".
      column.valueFormatter = (value: number | null | undefined) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return "";
        return `${(num * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
      };
      column.valueParser = (value: unknown) => {
        const raw = String(value ?? "").replace("%", "").trim();
        const num = Number(raw);
        if (!Number.isFinite(num)) return 0;
        // Values above 1 are read as whole percentages (5 -> 5%).
        return num > 1 ? num / 100 : num;
      };
      break;
    }
    case "DATE": {
      column.type = "date";
      // Row model keeps ISO strings (JSON-flat); the grid works with Dates.
      column.valueGetter = (value: string | null | undefined) =>
        value ? new Date(value) : null;
      column.valueSetter = (value: Date | null, row: PositionRow) => ({
        ...row,
        [def.key]:
          value instanceof Date && !Number.isNaN(value.getTime())
            ? value.toISOString().slice(0, 10)
            : null,
      });
      break;
    }
    case "BOOLEAN": {
      // The grid's own boolean type renders (and edits) a checkbox, and its
      // filter operators are is-true/is-false — which is what the "show
      // inactive" toggle drives.
      column.type = "boolean";
      column.align = "center";
      column.headerAlign = "center";
      break;
    }
    case "ENUM":
    case "ACCOUNT_CODE": {
      const options = selectOptions(def.dropdownSource);
      if (options) {
        delete column.align;
        delete column.headerAlign;
        // GridColDef is a discriminated union; widen through Object.assign to
        // attach the singleSelect variant's valueOptions. singleSelect still owns
        // the *display* (value -> label) and filtering; the custom edit cell only
        // replaces the editor, so a pick commits on the first click.
        Object.assign(column, { type: "singleSelect", valueOptions: options });
        column.renderEditCell = (params) => (
          <SelectEditCell {...params} options={options} />
        );
      }
      break;
    }
    default:
      break;
  }

  // Vacation Cost is the engine's simulated figure (not a row-only formula):
  // it reads from the per-id map ctx builds by running the same spread math the
  // budget uses, so a vacation day is priced against the merit ramp and weights.
  const isEngineCost = def.computeKey === "vacationEstimate";
  if (
    def.storage === "COMPUTED" &&
    def.computeKey &&
    (isEngineCost || COMPUTES[def.computeKey])
  ) {
    const compute = COMPUTES[def.computeKey];
    column.editable = false;
    column.valueGetter = isEngineCost
      ? (_value: unknown, row: PositionRow) =>
          row ? ctx.vacationCostById.get(row.id) ?? 0 : 0
      : (_value: unknown, row: PositionRow) => (row ? compute(row) : 0);
    column.cellClassName = "pos-cell--num pos-cell--derived";
    column.valueFormatter = (value: number | null | undefined) => {
      const num = Number(value);
      return Number.isFinite(num)
        ? num.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : "";
    };

    // Weights must sum to 1 — tint the total when it drifts.
    if (def.computeKey === "vacationWeightsTotal") {
      column.cellClassName = (params) =>
        Math.abs(Number(params.value) - 1) > 0.001
          ? "pos-cell--num pos-cell--warn"
          : "pos-cell--num pos-cell--derived";
    }
  }

  // Manhours Worked: shows the row's EFFECTIVE worked hours — a positive manual
  // override, else the calendar-derived value (Σ net productive days − vacation
  // × daily hours), which is what the engine spreads. Editable so the auto value
  // can be overridden; an untouched commit echoes the derived value back, which
  // the valueSetter drops so the cell stays auto (mirrors the Cluster Multiplier
  // override). An empty cell persists as 0 → the loaders re-derive it.
  if (def.key === "yearlyHoursWorked") {
    const derivedOf = (row: PositionRow | undefined): number | null => {
      if (!row) return null;
      const value = ctx.manhoursWorkedById.get(row.id);
      return typeof value === "number" ? value : null;
    };
    const storedOverride = (row: PositionRow | undefined): number | null => {
      const num = Number(row?.yearlyHoursWorked);
      return Number.isFinite(num) && num > 0 ? num : null;
    };
    column.valueGetter = (_value: unknown, row: PositionRow) => {
      if (!row) return null;
      return storedOverride(row) ?? derivedOf(row);
    };
    column.valueSetter = (value: number | null | undefined, row: PositionRow) => {
      const num = typeof value === "number" && Number.isFinite(value) ? value : null;
      const derived = derivedOf(row);
      // Clearing, a non-positive entry, or committing the derived value back
      // unchanged all mean "stay auto" — store null (persisted as 0) so the row
      // keeps following the calendar instead of freezing as an override.
      if (num === null || num <= 0 || (derived !== null && Math.abs(num - derived) < 0.5)) {
        return { ...row, yearlyHoursWorked: null };
      }
      return { ...row, yearlyHoursWorked: num };
    };
    column.valueFormatter = (value: number | null | undefined) => {
      const num = Number(value);
      return value !== null && value !== undefined && Number.isFinite(num)
        ? num.toLocaleString(undefined, { maximumFractionDigits: 0 })
        : "";
    };
    column.cellClassName = (params) =>
      storedOverride(params.row) !== null
        ? "pos-cell--num"
        : "pos-cell--num pos-cell--derived";
    column.renderCell = (params) => {
      const overridden = storedOverride(params.row) !== null;
      const num = Number(params.value);
      const label =
        params.value !== null && params.value !== undefined && Number.isFinite(num)
          ? num.toLocaleString(undefined, { maximumFractionDigits: 0 })
          : "";
      const title = overridden
        ? "Manual override — clear the cell to fall back to the calendar-derived hours (productive days − vacation × daily hours)."
        : "Auto-calculated: (calendar productive days − vacation days) × daily hours. Type a value to override.";
      return (
        <Tooltip title={title}>
          <span>{label}</span>
        </Tooltip>
      );
    };
  }

  // Department: a type-ahead picker (by name) over the synced reference data.
  // Attached only when options exist — otherwise the field stays plain editable
  // text, and both the paste path and the code auto-fill tolerate a typed name.
  if (def.dropdownSource?.kind === "departments" && ctx.departments.length > 0) {
    const options = ctx.departments;
    column.renderEditCell = (params) => (
      <DepartmentEditCell {...params} options={options} />
    );
  }

  // Account: a type-ahead picker (search by description, store the base_account
  // code) over the synced account_maps, narrowed to the field's subset via the
  // dropdown source's filter (A9…, A5…). Attached only when accounts exist —
  // otherwise the field stays plain editable text, so an account can still be
  // typed with no reference data.
  if (def.dropdownSource?.kind === "accounts" && ctx.accounts.length > 0) {
    const options = ctx.accounts;
    const filter = def.dropdownSource.filter ?? null;
    column.renderEditCell = (params) => (
      <AccountEditCell {...params} options={options} filter={filter} />
    );
  }

  // A department-code mirror is filled in for the user from their pick — never
  // typed — so it reads read-only and muted, like the computed columns.
  if (isAutofilledCode) {
    column.editable = false;
    column.cellClassName = "pos-cell--derived";
  }

  // Hotel cluster with NO clusters loaded (none created yet, or the list
  // failed to load): unlike departments there is no legitimate free-text
  // entry — a typed raw id is never right — so the cell goes read-only
  // instead of degrading to text. Stored ids render as a placeholder rather
  // than leaking uuids into the grid.
  if (
    def.dropdownSource?.kind === "hotelClusters" &&
    ctx.hotelClusters.length === 0
  ) {
    column.editable = false;
    column.cellClassName = "pos-cell--derived";
    column.valueFormatter = (value: unknown) =>
      typeof value === "string" && value !== "" ? "(cluster unavailable)" : "";
  }

  // Hotel cluster: the cell stores a cluster ID; the picker and display both
  // speak names. A stored id whose cluster was deleted shows "(deleted
  // cluster)" and is offered as an option so re-picking None never blanks
  // silently; a cluster whose members don't include this hotel tints the cell
  // (the row resolves to multiplier ×1). Attached only when clusters loaded.
  if (
    def.dropdownSource?.kind === "hotelClusters" &&
    ctx.hotelClusters.length > 0
  ) {
    const clusterById = clusterMapById(ctx.hotelClusters);
    const resolveRow = (row: PositionRow | undefined): ResolvedClusterWeight =>
      resolveHotelClusterWeight(
        ctx.currentOu ?? "",
        typeof row?.[HOTEL_CLUSTER_KEY] === "string"
          ? (row[HOTEL_CLUSTER_KEY] as string)
          : "",
        typeof row?.[HOTEL_CLUSTER_MULT_KEY] === "number"
          ? (row[HOTEL_CLUSTER_MULT_KEY] as number)
          : null,
        clusterById
      );
    const options = [
      { value: "", label: "None" },
      ...ctx.hotelClusters.map((cluster) => ({
        value: cluster.id,
        label: cluster.name,
      })),
    ];
    delete column.align;
    delete column.headerAlign;
    // singleSelect owns filtering; display + editor are custom below.
    Object.assign(column, { type: "singleSelect", valueOptions: options });
    column.valueFormatter = (value: unknown) => {
      const id = typeof value === "string" ? value : "";
      if (!id) return "";
      return clusterById.get(id)?.name ?? "(deleted cluster)";
    };
    column.renderEditCell = (params) => {
      const stored = typeof params.value === "string" ? params.value : "";
      const orphan = stored !== "" && !clusterById.has(stored);
      return (
        <SelectEditCell
          {...params}
          options={
            orphan
              ? [{ value: stored, label: "(deleted cluster)" }, ...options]
              : options
          }
        />
      );
    };
    column.cellClassName = (params) =>
      resolveRow(params.row).warning ? "pos-cell--warn" : "";
    column.renderCell = (params) => {
      const resolved = resolveRow(params.row);
      const label = column.valueFormatter
        ? String(
            (column.valueFormatter as (value: unknown) => string)(params.value)
          )
        : "";
      if (!resolved.warning) return <span>{label}</span>;
      const title =
        resolved.warning === "DANGLING"
          ? "This cluster no longer exists — the position gets multiplier ×1. Pick None or another cluster."
          : `This hotel is not a member of “${resolved.clusterName}” — the position gets multiplier ×1. Add it on the Clusters tab.`;
      return (
        <Tooltip title={title}>
          <span>{label}</span>
        </Tooltip>
      );
    };
  }

  // Cluster Multiplier: shows the row's EFFECTIVE hotel-cluster share — the
  // stored manual override when it applies, else the assigned cluster's
  // weight for this hotel — and blank when no cluster is assigned (a column
  // of ×1.00 is noise). The cell only accepts edits for a single-hotel
  // cluster (PositionsGrid.isCellEditable is the functional gate); the muting
  // here mirrors that rule so locked cells read as derived.
  if (def.key === HOTEL_CLUSTER_MULT_KEY) {
    const clusterById = clusterMapById(ctx.hotelClusters);
    const resolveRow = (row: PositionRow | undefined): ResolvedClusterWeight =>
      resolveHotelClusterWeight(
        ctx.currentOu ?? "",
        typeof row?.[HOTEL_CLUSTER_KEY] === "string"
          ? (row[HOTEL_CLUSTER_KEY] as string)
          : "",
        typeof row?.[HOTEL_CLUSTER_MULT_KEY] === "number"
          ? (row[HOTEL_CLUSTER_MULT_KEY] as number)
          : null,
        clusterById
      );
    const overridable = (row: PositionRow | undefined): boolean => {
      const id =
        typeof row?.[HOTEL_CLUSTER_KEY] === "string"
          ? (row[HOTEL_CLUSTER_KEY] as string)
          : "";
      const cluster = id ? clusterById.get(id) : undefined;
      return (
        !!cluster &&
        cluster.members.length === 1 &&
        cluster.members[0].ou === (ctx.currentOu ?? "")
      );
    };
    column.valueGetter = (_value: unknown, row: PositionRow) => {
      if (!row) return null;
      const resolved = resolveRow(row);
      return resolved.source === "NONE" ? null : resolved.weight;
    };
    // The valueGetter shows the EFFECTIVE weight, so an untouched edit commit
    // echoes the cluster's own weight back. Persisting that echo would
    // silently freeze the row as a manual override (it would stop following
    // future weight edits) — drop it so null stays null.
    column.valueSetter = (value: number | null | undefined, row: PositionRow) => {
      const stored =
        typeof row[HOTEL_CLUSTER_MULT_KEY] === "number"
          ? (row[HOTEL_CLUSTER_MULT_KEY] as number)
          : null;
      const clusterWeight = resolveHotelClusterWeight(
        ctx.currentOu ?? "",
        typeof row[HOTEL_CLUSTER_KEY] === "string"
          ? (row[HOTEL_CLUSTER_KEY] as string)
          : "",
        null,
        clusterById
      ).weight;
      if (stored === null && value === clusterWeight) return row;
      return { ...row, [HOTEL_CLUSTER_MULT_KEY]: value ?? null };
    };
    // Invert the ×n.nn display format on paste; garbage rejects the paste
    // (undefined) instead of clearing a stored override.
    column.pastedValueParser = (value: string) => {
      const raw = String(value ?? "").replace(/×/g, "").trim().replace(",", ".");
      if (raw === "") return null; // pasting an empty cell clears the override
      const num = Number(raw);
      return Number.isFinite(num) ? num : undefined;
    };
    column.valueFormatter = (value: number | null | undefined) => {
      const num = Number(value);
      if (value === null || value === undefined || !Number.isFinite(num))
        return "";
      return `×${num.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    };
    column.cellClassName = (params) => {
      const resolved = resolveRow(params.row);
      const classes = ["pos-cell--num"];
      if (resolved.warning) classes.push("pos-cell--warn");
      else if (resolved.source !== "NONE" && !overridable(params.row))
        classes.push("pos-cell--derived");
      return classes.join(" ");
    };
    column.renderCell = (params) => {
      const resolved = resolveRow(params.row);
      if (resolved.source === "NONE") return <span />;
      const formatted = `×${resolved.weight.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
      const flexNote =
        resolved.weight !== 1
          ? " Scales hours, costs and statistics — not Count."
          : "";
      const clusterWeight = resolveHotelClusterWeight(
        ctx.currentOu ?? "",
        typeof params.row?.[HOTEL_CLUSTER_KEY] === "string"
          ? (params.row[HOTEL_CLUSTER_KEY] as string)
          : "",
        null,
        clusterById
      ).weight;
      const title = resolved.warning
        ? resolved.warning === "DANGLING"
          ? "The assigned cluster no longer exists — multiplier ×1."
          : `This hotel is not a member of “${resolved.clusterName}” — multiplier ×1.`
        : resolved.source === "OVERRIDE"
          ? `Manual override — the cluster weight is ×${clusterWeight.toFixed(2)}. Clear the cell to fall back.${flexNote}`
          : overridable(params.row)
            ? `Manual override allowed (single-hotel cluster). Clear the cell to fall back to the cluster weight.${flexNote}`
            : `From cluster “${resolved.clusterName}” — this hotel's weight. Overridable only for single-hotel clusters.${flexNote}`;
      return (
        <Tooltip title={title}>
          <span>{formatted}</span>
        </Tooltip>
      );
    };
  }

  // Basic salary: Pay Basis decides which of Monthly Basic / Hourly Rate is live.
  // Mute whichever cell the current basis locks (the functional read-only gate
  // lives in PositionsGrid.isCellEditable). Row-aware, so the muting follows the
  // Pay Basis toggle. HOURLY → Monthly Basic muted; SALARIED → Hourly Rate muted.
  if (def.key === BASIC_SALARY_MONTHLY_KEY || def.key === BASIC_SALARY_HOURLY_KEY) {
    const liveWhenHourly = def.key === BASIC_SALARY_HOURLY_KEY;
    column.cellClassName = (params) => {
      const isHourly = params.row?.payType === "HOURLY";
      const locked = liveWhenHourly ? !isHourly : isHourly;
      return locked ? "pos-cell--num pos-cell--derived" : "pos-cell--num";
    };
  }

  // Vacation weights are relative proportions the engine normalizes by their
  // total (see reference.vacationCost). Redden the weight cells while the row's
  // total drifts from 1 — a nudge to tidy up, though the math self-corrects.
  if (def.vector === "vacationMonthlyWeights") {
    column.cellClassName = (params) =>
      params.row &&
      Math.abs(COMPUTES.vacationWeightsTotal(params.row) - 1) > 0.001
        ? "pos-cell--num pos-cell--warn"
        : "pos-cell--num";
  }

  // The mask overrides rendering AND the formatted value (clipboard/export).
  if (ctx.masked && def.maskable) {
    column.valueFormatter = () => MASK_TEXT;
    column.renderCell = () => (
      <span className="pos-cell--masked">{MASK_TEXT}</span>
    );
  }

  // After the type branches, so the singleSelect case (which drops headerAlign)
  // is reflected in how the two-line header stacks.
  column.renderHeader = renderHeaderCell(def, column.headerAlign === "right");

  if (isSectionStart) {
    const base = column.cellClassName;
    column.cellClassName =
      typeof base === "function"
        ? (params) => `${base(params) ?? ""} pos-cell--sectionStart`
        : `${base ?? ""} pos-cell--sectionStart`.trim();
  }

  return column;
}

/**
 * Section banner with an inline "add a column here" affordance.
 *
 * Rendering the label ourselves means the grid's own title styling no longer
 * applies, so the band typography is restated here (it lives in PositionsGrid's
 * sx for the plain banners).
 */
function renderSectionBanner(label: string, onAdd: () => void, onManage?: () => void) {
  // The banner is a header cell; without stopPropagation the grid steals the
  // click for column-group selection and the dialog never opens.
  const swallow = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return () => (
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
        {label}
      </Box>
      <Tooltip title={`Add a hotel-wide column to ${label}`}>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          startIcon={<AddIcon sx={{ fontSize: 14 }} />}
          aria-label={`Add a column to ${label}`}
          onMouseDown={swallow}
          onClick={(event) => {
            event.stopPropagation();
            onAdd();
          }}
          sx={{
            flexShrink: 0,
            height: 22,
            px: 0.75,
            py: 0,
            minWidth: 0,
            borderRadius: 1,
            color: "text.secondary",
            borderColor: "divider",
            bgcolor: "background.paper",
            fontWeight: 700,
            fontSize: "0.625rem",
            letterSpacing: "0.06em",
            lineHeight: 1,
            whiteSpace: "nowrap",
            "& .MuiButton-startIcon": { mr: 0.375, ml: 0 },
          }}
        >
          Add column
        </Button>
      </Tooltip>
      {onManage && (
        <Tooltip title="Manage removed columns">
          <IconButton
            size="small"
            aria-label="Manage removed columns"
            onMouseDown={swallow}
            onClick={(event) => {
              event.stopPropagation();
              onManage();
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
            <TuneIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

export function buildColumnGroupingModel(
  catalog: FieldCatalog,
  /** Sections that accept user-defined columns -> the click handler. */
  onAddField?: (section: SectionId) => void,
  /** Opens the "Recently removed" surface — rendered on addable sections. */
  onManageFields?: () => void
): GridColumnGroupingModel {
  const sections = [...catalog.sections].sort((a, b) => a.order - b.order);
  return sections
    .map((section) => ({
      groupId: section.id,
      headerName: section.label,
      // Its own class, not the column one: the banner is tinted harder than the
      // columns it spans so the eye reads section-then-column, not one flat row.
      headerClassName: `pos-band--${section.id} pos-band`,
      ...(onAddField && ADDABLE_SECTIONS.has(section.id)
        ? {
            renderHeaderGroup: renderSectionBanner(
              section.label,
              () => onAddField(section.id),
              onManageFields
            ),
          }
        : {}),
      children: catalog.fields
        .filter((def) => def.section === section.id && def.visible)
        .map((def) => ({ field: def.key })),
    }))
    .filter((group) => group.children.length > 0);
}

/** Bands that can grow: adding a column here is a catalog row, nothing more. */
const ADDABLE_SECTIONS: ReadonlySet<string> = new Set(["pii"]);

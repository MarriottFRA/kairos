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

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import AddIcon from "@mui/icons-material/Add";
import TuneIcon from "@mui/icons-material/Tune";
import {
  GridColDef,
  GridColumnGroupingModel,
} from "@mui/x-data-grid-premium";
import {
  DropdownSource,
  FieldCatalog,
  FieldDef,
  fieldLabel,
  SectionId,
} from "../../shared/positions/fields";
import { COMPUTES, PositionRow } from "../../shared/positions/rowModel";
import { headerPresentation } from "./headerMeta";

export const MASK_TEXT = "••••••";

export interface ColumnFactoryContext {
  /** PII mask state — when true, maskable columns render/copy/export dots. */
  masked: boolean;
  /** Locale-aware thousands separators for numeric cells. */
  numberFormat: Intl.NumberFormat;
}

const MONTH_SELECT_OPTIONS = [
  ...Array.from({ length: 12 }, (_, index) => ({
    value: index + 1,
    label: new Date(2000, index, 1).toLocaleString("en", { month: "short" }),
  })),
  { value: 13, label: "None" },
];

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
    // Reference data for accounts/departments does not exist yet — these
    // degrade to free text until a ref-data channel lands.
    case "accounts":
    case "departments":
      return null;
  }
}

export function buildColumns(
  catalog: FieldCatalog,
  ctx: ColumnFactoryContext
): GridColDef<PositionRow>[] {
  const visible = catalog.fields.filter((def) => def.visible);
  // The first column of each section carries the divider rule (header + cells),
  // so section boundaries stay visible while you scroll horizontally.
  const seenSections = new Set<string>();
  return visible.map((def) => {
    const isSectionStart = !seenSections.has(def.section);
    seenSections.add(def.section);
    return buildColumn(def, ctx, isSectionStart);
  });
}

function buildColumn(
  def: FieldDef,
  ctx: ColumnFactoryContext,
  isSectionStart: boolean
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
        // attach the singleSelect variant's valueOptions.
        Object.assign(column, { type: "singleSelect", valueOptions: options });
      }
      break;
    }
    default:
      break;
  }

  if (def.storage === "COMPUTED" && def.computeKey && COMPUTES[def.computeKey]) {
    const compute = COMPUTES[def.computeKey];
    column.editable = false;
    column.valueGetter = (_value: unknown, row: PositionRow) =>
      row ? compute(row) : 0;
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

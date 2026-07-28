/**
 * PositionsGrid — the DataGridPremium wrapper for the Positions page.
 * -----------------------------------------------------------
 * Columns and section groups are generated from the field catalog
 * (columnFactory). The grid owns editing mechanics: cell edits and clipboard
 * pastes both flow through processRowUpdate, so sanitization and the save
 * queue get every change for free. Masked PII cells are non-editable — that
 * closes typing AND paste in one place.
 */

import { useCallback, useMemo } from "react";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Box from "@mui/material/Box";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import { alpha, SxProps, Theme } from "@mui/material/styles";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import {
  DataGridPremium,
  GridColumnMenu,
  GridColumnMenuProps,
  GRID_CHECKBOX_SELECTION_FIELD,
  GridActionsCellItem,
  GridCellParams,
  GridColDef,
  GridInitialState,
  GridRenderCellParams,
  GridRowClassNameParams,
  GridRowId,
  GridRowSelectionModel,
  MuiEvent,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import {
  COLLAPSIBLE_MONTH_FAMILIES,
  collapsibleMonthKeys,
  FieldCatalog,
  SectionId,
  vectorKey,
} from "../../shared/positions/fields";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import { clusterMapById } from "../../shared/hotelClusters/resolve";
import { BlockDto } from "../../shared/blocks/ipc";
import { BlockResultsById } from "../../shared/positions/liveSim";
import { PositionRow } from "../../shared/positions/rowModel";
import { RowSaveStatus } from "../../services/positionsWriteQueue";
import {
  buildColumnGroupingModel,
  buildColumns,
  cellEditable,
} from "./columnFactory";
import { buildBlockColumns, buildBlockGroupingEntries } from "./blockColumns";
import {
  healCollapsedFamilies,
  healNewColumn,
  healPinnedBand,
} from "./gridLayout";

export const ROW_HEIGHT = 36;
/** Two lines: the short name (up to 2 rows) over the muted unit tag. */
export const HEADER_HEIGHT = 54;
/** One short line — plus room for the "Add column" button the PII band carries. */
export const GROUP_HEADER_HEIGHT = 34;

// ── Stable prop identities ──
// MUI is explicit that "all non-primitive props should maintain a stable
// reference between renders" (mui.com/x/react-data-grid/performance). Every
// object literal handed to the grid inline is a NEW identity each render, and
// the grid reacts to identity, not content — most damagingly filterModel, whose
// controlled-model effect compares by reference and re-runs the whole filter
// pipeline (filter -> aggregate -> prune selection -> re-sort) over every row.
// At a thousand positions that turns any incidental parent render into real
// lag, so these live at module scope or behind a memo, never inline.

const NO_GROUPING: string[] = [];
const DEPT_GROUPING = ["departmentCode"];
const NO_FILTER_ITEMS: { field: string; operator: string; value: string }[] = [];
// Inactive positions are hidden rather than removed — they stay in the store,
// roll forward to next year, and come back with the toggle.
const ACTIVE_ONLY_ITEMS = [
  { field: "active", operator: "is", value: "true" },
];
const NO_QUICK_FILTER: string[] = [];

function getRowClassName(params: GridRowClassNameParams): string {
  return (params.row as PositionRow | undefined)?.active === false
    ? "pos-row--inactive"
    : "";
}

const GRID_SX: SxProps<Theme> = {
  borderRadius: 2,
  // Why the grid is permanently unselectable — this is a performance fix, not
  // a styling choice.
  //
  // With `cellSelection` on, MUI adds `root--disableUserSelection` to the grid
  // ROOT on cellMouseDown and removes it on mouseup (useGridCellSelection), to
  // stop a range drag from also dragging a text selection. That class sets
  // `user-select: none`, which is an INHERITED property — so flipping it on the
  // root makes the browser re-propagate computed style to every descendant.
  // At a full viewport that is ~1000 cells, twice per click and four times per
  // double click, and it is the whole reason clicking a cell lags while arrow
  // keys (which never touch the class) stay instant.
  //
  // Declaring it here means the root's computed value is already `none`, so
  // MUI's toggle no longer changes anything and the recalculation stops at the
  // root. Nothing is lost: a cellSelection grid never allowed drag-to-select
  // text anyway — that is precisely what MUI was toggling the class to prevent
  // — and Ctrl+C still copies through the grid's own clipboard handling.
  userSelect: "none",
  // Editors are the exception: text inside an open cell editor must still be
  // selectable, and `user-select` would otherwise inherit straight into them.
  "& input, & textarea": { userSelect: "text" },
  // renderHeader owns the column title's typography (see columnFactory);
  // this only styles the titles the grid draws itself — the group bands.
  "& .MuiDataGrid-columnHeader": { padding: "0 8px" },
  "& .pos-band .MuiDataGrid-columnHeaderTitle": {
    fontWeight: 700,
    fontSize: "0.6875rem",
    letterSpacing: "0.09em",
    textTransform: "uppercase",
  },
  "& .MuiDataGrid-columnHeaderTitleContainer": { overflow: "hidden" },
  // Section banners: the group row is centered over its columns and
  // tinted ~3x the columns below it, so the hierarchy reads at a glance.
  "& .pos-band": {
    justifyContent: "center",
    "& .MuiDataGrid-columnHeaderTitleContainer": {
      justifyContent: "center",
    },
  },
  // Section boundaries run the full height of the grid, so you always
  // know which block the cell you are editing belongs to.
  "& .pos-col--sectionStart, & .pos-cell--sectionStart": {
    borderLeft: (theme) => `2px solid ${theme.palette.divider}`,
  },
  "& .pos-cell--num": {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "0.8125rem",
  },
  "& .pos-cell--derived": { color: "text.secondary" },
  "& .pos-cell--warn": {
    bgcolor: (theme) => alpha(theme.palette.warning.main, 0.25),
    fontWeight: 700,
  },
  // Retained but not budgeted — visibly out of the plan without being
  // unreadable, since you still edit these rows before switching them on.
  "& .pos-row--inactive": {
    opacity: 0.55,
    fontStyle: "italic",
  },
  "& .pos-cell--masked": {
    fontFamily: "'IBM Plex Mono', monospace",
    color: "text.disabled",
    letterSpacing: 2,
  },
  // Section tints — one hue per section, strong on the banner and faint
  // on the columns it spans, which is what ties the two rows together.
  "& .pos-band--pii": {
    bgcolor: (theme) => alpha(theme.palette.warning.main, 0.22),
  },
  "& .pos-col--pii": {
    bgcolor: (theme) => alpha(theme.palette.warning.main, 0.07),
  },
  // Employee is PII's sibling band — same hue, half the strength, so the
  // two read as related without the identity block losing its emphasis.
  "& .pos-band--employee": {
    bgcolor: (theme) => alpha(theme.palette.warning.main, 0.11),
  },
  "& .pos-col--employee": {
    bgcolor: (theme) => alpha(theme.palette.warning.main, 0.035),
  },
  "& .pos-band--contract": {
    bgcolor: (theme) => alpha(theme.palette.secondary.main, 0.22),
  },
  "& .pos-col--contract": {
    bgcolor: (theme) => alpha(theme.palette.secondary.main, 0.06),
  },
  "& .pos-band--seasonality": {
    bgcolor: (theme) => alpha(theme.palette.info.main, 0.22),
  },
  "& .pos-col--seasonality": {
    bgcolor: (theme) => alpha(theme.palette.info.main, 0.06),
  },
  "& .pos-band--basicSalary": {
    bgcolor: (theme) => alpha(theme.palette.primary.main, 0.22),
  },
  "& .pos-col--basicSalary": {
    bgcolor: (theme) => alpha(theme.palette.primary.main, 0.06),
  },
  "& .pos-band--vacation": {
    bgcolor: (theme) => alpha(theme.palette.success.main, 0.22),
  },
  "& .pos-col--vacation": {
    bgcolor: (theme) => alpha(theme.palette.success.main, 0.06),
  },
  // Blocks get their own hue outside the section palette (violet), so
  // user-defined calculation bands read as such at a glance.
  "& .pos-band--blocks": {
    bgcolor: alpha("#7e57c2", 0.24),
  },
  "& .pos-col--blocks": {
    bgcolor: alpha("#7e57c2", 0.07),
  },
  // Editable cells read as inputs (same affordance as the calendar grid).
  "& .MuiDataGrid-cell--editable": {
    bgcolor: (theme) => alpha(theme.palette.primary.main, 0.04),
    cursor: "text",
    "&:hover": {
      bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
    },
  },
  "& .MuiDataGrid-cell:focus-within": { outlineOffset: -2 },
};

export interface PositionsGridProps {
  rows: PositionRow[];
  catalog: FieldCatalog;
  /** Options for the Department type-ahead; empty = free-text fallback. */
  departments: DepartmentOption[];
  /** Whole account_maps cache for the account type-aheads; empty = free-text
   *  fallback. Each account field narrows it to its own subset (A9…, A5…). */
  accounts: AccountOption[];
  /** Engine-simulated vacation cost per row id — feeds the Vacation Cost column. */
  vacationCostById: ReadonlyMap<string, number>;
  /** Calendar-derived Manhours Worked per row id — shown when the cell has no
   *  manual override. */
  manhoursWorkedById: ReadonlyMap<string, number>;
  /** Derived FTE per row id — feeds the read-only FTE column. */
  fteById: ReadonlyMap<string, number>;
  /** Hotel-cluster definitions for the Cluster picker + Multiplier column;
   *  empty until loaded (the Cluster field then degrades to plain text). */
  hotelClusters: HotelClusterDto[];
  /** The selected hotel — whose weight in an assigned cluster flexes a row. */
  currentOu: string | null;
  /** OU -> hotel name, for naming the hotels a cluster position is shared with. */
  hotelNames?: ReadonlyMap<string, string>;
  /** The hotel's blocks — each renders as a column band after the sections. */
  blocks: BlockDto[];
  /** Live-sim results feeding every block's Total column; null while loading. */
  blockResults: BlockResultsById | null;
  masked: boolean;
  groupByDept: boolean;
  /** False (the default) filters the grid down to budgeted positions. */
  showInactive: boolean;
  loading: boolean;
  quickFilter: string;
  statusByRow: ReadonlyMap<string, RowSaveStatus>;
  restoredState: GridInitialState | null;
  apiRef: ReturnType<typeof useGridApiRef>;
  /** Sanitize + optimistic update + enqueue; returns the row the grid keeps. */
  onRowUpdate: (newRow: PositionRow, oldRow: PositionRow) => PositionRow;
  onRowUpdateError: (error: unknown) => void;
  /** Checked row ids, for the toolbar's bulk actions. */
  onSelectionChange: (ids: string[]) => void;
  onDuplicate: (row: PositionRow) => void;
  onDelete: (row: PositionRow) => void;
  /** Opens the row as a form. `field` is the cell the user was on, so the
   *  dialog can focus it — the grid itself stays fully editable either way. */
  onEditRow: (row: PositionRow, field?: string) => void;
  onPasteStart: () => void;
  onPasteEnd: () => void;
  /** "+" on an extendable section banner (Employee PII). */
  onAddField: (section: SectionId) => void;
  /** Column-menu "Remove column" — only offered for user-added columns. */
  onRemoveField: (key: string) => void;
  /** The gear on the banner — opens the "Recently removed" surface. */
  onManageColumns: () => void;
  /** The cog on a block band — opens the block's config dialog. */
  onEditBlock: (block: BlockDto) => void;
}

/** A "Remove column" entry the default column menu renders only for user
 *  columns (`colDef.field` in the removable set). `colDef` and `hideMenu` are
 *  supplied to every column-menu item by GridColumnMenu. */
function RemoveColumnMenuItem(props: {
  colDef: GridColDef;
  hideMenu: (event: React.SyntheticEvent) => void;
  removableKeys: Set<string>;
  onRemoveField: (key: string) => void;
}) {
  const { colDef, hideMenu, removableKeys, onRemoveField } = props;
  if (!removableKeys.has(colDef.field)) return null;
  return (
    <MenuItem
      onClick={(event) => {
        onRemoveField(colDef.field);
        hideMenu(event);
      }}
    >
      <ListItemIcon>
        <DeleteOutlineIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Remove column…</ListItemText>
    </MenuItem>
  );
}

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return [yes, no];
}

function StatusCell({ status }: { status: RowSaveStatus | undefined }) {
  if (!status) return null;
  switch (status) {
    case "dirty":
      return (
        <Tooltip title="Unsaved changes">
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "warning.main" }} />
        </Tooltip>
      );
    case "saving":
      return <CircularProgress size={12} thickness={5} />;
    case "saved":
      return <CheckCircleOutlineIcon sx={{ fontSize: 16, color: "success.main" }} />;
    case "error":
      return (
        <Tooltip title="Save failed — will retry">
          <ErrorOutlineIcon sx={{ fontSize: 16, color: "error.main" }} />
        </Tooltip>
      );
  }
}

export default function PositionsGrid({
  rows,
  catalog,
  departments,
  accounts,
  vacationCostById,
  manhoursWorkedById,
  fteById,
  hotelClusters,
  currentOu,
  hotelNames,
  blocks,
  blockResults,
  masked,
  groupByDept,
  showInactive,
  loading,
  quickFilter,
  statusByRow,
  restoredState,
  apiRef,
  onRowUpdate,
  onRowUpdateError,
  onSelectionChange,
  onDuplicate,
  onDelete,
  onEditRow,
  onPasteStart,
  onPasteEnd,
  onAddField,
  onRemoveField,
  onManageColumns,
  onEditBlock,
}: PositionsGridProps) {
  const numberFormat = useMemo(() => new Intl.NumberFormat(), []);

  const controlKeys = useMemo(
    () =>
      new Set(
        catalog.fields
          .filter((def) => def.section === "control")
          .map((def) => def.key)
      ),
    [catalog]
  );

  // Only user-added columns can be removed; the menu item hides for the rest.
  const removableKeys = useMemo(
    () =>
      new Set(
        catalog.fields
          .filter((def) => def.origin === "USER")
          .map((def) => def.key)
      ),
    [catalog]
  );

  const ColumnMenu = useCallback(
    (menuProps: GridColumnMenuProps) => (
      <GridColumnMenu
        {...menuProps}
        slots={{ columnMenuUserItem: RemoveColumnMenuItem }}
        slotProps={{
          columnMenuUserItem: { displayOrder: 20, removableKeys, onRemoveField },
        }}
      />
    ),
    [removableKeys, onRemoveField]
  );

  const maskableKeys = useMemo(
    () =>
      new Set(
        catalog.fields.filter((def) => def.maskable).map((def) => def.key)
      ),
    [catalog]
  );

  const columns = useMemo<GridColDef<PositionRow>[]>(() => {
    const statusColumn: GridColDef<PositionRow> = {
      field: "_status",
      headerName: "",
      width: 40,
      minWidth: 40,
      sortable: false,
      filterable: false,
      editable: false,
      disableColumnMenu: true,
      disableReorder: true,
      align: "center",
      renderCell: (params: GridRenderCellParams<PositionRow>) => (
        <StatusCell status={statusByRow.get(String(params.id))} />
      ),
    };

    // Both row actions live behind the one overflow menu in the gutter — an
    // inline duplicate icon would double the gutter's width for an action
    // nobody reaches for mid-scan.
    // The gutter is pinned, so this cell renders for every visible row and never
    // virtualizes away — and MUI calls getActions on every render of it, then
    // clones each item again for the menu. The items only depend on the row and
    // the three handlers, none of which change without rebuilding this column,
    // so build them once per row instead of on every render. Deliberately still
    // a `type: "actions"` column: the roving-tabindex keyboard handling and the
    // menu's focus management come with it, and are not worth reimplementing.
    const actionItems = new WeakMap<PositionRow, React.ReactElement[]>();
    const actionsColumn: GridColDef<PositionRow> = {
      field: "_actions",
      type: "actions",
      headerName: "",
      width: 44,
      minWidth: 44,
      disableReorder: true,
      getActions: (params) => {
        const cached = actionItems.get(params.row);
        if (cached) return cached;
        const items = [
          <GridActionsCellItem
            key="edit"
            icon={<EditOutlinedIcon fontSize="small" />}
            label="Edit position (Alt+Enter)"
            onClick={() => onEditRow(params.row)}
            showInMenu
          />,
          <GridActionsCellItem
            key="duplicate"
            icon={<ContentCopyIcon fontSize="small" />}
            label="Duplicate position"
            onClick={() => onDuplicate(params.row)}
            showInMenu
          />,
          <GridActionsCellItem
            key="delete"
            icon={<DeleteOutlineIcon fontSize="small" />}
            label="Delete position"
            onClick={() => onDelete(params.row)}
            showInMenu
          />,
        ];
        actionItems.set(params.row, items);
        return items;
      },
    };

    // The gutter's members lead the array too, so unpinning keeps them together.
    const [controlColumns, dataColumns] = partition(
      buildColumns(catalog, { masked, numberFormat, departments, accounts, vacationCostById, manhoursWorkedById, fteById, hotelClusters, currentOu, hotelNames }),
      (column) => controlKeys.has(column.field)
    );

    // Block bands trail the catalog sections — user-defined calculations after
    // the built-in data, in the user's own order.
    const blockColumns = buildBlockColumns(blocks, { numberFormat, accounts, blockResults });

    return [statusColumn, ...controlColumns, actionsColumn, ...dataColumns, ...blockColumns];
  }, [catalog, controlKeys, masked, numberFormat, departments, accounts, vacationCostById, manhoursWorkedById, fteById, hotelClusters, currentOu, hotelNames, blocks, blockResults, statusByRow, onDuplicate, onDelete, onEditRow]);

  const columnGroupingModel = useMemo(
    () => [
      ...buildColumnGroupingModel(catalog, onAddField, onManageColumns),
      ...buildBlockGroupingEntries(blocks, onEditBlock),
    ],
    [catalog, onAddField, onManageColumns, blocks, onEditBlock]
  );

  // The row-aware half of "can this be edited" (masked PII, the locked basic-
  // salary faces, the single-hotel cluster rule) lives in columnFactory so the
  // Edit Position form applies exactly the same rules to the same row.
  const editabilityCtx = useMemo(
    () => ({
      masked,
      maskableKeys,
      hotelClusters,
      currentOu,
      // cellEditable runs per rendered cell per grid store update — a click
      // alone fires two or three — so the cluster lookup it does must be O(1).
      clusterById: clusterMapById(hotelClusters),
    }),
    [masked, maskableKeys, hotelClusters, currentOu]
  );

  // Memo for the answer above, keyed row -> field.
  //
  // Every mounted cell subscribes to isCellEditable and re-runs it on EVERY
  // grid store update, not just relevant ones (see GridCell's "Subscribe to
  // changes of the `isCellEditable` API result" selector). A single click
  // writes to the store three or four times — focus out, focus in, tab index,
  // cell selection — so with ~600 cells mounted the answer is recomputed a
  // couple of thousand times per click, for a value that cannot change unless
  // the row object or the context does.
  //
  // Keyed on the row object, same copy-on-write argument as the caches in
  // columnFactory: sanitizeRow and setRows always produce fresh objects rather
  // than mutating in place, so a stale row can never be read back. The cache
  // hangs off editabilityCtx, so a mask toggle, a new OU or a changed cluster
  // set builds a new ctx and therefore a new, empty cache.
  const editableCache = useMemo(
    () => new WeakMap<PositionRow, Map<string, boolean>>(),
    [editabilityCtx]
  );

  const isCellEditable = useCallback(
    (params: GridCellParams) => {
      const row = params.row as PositionRow | undefined;
      // Group and aggregation rows are not PositionRows — answer directly
      // rather than caching against a row object the grid rebuilds anyway.
      if (!row) return cellEditable(row, params.colDef, editabilityCtx);
      let byField = editableCache.get(row);
      if (!byField) {
        byField = new Map<string, boolean>();
        editableCache.set(row, byField);
      }
      const cached = byField.get(params.colDef.field);
      if (cached !== undefined) return cached;
      const editable = cellEditable(row, params.colDef, editabilityCtx);
      byField.set(params.colDef.field, editable);
      return editable;
    },
    [editabilityCtx, editableCache]
  );

  // The read-only Department (code) cell is a mirror of the Dept Name pick, so
  // trying to edit it hands you the picker where the choice actually happens:
  // code field -> its `departments` picker field (deptName).
  const editRedirect = useMemo(() => {
    const map = new Map<string, string>();
    // Only when the picker exists — with no reference data both fields are plain
    // text, so there is nowhere better to send the edit.
    if (departments.length === 0) return map;
    for (const def of catalog.fields) {
      const source = def.dropdownSource;
      if (source?.kind === "departments" && source.codeField) {
        map.set(source.codeField, def.key);
      }
    }
    return map;
  }, [catalog, departments]);

  const openPicker = useCallback(
    (id: GridRowId, field: string) => {
      // Defer a frame so the redirect runs after the grid finishes its own
      // click/key handling for the source cell.
      requestAnimationFrame(() => {
        try {
          apiRef.current?.startCellEditMode({ id, field });
          apiRef.current?.setCellFocus(id, field);
        } catch {
          /* focus is best-effort */
        }
      });
    },
    [apiRef]
  );

  const handleCellDoubleClick = useCallback(
    (params: GridCellParams) => {
      const target = editRedirect.get(params.field);
      if (target) openPicker(params.id, target);
    },
    [editRedirect, openPicker]
  );

  const handleCellKeyDown = useCallback(
    (params: GridCellParams, event: MuiEvent<React.KeyboardEvent>) => {
      // Alt+Enter opens the row as a form, focused on the cell you were on.
      // Deliberately a modifier: the redirect below swallows bare printable
      // keys for type-to-edit, so a plain letter would collide with it.
      if (event.altKey && event.key === "Enter") {
        event.defaultMuiPrevented = true;
        onEditRow(params.row as PositionRow, params.field);
        return;
      }
      const target = editRedirect.get(params.field);
      if (!target) return;
      // Leave shortcuts (Ctrl/⌘+C to copy the code, etc.) to the grid.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // Enter or the first printable key on the code cell jumps into the picker,
      // matching how the grid's own type-to-edit works on editable cells.
      if (event.key === "Enter" || event.key.length === 1) {
        event.defaultMuiPrevented = true;
        openPicker(params.id, target);
      }
    },
    [editRedirect, openPicker, onEditRow]
  );

  // v9 reports selection as {type, ids}: an "exclude" model means everything
  // except `ids`, which is what a header select-all over a filtered grid emits.
  const handleSelectionChange = useCallback(
    (model: GridRowSelectionModel) => {
      const ids =
        model.type === "exclude"
          ? rows.map((row) => row.id).filter((id) => !model.ids.has(id))
          : [...model.ids].map(String);
      onSelectionChange(ids);
    },
    [rows, onSelectionChange]
  );

  // Identity matters more than content for all four of these: the grid diffs
  // them by reference and re-runs real work when they change (see the module
  // constants above). Kept behind memos so an unrelated parent render — a save
  // status tick, a toast, a dialog opening — costs the grid nothing.
  const slots = useMemo(() => ({ columnMenu: ColumnMenu }), [ColumnMenu]);

  const rowGroupingModel = useMemo(
    () => (groupByDept ? DEPT_GROUPING : NO_GROUPING),
    [groupByDept]
  );

  const filterModel = useMemo(
    () => ({
      items: showInactive ? NO_FILTER_ITEMS : ACTIVE_ONLY_ITEMS,
      quickFilterValues: quickFilter ? quickFilter.split(/\s+/) : NO_QUICK_FILTER,
    }),
    [showInactive, quickFilter]
  );

  const initialState = useMemo<GridInitialState>(() => {
    const keysOfSection = (section: string) =>
      catalog.fields
        .filter((def) => def.section === section && def.visible)
        .map((def) => def.key);
    // Row controls, then the frozen identity block — both pinned whole (see
    // healPinnedBand). The gutter reads select · state · active · actions.
    const controlKeys = keysOfSection("control");
    const piiKeys = keysOfSection("pii");

    // Twelve Additional Cost columns is a lot of width for a family most rows
    // leave empty — they start folded behind their summary column and expand
    // from the chevron on its header (see COLLAPSIBLE_MONTH_FAMILIES).
    const monthKeys = collapsibleMonthKeys();

    const defaults: GridInitialState = {
      columns: {
        columnVisibilityModel: Object.fromEntries(
          monthKeys.map((key) => [key, false])
        ),
      },
      pinnedColumns: {
        left: [
          GRID_CHECKBOX_SELECTION_FIELD,
          "_status",
          ...controlKeys,
          "_actions",
          ...piiKeys,
        ],
        right: [],
      },
      aggregation: {
        model: {
          headcount: "sum",
          fte: "sum",
          budgetYearBasicSalary: "sum",
        },
      },
    };
    // Deliberately computed once per mount: the grid only reads initialState
    // on mount, so later changes to restoredState must not retrigger this.
    const merged = restoredState ? { ...defaults, ...restoredState } : defaults;
    // A restored `columns` replaces the defaults wholesale, so the collapse
    // default and the summary column's slot are re-applied over it here.
    let healed = healCollapsedFamilies(merged, monthKeys);
    for (const [summaryKey, vector] of Object.entries(COLLAPSIBLE_MONTH_FAMILIES)) {
      healed = healNewColumn(healed, summaryKey, vectorKey(vector, 1));
    }
    // Standard Title arrived with seed v22, so any layout saved before it lists
    // every other column and not this one — which strands it at the far right,
    // past Vacation, instead of beside the Job Title it belongs to.
    healed = healNewColumn(healed, "standardJobTitle", "payType");
    return healPinnedBand(healPinnedBand(healed, controlKeys), piiKeys);
  }, []);

  return (
    <DataGridPremium
      apiRef={apiRef}
      rows={rows}
      columns={columns}
      loading={loading}
      columnGroupingModel={columnGroupingModel}
      slots={slots}
      rowGroupingModel={rowGroupingModel}
      cellSelection
      checkboxSelection
      // Clicking a cell must not clear a selection the user built to act on.
      disableRowSelectionOnClick
      onRowSelectionModelChange={handleSelectionChange}
      rowHeight={ROW_HEIGHT}
      columnHeaderHeight={HEADER_HEIGHT}
      columnGroupHeaderHeight={GROUP_HEADER_HEIGHT}
      isCellEditable={isCellEditable}
      onCellDoubleClick={handleCellDoubleClick}
      onCellKeyDown={handleCellKeyDown}
      processRowUpdate={onRowUpdate}
      onProcessRowUpdateError={onRowUpdateError}
      onClipboardPasteStart={onPasteStart}
      onClipboardPasteEnd={onPasteEnd}
      initialState={initialState}
      getRowClassName={getRowClassName}
      filterModel={filterModel}
      sx={GRID_SX}
    />
  );
}

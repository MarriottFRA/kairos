/**
 * PositionsGrid — the DataGridPremium wrapper for the Positions page.
 * -----------------------------------------------------------
 * Columns and section groups are generated from the field catalog
 * (columnFactory). The grid owns editing mechanics: cell edits and clipboard
 * pastes both flow through processRowUpdate, so sanitization and the save
 * queue get every change for free. Masked PII cells are non-editable — that
 * closes typing AND paste in one place.
 */

import { useCallback, useMemo, useRef } from "react";
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
import ViewColumnOutlinedIcon from "@mui/icons-material/ViewColumnOutlined";
import {
  DataGridPremium,
  gridVisibleRowsSelector,
  GridColumnMenu,
  GridColumnMenuProps,
  GridActionsCellItem,
  GridCellParams,
  GridColDef,
  GridFilterModel,
  GridInitialState,
  GridRenderCellParams,
  GridRowClassNameParams,
  GridRowId,
  GridRowSelectionModel,
  GRID_CHECKBOX_SELECTION_COL_DEF,
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
import {
  departmentUnassigned,
  rowDepartmentWritable,
} from "../../shared/positions/writeScope";
import { DepartmentPickList } from "../../shared/positions/departmentPickList";
import { RowSaveStatus } from "../../services/positionsWriteQueue";
import {
  buildColumnGroupingModel,
  buildColumns,
  cellEditable,
} from "./columnFactory";
import {
  buildBlockColumns,
  buildBlockGroupingEntries,
  poolWeightGate,
} from "./blockColumns";
import { healCollapsedFamilies, healNewColumn } from "./gridLayout";

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
const NO_QUICK_FILTER: string[] = [];

/**
 * Row classes: retained-but-inactive, and locked.
 *
 * `locked` is passed in rather than closed over because this function is called
 * for every rendered row on every store update — building a new closure per
 * render would defeat the grid's own memoisation of the prop.
 */
function rowClassNameFor(
  locked: (row: PositionRow) => boolean,
  needsDepartment: (row: PositionRow) => boolean
): (params: GridRowClassNameParams) => string {
  return (params) => {
    const row = params.row as PositionRow | undefined;
    if (!row) return "";
    const classes: string[] = [];
    if (row.active === false) classes.push("pos-row--inactive");
    // Somebody else is editing this department. Without a visual cue the only
    // signal is that double-click quietly does nothing, which reads as a broken
    // grid rather than as a rule.
    if (locked(row)) classes.push("pos-row--locked");
    // Mutually exclusive with locked by construction: a row with no department
    // is writable for anyone who holds one, and this only applies to people who
    // cannot publish it as it stands.
    else if (needsDepartment(row)) classes.push("pos-row--needsDepartment");
    return classes.join(" ");
  };
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
  // Delegated to somebody else, or otherwise not this user's to write. Tinted
  // rather than faded: these rows are current and correct, they are simply
  // being maintained by another person, and dimming them would say the opposite.
  "& .pos-row--locked": {
    bgcolor: (theme) => alpha(theme.palette.text.disabled, 0.06),
    "&:hover": {
      bgcolor: (theme) => alpha(theme.palette.text.disabled, 0.09),
    },
  },
  // Added but not finished: no department, and this user cannot publish a row
  // without one. Deliberately a warning tint rather than the disabled one —
  // the row IS editable, it just will not go anywhere until it is classified.
  "& .pos-row--needsDepartment": {
    bgcolor: (theme) => alpha(theme.palette.warning.main, 0.1),
    "&:hover": {
      bgcolor: (theme) => alpha(theme.palette.warning.main, 0.16),
    },
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
  /**
   * Departments this user may write, from the published plan's
   * `/department-ownership`. Omit (undefined) when the plan was never published:
   * the local file is then the only copy and every row is editable, which is how
   * the app behaved before server sync and how it must keep behaving for a hotel
   * that never opts in.
   *
   * A `Set` because `cellEditable` consults it for every rendered cell on every
   * grid store update — see the resolver in columnFactory.
   */
  writableDepartments?: ReadonlySet<string>;
  /**
   * Which departments the picker may OFFER, and which it shows greyed.
   *
   * Separate from `writableDepartments` and from `departments` on purpose. The
   * lock answers "may I edit this row"; this answers "what may I turn it into",
   * and the two have different right answers for an owner — who can assign a
   * department that has no rows in it yet, and cannot assign one they have
   * delegated away. Omit for no restriction.
   */
  departmentPicks?: DepartmentPickList;
  /** An administrator holds a support lease, or the plan is archived. */
  planLocked?: boolean;
  /**
   * May this user change the hotel's setup — columns, blocks, schemes?
   *
   * Used here only to decide whether an unassigned row is worth flagging: a row
   * with no department can be published by somebody with structure rights and by
   * nobody else, so for an owner it is a choice and for a delegate it is an
   * unfinished row. Defaults to true, which flags nothing.
   */
  structureEditable?: boolean;
  groupByDept: boolean;
  /** False (the default) filters the grid down to budgeted positions. */
  showInactive: boolean;
  loading: boolean;
  quickFilter: string;
  /**
   * The column filters the user built in the filter panel — owned by the page
   * so they survive the remount an added column forces (see `gridEpoch`).
   *
   * This must be paired with `onFilterModelChange`: MUI registers `filter` as
   * controlled state, and a controlled model with no change handler makes the
   * prop win over every write the panel attempts — which silently breaks the
   * whole panel, not just the filters we set ourselves.
   */
  filterModel: GridFilterModel;
  onFilterModelChange: (model: GridFilterModel) => void;
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

/** The gutter columns and MUI's own — status dot, row menu, checkbox, the row-
 *  grouping column. None of them hold a value, and MUI's own range selection
 *  refuses them too (hasClickedValidCellForRangeSelection), so neither the
 *  keyboard shortcuts nor the menu item offer to select them. */
function isDataColumn(field: string): boolean {
  return (
    field !== "_status" &&
    field !== "_actions" &&
    field !== GRID_CHECKBOX_SELECTION_COL_DEF.field &&
    !field.startsWith("__")
  );
}

/** "Select column" — the mouse route to what Ctrl+Space does from the keyboard.
 *  Same prop shape as RemoveColumnMenuItem above: GridColumnMenu supplies
 *  `colDef` and `hideMenu` to every menu item it renders. */
function SelectColumnMenuItem(props: {
  colDef: GridColDef;
  hideMenu: (event: React.SyntheticEvent) => void;
  onSelectColumn: (field: string) => void;
}) {
  const { colDef, hideMenu, onSelectColumn } = props;
  if (!isDataColumn(colDef.field)) return null;
  return (
    <MenuItem
      onClick={(event) => {
        onSelectColumn(colDef.field);
        hideMenu(event);
      }}
    >
      <ListItemIcon>
        <ViewColumnOutlinedIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Select column (Ctrl+Space)</ListItemText>
    </MenuItem>
  );
}

/** Take a keystroke off both MUI and the browser. `defaultMuiPrevented` only
 *  stops MUI's own handlers — and since MUI is the thing that would normally
 *  have called preventDefault for an arrow or a space, suppressing it without
 *  this leaves the virtual scroller free to scroll underneath the shortcut. */
function claim(event: MuiEvent<React.KeyboardEvent>): void {
  event.defaultMuiPrevented = true;
  event.preventDefault();
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
  writableDepartments,
  departmentPicks,
  planLocked,
  structureEditable = true,
  groupByDept,
  showInactive,
  loading,
  quickFilter,
  filterModel,
  onFilterModelChange,
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

  // ── Excel-style column navigation and selection ──
  //
  // MUI's keyboard navigation matches on `event.key` alone and never consults
  // Ctrl, so Ctrl+Down moves one row exactly like Down does; and cellSelection
  // only ever extends a range by a single cell per Shift+Arrow. Setting a merit
  // increase down four hundred rows therefore meant four hundred keystrokes or
  // a mouse drag the length of the plan. The modified arrows are free to claim:
  // nothing in MUI or in this grid's own shortcuts uses them (Ctrl+C/V, Ctrl+D
  // fill-down, Ctrl+R fill-right and Ctrl+A select-all-rows all stay put).
  //
  // All of it hangs off the onCellKeyDown handler that already exists and one
  // ref, so the grid gains no listener, no memo and no prop: the cost is a few
  // comparisons per keydown and nothing whatsoever per render.

  /** Rows in the order the grid shows them, plus the id -> index map. This is
   *  the very selector `selectCellRange` and `getRowIndexRelativeToVisibleRows`
   *  read, so indices taken from it always line up; and it is the grid's own
   *  memo, so reading it recomputes nothing. */
  const visibleRows = useCallback(() => gridVisibleRowsSelector(apiRef), [apiRef]);

  /** Group headers and the aggregation footer are real entries in that list but
   *  are not cells anyone means to land on. */
  const isLeafRow = useCallback(
    (id: GridRowId) => apiRef.current?.getRowNode(id)?.type === "leaf",
    [apiRef]
  );

  /** The first (up) or last (down) row the cursor can occupy. Walks inward from
   *  the end rather than filtering the list — in practice it stops on the first
   *  or second entry, so a thousand-row plan costs the same as a ten-row one. */
  const edgeRowId = useCallback(
    (direction: 1 | -1): GridRowId | null => {
      const { rows } = visibleRows();
      const from = direction === 1 ? rows.length - 1 : 0;
      for (let i = from; i >= 0 && i < rows.length; i -= direction) {
        if (isLeafRow(rows[i].id)) return rows[i].id;
      }
      return null;
    },
    [visibleRows, isLeafRow]
  );

  /** One row along from `fromId`, skipping group headers, or null at the end. */
  const stepRowId = useCallback(
    (fromId: GridRowId, direction: 1 | -1): GridRowId | null => {
      const { rows, rowIdToIndexMap } = visibleRows();
      const index = rowIdToIndexMap.get(fromId);
      if (index === undefined) return null;
      for (let i = index + direction; i >= 0 && i < rows.length; i += direction) {
        if (isLeafRow(rows[i].id)) return rows[i].id;
      }
      return null;
    },
    [visibleRows, isLeafRow]
  );

  const scrollToRow = useCallback(
    (id: GridRowId) => {
      const index = visibleRows().rowIdToIndexMap.get(id);
      if (index !== undefined) apiRef.current?.scrollToIndexes({ rowIndex: index });
    },
    [apiRef, visibleRows]
  );

  /** Every cell of one column. Shared by Ctrl+Space and the column menu item. */
  const onSelectColumn = useCallback(
    (field: string) => {
      if (!isDataColumn(field)) return;
      const top = edgeRowId(-1);
      const bottom = edgeRowId(1);
      if (top === null || bottom === null) return;
      apiRef.current?.selectCellRange({ id: top, field }, { id: bottom, field });
    },
    [apiRef, edgeRowId]
  );

  // The moving end of a keyboard-built range. MUI tracks the same thing in a
  // private ref (`cellWithVirtualFocus`) it never exposes, so the moment we
  // handle any Shift+Arrow ourselves we have to own the whole vertical family —
  // otherwise the two refs drift and the Shift+Up after a Ctrl+Shift+Down
  // collapses the range instead of trimming it by one.
  //
  // MUI deliberately leaves DOM focus on the anchor while a range is being
  // extended, so `params` still reports the anchor on every one of these
  // keystrokes. That gives the staleness check for free: if params no longer
  // matches, the user clicked or navigated away and this is a new range.
  const rangeEnd = useRef<{ anchorId: GridRowId; anchorField: string; endId: GridRowId } | null>(
    null
  );

  const ColumnMenu = useCallback(
    (menuProps: GridColumnMenuProps) => (
      <GridColumnMenu
        {...menuProps}
        slots={{
          columnMenuSelectColumnItem: SelectColumnMenuItem,
          columnMenuUserItem: RemoveColumnMenuItem,
        }}
        // MUI's own items claim 10 (Sort), 20 (Filter) and 30 (Columns) — ours
        // sit between and after rather than colliding with Filter for a slot.
        slotProps={{
          columnMenuSelectColumnItem: { displayOrder: 15, onSelectColumn },
          columnMenuUserItem: { displayOrder: 40, removableKeys, onRemoveField },
        }}
      />
    ),
    [removableKeys, onRemoveField, onSelectColumn]
  );

  const maskableKeys = useMemo(
    () =>
      new Set(
        catalog.fields.filter((def) => def.maskable).map((def) => def.key)
      ),
    [catalog]
  );

  /**
   * Is this row in a department the user may write?
   *
   * The row-menu counterpart to `cellEditable`'s department gate, kept as one
   * inline predicate rather than another cache: `getActions` already memoises
   * its result per row in `actionItems`, so this runs once per row per column
   * rebuild.
   */
  const rowWritable = useCallback(
    (row: PositionRow): boolean =>
      rowDepartmentWritable(row, { writableDepartments, planLocked }),
    [writableDepartments, planLocked]
  );

  /**
   * Created, editable, and not finished: no department yet.
   *
   * Only worth marking for somebody who cannot publish a department-less row —
   * an owner can, so for them an unclassified row is a choice rather than an
   * omission. Warning-tinted rather than disabled-tinted, because unlike a
   * locked row this one IS editable.
   */
  const rowNeedsDepartment = useCallback(
    (row: PositionRow): boolean =>
      !structureEditable && departmentUnassigned(row, { writableDepartments }),
    [writableDepartments, structureEditable]
  );

  const getRowClassName = useMemo(
    () => rowClassNameFor((row) => !rowWritable(row), rowNeedsDepartment),
    [rowWritable, rowNeedsDepartment]
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
    // MUI calls getActions on every render of this cell, then clones each item
    // again for the menu — and the gutter leads the grid, so the cell is on
    // screen for every visible row until you scroll well to the right. The items
    // only depend on the row and the three handlers, none of which change
    // without rebuilding this column, so build them once per row instead of on
    // every render. Deliberately still
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
        // Duplicating or deleting a row in a department somebody else holds would
        // be accepted locally and then rejected at publish as
        // DEPARTMENT_OUT_OF_SCOPE. Disabling here rather than at save time means
        // the answer is the same one the server would give, given now.
        const writable = rowWritable(params.row);
        const items = [
          <GridActionsCellItem
            key="edit"
            icon={<EditOutlinedIcon fontSize="small" />}
            label={writable ? "Edit position (Alt+Enter)" : "Edit position — not yours to edit"}
            onClick={() => onEditRow(params.row)}
            disabled={!writable}
            showInMenu
          />,
          <GridActionsCellItem
            key="duplicate"
            icon={<ContentCopyIcon fontSize="small" />}
            label="Duplicate position"
            onClick={() => onDuplicate(params.row)}
            disabled={!writable}
            showInMenu
          />,
          <GridActionsCellItem
            key="delete"
            icon={<DeleteOutlineIcon fontSize="small" />}
            label="Delete position"
            onClick={() => onDelete(params.row)}
            disabled={!writable}
            showInMenu
          />,
        ];
        actionItems.set(params.row, items);
        return items;
      },
    };

    // The gutter's members lead the array, which is the only thing keeping them
    // together now that nothing is pinned.
    const [controlColumns, dataColumns] = partition(
      buildColumns(catalog, { masked, numberFormat, departments, departmentPicks, accounts, vacationCostById, manhoursWorkedById, fteById, hotelClusters, currentOu, hotelNames }),
      (column) => controlKeys.has(column.field)
    );

    // Block bands trail the catalog sections — user-defined calculations after
    // the built-in data, in the user's own order.
    const blockColumns = buildBlockColumns(blocks, { numberFormat, accounts, blockResults });

    return [statusColumn, ...controlColumns, actionsColumn, ...dataColumns, ...blockColumns];
  }, [catalog, controlKeys, masked, numberFormat, departments, departmentPicks, accounts, vacationCostById, manhoursWorkedById, fteById, hotelClusters, currentOu, hotelNames, blocks, blockResults, statusByRow, onDuplicate, onDelete, onEditRow, rowWritable]);

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
      // Server-side write scope. A new ownership answer produces a new ctx, and
      // therefore fresh per-row caches both here and in columnFactory — which is
      // what makes a revoked delegation lock the grid on the next render rather
      // than at the next remount.
      writableDepartments,
      planLocked,
      // Pooled blocks whose rule decides membership: the weight cell of a row
      // the rule leaves out has nothing to set.
      poolWeightEditable: poolWeightGate(blocks),
    }),
    [masked, maskableKeys, hotelClusters, currentOu, writableDepartments, planLocked, blocks]
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

      // ── Column navigation and selection ──
      // Skipped wholesale inside an open editor (where the arrows belong to the
      // input) and for Alt chords (Alt+Enter above, Alt+Up/Down in the form).
      const vertical =
        event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      const ctrl = event.ctrlKey || event.metaKey;
      if (
        params.cellMode !== "edit" &&
        !event.altKey &&
        isDataColumn(params.field) &&
        (vertical !== 0 || (ctrl && event.key === " "))
      ) {
        // Ctrl+Space — the whole column, from anywhere in it. Must be claimed:
        // MUI counts space as a navigation key, so left alone it page-scrolls
        // and clears the range.
        if (vertical === 0) {
          claim(event);
          onSelectColumn(params.field);
          rangeEnd.current = null;
          return;
        }

        // Plain Ctrl+Arrow — jump to the far end of the column. Same three
        // calls MUI makes for an unmodified arrow, only with a different target.
        if (ctrl && !event.shiftKey) {
          claim(event);
          const target = edgeRowId(vertical);
          if (target === null || target === params.id) return;
          apiRef.current?.setCellSelectionModel({});
          apiRef.current?.setCellFocus(target, params.field);
          scrollToRow(target);
          rangeEnd.current = null;
          return;
        }

        // Shift+Arrow extends the range: to the far end with Ctrl, by one row
        // without it. The unmodified case reproduces what MUI already does —
        // taken over only so both directions read the same end from one ref.
        if (event.shiftKey) {
          claim(event);
          const anchorField = params.field;
          const anchorId = params.id;
          const state = rangeEnd.current;
          const from =
            state && state.anchorId === anchorId && state.anchorField === anchorField
              ? state.endId
              : anchorId;
          const target = ctrl ? edgeRowId(vertical) : stepRowId(from, vertical);
          // Already against the edge — holding the chord down then costs
          // nothing rather than rebuilding the same model on every repeat.
          if (target === null || target === from) return;
          apiRef.current?.selectCellRange(
            { id: anchorId, field: anchorField },
            { id: target, field: anchorField }
          );
          scrollToRow(target);
          rangeEnd.current = { anchorId, anchorField, endId: target };
          return;
        }

        // An unmodified arrow moves focus, which starts any next range afresh.
        rangeEnd.current = null;
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
    [
      editRedirect,
      openPicker,
      onEditRow,
      apiRef,
      edgeRowId,
      stepRowId,
      scrollToRow,
      onSelectColumn,
    ]
  );

  // One copied row fills every row of the pasted-into range.
  //
  // MUI already does exactly this — but only in defaultPasteResolver's
  // row-selection branch ("If only one row is pasted - paste it to all selected
  // rows"). `cellSelection` sends a dragged range down the earlier cell branch
  // instead, which indexes pastedData[rowIndex], so copying one row of a
  // twelve-month family into a four-row range fills the first row and silently
  // skips the rest. Repeating the row to the height of the range makes the two
  // branches agree.
  //
  // Hooked here rather than on keydown because splitClipboardPastedText is the
  // one supported seam ahead of the resolver, and it only runs on Ctrl+V —
  // nothing is added to the render, scroll or typing paths.
  const splitClipboardPastedText = useCallback(
    (text: string, delimiter = "\t") => {
      const rows = text
        // Excel on Windows appends a trailing newline (MUI's own default does
        // this too — this callback replaces that default wholesale).
        .replace(/\r?\n$/, "")
        .split(/\r\n|\n|\r/)
        .map((row) => row.split(delimiter));
      // A single cell already fills a whole range (isSingleValuePasted), and a
      // genuine multi-row clipboard must keep mapping 1:1 — leave both alone.
      if (rows.length !== 1 || rows[0].length < 2) return rows;
      const selected = apiRef.current?.getSelectedCellsAsArray() ?? [];
      const rowCount = new Set(selected.map((cell) => cell.id)).size;
      if (rowCount < 2) return rows;
      // Copies, not the same array n times: the resolver's other branch
      // consumes rows with pastedData.shift().
      return Array.from({ length: rowCount }, () => rows[0].slice());
    },
    [apiRef]
  );

  // Inactive positions are hidden rather than removed — they stay in the store,
  // roll forward to next year, and come back with the toggle.
  //
  // Withheld from the grid rather than expressed as a filter item, because the
  // filter model belongs to the user now: an item here would show up as an
  // editable "Active is true" row that snaps back when deleted, and switching
  // the panel's logic operator to OR would OR this rule in and bring the
  // inactive rows straight back.
  const gridRows = useMemo(
    () => (showInactive ? rows : rows.filter((row) => row.active !== false)),
    [rows, showInactive]
  );

  // v9 reports selection as {type, ids}: an "exclude" model means everything
  // except `ids`, which is what a header select-all over a filtered grid emits.
  const handleSelectionChange = useCallback(
    (model: GridRowSelectionModel) => {
      const ids =
        model.type === "exclude"
          ? gridRows.map((row) => row.id).filter((id) => !model.ids.has(id))
          : [...model.ids].map(String);
      onSelectionChange(ids);
    },
    [gridRows, onSelectionChange]
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

  // Two owners, one model: the toolbar's search box owns quickFilterValues, the
  // filter panel owns items. Merged behind a memo so the grid still sees a
  // stable reference (see the stable-prop note above); the search box stays the
  // source of truth for its half either way, since this re-applies it over
  // whatever the panel last sent up.
  const gridFilterModel = useMemo(
    () => ({
      ...filterModel,
      quickFilterValues: quickFilter ? quickFilter.split(/\s+/) : NO_QUICK_FILTER,
    }),
    [filterModel, quickFilter]
  );

  const initialState = useMemo<GridInitialState>(() => {
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
    // Pinning is off (see disableColumnPinning), but layouts saved while the
    // gutter and identity block were frozen still carry the band — dropped here
    // so the next save writes it out of the stored layout for good.
    delete (merged as Record<string, unknown>).pinnedColumns;
    // A restored `columns` replaces the defaults wholesale, so the collapse
    // default and the summary column's slot are re-applied over it here.
    let healed = healCollapsedFamilies(merged, monthKeys);
    for (const [summaryKey, vector] of Object.entries(COLLAPSIBLE_MONTH_FAMILIES)) {
      healed = healNewColumn(healed, summaryKey, vectorKey(vector, 1));
    }
    // Standard Title arrived with seed v22, so any layout saved before it lists
    // every other column and not this one — which strands it at the far right,
    // past Vacation, instead of beside the Job Title it belongs to.
    return healNewColumn(healed, "standardJobTitle", "payType");
  }, []);

  return (
    <DataGridPremium
      apiRef={apiRef}
      rows={gridRows}
      columns={columns}
      loading={loading}
      columnGroupingModel={columnGroupingModel}
      slots={slots}
      rowGroupingModel={rowGroupingModel}
      cellSelection
      checkboxSelection
      // No frozen columns: a pinned band renders as its own grid section on
      // every scroll and buys little at this width. Off wholesale rather than
      // merely unpinned, so the column menu stops offering it and no saved
      // layout can quietly bring the split back.
      disableColumnPinning
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
      splitClipboardPastedText={splitClipboardPastedText}
      initialState={initialState}
      getRowClassName={getRowClassName}
      filterModel={gridFilterModel}
      // Non-negotiable while filterModel is passed: without it MUI treats the
      // model as controlled-with-no-owner and drops every write the panel makes.
      onFilterModelChange={onFilterModelChange}
      sx={GRID_SX}
    />
  );
}

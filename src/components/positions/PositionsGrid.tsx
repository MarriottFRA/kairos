/**
 * PositionsGrid — the DataGridPremium wrapper for the Positions page.
 * -----------------------------------------------------------
 * Columns and section groups are generated from the field catalog
 * (columnFactory). The grid owns editing mechanics: cell edits and clipboard
 * pastes both flow through processRowUpdate, so sanitization and the save
 * queue get every change for free. Masked PII cells are non-editable — that
 * closes typing AND paste in one place.
 */

import { memo, useCallback, useMemo, useRef, useState } from "react";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Box from "@mui/material/Box";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { alpha, SxProps, Theme } from "@mui/material/styles";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ContentPasteIcon from "@mui/icons-material/ContentPaste";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
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
  INPUT_BASIS_KEY,
  SectionId,
  vectorKey,
} from "../../shared/positions/fields";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import { clusterMapById } from "../../shared/hotelClusters/resolve";
import { BlockDto } from "../../shared/blocks/ipc";
import type { DerivedRowValuesRef } from "../../shared/positions/derivedRowValues";
import { PositionRow } from "../../shared/positions/rowModel";
import {
  departmentCodeOf,
  departmentUnassigned,
  rowDepartmentWritable,
} from "../../shared/positions/writeScope";
import { DepartmentPickList } from "../../shared/positions/departmentPickList";
import type { DepartmentWritePolicy } from "../../shared/kairosSync/writePolicy";
import { RowSaveStatus } from "../../services/positionsWriteQueue";
import CellSelectionStats, {
  CELL_SELECTION_PERF_SX,
} from "../common/CellSelectionStats";
import { makeCellRangePasteSplitter } from "../common/cellRangePaste";
import {
  copyGridSelectionToClipboard,
  pasteClipboardIntoGrid,
} from "../common/gridClipboardActions";
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
import {
  healCollapsedFamilies,
  healMovedColumn,
  healNewColumn,
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

// Translucent tints below are painted as background-image gradients rather
// than background-color so they composite over MUI's opaque pinned-cell and
// pinned-header backgrounds: a pinned column keeps its tint without letting
// the content scrolling beneath ghost through the frozen block. (A tint set
// as background-color at this specificity would replace the opaque pinned
// base, because sx rules inject after the grid's root styles.)
const tint = (color: string) => `linear-gradient(${color}, ${color})`;

const GRID_SX: SxProps<Theme> = {
  borderRadius: 2,
  // Why the grid is permanently unselectable: a performance fix every
  // cellSelection grid needs, explained where it is defined.
  ...(CELL_SELECTION_PERF_SX as object),
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
    backgroundImage: (theme) => tint(alpha(theme.palette.warning.main, 0.25)),
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
  // Pinned cells are opaque (they must hide what scrolls beneath), which also
  // hides the row-status tints painted on the row element behind them — so
  // those two tints are re-applied to pinned cells directly.
  "& .pos-row--locked .MuiDataGrid-cell--pinnedLeft, & .pos-row--locked .MuiDataGrid-cell--pinnedRight":
    {
      backgroundImage: (theme) => tint(alpha(theme.palette.text.disabled, 0.06)),
    },
  "& .pos-row--needsDepartment .MuiDataGrid-cell--pinnedLeft, & .pos-row--needsDepartment .MuiDataGrid-cell--pinnedRight":
    {
      backgroundImage: (theme) => tint(alpha(theme.palette.warning.main, 0.1)),
    },
  "& .pos-cell--masked": {
    fontFamily: "'IBM Plex Mono', monospace",
    color: "text.disabled",
    letterSpacing: 2,
  },
  // Section tints — one hue per section, strong on the banner and faint
  // on the columns it spans, which is what ties the two rows together.
  "& .pos-band--pii": {
    backgroundImage: (theme) => tint(alpha(theme.palette.warning.main, 0.22)),
  },
  "& .pos-col--pii": {
    backgroundImage: (theme) => tint(alpha(theme.palette.warning.main, 0.07)),
  },
  // Employee is PII's sibling band — same hue, half the strength, so the
  // two read as related without the identity block losing its emphasis.
  "& .pos-band--employee": {
    backgroundImage: (theme) => tint(alpha(theme.palette.warning.main, 0.11)),
  },
  "& .pos-col--employee": {
    backgroundImage: (theme) => tint(alpha(theme.palette.warning.main, 0.035)),
  },
  "& .pos-band--contract": {
    backgroundImage: (theme) => tint(alpha(theme.palette.secondary.main, 0.22)),
  },
  "& .pos-col--contract": {
    backgroundImage: (theme) => tint(alpha(theme.palette.secondary.main, 0.06)),
  },
  "& .pos-band--seasonality": {
    backgroundImage: (theme) => tint(alpha(theme.palette.info.main, 0.22)),
  },
  "& .pos-col--seasonality": {
    backgroundImage: (theme) => tint(alpha(theme.palette.info.main, 0.06)),
  },
  "& .pos-band--basicSalary": {
    backgroundImage: (theme) => tint(alpha(theme.palette.primary.main, 0.22)),
  },
  "& .pos-col--basicSalary": {
    backgroundImage: (theme) => tint(alpha(theme.palette.primary.main, 0.06)),
  },
  "& .pos-band--vacation": {
    backgroundImage: (theme) => tint(alpha(theme.palette.success.main, 0.22)),
  },
  "& .pos-col--vacation": {
    backgroundImage: (theme) => tint(alpha(theme.palette.success.main, 0.06)),
  },
  // Blocks get their own hue outside the section palette (violet), so
  // user-defined calculation bands read as such at a glance.
  "& .pos-band--blocks": {
    backgroundImage: tint(alpha("#7e57c2", 0.24)),
  },
  "& .pos-col--blocks": {
    backgroundImage: tint(alpha("#7e57c2", 0.07)),
  },
  // Editable cells read as inputs (same affordance as the calendar grid).
  "& .MuiDataGrid-cell--editable": {
    backgroundImage: (theme) => tint(alpha(theme.palette.primary.main, 0.04)),
    cursor: "text",
    "&:hover": {
      backgroundImage: (theme) => tint(alpha(theme.palette.primary.main, 0.1)),
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
  /**
   * Vacation cost, derived manhours, derived FTE and live block totals per row
   * — everything the grid shows but does not store.
   *
   * One ref rather than four maps because all four change on every committed
   * edit: as props they were column-memo dependencies, so a single cell commit
   * rebuilt ~100 colDefs and re-rendered every mounted row. The ref's identity
   * never changes, so the columns survive; the cell callbacks read through it
   * when they run. See shared/positions/derivedRowValues.
   */
  derived: DerivedRowValuesRef;
  /** Hotel-cluster definitions for the Cluster picker + Multiplier column;
   *  empty until loaded (the Cluster field then degrades to plain text). */
  hotelClusters: HotelClusterDto[];
  /** The selected hotel — whose weight in an assigned cluster flexes a row. */
  currentOu: string | null;
  /** OU -> hotel name, for naming the hotels a cluster position is shared with. */
  hotelNames?: ReadonlyMap<string, string>;
  /** The hotel's blocks — each renders as a column band after the sections. */
  blocks: BlockDto[];
  masked: boolean;
  /**
   * What this user may write, from the published plan's
   * `/department-ownership`. Omit (undefined) when the plan was never published:
   * the local file is then the only copy and every row is editable, which is how
   * the app behaved before server sync and how it must keep behaving for a hotel
   * that never opts in.
   *
   * Sets inside, because `cellEditable` consults it for every rendered cell on
   * every grid store update — see the resolver in columnFactory.
   */
  writePolicy?: DepartmentWritePolicy;
  /**
   * Which departments the picker may OFFER, and which it shows greyed.
   *
   * Separate from `writePolicy` and from `departments` on purpose. The lock
   * answers "may I edit this row"; this answers "what may I turn it into". Both
   * are now derived from the same policy — an owner can assign a department that
   * has no rows in it yet, and cannot assign one they have delegated away — but
   * this one also has to decide what to grey and what to hide. Omit for no
   * restriction.
   */
  departmentPicks?: DepartmentPickList;
  /** An administrator holds a support lease, or the plan is archived. */
  planLocked?: boolean;
  /**
   * Why each locked department is locked, in the words for whoever is reading.
   *
   * The grid greys what it cannot write and there is deliberately no banner
   * listing the departments somebody else holds — the Sync page answers who has
   * them and why. But the row menu was already going to say something, and
   * "not yours to edit" is the one sentence that fits every case and explains
   * none of them. Same map the department picker uses, so the two cannot drift.
   *
   * Omit for no restriction; a code that is not in the map falls back.
   */
  lockReasonByDepartment?: ReadonlyMap<string, string>;
  /**
   * Ask the server again, ignoring anything this computer remembers.
   *
   * Offered on locked rows only, and it disappears the moment the row is
   * writable. A lock that is wrong is invisible from here — the grid cannot tell
   * a stale cached answer from a current one — so the escape hatch belongs on
   * the screen where somebody actually hits the wall, not only on the Sync page
   * they would have to think to visit.
   */
  onRecheckAccess?: () => void;
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

function PositionsGrid({
  rows,
  catalog,
  departments,
  accounts,
  derived,
  hotelClusters,
  currentOu,
  hotelNames,
  blocks,
  masked,
  writePolicy,
  departmentPicks,
  planLocked,
  lockReasonByDepartment,
  onRecheckAccess,
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
  // How many times this component rendered, in dev only (statically eliminated
  // from production). Pairs with the [liveSim] line on the Positions page: a
  // committed edit should move this by one (two under StrictMode), and an
  // unrelated toast or dialog should not move it at all. Deliberately per
  // COMPONENT, never per row or per cell — electron-log writes to disk, and a
  // per-cell log turns a slow frame into thousands of writes and makes the app
  // look hung, which misattributes the very problem you are measuring.
  const renderCount = useRef(0);
  if (import.meta.env.DEV) {
    renderCount.current += 1;
    console.debug(`[grid] render #${renderCount.current} — ${rows.length} rows`);
  }

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
        // MUI's own items claim 10 (Sort), 15 (Pin), 20 (Filter), 23
        // (Aggregation), 27 (Grouping) and 28 (Manage) — ours sit between
        // Pin and Filter, and after everything, rather than colliding.
        slotProps={{
          columnMenuSelectColumnItem: { displayOrder: 17, onSelectColumn },
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
      rowDepartmentWritable(row, { writePolicy, planLocked }),
    [writePolicy, planLocked]
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
      !structureEditable && departmentUnassigned(row, { writePolicy }),
    [writePolicy, structureEditable]
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
        // The reason, not the fact. A greyed row already says it cannot be
        // edited; what the menu can add is which of the several quite different
        // situations this is — and, when the answer is one nobody should be
        // seeing, the way to make this computer ask again.
        const lockReason = writable
          ? null
          : lockReasonByDepartment?.get(departmentCodeOf(params.row)) ??
            "not yours to edit";
        const items = [
          <GridActionsCellItem
            key="edit"
            icon={<EditOutlinedIcon fontSize="small" />}
            label={writable ? "Edit position (Alt+Enter)" : `Cannot edit — ${lockReason}`}
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
        if (!writable && onRecheckAccess) {
          items.push(
            <GridActionsCellItem
              key="recheck"
              icon={<RefreshIcon fontSize="small" />}
              label="Re-check my access"
              onClick={() => onRecheckAccess()}
              showInMenu
            />
          );
        }
        actionItems.set(params.row, items);
        return items;
      },
    };

    // The gutter's members lead the array, which is the only thing keeping them
    // together now that nothing is pinned.
    const [controlColumns, dataColumns] = partition(
      buildColumns(catalog, { masked, numberFormat, departments, departmentPicks, accounts, derived, hotelClusters, currentOu, hotelNames }),
      (column) => controlKeys.has(column.field)
    );

    // Block bands trail the catalog sections — user-defined calculations after
    // the built-in data, in the user's own order.
    const blockColumns = buildBlockColumns(blocks, { numberFormat, accounts, departments, derived });

    return [statusColumn, ...controlColumns, actionsColumn, ...dataColumns, ...blockColumns];
    // `derived` is a ref whose identity never changes — it is listed for
    // honesty, not because it can fire. Nothing left in this array moves on a
    // committed cell edit, which is the point: rebuilding these ~100 colDefs
    // re-runs MUI's whole column pipeline and re-renders every mounted row.
    // Before adding a dependency here, check it cannot change per edit.
  }, [catalog, controlKeys, masked, numberFormat, departments, departmentPicks, accounts, derived, hotelClusters, currentOu, hotelNames, blocks, statusByRow, onDuplicate, onDelete, onEditRow, rowWritable, lockReasonByDepartment, onRecheckAccess]);

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
      writePolicy,
      planLocked,
      // Pooled blocks whose rule decides membership: the weight cell of a row
      // the rule leaves out has nothing to set.
      poolWeightEditable: poolWeightGate(blocks),
    }),
    [masked, maskableKeys, hotelClusters, currentOu, writePolicy, planLocked, blocks]
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

  // One copied row fills every row of the pasted-into range — see the shared
  // helper for why `cellSelection` needs this at all.
  const splitClipboardPastedText = useMemo(
    () => makeCellRangePasteSplitter(apiRef),
    [apiRef]
  );

  // ── Right-click Copy / Paste ──
  // Chording Ctrl+C/Ctrl+V is not comfortable for everyone, so both clipboard
  // actions are also on the cell's context menu. The menu re-enters MUI's own
  // keyboard pipeline (see gridClipboardActions), so a menu Copy/Paste and a
  // keyboard one are indistinguishable: same range serializer, same Excel-
  // shaped splitter, and every write still passes isCellEditable +
  // processRowUpdate — pasting onto a masked or locked cell stays a no-op.
  //
  // The menu lives on the wrapper Box, outside the grid: opening it re-renders
  // the wrapper only, and every prop handed to DataGridPremium keeps its
  // identity, so the grid's own memo skips the render entirely.
  const [cellMenu, setCellMenu] = useState<{
    position: { top: number; left: number };
    id: GridRowId;
    field: string;
  } | null>(null);

  const closeCellMenu = useCallback(() => setCellMenu(null), []);

  const handleGridContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const cellEl = target.closest<HTMLElement>(".MuiDataGrid-cell[data-field]");
      const field = cellEl?.dataset.field;
      const id = cellEl?.closest<HTMLElement>("[data-id]")?.dataset.id;
      // Headers, the gutter columns and empty space keep the default menu.
      if (!cellEl || !field || id === undefined || !isDataColumn(field)) return;
      // Group headers and the aggregation footer are cells too, but not ones
      // a clipboard action can mean anything on.
      if (apiRef.current?.getRowNode(id)?.type !== "leaf") return;
      event.preventDefault();
      // Excel's convention: right-click inside the selected range acts on the
      // range; outside it, the selection moves to the clicked cell first — so
      // "Paste" always lands where the user just pointed.
      if (!apiRef.current?.isCellSelected(id, field)) {
        apiRef.current?.selectCellRange({ id, field }, { id, field });
        apiRef.current?.setCellFocus(id, field);
      }
      setCellMenu({
        position: { top: event.clientY - 4, left: event.clientX + 2 },
        id,
        field,
      });
    },
    [apiRef]
  );

  const handleMenuCopy = useCallback(() => {
    closeCellMenu();
    copyGridSelectionToClipboard(apiRef);
  }, [apiRef, closeCellMenu]);

  const handleMenuPaste = useCallback(() => {
    const menu = cellMenu;
    closeCellMenu();
    // Fire-and-forget: the paste helper resolves after the clipboard read, by
    // which point the menu has closed and returned focus to the grid.
    if (menu) void pasteClipboardIntoGrid(apiRef, menu);
  }, [apiRef, cellMenu, closeCellMenu]);

  // ── Undo/redo (Ctrl+Z / Ctrl+Y) ──
  // The grid's built-in history (MUI v9, on by default) answers the shortcut,
  // but its handlers restore rows with apiRef.updateRows — the DISPLAY cache —
  // and never call processRowUpdate. Left alone, an undo looks applied while
  // the write queue, the live sim and the store all keep the typed value, and
  // a reload resurrects it. This listener runs after the grid has repainted
  // the restored row; it replays that row through the same onRowUpdate
  // pipeline as a typed edit, so an undo sanitizes, cascades (department-code
  // autofill, the salary pair), persists and cluster-syncs exactly as if the
  // user had typed the old value back. Redo is the same event shape.
  const replayHistory = useCallback(
    (params: { eventName: string; data: unknown }) => {
      const data = params.data as
        | { id?: GridRowId; newRows?: ReadonlyMap<GridRowId, unknown> }
        | null
        | undefined;
      // Cell and row edits carry one id; a paste-undo carries a map of rows.
      const ids: GridRowId[] =
        data?.id !== undefined
          ? [data.id]
          : data?.newRows
            ? [...data.newRows.keys()]
            : [];
      if (ids.length === 0) return;
      const before = new Map(rows.map((row) => [row.id, row]));
      for (const id of ids) {
        // The grid already applied the restore, so ITS row is the target state
        // and the page's row (still pre-undo) is the baseline to diff against.
        const restored = apiRef.current?.getRow(id) as PositionRow | undefined;
        const previous = before.get(String(id));
        if (!restored || !previous || restored === previous) continue;
        onRowUpdate(restored, previous);
      }
    },
    [rows, apiRef, onRowUpdate]
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
    // Input Basis moved bands in v31 (end of Basic Salary → head of Contract).
    // Only relocated in layouts that still have it in its old slot, right after
    // Hourly Rate; anyone who dragged it keeps where they put it.
    return healMovedColumn(healed, INPUT_BASIS_KEY, "contractYearlyDays", "hourlyRate");
  }, []);

  // The wrapper exists only to anchor the selection readout, which is absolutely
  // positioned. It adds a DOM node and nothing else: no state, no prop on the
  // grid, and the pill re-renders on its own without involving either.
  return (
    <Box
      sx={{ position: "relative", height: "100%", width: "100%" }}
      onContextMenu={handleGridContextMenu}
    >
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
        onUndo={replayHistory}
        onRedo={replayHistory}
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
      {/* Cleared of the footer, which prints the row and selected-row counts. */}
      <CellSelectionStats apiRef={apiRef} bottom={56} />
      <Menu
        open={cellMenu !== null}
        onClose={closeCellMenu}
        anchorReference="anchorPosition"
        anchorPosition={cellMenu?.position}
      >
        <MenuItem onClick={handleMenuCopy}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Copy</ListItemText>
          {/* The hint teaches the shortcut without requiring it. */}
          <Typography variant="body2" color="text.secondary" sx={{ ml: 3 }}>
            Ctrl+C
          </Typography>
        </MenuItem>
        <MenuItem onClick={handleMenuPaste}>
          <ListItemIcon>
            <ContentPasteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Paste</ListItemText>
          <Typography variant="body2" color="text.secondary" sx={{ ml: 3 }}>
            Ctrl+V
          </Typography>
        </MenuItem>
      </Menu>
    </Box>
  );
}

/**
 * Memoized because the page that owns it holds ~45 pieces of unrelated state —
 * toasts, dialogs, snackbars, the pending-delete confirm — and every one of them
 * re-rendered this grid for nothing. Worth doing only now that the four derived
 * maps are behind one stable ref: while they were props, every prop-identity
 * check here failed on every edit anyway.
 *
 * The remaining props that legitimately move (`rows`, `quickFilter`,
 * `filterModel`, `loading`, `restoredState`) are exactly the ones that SHOULD
 * re-render it. Verify with the dev render counter above: a toast must not move
 * it, a committed edit must move it by one.
 */
export default memo(PositionsGrid);

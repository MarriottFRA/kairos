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
import { alpha } from "@mui/material/styles";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
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
  GridRowId,
  GridRowSelectionModel,
  MuiEvent,
  useGridApiRef,
} from "@mui/x-data-grid-premium";
import {
  BASIC_SALARY_HOURLY_KEY,
  BASIC_SALARY_MONTHLY_KEY,
  FieldCatalog,
  HOTEL_CLUSTER_KEY,
  HOTEL_CLUSTER_MULT_KEY,
  SectionId,
} from "../../shared/positions/fields";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import { BlockDto } from "../../shared/blocks/ipc";
import { BlockResultsById } from "../../shared/positions/liveSim";
import { PositionRow } from "../../shared/positions/rowModel";
import { RowSaveStatus } from "../../services/positionsWriteQueue";
import { buildColumnGroupingModel, buildColumns } from "./columnFactory";
import { buildBlockColumns, buildBlockGroupingEntries } from "./blockColumns";

export const ROW_HEIGHT = 36;
/** Two lines: the short name (up to 2 rows) over the muted unit tag. */
export const HEADER_HEIGHT = 54;
/** One short line — plus room for the "Add column" button the PII band carries. */
export const GROUP_HEADER_HEIGHT = 34;

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
  /** Hotel-cluster definitions for the Cluster picker + Multiplier column;
   *  empty until loaded (the Cluster field then degrades to plain text). */
  hotelClusters: HotelClusterDto[];
  /** The selected hotel — whose weight in an assigned cluster flexes a row. */
  currentOu: string | null;
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

/**
 * A column group that straddles the pinned/scrolling boundary is drawn once on
 * EACH side, so its band header appears twice. Bands that live in the frozen
 * block are therefore pinned all-or-nothing: if any of a band's columns is
 * pinned left, they all are, contiguously, in catalog order.
 *
 * The band lands where its first pinned member already was, so healing one band
 * never reshuffles the ones around it — which matters once the gutter holds
 * more than one. Also heals layouts saved before a band existed.
 */
function healPinnedBand(
  state: GridInitialState,
  bandKeys: string[]
): GridInitialState {
  const left = state.pinnedColumns?.left;
  if (!left || bandKeys.length === 0) return state;
  const at = left.findIndex((field) => bandKeys.includes(field));
  if (at < 0) return state;
  const rest = left.filter((field) => !bandKeys.includes(field));
  // `at` indexes the original array; clamp it into the filtered one.
  const insertAt = Math.min(at, rest.length);
  return {
    ...state,
    pinnedColumns: {
      ...state.pinnedColumns,
      left: [...rest.slice(0, insertAt), ...bandKeys, ...rest.slice(insertAt)],
    },
  };
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
  hotelClusters,
  currentOu,
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
    const actionsColumn: GridColDef<PositionRow> = {
      field: "_actions",
      type: "actions",
      headerName: "",
      width: 44,
      minWidth: 44,
      disableReorder: true,
      getActions: (params) => [
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
      ],
    };

    // The gutter's members lead the array too, so unpinning keeps them together.
    const [controlColumns, dataColumns] = partition(
      buildColumns(catalog, { masked, numberFormat, departments, accounts, vacationCostById, manhoursWorkedById, hotelClusters, currentOu }),
      (column) => controlKeys.has(column.field)
    );

    // Block bands trail the catalog sections — user-defined calculations after
    // the built-in data, in the user's own order.
    const blockColumns = buildBlockColumns(blocks, { numberFormat, accounts, blockResults });

    return [statusColumn, ...controlColumns, actionsColumn, ...dataColumns, ...blockColumns];
  }, [catalog, controlKeys, masked, numberFormat, departments, accounts, vacationCostById, manhoursWorkedById, hotelClusters, currentOu, blocks, blockResults, statusByRow, onDuplicate, onDelete]);

  const columnGroupingModel = useMemo(
    () => [
      ...buildColumnGroupingModel(catalog, onAddField, onManageColumns),
      ...buildBlockGroupingEntries(blocks, onEditBlock),
    ],
    [catalog, onAddField, onManageColumns, blocks, onEditBlock]
  );

  // Only a single-hotel cluster's multiplier may be overridden by hand — with
  // several member hotels the cluster's weights ARE the spread, and a manual
  // number would silently break the split.
  const clusterOverridable = useCallback(
    (row: PositionRow | undefined): boolean => {
      const id =
        typeof row?.[HOTEL_CLUSTER_KEY] === "string"
          ? (row[HOTEL_CLUSTER_KEY] as string)
          : "";
      if (!id) return false;
      const cluster = hotelClusters.find((candidate) => candidate.id === id);
      return (
        !!cluster &&
        cluster.members.length === 1 &&
        cluster.members[0].ou === (currentOu ?? "")
      );
    },
    [hotelClusters, currentOu]
  );

  // Masked PII cells are read-only: blind edits and blind pastes into hidden
  // fields are a data-integrity hazard. Reveal to edit.
  const isCellEditable = useCallback(
    (params: GridCellParams) => {
      if (masked && maskableKeys.has(params.field)) return false;
      // Basic salary: Pay Basis decides which base input is live, so a row only
      // ever drives its base from one field. HOURLY locks Monthly Basic; SALARIED
      // locks Hourly Rate. Flip the Pay Basis toggle to switch which is editable.
      const isHourly = params.row?.payType === "HOURLY";
      if (params.field === BASIC_SALARY_MONTHLY_KEY && isHourly) return false;
      if (params.field === BASIC_SALARY_HOURLY_KEY && !isHourly) return false;
      if (params.field === HOTEL_CLUSTER_MULT_KEY && !clusterOverridable(params.row)) {
        return false;
      }
      return params.colDef.editable !== false;
    },
    [masked, maskableKeys, clusterOverridable]
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
    [editRedirect, openPicker]
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

  const initialState = useMemo<GridInitialState>(() => {
    const keysOfSection = (section: string) =>
      catalog.fields
        .filter((def) => def.section === section && def.visible)
        .map((def) => def.key);
    // Row controls, then the frozen identity block — both pinned whole (see
    // healPinnedBand). The gutter reads select · state · active · actions.
    const controlKeys = keysOfSection("control");
    const piiKeys = keysOfSection("pii");

    const defaults: GridInitialState = {
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
    return healPinnedBand(healPinnedBand(merged, controlKeys), piiKeys);
  }, []);

  return (
    <DataGridPremium
      apiRef={apiRef}
      rows={rows}
      columns={columns}
      loading={loading}
      columnGroupingModel={columnGroupingModel}
      slots={{ columnMenu: ColumnMenu }}
      rowGroupingModel={groupByDept ? ["departmentCode"] : []}
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
      getRowClassName={(params) =>
        (params.row as PositionRow | undefined)?.active === false
          ? "pos-row--inactive"
          : ""
      }
      filterModel={{
        // Inactive positions are hidden rather than removed — they stay in the
        // store, roll forward to next year, and come back with the toggle.
        items: showInactive
          ? []
          : [{ field: "active", operator: "is", value: "true" }],
        quickFilterValues: quickFilter ? quickFilter.split(/\s+/) : [],
      }}
      sx={{
        borderRadius: 2,
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
      }}
    />
  );
}

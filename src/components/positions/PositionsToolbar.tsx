/**
 * PositionsToolbar — the control band above the positions grid.
 * Add row · PII mask toggle · group-by-department · quick filter · column
 * filters · CSV export, plus the aggregate save-status chip fed by the write
 * queue.
 */

import { useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DashboardCustomizeOutlinedIcon from "@mui/icons-material/DashboardCustomizeOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import FilterAltOutlinedIcon from "@mui/icons-material/FilterAltOutlined";
import HistoryToggleOffIcon from "@mui/icons-material/HistoryToggleOff";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import SwapHorizOutlinedIcon from "@mui/icons-material/SwapHorizOutlined";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import WorkspacesIcon from "@mui/icons-material/Workspaces";
import {
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  Tooltip,
} from "@mui/material";
import { QueueState } from "../../services/positionsWriteQueue";

const CONTROL_HEIGHT = 36;

/** Ceiling on one "add several" action — each new row is a queued create. */
export const MAX_BULK_ADD = 50;

const ADD_PRESETS = [5, 10, 25];

export interface PositionsToolbarProps {
  disabled: boolean;
  masked: boolean;
  groupByDept: boolean;
  showInactive: boolean;
  /** Checked rows — drives the whole bulk band. */
  selectedCount: number;
  quickFilter: string;
  /** How many column filters are actually narrowing the grid — a half-built row
   *  in the panel counts for nothing. Drives the badge and the Clear button. */
  filterCount: number;
  queueState: QueueState;
  pendingRows: number;
  /** Append `count` blank positions (1 from the main button, N from its menu). */
  onAddPositions: (count: number) => void;
  /**
   * May this user create rows at all?
   *
   * Separate from `disabled`, which is the loading state. This one is a
   * permission and needs its own sentence — a read-only share, a support lease,
   * a withdrawn delegation and a grant made without `canAddRows` all land here
   * and mean different things.
   */
  canAddPositions?: boolean;
  /** The sentence for the tooltip when `canAddPositions` is false. */
  addBlockedReason?: string | null;
  onAddBlock: () => void;
  /** Open the block-order dialog. Reached from "Add block"'s arrow, because a
   *  band's own cog is already spoken for by its configuration. */
  onReorderBlocks: () => void;
  /** How many blocks this hotel has — one block has no order to change. */
  blockCount: number;
  onToggleMask: () => void;
  onToggleGroup: () => void;
  onToggleInactive: () => void;
  onBulkActive: (active: boolean) => void;
  onBulkDuplicate: () => void;
  onBulkDelete: () => void;
  /** Fill this empty scenario from another year — or another scenario. */
  onCopyFrom: () => void;
  onQuickFilter: (value: string) => void;
  /** Opens the grid's own filter panel — the same one a column's three-dots
   *  menu opens, which MUI anchors to the grid rather than to this button. */
  onOpenFilters: () => void;
  onClearFilters: () => void;
  /**
   * Recompute every block Total from scratch.
   *
   * The grid keeps a compiled plan between edits and only re-runs the numbers
   * while the plan's shape is unchanged (see shared/engine/structureKey). That
   * is guarded by a fuzz test and, in dev, by an assertion — but the guards
   * protect against a bug, and this protects against the guards being wrong.
   * Without it the only way out of a stale total would be to leave the hotel and
   * come back.
   */
  onRefreshTotals: () => void;
}

/**
 * The save state, when there is one worth reporting.
 *
 * Nothing is rendered while the queue is idle. A permanent green "All changes
 * saved" is the state the grid is in almost all of the time, so it carried no
 * information — the states below do, and they read louder without it sitting
 * next to them.
 */
function saveChip(state: QueueState, pendingRows: number) {
  switch (state) {
    case "saving":
      return (
        <Chip
          size="small"
          color="info"
          variant="outlined"
          icon={<CircularProgress size={12} thickness={5} />}
          label="Saving…"
          sx={{ height: 28, fontWeight: 600 }}
        />
      );
    case "dirty":
      return (
        <Chip
          size="small"
          color="warning"
          variant="filled"
          label={`${pendingRows} unsaved`}
          sx={{ height: 28, fontWeight: 600 }}
        />
      );
    case "error":
      return (
        <Chip
          size="small"
          color="error"
          variant="filled"
          label="Save failed — retrying"
          sx={{ height: 28, fontWeight: 600 }}
        />
      );
    case "locked":
      return (
        <Chip
          size="small"
          color="error"
          variant="filled"
          label="Secure store locked — sign in again"
          sx={{ height: 28, fontWeight: 600 }}
        />
      );
    default:
      return null;
  }
}

export default function PositionsToolbar({
  disabled,
  masked,
  groupByDept,
  showInactive,
  selectedCount,
  quickFilter,
  filterCount,
  queueState,
  pendingRows,
  onAddPositions,
  canAddPositions = true,
  addBlockedReason = null,
  onAddBlock,
  onReorderBlocks,
  blockCount,
  onToggleMask,
  onToggleGroup,
  onToggleInactive,
  onBulkActive,
  onBulkDuplicate,
  onBulkDelete,
  onCopyFrom,
  onQuickFilter,
  onOpenFilters,
  onClearFilters,
  onRefreshTotals,
}: PositionsToolbarProps) {
  // Both menus and the custom-count prompt are the toolbar's own business —
  // the page above it only ever hears the resulting intent.
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [blockAnchor, setBlockAnchor] = useState<HTMLElement | null>(null);
  const [bulkAnchor, setBulkAnchor] = useState<HTMLElement | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customCount, setCustomCount] = useState("10");

  const customValid = /^\d+$/.test(customCount.trim())
    ? Number(customCount) >= 1 && Number(customCount) <= MAX_BULK_ADD
    : false;

  const submitCustom = () => {
    if (!customValid) return;
    setCustomOpen(false);
    onAddPositions(Number(customCount));
  };

  const plural = `position${selectedCount === 1 ? "" : "s"}`;

  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
    >
      {/* Split button: the bare click adds one row and drops you into its first
          cell; the arrow adds a batch, which deliberately does not open an
          editor (see addPositions). */}
      {/* The span wrapper is what lets a disabled button still show a tooltip —
          the same idiom "Add block" already uses below. Without it the one
          explanation of why the button is dead never appears. */}
      <Tooltip title={canAddPositions ? "" : addBlockedReason ?? ""}>
        <span>
          <ButtonGroup
            variant="contained"
            disableElevation
            sx={{ height: CONTROL_HEIGHT }}
          >
            <Button
              startIcon={<AddIcon />}
              onClick={() => onAddPositions(1)}
              disabled={disabled || !canAddPositions}
              sx={{ px: 2 }}
            >
              Add position
            </Button>
            <Button
              size="small"
              aria-label="Add several positions"
              onClick={(event) => setAddAnchor(event.currentTarget)}
              disabled={disabled || !canAddPositions}
              sx={{ px: 0.5, minWidth: 32 }}
            >
              <ArrowDropDownIcon />
            </Button>
          </ButtonGroup>
        </span>
      </Tooltip>

      <Menu
        anchorEl={addAnchor}
        open={!!addAnchor}
        onClose={() => setAddAnchor(null)}
      >
        {ADD_PRESETS.map((count) => (
          <MenuItem
            key={count}
            onClick={() => {
              setAddAnchor(null);
              onAddPositions(count);
            }}
          >
            Add {count} positions
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            setAddAnchor(null);
            setCustomOpen(true);
          }}
        >
          Add a specific number…
        </MenuItem>
      </Menu>

      <Dialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Add positions</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Blank rows are appended to the grid, ready to fill in. Up to{" "}
            {MAX_BULK_ADD} at a time.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            type="number"
            label="How many"
            value={customCount}
            onChange={(event) => setCustomCount(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitCustom();
              }
            }}
            error={customCount.trim() !== "" && !customValid}
            helperText={
              customCount.trim() !== "" && !customValid
                ? `Enter a whole number between 1 and ${MAX_BULK_ADD}`
                : " "
            }
            slotProps={{ htmlInput: { min: 1, max: MAX_BULK_ADD } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCustomOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disableElevation
            disabled={!customValid}
            onClick={submitCustom}
          >
            Add
          </Button>
        </DialogActions>
      </Dialog>

      {/* Same split-button idiom as "Add position" above — the tooltip wraps the
          whole group, which is what keeps ButtonGroup's own edge styling: the
          bare click adds a block, the arrow holds what you do to the ones that
          are already there. */}
      <Tooltip title="Add a calculation block — a new set of columns that generates costs or statistics for every position. The arrow reorders the blocks you have.">
        <span>
          <ButtonGroup
            variant="outlined"
            disableElevation
            sx={{ height: CONTROL_HEIGHT }}
          >
            <Button
              startIcon={<DashboardCustomizeOutlinedIcon />}
              onClick={onAddBlock}
              disabled={disabled}
              sx={{ px: 2 }}
            >
              Add block
            </Button>
            <Button
              size="small"
              aria-label="More block options"
              onClick={(event) => setBlockAnchor(event.currentTarget)}
              disabled={disabled}
              sx={{ px: 0.5, minWidth: 32 }}
            >
              <ArrowDropDownIcon />
            </Button>
          </ButtonGroup>
        </span>
      </Tooltip>

      <Menu
        anchorEl={blockAnchor}
        open={!!blockAnchor}
        onClose={() => setBlockAnchor(null)}
      >
        <MenuItem
          disabled={blockCount < 2}
          onClick={() => {
            setBlockAnchor(null);
            onReorderBlocks();
          }}
        >
          <ListItemIcon>
            <SwapHorizOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Reorder blocks…"
            secondary={
              blockCount < 2
                ? "Needs at least two blocks"
                : "Change where each block's columns sit"
            }
          />
        </MenuItem>
      </Menu>

      <Tooltip
        title={
          masked
            ? "PII is masked — cells show dots and are read-only. Click to reveal."
            : "PII is visible. Click to mask."
        }
      >
        <ToggleButton
          value="pii"
          selected={!masked}
          onChange={onToggleMask}
          size="small"
          color="warning"
          disabled={disabled}
          sx={{ height: CONTROL_HEIGHT, px: 1.5, gap: 0.75, fontWeight: 600 }}
        >
          {masked ? (
            <VisibilityOffIcon fontSize="small" />
          ) : (
            <VisibilityIcon fontSize="small" />
          )}
          PII
        </ToggleButton>
      </Tooltip>

      <Tooltip title="Group rows by department">
        <ToggleButton
          value="group"
          selected={groupByDept}
          onChange={onToggleGroup}
          size="small"
          disabled={disabled}
          sx={{ height: CONTROL_HEIGHT, px: 1.5, gap: 0.75, fontWeight: 600 }}
        >
          <WorkspacesIcon fontSize="small" />
          By dept
        </ToggleButton>
      </Tooltip>

      {/* Only present with a selection: the checkbox column is the affordance
          that puts it there, and the band is meaningless without one. The two
          reversible toggles stay inline; everything that creates or destroys
          rows sits behind the menu, which is also where the band stops growing
          as more bulk actions land. */}
      {selectedCount > 0 && (
        <>
          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
          <Chip
            size="small"
            color="primary"
            variant="filled"
            label={`${selectedCount} selected`}
            sx={{ height: 28, fontWeight: 600 }}
          />
          <Button
            variant="outlined"
            size="small"
            onClick={() => onBulkActive(true)}
            sx={{ height: CONTROL_HEIGHT, px: 1.5 }}
          >
            Activate
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={() => onBulkActive(false)}
            sx={{ height: CONTROL_HEIGHT, px: 1.5 }}
          >
            Deactivate
          </Button>
          <Button
            variant="outlined"
            size="small"
            endIcon={<ArrowDropDownIcon />}
            onClick={(event) => setBulkAnchor(event.currentTarget)}
            sx={{ height: CONTROL_HEIGHT, px: 1.5 }}
          >
            Bulk actions
          </Button>
          <Menu
            anchorEl={bulkAnchor}
            open={!!bulkAnchor}
            onClose={() => setBulkAnchor(null)}
          >
            <MenuItem
              onClick={() => {
                setBulkAnchor(null);
                onBulkDuplicate();
              }}
            >
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={`Duplicate ${selectedCount} ${plural}`}
                secondary="Copies keep the contract, not the identity"
              />
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                setBulkAnchor(null);
                onBulkDelete();
              }}
              sx={{ color: "error.main" }}
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" color="error" />
              </ListItemIcon>
              <ListItemText primary={`Delete ${selectedCount} ${plural}`} />
            </MenuItem>
          </Menu>
          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
        </>
      )}

      <Tooltip title="Show positions that are on file but not budgeted this year">
        <ToggleButton
          value="inactive"
          selected={showInactive}
          onChange={onToggleInactive}
          size="small"
          disabled={disabled}
          sx={{ height: CONTROL_HEIGHT, px: 1.5, gap: 0.75, fontWeight: 600 }}
        >
          <HistoryToggleOffIcon fontSize="small" />
          Inactive
        </ToggleButton>
      </Tooltip>

      {/* Column filters hide rows silently, so the count is the point of this
          button — without it a forgotten filter reads as missing data. Clear
          sits beside it rather than inside the panel, which the user has to
          open before they can find out anything is filtered at all. */}
      <ButtonGroup variant="outlined" sx={{ height: CONTROL_HEIGHT }}>
        <Tooltip title="Filter rows by any column's value">
          <span>
            <Button
              onClick={onOpenFilters}
              disabled={disabled}
              startIcon={<FilterAltOutlinedIcon />}
              color={filterCount > 0 ? "primary" : "inherit"}
              sx={{
                height: CONTROL_HEIGHT,
                px: 1.5,
                fontWeight: filterCount > 0 ? 700 : 500,
                borderColor: filterCount > 0 ? undefined : "divider",
                whiteSpace: "nowrap",
              }}
            >
              {filterCount > 0 ? `Filters (${filterCount})` : "Filters"}
            </Button>
          </span>
        </Tooltip>
        {filterCount > 0 && (
          <Tooltip title="Remove every column filter">
            <Button
              onClick={onClearFilters}
              disabled={disabled}
              sx={{ height: CONTROL_HEIGHT, px: 1.5 }}
            >
              Clear
            </Button>
          </Tooltip>
        )}
      </ButtonGroup>

      {/* Deliberately an icon, not a button with a label: on almost every day
          it does nothing visible, because the totals are already right. It is
          here for the day they are not. */}
      <Tooltip title="Recalculate every block total from scratch">
        <span>
          <IconButton
            onClick={onRefreshTotals}
            disabled={disabled}
            size="small"
            sx={{ height: CONTROL_HEIGHT, width: CONTROL_HEIGHT }}
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <TextField
        size="small"
        placeholder="Search positions…"
        value={quickFilter}
        onChange={(event) => onQuickFilter(event.target.value)}
        disabled={disabled}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
        sx={{
          width: 220,
          "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT },
        }}
      />

      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />

      <Tooltip title="Copy every position from another year or scenario into this one">
        <span>
          <Button
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            onClick={onCopyFrom}
            disabled={disabled}
            sx={{ height: CONTROL_HEIGHT, px: 2 }}
          >
            Copy from…
          </Button>
        </span>
      </Tooltip>

      {/* Only the save states that need answering. The budget year and the
          scenario are already named in the app bar pickers directly above this
          toolbar, and repeating them here said nothing the user could not see. */}
      <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
        {saveChip(queueState, pendingRows)}
      </Stack>
    </Stack>
  );
}

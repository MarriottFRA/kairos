/**
 * PositionsToolbar — the control band above the positions grid.
 * Add row · PII mask toggle · group-by-department · quick filter · CSV export,
 * plus the aggregate save-status chip fed by the write queue.
 */

import { useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DashboardCustomizeOutlinedIcon from "@mui/icons-material/DashboardCustomizeOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import DownloadIcon from "@mui/icons-material/Download";
import HistoryToggleOffIcon from "@mui/icons-material/HistoryToggleOff";
import SearchIcon from "@mui/icons-material/Search";
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
  /** Planning context (set in the app bar) — shown as chips on the right. */
  budgetYear: number;
  scenarioLabel: string;
  masked: boolean;
  groupByDept: boolean;
  showInactive: boolean;
  /** Checked rows — drives the whole bulk band. */
  selectedCount: number;
  quickFilter: string;
  queueState: QueueState;
  pendingRows: number;
  /** Append `count` blank positions (1 from the main button, N from its menu). */
  onAddPositions: (count: number) => void;
  onAddBlock: () => void;
  onToggleMask: () => void;
  onToggleGroup: () => void;
  onToggleInactive: () => void;
  onBulkActive: (active: boolean) => void;
  onBulkDuplicate: () => void;
  onBulkDelete: () => void;
  onCopyFromYear: () => void;
  onQuickFilter: (value: string) => void;
  onExportCsv: () => void;
}

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
      return (
        <Chip
          size="small"
          color="success"
          variant="outlined"
          label="All changes saved"
          sx={{ height: 28, fontWeight: 600 }}
        />
      );
  }
}

export default function PositionsToolbar({
  disabled,
  budgetYear,
  scenarioLabel,
  masked,
  groupByDept,
  showInactive,
  selectedCount,
  quickFilter,
  queueState,
  pendingRows,
  onAddPositions,
  onAddBlock,
  onToggleMask,
  onToggleGroup,
  onToggleInactive,
  onBulkActive,
  onBulkDuplicate,
  onBulkDelete,
  onCopyFromYear,
  onQuickFilter,
  onExportCsv,
}: PositionsToolbarProps) {
  // Both menus and the custom-count prompt are the toolbar's own business —
  // the page above it only ever hears the resulting intent.
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
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
      <ButtonGroup variant="contained" disableElevation sx={{ height: CONTROL_HEIGHT }}>
        <Button
          startIcon={<AddIcon />}
          onClick={() => onAddPositions(1)}
          disabled={disabled}
          sx={{ px: 2 }}
        >
          Add position
        </Button>
        <Button
          size="small"
          aria-label="Add several positions"
          onClick={(event) => setAddAnchor(event.currentTarget)}
          disabled={disabled}
          sx={{ px: 0.5, minWidth: 32 }}
        >
          <ArrowDropDownIcon />
        </Button>
      </ButtonGroup>

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

      <Tooltip title="Add a calculation block — a new set of columns that generates costs or statistics for every position">
        <span>
          <Button
            variant="outlined"
            startIcon={<DashboardCustomizeOutlinedIcon />}
            onClick={onAddBlock}
            disabled={disabled}
            sx={{ height: CONTROL_HEIGHT, px: 2 }}
          >
            Add block
          </Button>
        </span>
      </Tooltip>

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
            onClick={onCopyFromYear}
            disabled={disabled}
            sx={{ height: CONTROL_HEIGHT, px: 2 }}
          >
            Copy from…
          </Button>
        </span>
      </Tooltip>

      <Tooltip title="Export the grid as CSV (masked PII exports as dots)">
        <span>
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={onExportCsv}
            disabled={disabled}
            sx={{ height: CONTROL_HEIGHT, px: 2 }}
          >
            CSV
          </Button>
        </span>
      </Tooltip>

      {/* Save state first, then the planning context this grid edits — the
          context strip used to be its own row above the toolbar. */}
      <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
        {saveChip(queueState, pendingRows)}
        <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
        <Tooltip title="Budget year and planning scenario are set in the app bar">
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Chip
              size="small"
              variant="outlined"
              label={`Budget ${budgetYear}`}
              sx={{ height: 28, fontWeight: 600 }}
            />
            <Chip
              size="small"
              variant="outlined"
              color="primary"
              label={scenarioLabel}
              sx={{ height: 28, fontWeight: 600 }}
            />
          </Stack>
        </Tooltip>
      </Stack>
    </Stack>
  );
}

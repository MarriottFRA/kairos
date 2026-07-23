/**
 * PositionsToolbar — the control band above the positions grid.
 * Add row · PII mask toggle · group-by-department · quick filter · CSV export,
 * plus the aggregate save-status chip fed by the write queue.
 */

import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DashboardCustomizeOutlinedIcon from "@mui/icons-material/DashboardCustomizeOutlined";
import DownloadIcon from "@mui/icons-material/Download";
import HistoryToggleOffIcon from "@mui/icons-material/HistoryToggleOff";
import SearchIcon from "@mui/icons-material/Search";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import WorkspacesIcon from "@mui/icons-material/Workspaces";
import {
  Button,
  Chip,
  CircularProgress,
  Divider,
  InputAdornment,
  Stack,
  TextField,
  ToggleButton,
  Tooltip,
} from "@mui/material";
import { QueueState } from "../../services/positionsWriteQueue";

const CONTROL_HEIGHT = 36;

export interface PositionsToolbarProps {
  disabled: boolean;
  /** Planning context (set in the app bar) — shown as chips on the right. */
  budgetYear: number;
  scenarioLabel: string;
  masked: boolean;
  groupByDept: boolean;
  showInactive: boolean;
  /** Checked rows — drives the bulk activate/deactivate pair. */
  selectedCount: number;
  quickFilter: string;
  queueState: QueueState;
  pendingRows: number;
  onAddPosition: () => void;
  onAddBlock: () => void;
  onToggleMask: () => void;
  onToggleGroup: () => void;
  onToggleInactive: () => void;
  onBulkActive: (active: boolean) => void;
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
  onAddPosition,
  onAddBlock,
  onToggleMask,
  onToggleGroup,
  onToggleInactive,
  onBulkActive,
  onCopyFromYear,
  onQuickFilter,
  onExportCsv,
}: PositionsToolbarProps) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
    >
      <Button
        variant="contained"
        disableElevation
        startIcon={<AddIcon />}
        onClick={onAddPosition}
        disabled={disabled}
        sx={{ height: CONTROL_HEIGHT, px: 2 }}
      >
        Add position
      </Button>

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
          that puts it there, and the pair is meaningless without one. */}
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

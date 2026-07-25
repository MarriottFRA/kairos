/**
 * BlockDialog — add or edit a block (the positions grid's calculation bands).
 *
 * Create runs two steps inside one dialog: pick a block type from the palette
 * tiles, then fill the type's config form. Edit opens straight on the form
 * (the type is fixed once created — the stored inputs depend on it). The
 * language is finance-director-first: "Same account for every row", "Apply
 * merit increase", "Calculation only — not included in output".
 */

import { useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import CalendarMonthOutlinedIcon from "@mui/icons-material/CalendarMonthOutlined";
import Grid3x3OutlinedIcon from "@mui/icons-material/Grid3x3Outlined";
import PercentOutlinedIcon from "@mui/icons-material/PercentOutlined";
import PaidOutlinedIcon from "@mui/icons-material/PaidOutlined";
import AccountBalanceOutlinedIcon from "@mui/icons-material/AccountBalanceOutlined";
import {
  BlockBaseRef,
  BlockDto,
  BlockInput,
  BlockSpread,
  BlockType,
} from "../../shared/blocks/ipc";
import { AccountOption } from "../../shared/mappingTables/types";
import AccountAutocomplete from "../common/AccountAutocomplete";

export interface BlockDialogProps {
  open: boolean;
  /** Null = create (starts on the type palette); a block = edit its config. */
  block: BlockDto | null;
  /** Existing blocks — the "multiply another block" base options. */
  blocks: BlockDto[];
  /** KPI drivers for the KPI base options. */
  kpiDrivers: Array<{ id: string; label: string }>;
  /** Synced account cache for the account pickers; empty = free-text entry. */
  accounts: AccountOption[];
  saving?: boolean;
  onClose: () => void;
  onSave: (input: BlockInput) => void;
  /** Edit mode only — soft delete (page shows the undo snackbar). */
  onDelete?: (block: BlockDto) => void;
  /** Palette picked "Social Security / NI" — the parent opens the scheme dialog
   *  (rich brackets/caps/base config) instead of the generic block form. */
  onPickSocialSecurity?: () => void;
}

const TYPE_TILES: Array<{
  type: BlockType;
  title: string;
  blurb: string;
  icon: React.ReactNode;
}> = [
  {
    type: "MULTIPLIER",
    title: "Multiplier of…",
    blurb: "Each row enters a multiplier against a base — salary, another block, hours, days or vacation cost. 0.1 = 10% of salary.",
    icon: <PercentOutlinedIcon />,
  },
  {
    type: "FLAT_MONTHLY",
    title: "Fixed monthly amount",
    blurb: "Each row enters one amount booked every working month. Total = amount × working months.",
    icon: <PaidOutlinedIcon />,
  },
  {
    type: "COUNT_RATE",
    title: "Count × Rate",
    blurb: "Each row enters a count and a rate. Cost goes to one account, the count itself to a statistics account.",
    icon: <Grid3x3OutlinedIcon />,
  },
  {
    type: "CUSTOM_MONTHLY",
    title: "Custom monthly amounts",
    blurb: "Each row types an amount for each of the twelve months — full manual control of the spread.",
    icon: <CalendarMonthOutlinedIcon />,
  },
  {
    type: "SOCIAL_SECURITY",
    title: "Social Security / NI",
    blurb: "An employer contribution (NI, pension, levy…) charged as progressive rate bands over a contributory base you choose. One column per scheme.",
    icon: <AccountBalanceOutlinedIcon />,
  },
];

/** Encode a base ref as a stable Select value. */
function baseValue(base: BlockBaseRef | undefined): string {
  return base ? JSON.stringify(base) : "";
}

export default function BlockDialog({
  open,
  block,
  blocks,
  kpiDrivers,
  accounts,
  saving,
  onClose,
  onSave,
  onDelete,
  onPickSocialSecurity,
}: BlockDialogProps) {
  const isEdit = !!block;
  const [type, setType] = useState<BlockType | null>(null);
  const [label, setLabel] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [accountLocked, setAccountLocked] = useState(true);
  const [statsAccountCode, setStatsAccountCode] = useState("");
  const [base, setBase] = useState<BlockBaseRef | undefined>(undefined);
  const [spread, setSpread] = useState<BlockSpread>("ACTIVE_MONTHS");
  const [increaseAware, setIncreaseAware] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Seed the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setType(block?.blockType ?? null);
    setLabel(block?.label ?? "");
    setAccountCode(block?.accountCode ?? "");
    setAccountLocked(block?.accountLocked ?? true);
    setStatsAccountCode(block?.statsAccountCode ?? "");
    setBase(block?.base);
    setSpread(block?.spread ?? "ACTIVE_MONTHS");
    setIncreaseAware(block?.increaseAware ?? false);
    setConfirmingDelete(false);
  }, [open, block]);

  const baseOptions = useMemo(() => {
    const blockOptions = blocks.filter((candidate) => candidate.id !== block?.id);
    return { blockOptions, kpiDrivers };
  }, [blocks, block, kpiDrivers]);

  const labelError = label.trim() === "";
  const baseError = type === "MULTIPLIER" && !base;
  const valid = !!type && !labelError && !baseError;

  const handleSave = () => {
    if (!type || !valid) return;
    onSave({
      id: isEdit ? block!.id : undefined,
      blockType: type,
      label: label.trim(),
      accountCode,
      accountLocked,
      statsAccountCode: type === "COUNT_RATE" ? statsAccountCode : undefined,
      base: type === "MULTIPLIER" ? base : undefined,
      spread: type === "COUNT_RATE" ? spread : undefined,
      increaseAware: type === "MULTIPLIER" ? undefined : increaseAware,
    });
  };

  const title = isEdit
    ? `Edit "${block!.label}"`
    : type
      ? `New block — ${TYPE_TILES.find((tile) => tile.type === type)?.title}`
      : "Add a block";

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {!type ? (
          // ── Step 1: the palette ──
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              A block adds a set of columns to the positions grid and generates a
              cost or statistics line for every position.
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                gap: 1.5,
              }}
            >
              {TYPE_TILES.map((tile) => (
                <ButtonBase
                  key={tile.type}
                  onClick={() =>
                    tile.type === "SOCIAL_SECURITY"
                      ? onPickSocialSecurity?.()
                      : setType(tile.type)
                  }
                  sx={{
                    p: 1.75,
                    borderRadius: 2,
                    border: (theme) => `1px solid ${theme.palette.divider}`,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    textAlign: "left",
                    gap: 0.75,
                    "&:hover": {
                      borderColor: "primary.main",
                      bgcolor: (theme) => theme.palette.action.hover,
                    },
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Box sx={{ color: "primary.main", display: "flex" }}>{tile.icon}</Box>
                    <Typography variant="subtitle2">{tile.title}</Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {tile.blurb}
                  </Typography>
                </ButtonBase>
              ))}
            </Box>
          </Stack>
        ) : (
          // ── Step 2: the config form ──
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <TextField
              label="Name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              error={labelError}
              size="small"
              fullWidth
              autoFocus={!isEdit}
              helperText="Shown as the column band's title, e.g. Pension, Uniforms, Meals."
            />

            {type === "MULTIPLIER" && (
              <TextField
                select
                label="Multiply against"
                value={baseValue(base)}
                onChange={(event) =>
                  setBase(
                    event.target.value
                      ? (JSON.parse(event.target.value) as BlockBaseRef)
                      : undefined
                  )
                }
                error={baseError}
                size="small"
                fullWidth
                helperText="Each row's multiplier is applied to this value, month by month. Plain number: 0.1 = 10%, 2 = double."
              >
                <ListSubheader>Salary</ListSubheader>
                <MenuItem value={baseValue({ kind: "BASE_SALARY" })}>
                  Basic salary (gross)
                </MenuItem>
                <ListSubheader>Days &amp; hours</ListSubheader>
                <MenuItem value={baseValue({ kind: "CALENDAR", series: "PAY_DAYS" })}>
                  Working days in month
                </MenuItem>
                <MenuItem value={baseValue({ kind: "CALENDAR", series: "REAL_DAYS" })}>
                  Productive days in month
                </MenuItem>
                <MenuItem value={baseValue({ kind: "STAT", stat: "HOURS" })}>
                  Hours worked
                </MenuItem>
                <MenuItem value={baseValue({ kind: "VACATION" })}>
                  Vacation cost
                </MenuItem>
                {baseOptions.blockOptions.length > 0 && (
                  <ListSubheader>Your blocks</ListSubheader>
                )}
                {baseOptions.blockOptions.map((candidate) => (
                  <MenuItem
                    key={candidate.id}
                    value={baseValue({ kind: "BLOCK", blockId: candidate.id })}
                  >
                    {candidate.label}
                  </MenuItem>
                ))}
                {baseOptions.kpiDrivers.length > 0 && <ListSubheader>KPIs</ListSubheader>}
                {baseOptions.kpiDrivers.map((driver) => (
                  <MenuItem
                    key={driver.id}
                    value={baseValue({ kind: "KPI", kpiDriverId: driver.id })}
                  >
                    {driver.label}
                  </MenuItem>
                ))}
              </TextField>
            )}

            {type === "COUNT_RATE" && (
              <Stack spacing={1}>
                <Typography variant="subtitle2">Spread the year's figures</Typography>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={spread}
                  onChange={(_event, next: BlockSpread | null) => next && setSpread(next)}
                >
                  <ToggleButton value="ACTIVE_MONTHS">Evenly over months</ToggleButton>
                  <ToggleButton value="DAYS">By days in month</ToggleButton>
                  <ToggleButton value="VACATION_PATTERN">Like vacation</ToggleButton>
                </ToggleButtonGroup>
                <Typography variant="caption" color="text.secondary">
                  {spread === "ACTIVE_MONTHS"
                    ? "The yearly total is split evenly across each position's working months."
                    : spread === "DAYS"
                      ? "Months with more working days carry proportionally more."
                      : "Follows each position's vacation pattern — the months leave is taken in."}
                </Typography>
              </Stack>
            )}

            <Divider />

            <Stack spacing={1}>
              <Typography variant="subtitle2">
                {type === "COUNT_RATE" ? "Cost account" : "Account"}
              </Typography>
              <AccountAutocomplete
                options={accounts}
                value={accountCode}
                onChange={setAccountCode}
                size="small"
              />
              <Typography variant="caption" color="text.secondary">
                {accountCode
                  ? "The generated line posts to this account."
                  : "No account: the block still calculates (and other blocks can use it) but it is not included in the output."}
              </Typography>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={accountLocked}
                    onChange={(event) => setAccountLocked(event.target.checked)}
                  />
                }
                label={
                  <Typography variant="body2">
                    Same account for every row
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      {accountLocked ? "" : "— each row gets its own account dropdown"}
                    </Typography>
                  </Typography>
                }
              />
            </Stack>

            {type === "COUNT_RATE" && (
              <Stack spacing={1}>
                <Typography variant="subtitle2">Statistics account (for the count)</Typography>
                <AccountAutocomplete
                  options={accounts}
                  value={statsAccountCode}
                  onChange={setStatsAccountCode}
                  size="small"
                />
                <Typography variant="caption" color="text.secondary">
                  The count itself (not the cost) posts here — statistics accounts
                  usually start with 9.
                </Typography>
              </Stack>
            )}

            {type !== "MULTIPLIER" && (
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={increaseAware}
                    onChange={(event) => setIncreaseAware(event.target.checked)}
                  />
                }
                label={
                  <Typography variant="body2">
                    Apply merit increase
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      — amounts grow with each position's increase from its increase month
                    </Typography>
                  </Typography>
                }
              />
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {isEdit && onDelete && (
          <Button
            color="error"
            onClick={() => {
              if (!confirmingDelete) {
                setConfirmingDelete(true);
                return;
              }
              onDelete(block!);
            }}
            disabled={saving}
            sx={{ mr: "auto" }}
          >
            {confirmingDelete ? "Really delete?" : "Delete block"}
          </Button>
        )}
        {!isEdit && type && (
          <Button onClick={() => setType(null)} disabled={saving} sx={{ mr: "auto" }}>
            Back
          </Button>
        )}
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        {type && (
          <Button variant="contained" onClick={handleSave} disabled={!valid || saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add block"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

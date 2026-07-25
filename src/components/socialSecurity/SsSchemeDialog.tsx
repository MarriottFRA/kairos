/**
 * SsSchemeDialog — configure the permanent National Insurance / Social Security
 * block: its progressive rate bands, optional monthly/yearly caps, the GL
 * account, and whether Base Salary is in the contributory base. Opened from the
 * NI block's cog on the positions grid. The parent orchestrates the two saves
 * (scheme + block); this dialog only gathers and validates the input.
 *
 * A 0%-rate first band is the tax-free allowance; leave the top band's "Up to"
 * blank for "and above".
 */

import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Checkbox from "@mui/material/Checkbox";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import { BlockDto } from "../../shared/blocks/ipc";
import { AccountOption } from "../../shared/mappingTables/types";
import {
  SsSchemeInput,
  validateSsSchemeInput,
} from "../../shared/socialSecurity/ipc";
import {
  SocialSecurityScheme,
  SsAccumulationMode,
  SS_MAX_BRACKETS,
} from "../../shared/engine/types";
import AccountAutocomplete from "../common/AccountAutocomplete";

const MONTH_NAMES = Array.from({ length: 12 }, (_, m) =>
  new Date(2000, m, 1).toLocaleString("en", { month: "long" })
);

/** What the dialog hands back — the parent resolves the scheme id + saves. The
 *  contributory base now lives on the scheme itself; only the GL account is a
 *  block-level property. */
export interface SsSchemeDialogSave {
  scheme: SsSchemeInput;
  accountCode: string;
}

export interface SsSchemeDialogProps {
  open: boolean;
  /** The SS block being edited (carries the attached scheme id + account), or
   *  null when adding a new scheme. */
  niBlock: BlockDto | null;
  /** All schemes for the OU (from blocks:list) — to seed the attached one. */
  schemes: SocialSecurityScheme[];
  /** All blocks for the OU — the non-SS ones are the base-membership candidates. */
  blocks: BlockDto[];
  accounts: AccountOption[];
  saving?: boolean;
  onClose: () => void;
  onSave: (save: SsSchemeDialogSave) => void;
  /** Save the config, then run the opening-balance pre-sim. */
  onRecompute: (save: SsSchemeDialogSave) => void;
  /** Edit mode only — remove the block (its column). Page shows undo. */
  onDelete?: (block: BlockDto) => void;
}

interface BandRow {
  upTo: string; // blank = no upper limit (only valid on the last band)
  rate: string; // percent, e.g. "12" for 12%
}

function toNullableNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : NaN;
}

export default function SsSchemeDialog({
  open,
  niBlock,
  schemes,
  blocks,
  accounts,
  saving,
  onClose,
  onSave,
  onRecompute,
  onDelete,
}: SsSchemeDialogProps) {
  const attached = useMemo(
    () =>
      niBlock?.ssSchemeId
        ? schemes.find((scheme) => scheme.id === niBlock.ssSchemeId)
        : undefined,
    [niBlock, schemes]
  );

  // The non-SS blocks are the custom base-membership candidates (a scheme never
  // includes another SS block). Keyed by costDefId — the id stored in the base.
  const baseCandidates = useMemo(
    () => blocks.filter((block) => block.blockType !== "SOCIAL_SECURITY"),
    [blocks]
  );

  const [label, setLabel] = useState("National Insurance");
  const [bands, setBands] = useState<BandRow[]>([{ upTo: "", rate: "0" }]);
  const [monthlyCap, setMonthlyCap] = useState("");
  const [yearlyCap, setYearlyCap] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [includeBaseSalary, setIncludeBaseSalary] = useState(true);
  const [includeVacation, setIncludeVacation] = useState(true);
  const [baseComponentIds, setBaseComponentIds] = useState<string[]>([]);
  const [accumulationMode, setAccumulationMode] = useState<SsAccumulationMode>("CUMULATIVE");
  const [taxYearStartMonth, setTaxYearStartMonth] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAccountCode(niBlock?.accountCode ?? "");
    setIncludeBaseSalary(attached?.includeBaseSalary ?? true);
    setIncludeVacation(attached?.includeVacation ?? true);
    setBaseComponentIds(attached?.baseComponentIds ? [...attached.baseComponentIds] : []);
    setAccumulationMode(attached?.accumulationMode ?? "CUMULATIVE");
    setTaxYearStartMonth(attached?.taxYearStartMonth ?? 1);
    if (attached) {
      setLabel(attached.label);
      setBands(
        attached.brackets.map((bracket) => ({
          upTo: bracket.upTo === null ? "" : String(bracket.upTo),
          rate: String(bracket.rate * 100),
        }))
      );
      setMonthlyCap(attached.monthlyCap === null ? "" : String(attached.monthlyCap));
      setYearlyCap(attached.yearlyCap === null ? "" : String(attached.yearlyCap));
    } else {
      setLabel(niBlock?.label && niBlock.label !== "National Insurance" ? niBlock.label : "National Insurance");
      setBands([{ upTo: "", rate: "0" }]);
      setMonthlyCap("");
      setYearlyCap("");
    }
  }, [open, attached, niBlock]);

  const toggleBaseComponent = (costDefId: string, checked: boolean) =>
    setBaseComponentIds((ids) =>
      checked ? [...new Set([...ids, costDefId])] : ids.filter((id) => id !== costDefId)
    );

  const setBand = (index: number, patch: Partial<BandRow>) =>
    setBands((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const addBand = () =>
    setBands((rows) => (rows.length >= SS_MAX_BRACKETS ? rows : [...rows, { upTo: "", rate: "0" }]));
  const removeBand = (index: number) =>
    setBands((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));

  const build = (): SsSchemeInput => ({
    id: attached?.id,
    label: label.trim(),
    monthlyCap: toNullableNumber(monthlyCap),
    yearlyCap: toNullableNumber(yearlyCap),
    brackets: bands.map((band) => {
      const upToNum = toNullableNumber(band.upTo);
      const rateNum = Number(band.rate.trim());
      return {
        upTo: upToNum,
        rate: Number.isFinite(rateNum) ? rateNum / 100 : NaN,
      };
    }),
    accumulationMode,
    taxYearStartMonth: accumulationMode === "CUMULATIVE" ? taxYearStartMonth : 1,
    includeBaseSalary,
    includeVacation,
    // Keep only ids of blocks that still exist (a block may have been deleted).
    baseComponentIds: baseComponentIds.filter((id) =>
      baseCandidates.some((block) => block.costDefId === id)
    ),
  });

  const submit = (action: (save: SsSchemeDialogSave) => void) => {
    const scheme = build();
    try {
      validateSsSchemeInput(scheme);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That configuration is not valid.");
      return;
    }
    action({ scheme, accountCode });
  };

  const cumulativeNonJan =
    accumulationMode === "CUMULATIVE" && taxYearStartMonth > 1;

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {niBlock ? "Social Security / National Insurance" : "Add Social Security / NI scheme"}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Contributions are worked out as progressive rate bands over the
            contributory base. A 0% first band is a tax-free allowance; leave the
            top band&apos;s “Up to” blank for “and above”.
          </Typography>

          <TextField
            label="Scheme name"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            error={label.trim() === ""}
            size="small"
            fullWidth
          />

          <Stack spacing={1}>
            <Typography variant="subtitle2">Rate bands</Typography>
            {bands.map((band, index) => {
              const isLast = index === bands.length - 1;
              return (
                <Stack key={index} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <TextField
                    label="Up to"
                    value={band.upTo}
                    onChange={(event) => setBand(index, { upTo: event.target.value })}
                    placeholder={isLast ? "no limit" : ""}
                    size="small"
                    type="number"
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Rate"
                    value={band.rate}
                    onChange={(event) => setBand(index, { rate: event.target.value })}
                    size="small"
                    type="number"
                    sx={{ width: 120 }}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">%</InputAdornment>
                        ),
                      },
                    }}
                  />
                  <IconButton
                    aria-label="Remove band"
                    size="small"
                    onClick={() => removeBand(index)}
                    disabled={bands.length <= 1}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Stack>
              );
            })}
            <Box>
              <Button
                size="small"
                startIcon={<AddOutlinedIcon />}
                onClick={addBand}
                disabled={bands.length >= SS_MAX_BRACKETS}
              >
                Add band
              </Button>
            </Box>
          </Stack>

          <Divider />

          <Stack direction="row" spacing={1}>
            <TextField
              label="Monthly cap"
              value={monthlyCap}
              onChange={(event) => setMonthlyCap(event.target.value)}
              size="small"
              type="number"
              fullWidth
              helperText="Blank = no cap"
            />
            <TextField
              label="Yearly cap"
              value={yearlyCap}
              onChange={(event) => setYearlyCap(event.target.value)}
              size="small"
              type="number"
              fullWidth
              helperText="Blank = no cap"
            />
          </Stack>

          <Divider />

          <Stack spacing={1}>
            <Typography variant="subtitle2">Accumulation</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={accumulationMode}
              onChange={(_event, next: SsAccumulationMode | null) =>
                next && setAccumulationMode(next)
              }
            >
              <ToggleButton value="CUMULATIVE">Cumulative (annual)</ToggleButton>
              <ToggleButton value="PER_PERIOD">Per period (monthly)</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary">
              {accumulationMode === "PER_PERIOD"
                ? "Each month is charged on its own (UK National Insurance). The yearly cap and opening balances do not apply."
                : "The base runs up across the tax year against the yearly cap (UK PAYE / annual schemes)."}
            </Typography>
            {accumulationMode === "CUMULATIVE" && (
              <TextField
                select
                label="Tax year starts"
                value={taxYearStartMonth}
                onChange={(event) => setTaxYearStartMonth(Number(event.target.value))}
                size="small"
                sx={{ maxWidth: 220 }}
              >
                {MONTH_NAMES.map((name, index) => (
                  <MenuItem key={name} value={index + 1}>
                    {name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {cumulativeNonJan && (
              <Box>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => submit(onRecompute)}
                  disabled={saving}
                >
                  Recompute opening balances
                </Button>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mt: 0.5 }}
                >
                  Saves, then estimates each position&apos;s prior-year contributions
                  carried into this tax year (this year&apos;s pay, no rise). Fills this
                  scheme&apos;s Opening base column — overridable per row.
                </Typography>
              </Box>
            )}
          </Stack>

          <Divider />

          <Stack spacing={1}>
            <Typography variant="subtitle2">Account</Typography>
            <AccountAutocomplete
              options={accounts}
              value={accountCode}
              onChange={setAccountCode}
              size="small"
            />
            <Typography variant="caption" color="text.secondary">
              The NI cost line posts to this account. Leave blank for calculation
              only (not included in the output).
            </Typography>
          </Stack>

          <Divider />

          <Stack spacing={0.5}>
            <Typography variant="subtitle2">Contributory base</Typography>
            <Typography variant="caption" color="text.secondary">
              Which pay elements this scheme is charged on. Base Salary and Vacation
              are separate — contribute on either, both, or neither.
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={includeBaseSalary}
                  onChange={(event) => setIncludeBaseSalary(event.target.checked)}
                />
              }
              label={<Typography variant="body2">Base Salary (excl. vacation)</Typography>}
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={includeVacation}
                  onChange={(event) => setIncludeVacation(event.target.checked)}
                />
              }
              label={<Typography variant="body2">Vacation</Typography>}
            />
            {baseCandidates.map((block) => (
              <FormControlLabel
                key={block.costDefId}
                control={
                  <Checkbox
                    size="small"
                    checked={baseComponentIds.includes(block.costDefId)}
                    onChange={(event) =>
                      toggleBaseComponent(block.costDefId, event.target.checked)
                    }
                  />
                }
                label={<Typography variant="body2">{block.label}</Typography>}
              />
            ))}
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {niBlock && onDelete && (
          <Button color="error" onClick={() => onDelete(niBlock)} disabled={saving}>
            Delete
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => submit(onSave)} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

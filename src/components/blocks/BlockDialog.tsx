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
import Checkbox from "@mui/material/Checkbox";
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
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import Autocomplete from "@mui/material/Autocomplete";
import Chip from "@mui/material/Chip";
import {
  BlockBaseRef,
  BlockDto,
  BlockInput,
  BlockSpread,
  BlockType,
  POOL_MONTHS,
  POOL_SPREAD_BASES,
  POOL_SPREAD_BASE_META,
  PoolEligibilityMode,
  PoolSource,
  PoolSpreadBase,
} from "../../shared/blocks/ipc";
import { JOB_TYPE_OPTIONS } from "../../shared/positions/fieldSeed";
import {
  AccountOption,
  DepartmentOption,
} from "../../shared/mappingTables/types";
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
  /** Department reference data for a pooled block's eligibility rule. */
  departments?: DepartmentOption[];
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
  {
    type: "POOL_SPREAD",
    title: "Shared pool",
    blurb: "One pot — a KPI or a typed amount — divided among the positions that earn it. Gratuities, service charge, a bonus fund.",
    icon: <GroupsOutlinedIcon />,
  },
];

const MONTH_LABELS = Array.from({ length: POOL_MONTHS }, (_unused, m) =>
  new Date(2000, m, 1).toLocaleString("en", { month: "short" })
);

const JOB_TYPE_CODES = JOB_TYPE_OPTIONS.map((option) => option.value);

/**
 * Encode a base ref as a stable Select value. A composite's contents change as
 * the user ticks boxes, so it collapses to a sentinel — the Select only picks
 * the KIND, and the checkbox list below it owns the members.
 */
const COMPOSITE_OPTION = "COMPOSITE";
function baseValue(base: BlockBaseRef | undefined): string {
  if (!base) return "";
  return base.kind === "COMPOSITE" ? COMPOSITE_OPTION : JSON.stringify(base);
}

/** A composite with nothing ticked multiplies against zero — treat as unset. */
function isEmptyComposite(base: BlockBaseRef | undefined): boolean {
  return (
    base?.kind === "COMPOSITE" &&
    !base.includeBaseSalary &&
    base.blockIds.length === 0
  );
}

export default function BlockDialog({
  open,
  block,
  blocks,
  kpiDrivers,
  accounts,
  departments = [],
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
  // Pooled-block config.
  const [poolSource, setPoolSource] = useState<PoolSource>("KPI");
  const [poolKpiDriverId, setPoolKpiDriverId] = useState("");
  // Held as text so a half-typed "1200." survives the keystroke.
  const [poolAmounts, setPoolAmounts] = useState<string[]>(
    Array(POOL_MONTHS).fill("")
  );
  const [poolSpreadBase, setPoolSpreadBase] =
    useState<PoolSpreadBase>("HEADCOUNT");
  const [poolEligibilityMode, setPoolEligibilityMode] =
    useState<PoolEligibilityMode>("MANUAL");
  const [poolDepartments, setPoolDepartments] = useState<string[]>([]);
  const [poolJobTypes, setPoolJobTypes] = useState<string[]>([]);

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
    setPoolSource(block?.poolSource ?? "KPI");
    setPoolKpiDriverId(block?.poolKpiDriverId ?? "");
    setPoolAmounts(
      Array.from({ length: POOL_MONTHS }, (_unused, m) => {
        const amount = block?.poolMonthlyAmounts?.[m];
        return typeof amount === "number" && amount !== 0 ? String(amount) : "";
      })
    );
    setPoolSpreadBase(block?.poolSpreadBase ?? "HEADCOUNT");
    setPoolEligibilityMode(block?.poolEligibilityMode ?? "MANUAL");
    setPoolDepartments(block?.poolDepartments ?? []);
    setPoolJobTypes(block?.poolJobTypes ?? []);
  }, [open, block]);

  const baseOptions = useMemo(() => {
    const blockOptions = blocks.filter((candidate) => candidate.id !== block?.id);
    return { blockOptions, kpiDrivers };
  }, [blocks, block, kpiDrivers]);

  const departmentNameByCode = useMemo(
    () => new Map(departments.map((dept) => [dept.code, dept.name])),
    [departments]
  );
  // A saved code the mapping tables no longer carry stays selectable, so
  // editing something unrelated cannot silently drop it from the rule.
  const departmentCodes = useMemo(() => {
    const codes = departments.map((dept) => dept.code);
    const known = new Set(codes);
    return [...codes, ...poolDepartments.filter((code) => !known.has(code))];
  }, [departments, poolDepartments]);
  const jobTypeCodes = useMemo(() => {
    const known = new Set(JOB_TYPE_CODES);
    return [
      ...JOB_TYPE_CODES,
      ...poolJobTypes.filter((code) => !known.has(code)),
    ];
  }, [poolJobTypes]);

  const labelError = label.trim() === "";
  const baseError = type === "MULTIPLIER" && (!base || isEmptyComposite(base));
  const isPool = type === "POOL_SPREAD";
  const poolAmountValues = useMemo(
    () =>
      poolAmounts.map((text) => {
        const value = Number(text.trim());
        return text.trim() === "" ? 0 : value;
      }),
    [poolAmounts]
  );
  const poolAmountError =
    isPool &&
    poolSource === "MANUAL" &&
    poolAmountValues.some((value) => !Number.isFinite(value));
  const poolKpiError = isPool && poolSource === "KPI" && !poolKpiDriverId;
  const valid =
    !!type && !labelError && !baseError && !poolAmountError && !poolKpiError;

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
      // A pooled block's share IS the pot; a merit increase would inflate it.
      increaseAware:
        type === "MULTIPLIER" || isPool ? undefined : increaseAware,
      poolSource: isPool ? poolSource : undefined,
      poolKpiDriverId:
        isPool && poolSource === "KPI" ? poolKpiDriverId : undefined,
      poolMonthlyAmounts:
        isPool && poolSource === "MANUAL" ? poolAmountValues : undefined,
      poolSpreadBase: isPool ? poolSpreadBase : undefined,
      poolEligibilityMode: isPool ? poolEligibilityMode : undefined,
      poolDepartments:
        isPool && poolEligibilityMode === "RULE" ? poolDepartments : undefined,
      poolJobTypes:
        isPool && poolEligibilityMode === "RULE" ? poolJobTypes : undefined,
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
                onChange={(event) => {
                  const picked = event.target.value;
                  if (!picked) return setBase(undefined);
                  if (picked === COMPOSITE_OPTION) {
                    // Keep the members if the user is re-picking "several
                    // things" after straying to another kind and back.
                    return setBase(
                      base?.kind === "COMPOSITE"
                        ? base
                        : { kind: "COMPOSITE", includeBaseSalary: true, blockIds: [] }
                    );
                  }
                  setBase(JSON.parse(picked) as BlockBaseRef);
                }}
                error={baseError}
                size="small"
                fullWidth
                helperText="Each row's multiplier is applied to this value, month by month. Plain number: 0.1 = 10%, 2 = double."
              >
                <ListSubheader>Salary</ListSubheader>
                <MenuItem value={baseValue({ kind: "BASE_SALARY" })}>
                  Basic salary (gross)
                </MenuItem>
                <MenuItem value={COMPOSITE_OPTION}>
                  Several things added together…
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

            {type === "MULTIPLIER" && base?.kind === "COMPOSITE" && (
              <Stack
                spacing={0.25}
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  border: (theme) => `1px solid ${theme.palette.divider}`,
                }}
              >
                <Typography variant="subtitle2">Add up</Typography>
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={base.includeBaseSalary}
                      onChange={(event) =>
                        setBase({ ...base, includeBaseSalary: event.target.checked })
                      }
                    />
                  }
                  label="Basic salary (gross)"
                />
                {baseOptions.blockOptions.map((candidate) => (
                  <FormControlLabel
                    key={candidate.id}
                    control={
                      <Checkbox
                        size="small"
                        checked={base.blockIds.includes(candidate.id)}
                        onChange={(event) =>
                          setBase({
                            ...base,
                            blockIds: event.target.checked
                              ? [...base.blockIds, candidate.id]
                              : base.blockIds.filter((id) => id !== candidate.id),
                          })
                        }
                      />
                    }
                    label={candidate.label}
                  />
                ))}
                <Typography variant="caption" color="text.secondary" sx={{ pt: 0.5 }}>
                  {baseError
                    ? "Tick at least one thing to multiply against."
                    : "The multiplier applies to the sum of everything ticked, month by month."}
                </Typography>
              </Stack>
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
                  <ToggleButton value="WEIGHTED_BASE">Like salary</ToggleButton>
                </ToggleButtonGroup>
                <Typography variant="caption" color="text.secondary">
                  {spread === "ACTIVE_MONTHS"
                    ? "The yearly total is split evenly across each position's working months."
                    : spread === "DAYS"
                      ? "Months with more working days carry proportionally more."
                      : spread === "WEIGHTED_BASE"
                        ? "Follows each position's basic salary curve, so a mid-year raise pulls more of the total into the later months."
                        : "Follows each position's vacation pattern — the months leave is taken in."}
                </Typography>
              </Stack>
            )}

            {isPool && (
              <>
                <Stack spacing={1}>
                  <Typography variant="subtitle2">The pot</Typography>
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={poolSource}
                    onChange={(_event, next: PoolSource | null) =>
                      next && setPoolSource(next)
                    }
                  >
                    <ToggleButton value="KPI">From a KPI</ToggleButton>
                    <ToggleButton value="MANUAL">Typed amounts</ToggleButton>
                  </ToggleButtonGroup>

                  {poolSource === "KPI" ? (
                    <>
                      <TextField
                        select
                        label="KPI"
                        value={poolKpiDriverId}
                        onChange={(event) =>
                          setPoolKpiDriverId(event.target.value)
                        }
                        error={poolKpiError}
                        size="small"
                        fullWidth
                      >
                        {kpiDrivers.map((driver) => (
                          <MenuItem key={driver.id} value={driver.id}>
                            {driver.label}
                          </MenuItem>
                        ))}
                      </TextField>
                      <Typography variant="caption" color="text.secondary">
                        The KPI's monthly value is the pot for that month. Give
                        the KPI its own multiplier to turn a revenue figure into
                        a fund — 0.12 over the F&amp;B revenue accounts is a
                        gratuity pot.
                      </Typography>
                    </>
                  ) : (
                    <>
                      <Box
                        sx={{
                          display: "grid",
                          gridTemplateColumns: "repeat(4, 1fr)",
                          gap: 1,
                        }}
                      >
                        {poolAmounts.map((amount, index) => (
                          <TextField
                            key={MONTH_LABELS[index]}
                            label={MONTH_LABELS[index]}
                            value={amount}
                            onChange={(event) =>
                              setPoolAmounts((current) =>
                                current.map((existing, m) =>
                                  m === index ? event.target.value : existing
                                )
                              )
                            }
                            size="small"
                          />
                        ))}
                      </Box>
                      <Button
                        size="small"
                        onClick={() =>
                          setPoolAmounts((current) =>
                            Array(POOL_MONTHS).fill(current[0] ?? "")
                          )
                        }
                        sx={{ alignSelf: "flex-start" }}
                      >
                        Copy January to every month
                      </Button>
                      {poolAmountError && (
                        <Typography variant="caption" color="error">
                          Every month must be a number (or blank for nothing).
                        </Typography>
                      )}
                    </>
                  )}
                </Stack>

                <Stack spacing={1}>
                  <Typography variant="subtitle2">Divide it by</Typography>
                  <TextField
                    select
                    value={poolSpreadBase}
                    onChange={(event) =>
                      setPoolSpreadBase(event.target.value as PoolSpreadBase)
                    }
                    size="small"
                    fullWidth
                    helperText={POOL_SPREAD_BASE_META[poolSpreadBase].hint}
                  >
                    {POOL_SPREAD_BASES.map((option) => (
                      <MenuItem key={option} value={option}>
                        {POOL_SPREAD_BASE_META[option].label}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Typography variant="caption" color="text.secondary">
                    Each position's share also follows its working months and
                    hotel-cluster share, and the whole pot is always spread — if
                    someone drops out of a month, the others take more.
                  </Typography>
                </Stack>

                <Stack spacing={1}>
                  <Typography variant="subtitle2">Who shares it</Typography>
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={poolEligibilityMode}
                    onChange={(_event, next: PoolEligibilityMode | null) =>
                      next && setPoolEligibilityMode(next)
                    }
                  >
                    <ToggleButton value="MANUAL">Tick each position</ToggleButton>
                    <ToggleButton value="RULE">By department / classification</ToggleButton>
                  </ToggleButtonGroup>

                  {poolEligibilityMode === "MANUAL" ? (
                    <Typography variant="caption" color="text.secondary">
                      The grid gets a tick box column — tick the positions that
                      share this pot.
                    </Typography>
                  ) : (
                    <>
                      <Autocomplete
                        multiple
                        size="small"
                        options={departmentCodes}
                        value={poolDepartments}
                        onChange={(_event, next) => setPoolDepartments(next)}
                        getOptionLabel={(code) =>
                          departmentNameByCode.get(code)
                            ? `${code} — ${departmentNameByCode.get(code)}`
                            : code
                        }
                        renderValue={(value, getItemProps) =>
                          value.map((code, index) => (
                            <Chip
                              size="small"
                              label={code}
                              {...getItemProps({ index })}
                              key={code}
                            />
                          ))
                        }
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            label="Departments"
                            placeholder="Any department"
                          />
                        )}
                      />
                      <Autocomplete
                        multiple
                        size="small"
                        options={jobTypeCodes}
                        value={poolJobTypes}
                        onChange={(_event, next) => setPoolJobTypes(next)}
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            label="Classifications"
                            placeholder="Any classification"
                          />
                        )}
                      />
                      <Typography variant="caption" color="text.secondary">
                        Leave a list empty to mean "any". The grid's tick box
                        becomes read-only and shows who this rule selects.
                      </Typography>
                    </>
                  )}
                </Stack>
              </>
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

            {type !== "MULTIPLIER" && !isPool && (
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

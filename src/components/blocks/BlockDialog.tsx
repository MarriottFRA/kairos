/**
 * BlockDialog — add or edit a block (the positions grid's calculation bands).
 *
 * Create runs two steps inside one dialog: pick a block type from the palette
 * tiles, then fill the type's config form. Edit opens straight on the form
 * (the type is fixed once created — the stored inputs depend on it). The
 * language is finance-director-first: "Same account for every row", "Apply
 * merit increase", "Calculation only — not included in output".
 *
 * Step one has two tabs. "Build your own" is the type palette. "Ready-made" is
 * a catalogue of named starting points (Pension, Overtime, the country social
 * security schemes) that insert ORDINARY blocks with the fiddly parts already
 * chosen — nothing about them is special once inserted, which is why the pane's
 * copy leads with that. Statutory rows are the exception to one-click insert:
 * they open the scheme dialog pre-filled so someone reads the rates first.
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
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { alpha, Theme } from "@mui/material/styles";
import CalendarMonthOutlinedIcon from "@mui/icons-material/CalendarMonthOutlined";
import Grid3x3OutlinedIcon from "@mui/icons-material/Grid3x3Outlined";
import PercentOutlinedIcon from "@mui/icons-material/PercentOutlined";
import PaidOutlinedIcon from "@mui/icons-material/PaidOutlined";
import AccountBalanceOutlinedIcon from "@mui/icons-material/AccountBalanceOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import FunctionsOutlinedIcon from "@mui/icons-material/FunctionsOutlined";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import SavingsOutlinedIcon from "@mui/icons-material/SavingsOutlined";
import MoreTimeOutlinedIcon from "@mui/icons-material/MoreTimeOutlined";
import RedeemOutlinedIcon from "@mui/icons-material/RedeemOutlined";
import CardGiftcardOutlinedIcon from "@mui/icons-material/CardGiftcardOutlined";
import BadgeOutlinedIcon from "@mui/icons-material/BadgeOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import DirectionsBusOutlinedIcon from "@mui/icons-material/DirectionsBusOutlined";
import RestaurantOutlinedIcon from "@mui/icons-material/RestaurantOutlined";
import CheckroomOutlinedIcon from "@mui/icons-material/CheckroomOutlined";
import LocalHospitalOutlinedIcon from "@mui/icons-material/LocalHospitalOutlined";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import SchoolOutlinedIcon from "@mui/icons-material/SchoolOutlined";
import Autocomplete from "@mui/material/Autocomplete";
import Chip from "@mui/material/Chip";
import {
  BLOCK_COMBINE_OPS,
  BLOCK_COMBINE_OP_META,
  BLOCK_SPREAD_META,
  BlockBaseRef,
  BlockCombineOp,
  BlockDepartmentMode,
  BlockDto,
  BlockInput,
  BlockSpread,
  BlockType,
  POOL_MONTHS,
  POOL_SPREAD_BASES,
  POOL_SPREAD_BASE_META,
  POOL_WEIGHT_MAX,
  PoolEligibilityMode,
  PoolSource,
  PoolSpreadBase,
} from "../../shared/blocks/ipc";
import {
  BLOCK_PRESETS,
  BLOCK_PRESET_GROUP_LABELS,
  BlockPreset,
  BlockPresetGroup,
  BlockPresetStep,
} from "../../shared/blocks/presets";
import {
  SS_COUNTRY_PRESETS,
  SS_PRESET_DISCLAIMER,
  SsCountryPreset,
} from "../../shared/socialSecurity/presets";
import { JOB_TYPE_OPTIONS } from "../../shared/positions/fieldSeed";
import {
  AccountOption,
  DepartmentOption,
} from "../../shared/mappingTables/types";
import AccountAutocomplete from "../common/AccountAutocomplete";
import DepartmentAutocomplete from "../common/DepartmentAutocomplete";

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
   *  (rich brackets/caps/base config) instead of the generic block form. A
   *  country preset seeds that dialog's bands, caps and account. */
  onPickSocialSecurity?: (preset?: SsCountryPreset) => void;
  /** Ready-made tab picked a block preset — the parent inserts its blocks. */
  onApplyPreset?: (presetId: string) => void;
}

/** COUNT_RATE spread options, grouped for the dropdown's subheaders. */
const SPREAD_GROUPS: Record<"byTime" | "byCurve", readonly BlockSpread[]> = {
  byTime: ["ACTIVE_MONTHS", "DAYS"],
  byCurve: [
    "WEIGHTED_BASE",
    "VACATION_PATTERN",
    "WEIGHTED_HOURS_WORKED",
    "WEIGHTED_HOURS_PAID",
    "WEIGHTED_FTE",
  ],
};

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

/** Short type wording for a preset step that is not a multiplier. */
const TYPE_SHAPE: Record<BlockType, string> = {
  MULTIPLIER: "Multiplier",
  FLAT_MONTHLY: "One amount each month",
  COUNT_RATE: "Count × rate",
  CUSTOM_MONTHLY: "Twelve monthly amounts",
  SOCIAL_SECURITY: "Rate bands",
  POOL_SPREAD: "Shared pot",
};

/**
 * One icon per preset. Keyed by id rather than group so the list scans as a
 * set of recognizable things rather than four repeated glyphs.
 */
const PRESET_ICONS: Record<string, React.ReactNode> = {
  pension: <SavingsOutlinedIcon />,
  overtime: <MoreTimeOutlinedIcon />,
  bonus: <RedeemOutlinedIcon />,
  thirteenthMonth: <CardGiftcardOutlinedIcon />,
  servicePool: <GroupsOutlinedIcon />,
  agencyLabour: <BadgeOutlinedIcon />,
  housing: <HomeOutlinedIcon />,
  transport: <DirectionsBusOutlinedIcon />,
  dutyMeals: <RestaurantOutlinedIcon />,
  uniform: <CheckroomOutlinedIcon />,
  medical: <LocalHospitalOutlinedIcon />,
  eosGratuity: <AccountBalanceWalletOutlinedIcon />,
  trainingLevy: <SchoolOutlinedIcon />,
  costPerHour: <CalculateOutlinedIcon />,
};

/** The order the Ready-made tab's sections appear in. */
const PRESET_GROUP_ORDER: readonly BlockPresetGroup[] = [
  "PAY",
  "ALLOWANCE",
  "STATUTORY",
  "RATIO",
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
  if (base.kind === "COMPOSITE") return COMPOSITE_OPTION;
  if (base.kind === "COMBINE") return COMBINE_OPTION;
  return JSON.stringify(base);
}

/** A composite with nothing ticked multiplies against zero — treat as unset. */
function isEmptyComposite(base: BlockBaseRef | undefined): boolean {
  return (
    base?.kind === "COMPOSITE" &&
    !base.includeBaseSalary &&
    base.blockIds.length === 0
  );
}

/** Sentinel for the compound option — its sides live in the editor below. */
const COMBINE_OPTION = "COMBINE";

/** A compound needs both sides chosen before it means anything. */
function isIncompleteCombine(base: BlockBaseRef | undefined): boolean {
  return base?.kind === "COMBINE" && (!base.left || !base.right);
}

const CALENDAR_LABELS: Record<
  Extract<BlockBaseRef, { kind: "CALENDAR" }>["series"],
  string
> = {
  PAY_DAYS: "Working days",
  REAL_DAYS: "Productive days",
  HOLIDAY_DAYS: "Public holidays",
};

const SERVICE_LABELS: Record<
  Extract<BlockBaseRef, { kind: "SERVICE" }>["mode"],
  string
> = {
  MONTH: "Service days",
  TOTAL: "Total service days",
};

const STAT_LABELS: Record<
  Extract<BlockBaseRef, { kind: "STAT" }>["stat"],
  string
> = {
  HOURS: "Hours worked",
  HOURS_PAID: "Hours paid",
  HEADCOUNT: "Headcount",
  FTE: "FTE",
};

/**
 * The plain base options, in menu order. One source for the main picker, the
 * compound's two side pickers, and the closed field's read-out — the three
 * would otherwise drift apart every time a base kind is added.
 */
const SALARY_BASES: Array<{ base: BlockBaseRef; label: string }> = [
  { base: { kind: "BASE_SALARY" }, label: "Basic salary (gross)" },
  { base: { kind: "VACATION" }, label: "Vacation cost" },
];

const DAY_HOUR_BASES: Array<{ base: BlockBaseRef; label: string }> = [
  { base: { kind: "CALENDAR", series: "PAY_DAYS" }, label: "Working days in month" },
  { base: { kind: "CALENDAR", series: "REAL_DAYS" }, label: "Productive days in month" },
  { base: { kind: "CALENDAR", series: "HOLIDAY_DAYS" }, label: "Public holidays in month" },
  { base: { kind: "STAT", stat: "HOURS" }, label: "Hours worked" },
  { base: { kind: "STAT", stat: "HOURS_PAID" }, label: "Hours paid" },
  { base: { kind: "STAT", stat: "FTE" }, label: "FTE" },
  // Length of service, from the row's Hiring Date. Calendar days, not worked
  // days — indemnity/end-of-service accruals are written against service.
  { base: { kind: "SERVICE", mode: "MONTH" }, label: "Service days in month" },
  { base: { kind: "SERVICE", mode: "TOTAL" }, label: "Total service days to date" },
];

/** Encoded value -> the menu's own wording, for the closed field. */
const SIMPLE_BASE_LABELS = new Map(
  [...SALARY_BASES, ...DAY_HOUR_BASES].map(
    (option) => [JSON.stringify(option.base), option.label] as const
  )
);

interface BaseNames {
  blocks: Map<string, string>;
  kpis: Map<string, string>;
}

/**
 * Short human wording for a base ref. The two builder bases have no fixed
 * label — what they mean is whatever the user assembled — so this is what the
 * closed dropdown and the builders' formula line both read out.
 */
function describeBase(base: BlockBaseRef | undefined, names: BaseNames): string {
  if (!base) return "…";
  switch (base.kind) {
    case "BASE_SALARY":
      return "Basic salary";
    case "VACATION":
      return "Vacation cost";
    case "CALENDAR":
      return CALENDAR_LABELS[base.series];
    case "SERVICE":
      return SERVICE_LABELS[base.mode];
    case "STAT":
      return STAT_LABELS[base.stat];
    case "BLOCK":
      return names.blocks.get(base.blockId) ?? "a block";
    case "KPI":
      return names.kpis.get(base.kpiDriverId) ?? "a KPI";
    case "COMPOSITE": {
      const parts = [
        ...(base.includeBaseSalary ? ["Basic salary"] : []),
        ...base.blockIds.map((id) => names.blocks.get(id) ?? "a block"),
      ];
      return parts.length > 0 ? parts.join(" + ") : "nothing ticked yet";
    }
    case "COMBINE":
      return `${describeBase(base.left, names)} ${
        BLOCK_COMBINE_OP_META[base.op].symbol
      } ${describeBase(base.right, names)}`;
  }
}

/**
 * The composite/compound rows are a different kind of answer from the rest of
 * the base menu: every other option IS the base, these two open a builder that
 * makes one. They lead the menu as cards — tinted, bordered, two lines, with
 * the shape of the formula they produce — so it reads as "build a base, or pick
 * a ready-made one" rather than as eleven equal-weight lines.
 */
const builderItemSx = {
  mx: 1,
  my: 0.5,
  px: 1.25,
  py: 1,
  borderRadius: 1.5,
  alignItems: "flex-start",
  whiteSpace: "normal",
  border: (theme: Theme) => `1px solid ${alpha(theme.palette.primary.main, 0.35)}`,
  bgcolor: (theme: Theme) => alpha(theme.palette.primary.main, 0.05),
  "&:hover": {
    bgcolor: (theme: Theme) => alpha(theme.palette.primary.main, 0.12),
    borderColor: "primary.main",
  },
  "&.Mui-selected, &.Mui-selected:hover": {
    bgcolor: (theme: Theme) => alpha(theme.palette.primary.main, 0.16),
    borderColor: "primary.main",
  },
} as const;

const FORMULA_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function BuilderItemBody({
  icon,
  title,
  shape,
  blurb,
}: {
  icon: React.ReactNode;
  title: string;
  shape: string;
  blurb: string;
}) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: "flex-start" }}>
      <Box sx={{ display: "flex", color: "primary.main", mt: 0.25 }}>{icon}</Box>
      {/* A menu's paper is sized to its widest item's max-content, so an
          unbounded blurb would stretch the whole dropdown and leave every
          short option swimming in white space. Capping the text column wraps
          it to two or three lines and keeps the popup at the field's width. */}
      <Box sx={{ minWidth: 0, maxWidth: { xs: 232, sm: 336 } }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
          <Typography variant="subtitle2">{title}</Typography>
          <Chip
            label={shape}
            size="small"
            color="primary"
            variant="outlined"
            sx={{
              height: 18,
              fontFamily: FORMULA_FONT,
              "& .MuiChip-label": { px: 0.75, fontSize: 10.5 },
            }}
          />
        </Stack>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", lineHeight: 1.4 }}
        >
          {blurb}
        </Typography>
      </Box>
    </Stack>
  );
}

/** The tinted, accented frame the two builders' editors sit in. */
const builderPanelSx = {
  p: 1.75,
  borderRadius: 1.5,
  border: (theme: Theme) => `1px solid ${alpha(theme.palette.primary.main, 0.3)}`,
  borderLeft: (theme: Theme) => `3px solid ${theme.palette.primary.main}`,
  bgcolor: (theme: Theme) => alpha(theme.palette.primary.main, 0.04),
} as const;

/** "= multiplier × (Basic salary ÷ Hours worked)" — what the builder built. */
function FormulaLine({ text, error }: { text: string; error?: boolean }) {
  return (
    <Box
      sx={{
        px: 1.25,
        py: 0.75,
        borderRadius: 1,
        bgcolor: "background.paper",
        border: (theme) =>
          `1px solid ${error ? theme.palette.error.main : theme.palette.divider}`,
        fontFamily: FORMULA_FONT,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: error ? "error.main" : "text.primary",
        overflowX: "auto",
        whiteSpace: "nowrap",
      }}
    >
      <Box component="span" sx={{ color: "text.disabled", mr: 1 }}>
        =
      </Box>
      {text}
    </Box>
  );
}

/**
 * A preset's steps reference each other as `$key`, so the describeBase lookup
 * is keyed the same way — the card reads "Overtime Hours × Overtime Hourly
 * Rate" rather than "$otHours × $otRate".
 */
function presetBaseNames(preset: BlockPreset): BaseNames {
  return {
    blocks: new Map(
      preset.steps.map((step) => [`$${step.key}`, step.block.label] as const)
    ),
    kpis: new Map(),
  };
}

/** What a single preset step will produce, in the base picker's own wording. */
function describeStep(step: BlockPresetStep, names: BaseNames): string {
  return step.block.blockType === "MULTIPLIER"
    ? describeBase(step.block.base, names)
    : TYPE_SHAPE[step.block.blockType];
}

/** The account chip on a preset row, or the honest absence of one. */
function AccountTag({ code }: { code: string }) {
  return code ? (
    <Chip
      label={code}
      size="small"
      variant="outlined"
      sx={{
        height: 18,
        fontFamily: FORMULA_FONT,
        "& .MuiChip-label": { px: 0.75, fontSize: 10.5 },
      }}
    />
  ) : (
    <Typography variant="caption" color="text.disabled" sx={{ fontSize: 10.5 }}>
      no account
    </Typography>
  );
}

/** The shared frame for every row in the Ready-made tab. */
const presetCardSx = {
  width: "100%",
  p: 1.75,
  borderRadius: 2,
  border: (theme: Theme) => `1px solid ${theme.palette.divider}`,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  textAlign: "left",
  gap: 0.75,
  "&:hover": {
    borderColor: "primary.main",
    bgcolor: (theme: Theme) => theme.palette.action.hover,
  },
  "&.Mui-disabled": { opacity: 0.5 },
} as const;

/**
 * One ready-made block preset. Every block it will create is listed, with its
 * shape and its account — a three-block Overtime should never arrive as a
 * surprise, since clicking inserts it there and then.
 */
function BlockPresetCard({
  preset,
  disabled,
  onPick,
}: {
  preset: BlockPreset;
  disabled?: boolean;
  onPick: () => void;
}) {
  const names = presetBaseNames(preset);
  const multi = preset.steps.length > 1;
  return (
    <ButtonBase disabled={disabled} onClick={onPick} sx={presetCardSx}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ color: "primary.main", display: "flex" }}>
          {PRESET_ICONS[preset.id] ?? <FunctionsOutlinedIcon />}
        </Box>
        <Typography variant="subtitle2">{preset.title}</Typography>
        <Box sx={{ flex: 1 }} />
        {multi && (
          <Chip
            label={`${preset.steps.length} blocks`}
            size="small"
            color="primary"
            variant="outlined"
            sx={{ height: 18, "& .MuiChip-label": { px: 0.75, fontSize: 10.5 } }}
          />
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
        {preset.blurb}
      </Typography>
      <Stack spacing={0.25} sx={{ mt: 0.25 }}>
        {preset.steps.map((step, index) => (
          <Stack
            key={step.key}
            direction="row"
            spacing={1}
            sx={{ alignItems: "center", minWidth: 0 }}
          >
            {multi && (
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{ fontFamily: FORMULA_FONT, fontSize: 10.5 }}
              >
                {index + 1}.
              </Typography>
            )}
            <Typography
              variant="caption"
              sx={{
                fontFamily: FORMULA_FONT,
                fontSize: 11,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {multi ? `${step.block.label} — ` : ""}
              {describeStep(step, names)}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <AccountTag code={step.block.accountCode} />
          </Stack>
        ))}
      </Stack>
    </ButtonBase>
  );
}

/**
 * One statutory scheme. Unlike a block preset this does NOT insert on click —
 * it opens the scheme dialog pre-filled, because the rates are jurisdiction and
 * year specific and somebody has to look at them before they reach a budget.
 */
function SsPresetCard({
  preset,
  disabled,
  onPick,
}: {
  preset: SsCountryPreset;
  disabled?: boolean;
  onPick: () => void;
}) {
  const top = preset.scheme.brackets[preset.scheme.brackets.length - 1];
  return (
    <ButtonBase disabled={disabled} onClick={onPick} sx={presetCardSx}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ display: "flex", fontSize: 18, lineHeight: 1 }}>
          {preset.flag}
        </Box>
        <Typography variant="subtitle2">{preset.title}</Typography>
        <Box sx={{ flex: 1 }} />
        <Chip
          label={`${(top.rate * 100).toFixed(2).replace(/\.?0+$/, "")}%`}
          size="small"
          color="primary"
          variant="outlined"
          sx={{
            height: 18,
            fontFamily: FORMULA_FONT,
            "& .MuiChip-label": { px: 0.75, fontSize: 10.5 },
          }}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
        {preset.blurb}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography
          variant="caption"
          sx={{ fontFamily: FORMULA_FONT, fontSize: 11, color: "text.disabled" }}
        >
          Opens the scheme settings — check the rates, then save.
        </Typography>
        <Box sx={{ flex: 1 }} />
        <AccountTag code={preset.defaultAccountCode} />
      </Stack>
    </ButtonBase>
  );
}

/**
 * The "Build your own" tab — one tile per block type. Social Security is the
 * odd one out: it hands off to the scheme dialog rather than the generic form,
 * because its config is brackets and caps rather than a base and a rate.
 */
function TypePalette({
  onPickType,
  onPickSocialSecurity,
}: {
  onPickType: (type: BlockType) => void;
  onPickSocialSecurity?: (preset?: SsCountryPreset) => void;
}) {
  return (
    <>
      <Typography variant="body2" color="text.secondary">
        A block adds a set of columns to the positions grid and generates a cost
        or statistics line for every position.
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
                : onPickType(tile.type)
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
    </>
  );
}

/** Section heading inside the Ready-made tab. */
function PresetSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="overline"
      color="text.secondary"
      sx={{ display: "block", lineHeight: 2, letterSpacing: 0.8 }}
    >
      {children}
    </Typography>
  );
}

/**
 * The "Ready-made" tab. Block presets insert on click; the statutory rows hand
 * off to the scheme dialog instead. Grouped so the list reads as a small
 * catalogue rather than eighteen equal-weight rows.
 */
function ReadyMadePane({
  disabled,
  onApplyPreset,
  onPickSocialSecurity,
}: {
  disabled?: boolean;
  onApplyPreset?: (presetId: string) => void;
  onPickSocialSecurity?: (preset?: SsCountryPreset) => void;
}) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        These create ordinary blocks with the fiddly parts already chosen. Change
        the name, the account or anything else with the cog afterwards — and type
        each position&apos;s own figures into the columns they add.
      </Typography>

      {PRESET_GROUP_ORDER.map((group) => {
        const presets = BLOCK_PRESETS.filter((preset) => preset.group === group);
        const statutory = group === "STATUTORY";
        if (presets.length === 0 && !statutory) return null;
        return (
          <Stack key={group} spacing={0.75}>
            <PresetSectionTitle>
              {BLOCK_PRESET_GROUP_LABELS[group]}
            </PresetSectionTitle>
            {presets.map((preset) => (
              <BlockPresetCard
                key={preset.id}
                preset={preset}
                disabled={disabled}
                onPick={() => onApplyPreset?.(preset.id)}
              />
            ))}
            {statutory && (
              <>
                <Typography
                  variant="caption"
                  color="warning.main"
                  sx={{ display: "block", lineHeight: 1.4, pt: 0.5 }}
                >
                  {SS_PRESET_DISCLAIMER}
                </Typography>
                {SS_COUNTRY_PRESETS.map((preset) => (
                  <SsPresetCard
                    key={preset.id}
                    preset={preset}
                    disabled={disabled}
                    onPick={() => onPickSocialSecurity?.(preset)}
                  />
                ))}
              </>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

/**
 * One side of a compound base. Deliberately a narrower menu than the top-level
 * base picker: no KPI (it compiles to a different engine path and cannot act as
 * a base series) and no composite/compound (the members would need their own
 * nested editor, and the VM holds only one saved operand).
 */
function CombineSideSelect({
  label,
  value,
  onChange,
  blockOptions,
}: {
  label: string;
  value: BlockBaseRef | undefined;
  onChange: (next: BlockBaseRef) => void;
  blockOptions: BlockDto[];
}) {
  return (
    <TextField
      select
      label={label}
      value={value ? JSON.stringify(value) : ""}
      onChange={(event) => onChange(JSON.parse(event.target.value) as BlockBaseRef)}
      error={!value}
      size="small"
      fullWidth
    >
      <ListSubheader>Salary</ListSubheader>
      {SALARY_BASES.map((option) => (
        <MenuItem key={option.label} value={JSON.stringify(option.base)}>
          {option.label}
        </MenuItem>
      ))}
      <ListSubheader>Days &amp; hours</ListSubheader>
      {DAY_HOUR_BASES.map((option) => (
        <MenuItem key={option.label} value={JSON.stringify(option.base)}>
          {option.label}
        </MenuItem>
      ))}
      {blockOptions.length > 0 && <ListSubheader>Your blocks</ListSubheader>}
      {blockOptions.map((candidate) => (
        <MenuItem
          key={candidate.id}
          value={JSON.stringify({ kind: "BLOCK", blockId: candidate.id })}
        >
          {candidate.label}
        </MenuItem>
      ))}
    </TextField>
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
  onApplyPreset,
}: BlockDialogProps) {
  const isEdit = !!block;
  const [type, setType] = useState<BlockType | null>(null);
  // Step one only: 0 = the type palette, 1 = the ready-made catalogue.
  const [paletteTab, setPaletteTab] = useState(0);
  const [label, setLabel] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [accountLocked, setAccountLocked] = useState(true);
  const [statsAccountCode, setStatsAccountCode] = useState("");
  const [base, setBase] = useState<BlockBaseRef | undefined>(undefined);
  // Compound-base options; ignored for every other base kind.
  const [useRowRate, setUseRowRate] = useState(true);
  const [ratioNoHeadcount, setRatioNoHeadcount] = useState(false);
  const [spread, setSpread] = useState<BlockSpread>("ACTIVE_MONTHS");
  const [increaseAware, setIncreaseAware] = useState(false);
  // Where the cost books. The control is MULTIPLIER-only, but the STATE is
  // seeded and submitted for every type: a FIXED block created by an importer
  // or arriving from a sync peer must survive a trip through this dialog.
  const [departmentMode, setDepartmentMode] =
    useState<BlockDepartmentMode>("POSITION");
  const [fixedDepartment, setFixedDepartment] = useState("");
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
  // Classification -> share weight, as text for the same half-typed reason.
  // Absent or blank means one whole share; only the exceptions are stored.
  const [poolWeights, setPoolWeights] = useState<Record<string, string>>({});

  // Seed the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setType(block?.blockType ?? null);
    setPaletteTab(0);
    setLabel(block?.label ?? "");
    setAccountCode(block?.accountCode ?? "");
    setAccountLocked(block?.accountLocked ?? true);
    setStatsAccountCode(block?.statsAccountCode ?? "");
    setBase(block?.base);
    setUseRowRate(block?.useRowRate ?? true);
    setRatioNoHeadcount(
      block?.ratioNoHeadcount ??
        (block?.base?.kind === "COMBINE" && block.base.op === "DIV")
    );
    setSpread(block?.spread ?? "ACTIVE_MONTHS");
    setIncreaseAware(block?.increaseAware ?? false);
    setDepartmentMode(block?.departmentMode ?? "POSITION");
    setFixedDepartment(block?.fixedDepartment ?? "");
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
    setPoolWeights(
      Object.fromEntries(
        Object.entries(block?.poolJobTypeWeights ?? {}).map(([code, weight]) => [
          code,
          String(weight),
        ])
      )
    );
  }, [open, block]);

  const baseOptions = useMemo(() => {
    const blockOptions = blocks.filter((candidate) => candidate.id !== block?.id);
    return { blockOptions, kpiDrivers };
  }, [blocks, block, kpiDrivers]);

  // Lookup for describeBase — the closed dropdown and the builders' formula
  // line read block/KPI names out of here.
  const baseNames = useMemo<BaseNames>(
    () => ({
      blocks: new Map(blocks.map((candidate) => [candidate.id, candidate.label])),
      kpis: new Map(kpiDrivers.map((driver) => [driver.id, driver.label])),
    }),
    [blocks, kpiDrivers]
  );

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
  // Which classifications get a weight box: the ones the rule selects, or every
  // classification when the rule selects "any". A weight saved against a
  // classification the rule no longer names stays on screen rather than
  // lingering invisibly in the config — it can be cleared where it was set.
  const weightedJobTypes = useMemo(() => {
    const listed = poolJobTypes.length > 0 ? poolJobTypes : jobTypeCodes;
    const known = new Set(listed);
    return [
      ...listed,
      ...Object.keys(poolWeights).filter((code) => !known.has(code)),
    ];
  }, [poolJobTypes, jobTypeCodes, poolWeights]);

  const labelError = label.trim() === "";
  const baseError =
    type === "MULTIPLIER" &&
    (!base || isEmptyComposite(base) || isIncompleteCombine(base));
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
  // Only the classifications the user actually weighted travel: a blank box is
  // "one whole share", which is the default the spread already applies.
  const poolWeightValues = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [code, text] of Object.entries(poolWeights)) {
      if (text.trim() === "") continue;
      out[code] = Number(text.trim());
    }
    return out;
  }, [poolWeights]);
  const poolWeightError =
    isPool &&
    poolEligibilityMode === "RULE" &&
    Object.values(poolWeightValues).some(
      (weight) => !Number.isFinite(weight) || weight <= 0 || weight > POOL_WEIGHT_MAX
    );
  // "One department" needs one chosen; the other two modes need nothing.
  const departmentError =
    departmentMode === "FIXED" && fixedDepartment.trim() === "";
  const valid =
    !!type &&
    !labelError &&
    !baseError &&
    !poolAmountError &&
    !poolKpiError &&
    !poolWeightError &&
    !departmentError;

  const handleSave = () => {
    if (!type || !valid) return;
    onSave({
      id: isEdit ? block!.id : undefined,
      blockType: type,
      label: label.trim(),
      accountCode,
      accountLocked,
      statsAccountCode: type === "COUNT_RATE" ? statsAccountCode : undefined,
      // Echoed rather than edited — there is no switch for it, and omitting it
      // silently re-locked every per-row stats account on save.
      statsAccountLocked:
        type === "COUNT_RATE" ? block?.statsAccountLocked ?? true : undefined,
      // Sent for EVERY type, not just MULTIPLIER. The control below is
      // Multiplier-only, but a FIXED block from an importer or a sync peer
      // would otherwise be silently reset to the row's department on save —
      // moving real money with no message.
      departmentMode,
      fixedDepartment:
        departmentMode === "FIXED" ? fixedDepartment.trim() : undefined,
      base: type === "MULTIPLIER" ? base : undefined,
      ...(type === "MULTIPLIER" && base?.kind === "COMBINE"
        ? { useRowRate, ratioNoHeadcount }
        : {}),
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
      poolJobTypeWeights:
        isPool && poolEligibilityMode === "RULE" ? poolWeightValues : undefined,
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
            <Tabs
              value={paletteTab}
              onChange={(_event, next: number) => setPaletteTab(next)}
              sx={{ mt: -1, borderBottom: 1, borderColor: "divider" }}
            >
              <Tab label="Build your own" />
              <Tab label="Ready-made" />
            </Tabs>
            {paletteTab === 1 ? (
              <ReadyMadePane
                disabled={saving}
                onApplyPreset={onApplyPreset}
                onPickSocialSecurity={onPickSocialSecurity}
              />
            ) : (
              <TypePalette
                onPickType={setType}
                onPickSocialSecurity={onPickSocialSecurity}
              />
            )}
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
                  if (picked === COMBINE_OPTION) {
                    if (base?.kind === "COMBINE") return setBase(base);
                    // Seed the commonest compound: something ÷ hours worked,
                    // which is also why the ratio tick starts on.
                    setRatioNoHeadcount(true);
                    return setBase({
                      kind: "COMBINE",
                      op: "DIV",
                      left: { kind: "BASE_SALARY" },
                      right: { kind: "STAT", stat: "HOURS" },
                    });
                  }
                  setBase(JSON.parse(picked) as BlockBaseRef);
                }}
                error={baseError}
                size="small"
                fullWidth
                helperText="Each row's multiplier is applied to this value, month by month. Plain number: 0.1 = 10%, 2 = double."
                slotProps={{
                  select: {
                    // Without this the closed field would show a builder card's
                    // whole two-line body — and, worse, would say "Composite"
                    // without saying composite of what. "" keeps the untouched
                    // field empty so the label still sits inside it.
                    renderValue: (value) => {
                      const picked = value as string;
                      if (!picked) return "";
                      if (picked === COMPOSITE_OPTION || picked === COMBINE_OPTION) {
                        return (
                          <Stack
                            direction="row"
                            spacing={0.75}
                            sx={{ alignItems: "center", minWidth: 0 }}
                          >
                            {picked === COMPOSITE_OPTION ? (
                              <FunctionsOutlinedIcon
                                fontSize="small"
                                sx={{ color: "primary.main" }}
                              />
                            ) : (
                              <CalculateOutlinedIcon
                                fontSize="small"
                                sx={{ color: "primary.main" }}
                              />
                            )}
                            <Box
                              component="span"
                              sx={{
                                fontFamily: FORMULA_FONT,
                                fontSize: 13,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {describeBase(base, baseNames)}
                            </Box>
                          </Stack>
                        );
                      }
                      // A plain base reads back in the menu's own words; only
                      // blocks and KPIs need naming from the lookup.
                      return (
                        SIMPLE_BASE_LABELS.get(picked) ??
                        describeBase(JSON.parse(picked) as BlockBaseRef, baseNames)
                      );
                    },
                  },
                }}
              >
                <ListSubheader>Build a base</ListSubheader>
                <MenuItem value={COMPOSITE_OPTION} sx={builderItemSx}>
                  <BuilderItemBody
                    icon={<FunctionsOutlinedIcon fontSize="small" />}
                    title="Composite"
                    shape="a + b + c"
                    blurb="Add any number of bases together, then multiply the total — “% of salary + allowances”."
                  />
                </MenuItem>
                <MenuItem value={COMBINE_OPTION} sx={builderItemSx}>
                  <BuilderItemBody
                    icon={<CalculateOutlinedIcon fontSize="small" />}
                    title="Compound"
                    shape="a ÷ b"
                    blurb="Two bases either side of + − × ÷ — a difference, a product, or a rate like salary ÷ hours."
                  />
                </MenuItem>
                <ListSubheader>Salary</ListSubheader>
                {SALARY_BASES.map((option) => (
                  <MenuItem key={option.label} value={baseValue(option.base)}>
                    {option.label}
                  </MenuItem>
                ))}
                <ListSubheader>Days &amp; hours</ListSubheader>
                {DAY_HOUR_BASES.map((option) => (
                  <MenuItem key={option.label} value={baseValue(option.base)}>
                    {option.label}
                  </MenuItem>
                ))}
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
              <Stack spacing={0.25} sx={builderPanelSx}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", pb: 0.5 }}
                >
                  <FunctionsOutlinedIcon
                    fontSize="small"
                    sx={{ color: "primary.main" }}
                  />
                  <Typography variant="subtitle2">
                    Composite base — add up
                  </Typography>
                </Stack>
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
                <Box sx={{ pt: 1 }}>
                  <FormulaLine
                    error={baseError}
                    text={`multiplier × (${describeBase(base, baseNames)})`}
                  />
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ pt: 0.75 }}>
                  {baseError
                    ? "Tick at least one thing to multiply against."
                    : "The multiplier applies to the sum of everything ticked, month by month."}
                </Typography>
              </Stack>
            )}

            {type === "MULTIPLIER" && base?.kind === "COMBINE" && (
              <Stack spacing={1.5} sx={builderPanelSx}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <CalculateOutlinedIcon
                    fontSize="small"
                    sx={{ color: "primary.main" }}
                  />
                  <Typography variant="subtitle2">
                    Compound base — combine two
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <CombineSideSelect
                    label="First"
                    value={base.left}
                    onChange={(left) => setBase({ ...base, left })}
                    blockOptions={baseOptions.blockOptions}
                  />
                  <TextField
                    select
                    label="Operation"
                    value={base.op}
                    onChange={(event) => {
                      const op = event.target.value as BlockCombineOp;
                      setBase({ ...base, op });
                      // A ratio is the only one that must not be multiplied by
                      // headcount, so follow the operation unless the user has
                      // already overridden it below.
                      setRatioNoHeadcount(op === "DIV");
                    }}
                    size="small"
                    sx={{ minWidth: 132 }}
                  >
                    {BLOCK_COMBINE_OPS.map((op) => (
                      <MenuItem key={op} value={op}>
                        {BLOCK_COMBINE_OP_META[op].symbol}{" "}
                        {BLOCK_COMBINE_OP_META[op].label}
                      </MenuItem>
                    ))}
                  </TextField>
                  <CombineSideSelect
                    label="Second"
                    value={base.right}
                    onChange={(right) => setBase({ ...base, right })}
                    blockOptions={baseOptions.blockOptions}
                  />
                </Stack>
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={useRowRate}
                      onChange={(event) => setUseRowRate(event.target.checked)}
                    />
                  }
                  label="Also use a per-row multiplier"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={ratioNoHeadcount}
                      onChange={(event) => setRatioNoHeadcount(event.target.checked)}
                    />
                  }
                  label="This is a ratio — don't multiply by headcount"
                />
                <FormulaLine
                  error={isIncompleteCombine(base)}
                  text={`${useRowRate ? "multiplier × " : ""}(${describeBase(
                    base,
                    baseNames
                  )})`}
                />
                <Typography variant="caption" color="text.secondary">
                  {base.op === "DIV"
                    ? "Dividing by zero in any month books nothing for that month rather than an error."
                    : "The two are combined month by month."}
                  {useRowRate
                    ? " Each row's multiplier is then applied to the result."
                    : " No multiplier column is added to the grid — the block is the combination itself."}
                  {ratioNoHeadcount
                    ? " A row standing for several people shows the per-person figure, not a multiple of it."
                    : ""}
                </Typography>
              </Stack>
            )}

            {type === "COUNT_RATE" && (
              <TextField
                select
                label="Spread the year's figures"
                value={spread}
                onChange={(event) => setSpread(event.target.value as BlockSpread)}
                size="small"
                fullWidth
                helperText={BLOCK_SPREAD_META[spread].hint}
              >
                <ListSubheader>By time</ListSubheader>
                {SPREAD_GROUPS.byTime.map((option) => (
                  <MenuItem key={option} value={option}>
                    {BLOCK_SPREAD_META[option].label}
                  </MenuItem>
                ))}
                <ListSubheader>By a curve</ListSubheader>
                {SPREAD_GROUPS.byCurve.map((option) => (
                  <MenuItem key={option} value={option}>
                    {BLOCK_SPREAD_META[option].label}
                  </MenuItem>
                ))}
              </TextField>
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
                    Each position's share also follows its share weight, working
                    months and hotel-cluster share, and the whole pot is always
                    spread — if someone drops out of a month, the others take
                    more.
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
                    <ToggleButton value="MANUAL">Weight each position</ToggleButton>
                    <ToggleButton value="RULE">By department / classification</ToggleButton>
                  </ToggleButtonGroup>

                  {poolEligibilityMode === "MANUAL" ? (
                    <Typography variant="caption" color="text.secondary">
                      The grid gets a "Share weight" column. Type 1 for a normal
                      share, 1.5 for one-and-a-half, 2 for a double share; blank
                      leaves the position out of the pot.
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
                        Leave a list empty to mean "any". In the grid, everyone
                        this rule selects shares the pot; the others' Share
                        weight cells are locked.
                      </Typography>

                      <Divider flexItem sx={{ my: 0.5 }} />

                      <Typography variant="subtitle2">
                        Share weight by classification
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        How many shares each classification takes. Leave blank
                        for one whole share — set 1.5 for managers, 2 for
                        directors, and they draw that much more of the pot than
                        everyone else. A weight typed on a position's own row
                        beats these, so one person can still be an exception.
                      </Typography>
                      <Box
                        sx={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fill, minmax(168px, 1fr))",
                          gap: 1,
                        }}
                      >
                        {weightedJobTypes.map((code) => (
                          <TextField
                            key={code}
                            size="small"
                            label={code}
                            value={poolWeights[code] ?? ""}
                            placeholder="1"
                            onChange={(event) =>
                              setPoolWeights((current) => ({
                                ...current,
                                [code]: event.target.value,
                              }))
                            }
                            slotProps={{
                              htmlInput: {
                                inputMode: "decimal",
                                "aria-label": `Share weight for ${code}`,
                              },
                            }}
                          />
                        ))}
                      </Box>
                      {poolWeightError && (
                        <Typography variant="caption" color="error">
                          A share weight must be a positive number (up to{" "}
                          {POOL_WEIGHT_MAX}). To leave a classification out
                          entirely, remove it from the rule above.
                        </Typography>
                      )}
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

            {/* Department and account are the two halves of one output key, so
                this sits directly under the account section. Multiplier only —
                the rare "this cost belongs elsewhere" case. */}
            {type === "MULTIPLIER" && (
              <Stack spacing={1}>
                <Typography variant="subtitle2">Where it books</Typography>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={departmentMode}
                  onChange={(_event, next: BlockDepartmentMode | null) =>
                    next && setDepartmentMode(next)
                  }
                >
                  <ToggleButton value="POSITION">The row's department</ToggleButton>
                  <ToggleButton value="FIXED">One department</ToggleButton>
                  <ToggleButton value="PER_ROW">Each row picks</ToggleButton>
                </ToggleButtonGroup>

                {departmentMode === "POSITION" && (
                  <Typography variant="caption" color="text.secondary">
                    Each row's cost books to that row's own department. The
                    normal choice.
                  </Typography>
                )}
                {departmentMode === "FIXED" && (
                  <>
                    <DepartmentAutocomplete
                      options={departments}
                      value={fixedDepartment}
                      onChange={setFixedDepartment}
                      size="small"
                      error={departmentError}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Every row using this block books here, whatever department
                      the row itself is in.
                    </Typography>
                  </>
                )}
                {departmentMode === "PER_ROW" && (
                  <Typography variant="caption" color="text.secondary">
                    The grid gets a "Department" column for this block. Leave a
                    row blank and it books to that row's own department.
                  </Typography>
                )}
              </Stack>
            )}

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

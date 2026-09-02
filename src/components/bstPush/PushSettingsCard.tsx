/**
 * The push's behavior settings, in one visible place.
 *
 * Two kinds of setting live here: the GUARDS (what to do about the BST's own
 * allocation rows and its protection-locked cells — leave alone, overwrite, or
 * clear to 0) and the plain switches (backup, skip unused combos) that used to
 * sit loose on the page.
 *
 * The card collapses to save the grid its space, but its header caption always
 * spells out the current state — settings that silently change what a push
 * writes must never hide behind a cog. Expanding is for changing them, not for
 * finding out what they are.
 */

import { useState } from "react";
import {
  Box,
  Button,
  Collapse,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

import {
  BstPushOptions,
  GUARD_MODES,
  GuardMode,
} from "../../shared/bstPush/ipc";

/** Label + explanation per guard mode — shared with the page's report text. */
export const GUARD_MODE_META: Record<
  GuardMode,
  { label: string; hint: string }
> = {
  skip: {
    label: "Leave alone",
    hint: "Never touched — no values written, no clearing, whatever the clear rules say.",
  },
  overwrite: {
    label: "Overwrite",
    hint: "No guard: treated like any other row. Kairos values and the clear rules apply.",
  },
  clear: {
    label: "Clear to 0",
    hint: "Zeroed in every replaced or cleared month, rules or not. No values are written on top.",
  },
};

function GuardControl({
  title,
  description,
  value,
  consequence,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  value: GuardMode;
  /** Mode-specific caption; warning-toned for the destructive modes. */
  consequence: string | null;
  disabled: boolean;
  onChange: (mode: GuardMode) => void;
}) {
  return (
    <Box>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          rowGap: 0.75,
        }}
      >
        <Box sx={{ flex: "1 1 280px", minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {description}
          </Typography>
        </Box>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={value}
          disabled={disabled}
          onChange={(_event, next: GuardMode | null) => {
            if (next) onChange(next);
          }}
        >
          {/* Native `title` rather than a Tooltip wrapper: the group injects
              its selection props into direct children, and a Tooltip in
              between would swallow them. */}
          {GUARD_MODES.map((mode) => (
            <ToggleButton
              key={mode}
              value={mode}
              title={GUARD_MODE_META[mode].hint}
              sx={{ textTransform: "none", px: 1.25, py: 0.375, fontSize: "0.75rem" }}
            >
              {GUARD_MODE_META[mode].label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>
      {consequence && (
        <Typography
          variant="caption"
          sx={{
            display: "block",
            mt: 0.25,
            color: value === "skip" ? "text.secondary" : "warning.main",
          }}
        >
          {consequence}
        </Typography>
      )}
    </Box>
  );
}

export interface PushSettingsCardProps {
  options: BstPushOptions;
  onChange: (next: BstPushOptions) => void;
  /** Plan rows sitting on a BST allocation row — makes the captions concrete. */
  allocationRowCount: number;
  /** Plan rows with at least one protection-locked month cell. */
  protectedRowCount: number;
  /** For the skip-unused-combos heads-up, same as before the move here. */
  clearPrefixes: string[];
  /** Locks everything but backup — a refresh must not lock the plan options. */
  disabled?: boolean;
  /** Backup keeps its stricter gate: any in-flight work disables it. */
  backupDisabled?: boolean;
}

export default function PushSettingsCard({
  options,
  onChange,
  allocationRowCount,
  protectedRowCount,
  clearPrefixes,
  disabled = false,
  backupDisabled = false,
}: PushSettingsCardProps) {
  const [open, setOpen] = useState(false);

  const summary = [
    `Allocation rows: ${GUARD_MODE_META[options.allocationRows].label}`,
    `Locked cells: ${GUARD_MODE_META[options.protectedCells].label}`,
    `Backup ${options.backup ? "on" : "off"}`,
    options.skipUnusedCombos ? "Unused combos skipped" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const allocationConsequence =
    options.allocationRows === "skip"
      ? null
      : options.allocationRows === "overwrite"
        ? "Allocation rows are treated like any other row — Kairos values and the clear rules can replace their formulas."
        : "Allocation rows are zeroed in every replaced or cleared month, replacing their formulas with 0.";

  const protectedConsequence =
    options.protectedCells === "skip"
      ? null
      : options.protectedCells === "overwrite"
        ? "Sheet protection binds Excel's UI, not this tool — locked cells are written straight through."
        : "Locked month cells are zeroed in every replaced or cleared month, replacing locked formulas with 0.";

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          rowGap: 1,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Push settings
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {summary}
          </Typography>
        </Box>
        <Button
          size="small"
          startIcon={
            <ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none" }} />
          }
          onClick={() => setOpen((current) => !current)}
          sx={{ textTransform: "none" }}
        >
          {open ? "Hide settings" : "Change settings"}
        </Button>
      </Stack>

      <Collapse in={open} unmountOnExit>
        <Stack spacing={1.25} sx={{ mt: 1.25 }}>
          <GuardControl
            title="Allocation rows"
            description={
              `BST rows whose description marks them as allocations ` +
              `("Allocated from…") — ${allocationRowCount.toLocaleString()} in this plan.`
            }
            value={options.allocationRows}
            consequence={allocationConsequence}
            disabled={disabled}
            onChange={(allocationRows) => onChange({ ...options, allocationRows })}
          />
          <GuardControl
            title="Protected (locked) cells"
            description={
              `Month cells the BST locks under sheet protection — Excel refuses ` +
              `these edits, this tool does not have to. ${protectedRowCount.toLocaleString()} ` +
              `row(s) in this plan carry locked cells.`
            }
            value={options.protectedCells}
            consequence={protectedConsequence}
            disabled={disabled}
            onChange={(protectedCells) => onChange({ ...options, protectedCells })}
          />

          <Divider />

          <Box>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={options.backup}
                  disabled={backupDisabled}
                  onChange={(event) =>
                    onChange({ ...options, backup: event.target.checked })
                  }
                />
              }
              label={
                <Typography variant="body2">
                  Back up the file before writing
                </Typography>
              }
            />
            <FormControlLabel
              sx={{ display: "flex", mt: 0.5 }}
              control={
                <Switch
                  size="small"
                  checked={options.skipUnusedCombos}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({
                      ...options,
                      skipUnusedCombos: event.target.checked,
                    })
                  }
                />
              }
              label={
                <Typography variant="body2">
                  Skip unused combos — write no values to rows Kairos holds no
                  data for, instead of overwriting them with zeroes
                </Typography>
              }
            />
            {options.skipUnusedCombos && clearPrefixes.length > 0 && (
              <Typography
                variant="caption"
                sx={{ display: "block", pl: 4.75, color: "warning.main" }}
              >
                Heads up: the clear rules ({clearPrefixes.join(", ")}) still run
                — a skipped row whose account they match is still zeroed in
                replaced or cleared months, unless the guards above leave it
                alone.
              </Typography>
            )}
          </Box>
        </Stack>
      </Collapse>
    </Paper>
  );
}

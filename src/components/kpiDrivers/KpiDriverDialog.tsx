/**
 * KpiDriverDialog — create/edit a KPI driver definition.
 *
 * A driver aggregates budget rows (SUM per month) into a reusable series:
 *   - EXPLICIT: the user gives dept GLOB patterns (D00??, D01*, or * for all),
 *     so it resolves to one series shared by every position that uses it.
 *   - POSITION: no patterns — evaluated per position against that position's own
 *     department, one series per department.
 * Account is always explicit (>=1 prefix). Built-ins are read-only (no dialog).
 */

import { useEffect, useMemo, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import ChipListInput from "./ChipListInput";
import {
  KpiDeptMode,
  KpiDriver,
  KpiDriverInput,
} from "../../shared/kpiDrivers/ipc";
import { BucketMeta, bucketName } from "../../shared/budgetImport/ipc";

export interface KpiDriverDialogProps {
  open: boolean;
  /** The driver being edited/duplicated, or null to create a blank one. */
  driver: KpiDriver | null;
  /**
   * When true, seed from `driver` but treat it as a brand-new driver — no id is
   * carried, so Save creates a copy rather than overwriting the source.
   */
  duplicate?: boolean;
  /** The current import's buckets, so the source select can name each bucket. */
  buckets?: BucketMeta[];
  saving?: boolean;
  onClose: () => void;
  onSave: (input: KpiDriverInput) => void;
}

export default function KpiDriverDialog({
  open,
  driver,
  duplicate,
  buckets = [],
  saving,
  onClose,
  onSave,
}: KpiDriverDialogProps) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [deptMode, setDeptMode] = useState<KpiDeptMode>("EXPLICIT");
  const [deptPatterns, setDeptPatterns] = useState<string[]>([]);
  const [accountPrefixes, setAccountPrefixes] = useState<string[]>([]);
  const [bucketIndex, setBucketIndex] = useState(1);

  // Editing an existing user driver overwrites it; duplicating or creating makes
  // a new one. A duplicate seeds every field from the source but drops the id.
  const isEdit = !!driver && !duplicate;

  // Seed the form each time the dialog opens (new, existing, or duplicate).
  useEffect(() => {
    if (!open) return;
    setLabel(duplicate && driver ? `${driver.label} (copy)` : driver?.label ?? "");
    setDescription(driver?.description ?? "");
    setDeptMode(driver?.deptMode ?? "EXPLICIT");
    setDeptPatterns(driver?.deptPatterns ?? []);
    setAccountPrefixes(driver?.accountPrefixes ?? []);
    setBucketIndex(driver?.bucketIndex ?? 1);
  }, [open, driver, duplicate]);

  const labelError = label.trim() === "";
  const accountError = accountPrefixes.length === 0;
  const patternError = deptMode === "EXPLICIT" && deptPatterns.length === 0;
  const valid = !labelError && !accountError && !patternError;

  const bucketOptions = useMemo(() => [1, 2, 3], []);

  const handleSave = () => {
    if (!valid) return;
    onSave({
      // Editing overwrites the source; duplicating/creating omits the id.
      id: isEdit ? driver?.id : undefined,
      label: label.trim(),
      description: description.trim(),
      deptMode,
      deptPatterns: deptMode === "EXPLICIT" ? deptPatterns : [],
      accountPrefixes,
      bucketIndex,
    });
  };

  const title = isEdit
    ? "Edit KPI Driver"
    : duplicate
      ? "Duplicate KPI Driver"
      : "New KPI Driver";

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            error={labelError}
            size="small"
            fullWidth
            autoFocus
          />

          <TextField
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            size="small"
            fullWidth
            multiline
            minRows={2}
            helperText="A short note on what this driver measures — shown on the card and matched by search."
          />

          <Stack spacing={1}>
            <Typography variant="subtitle2">Department scope</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={deptMode}
              onChange={(_e, next: KpiDeptMode | null) =>
                next && setDeptMode(next)
              }
            >
              <ToggleButton value="EXPLICIT">Typed department(s)</ToggleButton>
              <ToggleButton value="POSITION">Position's department</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary">
              {deptMode === "EXPLICIT"
                ? "One series, matched to the departments you specify — the same value wherever this driver is used."
                : "Evaluated per position against that position's own department — one series per department."}
            </Typography>
          </Stack>

          {deptMode === "EXPLICIT" && (
            <ChipListInput
              label="Department patterns"
              values={deptPatterns}
              onChange={setDeptPatterns}
              error={patternError}
              placeholder="e.g. D0010, D00??, D01*, or * for all"
              helperText="GLOB patterns: ? = any single char, * = any run. Enter or comma to add."
            />
          )}

          <ChipListInput
            label="Account prefixes"
            values={accountPrefixes}
            onChange={setAccountPrefixes}
            error={accountError}
            placeholder="e.g. A3"
            helperText="Accounts whose code starts with any of these. Enter or comma to add."
          />

          <TextField
            select
            label="Budget bucket (source)"
            value={bucketIndex}
            onChange={(e) => setBucketIndex(Number(e.target.value))}
            size="small"
            sx={{ maxWidth: 320 }}
            helperText={
              bucketName(buckets, bucketIndex)
                ? `Currently: ${bucketName(buckets, bucketIndex)}. The bucket position is fixed; its contents come from the latest budget pull.`
                : "Bucket 1 is the budget (usual source). Pull a budget to see each bucket's name."
            }
          >
            {bucketOptions.map((b) => {
              const name = bucketName(buckets, b);
              return (
                <MenuItem key={b} value={b}>
                  {name ? `Bucket ${b} — ${name}` : `Bucket ${b}`}
                </MenuItem>
              );
            })}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!valid || saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

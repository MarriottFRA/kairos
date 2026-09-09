/**
 * ColumnConfigDialog — what the report is compared against.
 *
 * The budget column itself follows the page's source toggle and is not
 * chosen here. Each comparison is a BST offset (the next or the final set
 * of twelve columns in the pull, named from the pull's own headers) or a
 * scenario read as its own plan. The variances apply to every comparison.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import {
  BstOffset,
  BucketLabelInput,
  ColumnConfig,
  CompareRef,
  ScenarioRef,
  bstOffsetLabel,
  bucketIndexOf,
  sameCompare,
} from "../../shared/reports/columnConfig";

export interface ColumnConfigDialogProps {
  open: boolean;
  config: ColumnConfig;
  /** The report's own scenario, excluded from the comparison choices. */
  scenarioId: string;
  scenarios: readonly ScenarioRef[];
  buckets: readonly BucketLabelInput[];
  onCancel: () => void;
  onSave: (config: ColumnConfig) => void;
}

const OFFSETS: BstOffset[] = [1, 2];

/** A comparison as a select value and back. */
const keyOf = (ref: CompareRef) => (ref.kind === "bst" ? `bst:${ref.offset}` : `scenario:${ref.scenarioId}`);
function refOf(key: string): CompareRef | null {
  if (key === "bst:1") return { kind: "bst", offset: 1 };
  if (key === "bst:2") return { kind: "bst", offset: 2 };
  if (key.startsWith("scenario:")) return { kind: "scenario", scenarioId: key.slice("scenario:".length) };
  return null;
}

export default function ColumnConfigDialog({
  open,
  config,
  scenarioId,
  scenarios,
  buckets,
  onCancel,
  onSave,
}: ColumnConfigDialogProps) {
  const [draft, setDraft] = useState<ColumnConfig>(config);
  useEffect(() => {
    if (open) setDraft(config);
  }, [open, config]);

  const others = scenarios.filter((s) => s.id !== scenarioId);
  const isTaken = (ref: CompareRef, except: number) =>
    draft.compares.some((c, i) => i !== except && sameCompare(c, ref));
  const firstFree = (): CompareRef | null => {
    for (const offset of OFFSETS) {
      const ref: CompareRef = { kind: "bst", offset };
      if (!isTaken(ref, -1)) return ref;
    }
    for (const s of others) {
      const ref: CompareRef = { kind: "scenario", scenarioId: s.id };
      if (!isTaken(ref, -1)) return ref;
    }
    return null;
  };
  const canAdd = firstFree() !== null;

  const setCompare = (index: number, ref: CompareRef) =>
    setDraft((d) => ({ ...d, compares: d.compares.map((c, i) => (i === index ? ref : c)) }));
  const removeCompare = (index: number) =>
    setDraft((d) => ({ ...d, compares: d.compares.filter((_c, i) => i !== index) }));
  const addCompare = () => {
    const ref = firstFree();
    if (ref) setDraft((d) => ({ ...d, compares: [...d.compares, ref] }));
  };

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Columns</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          The budget column follows the source toggle. Add what to set beside it: the next or the final
          set of twelve columns in the pulled BST, or another scenario read as its own plan.
        </Typography>
        <Stack spacing={1.25}>
          {draft.compares.map((ref, index) => {
            const key = keyOf(ref);
            const missing = ref.kind === "scenario" && !others.some((s) => s.id === ref.scenarioId);
            return (
              <Stack key={`${key}-${index}`} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <FormControl size="small" fullWidth error={missing}>
                  <InputLabel id={`cmp-${index}`}>{`Comparison ${index + 1}`}</InputLabel>
                  <Select
                    labelId={`cmp-${index}`}
                    label={`Comparison ${index + 1}`}
                    value={missing ? "" : key}
                    onChange={(event) => {
                      const next = refOf(String(event.target.value));
                      if (next) setCompare(index, next);
                    }}
                  >
                    <ListSubheader>BST offsets</ListSubheader>
                    {OFFSETS.map((offset) => {
                      const candidate: CompareRef = { kind: "bst", offset };
                      return (
                        <MenuItem key={offset} value={keyOf(candidate)} disabled={isTaken(candidate, index)}>
                          {`Offset ${offset} — ${bstOffsetLabel(offset, buckets)} (set ${bucketIndexOf(offset)})`}
                        </MenuItem>
                      );
                    })}
                    {others.length > 0 && <ListSubheader>Scenarios</ListSubheader>}
                    {others.map((s) => {
                      const candidate: CompareRef = { kind: "scenario", scenarioId: s.id };
                      return (
                        <MenuItem key={s.id} value={keyOf(candidate)} disabled={isTaken(candidate, index)}>
                          {`${s.label} ${s.year}`}
                        </MenuItem>
                      );
                    })}
                  </Select>
                </FormControl>
                <Tooltip title="Remove">
                  <IconButton size="small" onClick={() => removeCompare(index)} aria-label="Remove comparison">
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            );
          })}
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={addCompare}
            disabled={!canAdd}
            sx={{ alignSelf: "flex-start" }}
          >
            Add comparison
          </Button>
        </Stack>
        <Stack sx={{ mt: 1.5 }}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={draft.showAbs}
                onChange={(_e, checked) => setDraft((d) => ({ ...d, showAbs: checked }))}
              />
            }
            label="Show the difference"
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={draft.showPct}
                onChange={(_e, checked) => setDraft((d) => ({ ...d, showPct: checked }))}
              />
            }
            label="Show the difference as a percentage"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" onClick={() => onSave(draft)}>
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}

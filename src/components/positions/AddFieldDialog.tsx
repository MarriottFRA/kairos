/**
 * AddFieldDialog — name a new user-defined column.
 * -----------------------------------------------------------
 * Reached from the "+" on a section banner. The column is hotel-wide (a
 * `field_catalog` row for the OU), so it appears on every position at once —
 * existing rows simply have no value for it yet.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { FieldDataType } from "../../shared/positions/fields";

/** The types a user-defined column can take — the ones the column factory can
 *  render and the sanitizer can coerce without extra configuration. */
const TYPE_OPTIONS: Array<{ value: FieldDataType; label: string }> = [
  { value: "TEXT", label: "Text" },
  { value: "NUMBER", label: "Number" },
  { value: "DATE", label: "Date" },
];

export interface AddFieldDialogProps {
  open: boolean;
  /** Section label, for the prompt copy ("… to Employee PII"). */
  sectionLabel: string;
  /** Labels already in use in this section — rejected as duplicates. */
  existingLabels: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (label: string, dataType: FieldDataType) => void;
}

export default function AddFieldDialog({
  open,
  sectionLabel,
  existingLabels,
  busy,
  onCancel,
  onSubmit,
}: AddFieldDialogProps) {
  const [label, setLabel] = useState("");
  const [dataType, setDataType] = useState<FieldDataType>("TEXT");

  useEffect(() => {
    if (open) {
      setLabel("");
      setDataType("TEXT");
    }
  }, [open]);

  const trimmed = label.trim();
  const duplicate = existingLabels.some(
    (existing) => existing.toLowerCase() === trimmed.toLowerCase()
  );
  const valid = trimmed.length > 0 && trimmed.length <= 40 && !duplicate;

  const submit = () => {
    if (valid && !busy) onSubmit(trimmed, dataType);
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Add a column to {sectionLabel}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2, fontSize: "0.875rem" }}>
          The column is added for this hotel — it appears on every position,
          empty until you fill it in.
        </DialogContentText>
        <Stack spacing={2}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Column name"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            error={duplicate}
            helperText={duplicate ? "A column with that name already exists" : " "}
            disabled={busy}
          />
          <TextField
            select
            fullWidth
            size="small"
            label="Type"
            value={dataType}
            onChange={(event) => setDataType(event.target.value as FieldDataType)}
            disabled={busy}
          >
            {TYPE_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!valid || busy}>
          Add column
        </Button>
      </DialogActions>
    </Dialog>
  );
}

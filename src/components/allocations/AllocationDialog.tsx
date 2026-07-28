/**
 * AllocationDialog — create / edit an allocation.
 *
 * Name (required, unique) + a spread-base Select (drives the whole column) + a
 * multi-select of departments to EXCLUDE (the cost's owners, zeroed before
 * normalizing) + the account the split posts to on the Results page. The
 * department options come from the current grid, so only departments that
 * actually exist in the scenario can be excluded.
 */

import { useEffect, useState } from "react";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  AllocationDto,
  AllocationInput,
  SPREAD_BASE_META,
  SpreadBase,
} from "../../shared/allocations/ipc";
import { AccountOption } from "../../shared/mappingTables/types";
import AccountAutocomplete from "../common/AccountAutocomplete";

/** A department option for the exclude picker. */
export interface DeptOption {
  code: string;
  name: string;
}

export interface AllocationDialogProps {
  open: boolean;
  /** The allocation being edited, or null to create a new one. */
  allocation: AllocationDto | null;
  /** All allocations, for the duplicate-name check. */
  existing: AllocationDto[];
  /** Departments present in the scenario, for the exclude picker. */
  departments: DeptOption[];
  /** The account cache, for the "post to" picker. */
  accounts: AccountOption[];
  saving?: boolean;
  onClose: () => void;
  onSave: (input: AllocationInput) => void;
}

export default function AllocationDialog({
  open,
  allocation,
  existing,
  departments,
  accounts,
  saving,
  onClose,
  onSave,
}: AllocationDialogProps) {
  const [name, setName] = useState("");
  const [spreadBase, setSpreadBase] = useState<SpreadBase>("HEADCOUNT");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [injectAccount, setInjectAccount] = useState("");

  const isEdit = !!allocation;

  useEffect(() => {
    if (!open) return;
    setName(allocation?.name ?? "");
    setSpreadBase(allocation?.spreadBase ?? "HEADCOUNT");
    setExcluded(allocation?.excludedDepartments ?? []);
    setInjectAccount(allocation?.injectAccount ?? "");
  }, [open, allocation]);

  const nameByCode = new Map(departments.map((dept) => [dept.code, dept]));
  // An excluded department that is no longer present in the scenario must
  // survive an unrelated edit — keep it as a code-only option.
  const excludedOptions: DeptOption[] = excluded.map(
    (code) => nameByCode.get(code) ?? { code, name: code }
  );
  const options: DeptOption[] = [
    ...departments,
    ...excludedOptions.filter((option) => !nameByCode.has(option.code)),
  ];

  const trimmedName = name.trim();
  const nameBlank = trimmedName === "";
  const nameClash = existing.some(
    (other) =>
      other.name.toLowerCase() === trimmedName.toLowerCase() &&
      (!isEdit || other.id !== allocation?.id)
  );
  const valid = !nameBlank && !nameClash;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      id: isEdit ? allocation?.id : undefined,
      name: trimmedName,
      spreadBase,
      excludedDepartments: excluded,
      injectAccount,
    });
  };

  const hint = SPREAD_BASE_META.find((entry) => entry.base === spreadBase)?.hint;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isEdit ? "Edit Allocation" : "New Allocation"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={nameClash}
            helperText={
              nameClash
                ? "An allocation with this name already exists."
                : "e.g. Laundry, Employee Meal"
            }
            size="small"
            fullWidth
            autoFocus
          />

          <TextField
            select
            label="Spread base"
            value={spreadBase}
            onChange={(e) => setSpreadBase(e.target.value as SpreadBase)}
            helperText={hint}
            size="small"
            fullWidth
          >
            {SPREAD_BASE_META.map((entry) => (
              <MenuItem key={entry.base} value={entry.base}>
                {entry.label}
              </MenuItem>
            ))}
          </TextField>

          <Autocomplete
            multiple
            options={options}
            value={excludedOptions}
            onChange={(_e, picked) => setExcluded(picked.map((dept) => dept.code))}
            disableCloseOnSelect
            getOptionLabel={(dept) => dept.name}
            isOptionEqualToValue={(a, b) => a.code === b.code}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Exclude departments"
                size="small"
                helperText="These departments get 0 (the cost's owners); the rest re-normalize to 100."
              />
            )}
          />

          <Stack spacing={0.75}>
            <Typography variant="subtitle2">Post to account</Typography>
            <AccountAutocomplete
              options={accounts}
              value={injectAccount}
              onChange={setInjectAccount}
              size="small"
            />
            <Typography variant="caption" color="text.secondary">
              {injectAccount
                ? "Each department's share posts to this account on the Results page as a decimal (0.1523, not 15.23), the same value every month."
                : "No account: the split is still calculated and shown here, but it is not included in the Results output or the BST push."}
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!valid || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

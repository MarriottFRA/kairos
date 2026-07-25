/**
 * ClusterDialog — create / edit / duplicate a hotel cluster.
 *
 * Name (required, unique) + a multi-hotel Autocomplete (type-ahead over the
 * user's hotels, checkbox rows like the hotel switcher) + the per-hotel
 * weights editor (equal split until touched — see ClusterMembersEditor).
 * Save gating: name present + unique, ≥1 hotel, every weight in (0, 1].
 * Weights summing ≠ 1 warn but never block (a deliberate product decision —
 * some clusters genuinely under/over-allocate a person).
 */

import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import {
  HotelClusterDto,
  HotelClusterInput,
  HotelClusterMember,
  isValidClusterWeight,
} from "../../shared/hotelClusters/ipc";
import type { Hotel } from "../../services/auth";
import ClusterMembersEditor, { equalSplit } from "./ClusterMembersEditor";

export interface ClusterDialogProps {
  open: boolean;
  /** The cluster being edited/duplicated, or null to create a blank one. */
  cluster: HotelClusterDto | null;
  /** Seed from `cluster` but save as a brand-new one (no id carried). */
  duplicate?: boolean;
  /** The hotels this user can see, for the picker. */
  hotels: Hotel[];
  /** All clusters, for the duplicate-name check. */
  existing: HotelClusterDto[];
  /** Positions currently assigned to `cluster` (edit mode; null = unknown). */
  assignedCount?: number | null;
  /** True when the hotels list failed to load — member hotels then can't be
   *  displayed by name, which is a different story than "outside access". */
  hotelsFailed?: boolean;
  saving?: boolean;
  onClose: () => void;
  onSave: (input: HotelClusterInput) => void;
}

const uncheckedIcon = <CheckBoxOutlineBlankIcon fontSize="small" />;
const checkedIcon = <CheckBoxIcon fontSize="small" />;

export default function ClusterDialog({
  open,
  cluster,
  duplicate,
  hotels,
  existing,
  assignedCount,
  hotelsFailed,
  saving,
  onClose,
  onSave,
}: ClusterDialogProps) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<HotelClusterMember[]>([]);
  // False until the first manual weight edit; while false, membership changes
  // re-split equally. See ClusterMembersEditor.
  const [touched, setTouched] = useState(false);

  const isEdit = !!cluster && !duplicate;

  // Seed the form each time the dialog opens (new, existing, or duplicate).
  useEffect(() => {
    if (!open) return;
    setName(duplicate && cluster ? `${cluster.name} (copy)` : cluster?.name ?? "");
    setMembers(cluster?.members.map((member) => ({ ...member })) ?? []);
    // An existing cluster's weights are someone's deliberate numbers.
    setTouched(!!cluster);
  }, [open, cluster, duplicate]);

  const hotelByOu = new Map(hotels.map((hotel) => [hotel.ou, hotel]));
  const hotelName = (ou: string) => hotelByOu.get(ou)?.hotel_name ?? ou;
  const selected = members
    .map((member) => hotelByOu.get(member.ou))
    .filter((hotel): hotel is Hotel => !!hotel);
  // A member hotel the user can no longer see must survive an unrelated edit —
  // it stays in `members` but cannot be rendered as an Autocomplete option.
  const unknownMembers = members.filter((member) => !hotelByOu.has(member.ou));

  const handleHotelsChange = (picked: Hotel[]) => {
    const pickedOus = picked.map((hotel) => hotel.ou);
    const keptUnknown = unknownMembers.map((member) => member.ou);
    const nextOus = [...keptUnknown, ...pickedOus];
    if (!touched) {
      setMembers(equalSplit(nextOus));
      return;
    }
    // Manual weights: keep existing rows, add newcomers at 0 (never clobber).
    setMembers(
      nextOus.map(
        (ou) =>
          members.find((member) => member.ou === ou) ?? { ou, weight: 0 }
      )
    );
  };

  const trimmedName = name.trim();
  const nameBlank = trimmedName === "";
  const nameClash = existing.some(
    (other) =>
      other.name.toLowerCase() === trimmedName.toLowerCase() &&
      (!isEdit || other.id !== cluster?.id)
  );
  const membersError = members.length === 0;
  const weightsError = members.some(
    (member) => !isValidClusterWeight(member.weight)
  );
  const valid = !nameBlank && !nameClash && !membersError && !weightsError;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      id: isEdit ? cluster?.id : undefined,
      name: trimmedName,
      members,
    });
  };

  const title = isEdit
    ? "Edit Cluster"
    : duplicate
      ? "Duplicate Cluster"
      : "New Cluster";

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={nameBlank || nameClash}
            helperText={
              nameClash ? "A cluster with this name already exists." : undefined
            }
            size="small"
            fullWidth
            autoFocus
          />

          <Autocomplete
            multiple
            options={hotels}
            value={selected}
            onChange={(_e, picked) => handleHotelsChange(picked)}
            disableCloseOnSelect
            getOptionLabel={(hotel) => hotel.hotel_name}
            isOptionEqualToValue={(a, b) => a.ou === b.ou}
            filterOptions={(options, state) => {
              const query = state.inputValue.trim().toLowerCase();
              if (!query) return options;
              return options.filter((hotel) =>
                `${hotel.ou} ${hotel.hotel_name}`.toLowerCase().includes(query)
              );
            }}
            renderOption={(props, hotel, { selected: isSelected }) => {
              const { key, ...rest } = props as { key?: string } & Record<
                string,
                unknown
              >;
              return (
                <li key={key ?? hotel.ou} {...rest}>
                  <Checkbox
                    icon={uncheckedIcon}
                    checkedIcon={checkedIcon}
                    checked={isSelected}
                    sx={{ mr: 1 }}
                  />
                  <ListItemText primary={hotel.hotel_name} secondary={hotel.ou} />
                </li>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Hotels"
                size="small"
                error={membersError}
                helperText="Hotels that share this cluster's people."
              />
            )}
          />

          {unknownMembers.length > 0 && (
            <Alert
              severity={hotelsFailed ? "warning" : "info"}
              variant="outlined"
            >
              {hotelsFailed
                ? `The hotel list failed to load — ${unknownMembers.length} ` +
                  `member hotel${unknownMembers.length > 1 ? "s" : ""} ` +
                  `(${unknownMembers.map((m) => m.ou).join(", ")}) can't be ` +
                  "displayed by name but are kept as-is."
                : `${unknownMembers.length} member hotel` +
                  `${unknownMembers.length > 1 ? "s are" : " is"} outside ` +
                  `your current hotel access ` +
                  `(${unknownMembers.map((m) => m.ou).join(", ")}) and kept as-is.`}
            </Alert>
          )}

          {members.length > 0 && (
            <>
              <Divider>
                <Typography variant="overline" color="text.secondary">
                  Weights
                </Typography>
              </Divider>
              <ClusterMembersEditor
                members={members}
                hotelName={hotelName}
                onChange={setMembers}
                onTouched={setTouched}
              />
            </>
          )}

          {isEdit && (assignedCount ?? 0) > 0 && (
            <Alert severity="info" variant="outlined">
              {assignedCount} position{assignedCount === 1 ? "" : "s"} use
              {assignedCount === 1 ? "s" : ""} this cluster. Weight changes
              update their multipliers immediately.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
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

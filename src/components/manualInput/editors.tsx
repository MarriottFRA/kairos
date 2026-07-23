/**
 * Grid edit-cell components for the Manual Input grid.
 *
 * Mirrors the positions columnFactory editors (which are module-private there):
 * a Department type-ahead that stores the name, an Account type-ahead (wrapping
 * the shared AccountAutocomplete) that stores the base_account code, and a
 * commit-on-click Select for the small enum/month dropdowns. All three chain
 * stopCellEditMode after setEditCellValue so a single pick commits straight in —
 * the grid's native singleSelect editor otherwise leaves the cell open and
 * processRowUpdate never runs.
 */

import { useEffect, useRef } from "react";
import Autocomplete, { createFilterOptions } from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import {
  GridRenderEditCellParams,
  useGridApiContext,
} from "@mui/x-data-grid-premium";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { AccountFilter } from "../../shared/positions/fields";
import AccountAutocomplete from "../common/AccountAutocomplete";
import type { ManualGridRow } from "./rowModel";

const filterDepartments = createFilterOptions<DepartmentOption>({
  limit: 50,
  stringify: (option) => `${option.code} ${option.name}`,
});

/** Type-ahead editor for the Department (name) cell — stores the name, commits on pick. */
export function DepartmentEditCell(
  props: GridRenderEditCellParams<ManualGridRow> & { options: DepartmentOption[] }
) {
  const { id, field, value, options, hasFocus } = props;
  const apiRef = useGridApiContext();
  const inputRef = useRef<HTMLInputElement>(null);

  const name = typeof value === "string" ? value : "";
  const known = name ? options.find((option) => option.name === name) : null;
  const orphan = name && !known ? { code: "", name } : null;
  const current = known ?? orphan;
  const selectable = orphan ? [orphan, ...options] : options;

  useEffect(() => {
    if (hasFocus) inputRef.current?.focus();
  }, [hasFocus]);

  return (
    <Autocomplete<DepartmentOption>
      options={selectable}
      value={current}
      openOnFocus
      autoHighlight
      fullWidth
      filterOptions={filterDepartments}
      getOptionLabel={(option) => option.name}
      isOptionEqualToValue={(option, picked) => option.name === picked.name}
      renderOption={(optionProps, option) => (
        <Box component="li" {...optionProps} key={option.code || option.name}>
          {option.name}
        </Box>
      )}
      onChange={(_event, picked) => {
        void Promise.resolve(
          apiRef.current.setEditCellValue({ id, field, value: picked?.name ?? "" })
        ).then(() => apiRef.current.stopCellEditMode({ id, field }));
      }}
      slotProps={{ paper: { sx: { minWidth: 360 } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          variant="standard"
          placeholder="Search department…"
          sx={{ px: 1 }}
        />
      )}
      sx={{ width: "100%" }}
    />
  );
}

/** Type-ahead editor for the Cost Account cell — searches by description, stores the code. */
export function AccountEditCell(
  props: GridRenderEditCellParams<ManualGridRow> & {
    options: AccountOption[];
    filter?: AccountFilter | null;
  }
) {
  const { id, field, value, options, filter, hasFocus } = props;
  const apiRef = useGridApiContext();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasFocus) inputRef.current?.focus();
  }, [hasFocus]);

  return (
    <AccountAutocomplete
      options={options}
      filter={filter}
      value={typeof value === "string" ? value : ""}
      inputRef={inputRef}
      autoFocus
      openOnFocus
      variant="standard"
      sx={{ px: 1 }}
      onChange={(code) => {
        void Promise.resolve(
          apiRef.current.setEditCellValue({ id, field, value: code })
        ).then(() => apiRef.current.stopCellEditMode({ id, field }));
      }}
    />
  );
}

/** Commit-on-click editor for the small enum/month dropdowns. */
export function SelectEditCell(
  props: GridRenderEditCellParams<ManualGridRow> & {
    options: Array<{ value: string | number; label: string }>;
  }
) {
  const { id, field, value, options, hasFocus } = props;
  const apiRef = useGridApiContext();
  const ref = useRef<HTMLDivElement>(null);
  const pickedRef = useRef(false);

  useEffect(() => {
    if (hasFocus) ref.current?.focus();
  }, [hasFocus]);

  return (
    <Select
      ref={ref}
      value={value ?? ""}
      defaultOpen
      fullWidth
      variant="standard"
      disableUnderline
      onChange={(event) => {
        pickedRef.current = true;
        void Promise.resolve(
          apiRef.current.setEditCellValue({ id, field, value: event.target.value })
        ).then(() => apiRef.current.stopCellEditMode({ id, field }));
      }}
      onClose={() => {
        if (pickedRef.current) return;
        apiRef.current.stopCellEditMode({ id, field, ignoreModifications: true });
      }}
      sx={{ px: 1, fontSize: "0.8125rem", width: "100%" }}
    >
      {options.map((option) => (
        <MenuItem
          key={String(option.value)}
          value={option.value}
          sx={{ fontSize: "0.8125rem" }}
        >
          {option.label}
        </MenuItem>
      ))}
    </Select>
  );
}

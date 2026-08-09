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
import type { DepartmentPickList } from "../../shared/positions/departmentPickList";
import AccountAutocomplete from "../common/AccountAutocomplete";
import type { ManualGridRow } from "./rowModel";

const filterDepartments = createFilterOptions<DepartmentOption>({
  limit: 50,
  stringify: (option) => `${option.code} ${option.name}`,
});

/**
 * Type-ahead editor for the Department (name) cell — stores the name, commits on pick.
 *
 * `picks` narrows it to what a save would actually accept. Offering a department
 * this user cannot write is offering to lose the row at publish, silently, since
 * `filterToWriteScope` withholds rather than rejects. Unavailable departments are
 * still listed, greyed, with the server's own reason underneath — removing them
 * answers a different question from the one being asked, per the module note on
 * `departmentPickList`. `picks` omitted means no restriction.
 */
export function DepartmentEditCell(
  props: GridRenderEditCellParams<ManualGridRow> & {
    options: DepartmentOption[];
    picks?: DepartmentPickList;
  }
) {
  const { id, field, value, options, picks, hasFocus } = props;
  const apiRef = useGridApiContext();
  const inputRef = useRef<HTMLInputElement>(null);

  const name = typeof value === "string" ? value : "";
  const offered = picks ? picks.selectable : options;
  const locked = picks?.locked ?? [];
  // Widest-last, so the cell never renders blank: something they may pick, then
  // something they may see but not pick, then whatever reference data knows,
  // then a name that exists only on this row.
  const current = name
    ? offered.find((option) => option.name === name) ??
      locked.find((option) => option.name === name) ??
      options.find((option) => option.name === name) ?? { code: "", name }
    : null;
  const currentIsOffered =
    current !== null && offered.some((option) => option.name === current.name);
  const selectable = [
    ...(current && !currentIsOffered ? [current] : []),
    ...offered,
    ...locked,
  ];
  const disabledNames = new Set<string>(locked.map((option) => option.name));
  // The row's own value when it is not one they may choose: shown so the cell
  // reads correctly, disabled so re-picking it is not offered as a fresh choice.
  if (current && !currentIsOffered) disabledNames.add(current.name);
  const reasonByName = new Map(locked.map((option) => [option.name, option.reason]));

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
      // By name, not identity: `filterOptions` hands back new array entries.
      getOptionDisabled={(option) => disabledNames.has(option.name)}
      renderOption={(optionProps, option) => {
        const reason = reasonByName.get(option.name);
        return (
          <Box component="li" {...optionProps} key={option.code || option.name}>
            <Box sx={{ minWidth: 0 }}>
              <Box component="span" sx={{ display: "block" }}>
                {option.name}
              </Box>
              {reason && (
                <Box
                  component="span"
                  sx={{ display: "block", fontSize: 12, color: "text.secondary" }}
                >
                  {reason}
                </Box>
              )}
            </Box>
          </Box>
        );
      }}
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

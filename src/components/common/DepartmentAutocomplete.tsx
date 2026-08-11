/**
 * DepartmentAutocomplete — a type-ahead picker over the cached department_maps.
 * -----------------------------------------------------------
 * The CODE-based twin of AccountAutocomplete, and deliberately separate from
 * the three name-based department pickers in the app (positions
 * columnFactory.DepartmentEditCell, manualInput/editors, PositionFormField).
 * Those store the department NAME and mirror the code into a sibling column via
 * applyDeptCodeAutofill; this one stores the code itself, because its two
 * consumers both feed a code straight through to the engine:
 *
 *   - a block's FIXED department (BlockDialog), which becomes
 *     cost_component_definitions.fixed_department;
 *   - a block's per-row department override (the grid cell and the position
 *     form), which becomes component_values.department_code.
 *
 * Both end up in the engine's `dept|account` aggregation key, which is built
 * from codes, and both are read by pure shared modules (blockRows, liveSim)
 * that have no name -> code map to consult. Storing a name there would push
 * reference data into the pure layer.
 *
 * If the name-based pickers are ever converted to codes, this is where they
 * should land. Controlled and presentation-only: `value` in, `onChange` out.
 */

import Autocomplete, { createFilterOptions } from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { DepartmentOption } from "../../shared/mappingTables/types";

// Cap how many options the popup renders — same reasoning as the account
// picker: a keystroke or two always narrows to the one meant.
const filterDepartmentOptions = createFilterOptions<DepartmentOption>({
  limit: 50,
  stringify: (option) => `${option.code} ${option.name}`,
});

export interface DepartmentAutocompleteProps {
  /** The full department list from the cache. */
  options: DepartmentOption[];
  /** Currently stored department code, or "" for none. */
  value: string;
  /** Called with the picked department code, or "" when cleared. */
  onChange: (code: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  openOnFocus?: boolean;
  variant?: "standard" | "outlined";
  size?: "small" | "medium";
  inputRef?: React.Ref<HTMLInputElement>;
  error?: boolean;
  helperText?: string;
  /** Min width of the dropdown paper — names read wider than the cell. */
  minPopupWidth?: number;
  sx?: SxProps<Theme>;
}

export default function DepartmentAutocomplete({
  options,
  value,
  onChange,
  placeholder = "Search department…",
  autoFocus,
  openOnFocus,
  variant = "outlined",
  size = "small",
  inputRef,
  error,
  helperText,
  minPopupWidth = 320,
  sx,
}: DepartmentAutocompleteProps) {
  // A code from unsynced mapping tables is injected as its own option rather
  // than dropped, so re-opening the picker never silently blanks a real value.
  const known = value
    ? options.find((option) => option.code === value) ?? null
    : null;
  const orphan = value && !known ? { code: value, name: "" } : null;
  const current = known ?? orphan;
  const selectable = orphan ? [orphan, ...options] : options;

  return (
    <Autocomplete<DepartmentOption>
      options={selectable}
      value={current}
      openOnFocus={openOnFocus}
      autoHighlight
      fullWidth
      filterOptions={filterDepartmentOptions}
      // The input shows the CODE — that is what gets stored.
      getOptionLabel={(option) => option.code}
      isOptionEqualToValue={(option, picked) => option.code === picked.code}
      renderOption={(optionProps, option) => (
        <Box component="li" {...optionProps} key={option.code}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
              {option.code}
            </Typography>
            {option.name && (
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", lineHeight: 1.2 }}
              >
                {option.name}
              </Typography>
            )}
          </Box>
        </Box>
      )}
      onChange={(_event, picked) => onChange(picked?.code ?? "")}
      slotProps={{ paper: { sx: { minWidth: minPopupWidth } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          variant={variant}
          size={size}
          placeholder={placeholder}
          autoFocus={autoFocus}
          error={error}
          helperText={helperText}
        />
      )}
      sx={{ width: "100%", ...sx }}
    />
  );
}

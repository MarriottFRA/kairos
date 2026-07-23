/**
 * AccountAutocomplete — a type-ahead picker over the cached account_maps.
 * -----------------------------------------------------------
 * One picker, two homes: the Positions grid's account edit cells and the Home
 * page's bank-holiday premium account. Both need the same behaviour, so it lives
 * here rather than being re-derived in each:
 *
 *   - the user SEARCHES by description (the "detail level max") or code, but the
 *     value stored/committed is the base_account CODE — the input shows the code;
 *   - the offered set is narrowed by an {@link AccountFilter} (A9…, A5…, …),
 *     applied here over the full account list so callers pass the whole cache;
 *   - a value already on the field that no longer matches the filter (or the
 *     synced data) is injected as its own option, so it stays visible and
 *     re-opening the picker never silently blanks it.
 *
 * It is deliberately controlled and presentation-only: `value` in, `onChange`
 * out. The grid edit cell wraps it to commit on pick; the Home page uses it as a
 * plain field. Rule-based auto-selection, when it lands, sets `value` from
 * outside — nothing here needs to change.
 */

import { useMemo } from "react";
import Autocomplete, {
  createFilterOptions,
} from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { AccountOption } from "../../shared/mappingTables/types";
import { AccountFilter, accountAllowed } from "../../shared/positions/fields";

// Cap how many options the popup renders: over a few thousand accounts an
// unbounded list janks. A keystroke or two narrows it, so 50 is always enough
// to see the one meant. Matches on both the code and the description.
const filterAccountOptions = createFilterOptions<AccountOption>({
  limit: 50,
  stringify: (option) => `${option.code} ${option.name}`,
});

export interface AccountAutocompleteProps {
  /** The full account list from the cache; this component narrows it by `filter`. */
  options: AccountOption[];
  /** Which subset to offer. Absent/empty = every account. */
  filter?: AccountFilter | null;
  /** Currently stored base_account code, or "" for none. */
  value: string;
  /** Called with the picked base_account code, or "" when cleared. */
  onChange: (code: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  openOnFocus?: boolean;
  variant?: "standard" | "outlined";
  size?: "small" | "medium";
  inputRef?: React.Ref<HTMLInputElement>;
  /** Show the field in an error state (e.g. a required account left blank). */
  error?: boolean;
  helperText?: string;
  /** Min width of the dropdown paper — accounts read wider than the cell. */
  minPopupWidth?: number;
  sx?: SxProps<Theme>;
}

export default function AccountAutocomplete({
  options,
  filter,
  value,
  onChange,
  placeholder = "Search account…",
  autoFocus,
  openOnFocus,
  variant = "outlined",
  size = "small",
  inputRef,
  error,
  helperText,
  minPopupWidth = 320,
  sx,
}: AccountAutocompleteProps) {
  // Narrow to the field's subset once per (options, filter). Callers pass stable
  // references (a catalog's filter, a module constant), so this rarely recomputes.
  const allowed = useMemo(
    () => options.filter((option) => accountAllowed(option.code, filter)),
    [options, filter]
  );

  // Resolve the current value against the FULL list, not just `allowed` — a code
  // set before the filter tightened (or from unsynced data) must still show.
  const known = value
    ? options.find((option) => option.code === value) ?? null
    : null;
  const orphan = value && !known ? { code: value, name: "" } : null;
  const current = known ?? orphan;

  // Keep the current pick selectable even when it falls outside the filter.
  const selectable =
    current && !allowed.some((option) => option.code === current.code)
      ? [current, ...allowed]
      : allowed;

  return (
    <Autocomplete<AccountOption>
      options={selectable}
      value={current}
      openOnFocus={openOnFocus}
      autoHighlight
      fullWidth
      filterOptions={filterAccountOptions}
      // The input shows the CODE — that is what gets stored, so the cell reads
      // as its account number once picked.
      getOptionLabel={(option) => option.code}
      isOptionEqualToValue={(option, picked) => option.code === picked.code}
      renderOption={(optionProps, option) => (
        <Box component="li" {...optionProps} key={option.code}>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="body2"
              sx={{ fontWeight: 600, lineHeight: 1.3 }}
            >
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

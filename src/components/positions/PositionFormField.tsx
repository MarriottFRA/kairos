/**
 * One line of the Edit Position form.
 *
 * Picks a control from the column's own type and options, seeds it from the
 * column's valueGetter, and commits through its valueParser + valueSetter (see
 * gridValueBridge). It therefore inherits every field rule the grid has — the
 * PERCENT scale, ISO dates, the auto/override drop rules, PII dots — instead of
 * restating any of them.
 *
 * Two conventions carry the form's speed:
 *   - read-only lines are `tabIndex={-1}`, so Tab visits only the fields you can
 *     actually change (the grid, by contrast, stops on every locked cell);
 *   - text and numbers are held as a draft STRING while focused and committed on
 *     blur/Enter, so a half-typed "0." is never normalised out from under the
 *     caret (the same trick KpiDriverDialog uses for its multiplier).
 *
 * Every field renders as the SAME box — label above a control slot of a fixed
 * height — whatever control ends up inside it. That uniformity is what lets the
 * dialog lay all of them out on one lattice: a switch, a date and a locked
 * computed figure occupy identical cells, so no row of the form can come out
 * taller than its neighbours and leave a gap.
 */

import { useEffect, useState } from "react";
import Autocomplete, { createFilterOptions } from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import type { GridColDef } from "@mui/x-data-grid-premium";
import { FieldDef } from "../../shared/positions/fields";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { DepartmentPickList } from "../../shared/positions/departmentPickList";
import { PositionRow } from "../../shared/positions/rowModel";
import AccountAutocomplete from "../common/AccountAutocomplete";
import DepartmentAutocomplete from "../common/DepartmentAutocomplete";
import {
  commitValue,
  dayToDate,
  displayValue,
  editValue,
  optionsOf,
  ORPHAN_GROUP,
  rawEditText,
} from "./gridValueBridge";

/** Above this many choices a plain menu stops being faster than typing.
 *  Same threshold the grid's edit cells use. */
const SEARCHABLE_OPTION_THRESHOLD = 12;

const filterDepartments = createFilterOptions<DepartmentOption>({
  limit: 50,
  stringify: (option) => `${option.code} ${option.name}`,
});

/** Fields that show a derived value until you type over them, and fall back to
 *  it when cleared. The form gives them an explicit "revert to auto" button —
 *  clearing the cell is the grid's only gesture for this and it is easy to
 *  miss, since sanitizeRow puts the old number straight back on most numerics. */
const AUTO_FIELDS: ReadonlySet<string> = new Set([
  "yearlyHoursWorked",
  "clusterMultiplierOverride",
]);

export interface PositionFormFieldProps {
  column: GridColDef<PositionRow>;
  /** Absent for block slots, which have no catalog def. */
  def?: FieldDef;
  /** Always the live row from page state, never a local draft copy. */
  row: PositionRow;
  label: string;
  unit?: string | null;
  hint?: string | null;
  editable: boolean;
  /** Extra explanation for a locked field — why it is locked, not what it is. */
  lockNote?: string | null;
  /** Flags a value that needs attention (vacation weights off 100%). */
  warn?: boolean;
  /** Month cells: no unit suffix, smaller type — same box height. */
  dense?: boolean;
  /** Rendered right of the label — the chevron a month family hangs off. */
  action?: React.ReactNode;
  departments: DepartmentOption[];
  /** Which of them may be chosen. Omit for no restriction. See the grid's. */
  departmentPicks?: DepartmentPickList;
  accounts: AccountOption[];
  /**
   * Hands the dialog a function that applies this edit, rather than a finished
   * row. The dialog holds the authoritative row and calls it, so two commits
   * landing in the same tick (Enter blurs one field and focuses the next)
   * compose instead of the second silently reverting the first.
   */
  onCommit: (apply: (current: PositionRow) => PositionRow) => void;
}

export default function PositionFormField({
  column,
  def,
  row,
  label,
  unit,
  hint,
  editable,
  lockNote,
  warn,
  dense,
  action,
  departments,
  departmentPicks,
  accounts,
  onCommit,
}: PositionFormFieldProps) {
  // null = not being edited, so the box shows the formatted cell value.
  const [draft, setDraft] = useState<string | null>(null);
  // What the store says this cell holds right now. Watched, not just read: a
  // draft is only a pending overwrite of the value it was seeded from, so once
  // that value moves underneath it the draft is stale and must go.
  const committed = rawEditText(column, def, row);
  // Two ways it moves. A row swap under a focused input (Alt+Down to the next
  // position) must not carry the previous row's half-typed text across. And an
  // edit to THIS cell from outside the input — Ctrl+Z is the one that bites —
  // must not leave the pre-undo text armed behind the reverted value: blur
  // commits a draft, so the next click anywhere wrote the undone number
  // straight back and the undo looked like it had never persisted.
  useEffect(() => {
    setDraft(null);
  }, [row.id, committed]);

  // The column's setter returns the row untouched when it decides the edit is a
  // no-op (an echoed cluster weight or derived manhours), and the dialog skips
  // the write on that identity — so "focus a field, tab straight out" never
  // enqueues anything.
  const commit = (raw: unknown) => {
    onCommit((current) => commitValue(column, current, raw));
  };

  const commitDraft = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    commit(text === "" ? null : text);
  };

  const shared = { size: "small" as const, fullWidth: true };
  const rowProps = { field: column.field, label, unit, hint, dense, action };

  if (!editable) {
    return (
      <FieldRow {...rowProps} locked>
        <Tooltip title={lockNote ?? hint ?? ""} placement="top-start">
          <Typography
            variant="body2"
            tabIndex={-1}
            sx={{
              width: "100%",
              px: 1,
              color: warn ? "error.main" : "text.secondary",
              fontVariantNumeric: "tabular-nums",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayValue(column, row) || "—"}
          </Typography>
        </Tooltip>
      </FieldRow>
    );
  }

  const value = editValue(column, row);
  const options = optionsOf(column);
  const source = def?.dropdownSource;

  // ── Boolean ─────────────────────────────────────────────────────────
  if (def?.dataType === "BOOLEAN" || column.type === "boolean") {
    return (
      <FieldRow {...rowProps}>
        <Box sx={{ pl: 0.5 }}>
          <Switch
            size="small"
            checked={value === true || value === 1}
            slotProps={{ input: { "aria-label": label } }}
            onChange={(event) => commit(event.target.checked)}
          />
        </Box>
      </FieldRow>
    );
  }

  // ── Accounts ────────────────────────────────────────────────────────
  // Block account cells have no catalog def; they offer every account, matching
  // the grid's BlockAccountEditCell.
  const isAccountCell =
    source?.kind === "accounts" ||
    (!def && /:(?:account|statsAccount)$/.test(column.field));
  if (isAccountCell && accounts.length > 0) {
    return (
      <FieldRow {...rowProps}>
        <AccountAutocomplete
          options={accounts}
          filter={source?.kind === "accounts" ? source.filter : null}
          value={typeof value === "string" ? value : ""}
          onChange={(code) => commit(code)}
          size="small"
          openOnFocus
          sx={{ width: "100%", "& .MuiInputBase-root": { fontSize: "0.8125rem" } }}
        />
      </FieldRow>
    );
  }

  // ── Block department cells ──────────────────────────────────────────
  // A block's per-row department override has no catalog def and stores the
  // CODE, so it must be handled BEFORE the name-based department branch below —
  // that one would write a department name into a code cell. Unrestricted by
  // write scope, matching the grid's BlockDepartmentEditCell.
  const isBlockDepartmentCell = !def && /:department$/.test(column.field);
  if (isBlockDepartmentCell && departments.length > 0) {
    return (
      <FieldRow {...rowProps}>
        <DepartmentAutocomplete
          options={departments}
          value={typeof value === "string" ? value : ""}
          onChange={(code) => commit(code)}
          size="small"
          openOnFocus
          placeholder="Row's own department"
          sx={{ width: "100%", "& .MuiInputBase-root": { fontSize: "0.8125rem" } }}
        />
      </FieldRow>
    );
  }

  // ── Departments ─────────────────────────────────────────────────────
  if (source?.kind === "departments" && departments.length > 0) {
    const name = typeof value === "string" ? value : "";
    // The same narrow-then-grey rule as the grid's edit cell, and the same
    // resolution order for the row's current value, so opening a row in the form
    // can never offer a choice the grid would refuse. See `departmentPickList`.
    const picks = departmentPicks ?? { selectable: departments, locked: [] };
    const current = name
      ? picks.selectable.find((option) => option.name === name) ??
        picks.locked.find((option) => option.name === name) ??
        departments.find((option) => option.name === name) ?? { code: "", name }
      : null;
    const currentIsSelectable =
      current !== null &&
      picks.selectable.some((option) => option.name === current.name);
    const disabledNames = new Set<string>(picks.locked.map((option) => option.name));
    if (current && !currentIsSelectable) disabledNames.add(current.name);
    const reasonByName = new Map(
      picks.locked.map((option) => [option.name, option.reason])
    );
    return (
      <FieldRow {...rowProps}>
        <Autocomplete<DepartmentOption>
          options={[
            ...(current && !currentIsSelectable ? [current] : []),
            ...picks.selectable,
            ...picks.locked,
          ]}
          value={current}
          openOnFocus
          autoHighlight
          filterOptions={filterDepartments}
          getOptionLabel={(option) => option.name}
          isOptionEqualToValue={(option, picked) => option.name === picked.name}
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
          onChange={(_event, picked) => commit(picked?.name ?? "")}
          slotProps={{ paper: { sx: { minWidth: 340 } } }}
          renderInput={(params) => (
            <TextField {...params} {...shared} placeholder="Search department…" />
          )}
        />
      </FieldRow>
    );
  }

  // ── Closed lists ────────────────────────────────────────────────────
  if (options) {
    if (options.length > SEARCHABLE_OPTION_THRESHOLD) {
      const known = options.find((option) => option.value === value) ?? null;
      // Same orphan contract as the grid's edit cell and the department picker
      // above: a stored value the list no longer offers (a title retired in a
      // later seed) is injected as its own option. Without it the box renders
      // empty over a row that plainly shows the value, and opening the field
      // would quietly clear it.
      const orphan =
        !known && value !== null && value !== undefined && value !== ""
          ? { value, label: String(value), group: ORPHAN_GROUP }
          : null;
      const selectable = orphan ? [orphan, ...options] : options;
      const grouped = selectable.some((option) => option.group);
      return (
        <FieldRow {...rowProps}>
          <Autocomplete
            options={selectable}
            value={known ?? orphan}
            openOnFocus
            autoHighlight
            getOptionLabel={(option) => option.label}
            groupBy={grouped ? (option) => option.group ?? "" : undefined}
            isOptionEqualToValue={(option, picked) => option.value === picked.value}
            onChange={(_event, picked) => commit(picked?.value ?? null)}
            slotProps={{ paper: { sx: { minWidth: 300 } } }}
            renderInput={(params) => <TextField {...params} {...shared} />}
          />
        </FieldRow>
      );
    }
    return (
      <FieldRow {...rowProps}>
        <TextField
          {...shared}
          select
          value={options.some((option) => option.value === value) ? value : ""}
          onChange={(event) => commit(event.target.value)}
        >
          {options.map((option) => (
            <MenuItem key={String(option.value)} value={option.value as string | number}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>
      </FieldRow>
    );
  }

  // ── Date ────────────────────────────────────────────────────────────
  if (def?.dataType === "DATE" || column.type === "date") {
    return (
      <FieldRow {...rowProps}>
        <TextField
          {...shared}
          type="date"
          value={value instanceof Date ? rawEditText(column, def, row) : ""}
          onChange={(event) => {
            const text = event.target.value;
            commit(text === "" ? null : dayToDate(text));
          }}
        />
      </FieldRow>
    );
  }

  // ── Text / numbers ──────────────────────────────────────────────────
  const numeric =
    def?.dataType === "NUMBER" ||
    def?.dataType === "INTEGER" ||
    def?.dataType === "PERCENT" ||
    (!def && column.type === "number");
  const isAuto = AUTO_FIELDS.has(column.field);
  const overridden =
    isAuto && row[column.field] !== null && row[column.field] !== undefined;

  return (
    <FieldRow {...rowProps}>
      <TextField
        {...shared}
        value={draft ?? displayValue(column, row)}
        error={warn}
        onFocus={() => setDraft(rawEditText(column, def, row))}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitDraft();
            return;
          }
          if (event.key === "Escape" && draft !== null) {
            // Revert this field; leave the dialog open. Without stopping it the
            // keystroke would bubble to Dialog.onClose and lose the row.
            event.stopPropagation();
            setDraft(null);
          }
        }}
        slotProps={{
          htmlInput: {
            inputMode: numeric ? ("decimal" as const) : undefined,
            style: numeric
              ? { textAlign: "right", fontVariantNumeric: "tabular-nums" }
              : undefined,
          },
          input: overridden
            ? {
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title="Revert to the auto-calculated value">
                      <IconButton
                        size="small"
                        edge="end"
                        tabIndex={-1}
                        onClick={() => {
                          setDraft(null);
                          commit(null);
                        }}
                      >
                        <RestartAltIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ),
              }
            : undefined,
        }}
      />
    </FieldRow>
  );
}

/**
 * The form's one cell: label above a control slot of a fixed height.
 *
 * Every field uses it — editable or locked, switch or autocomplete — because a
 * cell that is always the same size is what makes the dialog's lattice line up.
 * The height comes from MUI's small outlined input (40px); the locked variant
 * borrows the control's box but draws it dashed and quiet, so "you cannot type
 * here" is legible without the value having to look like a different species of
 * thing from the one two cells over.
 *
 * The wrapper carries `data-form-field` (rather than the input, which is not a
 * plain DOM node for every control) so the dialog can find a field by key when
 * it restores focus after stepping to the next position.
 */
const CONTROL_HEIGHT = 40;

function FieldRow({
  field,
  label,
  unit,
  hint,
  dense,
  locked,
  action,
  children,
}: {
  field: string;
  label: string;
  unit?: string | null;
  hint?: string | null;
  dense?: boolean;
  locked?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Box data-form-field={field} sx={{ minWidth: 0 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.25,
          minWidth: 0,
          height: 18,
        }}
      >
        <Tooltip title={hint ?? ""} placement="top-start" enterDelay={600}>
          <Typography
            variant="caption"
            noWrap
            sx={{
              flex: 1,
              minWidth: 0,
              color: "text.secondary",
              lineHeight: 1.2,
              fontSize: dense ? "0.6875rem" : undefined,
              cursor: hint ? "help" : "default",
            }}
          >
            {label}
            {unit && !dense ? (
              <Box component="span" sx={{ color: "text.disabled", ml: 0.5 }}>
                {unit}
              </Box>
            ) : null}
          </Typography>
        </Tooltip>
        {action}
      </Box>

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          height: CONTROL_HEIGHT,
          ...(locked
            ? {
                borderRadius: 1,
                border: "1px dashed",
                borderColor: "divider",
                bgcolor: "action.hover",
              }
            : null),
          "& .MuiOutlinedInput-root": { height: CONTROL_HEIGHT },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

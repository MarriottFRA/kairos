/**
 * FieldConditionPicker — one condition of a rate rule: field, comparison,
 * value. Three coordinated inputs on one row:
 *
 *   [ Band ▾ ]  [ is ▾ ]  [ blue        ]
 *
 * The field menu is grouped like the base picker (ListSubheader per catalog
 * section) and offers: a pinned "Position" group — days in position plus the
 * engine scalars rules may reference (RATE_RULE_ENGINE_FIELDS) — every
 * POSITION_EXTRA and PII catalog field (system and user columns alike), and a
 * "KPIs" group comparing a KPI's monthly series. Computed columns are
 * deliberately absent (they exist only in the renderer; the repo rejects
 * them at save). Another block's computed value cannot be a condition — it
 * does not exist until the engine runs — but it CAN be the rule's multiplier
 * (see BlockDialog's outcome picker).
 *
 * The operator list and the value editor both follow the picked field's data
 * type: an ENUM field offers its own dropdown options, department code the
 * synced department list, BOOLEAN Yes/No, DATE a date input, numbers a
 * numeric field, and "is one of" turns the value into a chip list that also
 * splits pasted comma-separated text. A saved key the catalog no longer
 * carries stays selectable with a warning (the stale-department precedent) —
 * its condition reads as blank until re-pointed.
 */

import { useMemo, useState } from "react";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import type { FieldCatalog, FieldDataType } from "../../shared/positions/fields";
import { fieldLabel } from "../../shared/positions/fields";
import type { DepartmentOption } from "../../shared/mappingTables/types";
import {
  RATE_RULE_ENGINE_FIELDS,
  RATE_RULE_OPERATORS,
  RateRuleOperator,
  RateRuleTerm,
  operatorNeedsValue,
  ruleSourceType,
} from "../../shared/blocks/rateRules";

/** The field menu's value for the days-in-position source (no field key). */
const DAYS_OPTION = "__daysInPosition__";
/** KPI entries are encoded as `kpi:<driverId>` in the field menu. */
const KPI_PREFIX = "kpi:";

const OPERATOR_LABELS: Record<RateRuleOperator, string> = {
  EQ: "is",
  NEQ: "is not",
  IN: "is one of",
  GT: "more than",
  GTE: "at least",
  LT: "less than",
  LTE: "at most",
  IS_BLANK: "is blank",
  NOT_BLANK: "is filled in",
};

interface FieldOption {
  /** Menu value: a field key, DAYS_OPTION, or `kpi:<driverId>`. */
  key: string;
  label: string;
  dataType: FieldDataType | "DAYS_IN_POSITION" | "KPI";
  /** Fixed choices for the value editor (ENUM/static sources, departments). */
  choices?: Array<{ value: string | number; label: string }>;
  /** Set when the key no longer exists in the catalog / driver list. */
  stale?: boolean;
}

interface FieldGroup {
  /**
   * Menu-unique group id — the React key for its subheader.
   *
   * Not the label: the catalog's `employee` section is itself labelled
   * "Position", so keying by label collided with the pinned group and React
   * dropped one of the two subheaders ("Encountered two children with the same
   * key, `h:Position`").
   */
  key: string;
  label: string;
  options: FieldOption[];
}

export interface FieldConditionPickerProps {
  catalog?: FieldCatalog | null;
  /** KPI drivers offered as month-varying condition sources. */
  kpiDrivers?: Array<{ id: string; label: string }>;
  /** Synced department reference data — the value choices for departmentCode. */
  departments?: DepartmentOption[];
  term: RateRuleTerm;
  onChange: (term: RateRuleTerm) => void;
  disabled?: boolean;
}

/** Condition-source storages: extras and PII (the loaders read both), never
 *  COMPUTED (renderer-only) or unlisted ENGINE columns. */
const CONDITION_STORAGES = new Set(["POSITION_EXTRA", "PII_CORE", "PII_EXTRA"]);

function menuValueOf(term: RateRuleTerm): string {
  if (term.source.kind === "DAYS_IN_POSITION") return DAYS_OPTION;
  if (term.source.kind === "KPI") return KPI_PREFIX + term.source.kpiDriverId;
  return term.source.fieldKey;
}

export default function FieldConditionPicker({
  catalog,
  kpiDrivers = [],
  departments = [],
  term,
  onChange,
  disabled,
}: FieldConditionPickerProps) {
  // Half-typed "is one of" text lives here so a comma can commit chips.
  const [listInput, setListInput] = useState("");

  const groups = useMemo<FieldGroup[]>(() => {
    const fields = catalog?.fields ?? [];
    const byKey = new Map(fields.map((field) => [field.key, field]));

    const engineOptions: FieldOption[] = RATE_RULE_ENGINE_FIELDS.map((meta) => {
      // The catalog usually carries these as ENGINE fields with the labels
      // and dropdown options the grid itself uses — prefer that over the
      // fallback metadata so "Job type" offers its classification list.
      const def = byKey.get(meta.key);
      let choices =
        def?.dropdownSource?.kind === "static"
          ? def.dropdownSource.options.map((option) => ({
              value: option.value,
              label: option.label,
            }))
          : undefined;
      if (meta.key === "departmentCode" && !choices && departments.length > 0) {
        choices = departments.map((dept) => ({
          value: dept.code,
          label: `${dept.code} — ${dept.name}`,
        }));
      }
      return {
        key: meta.key,
        label: def ? fieldLabel(def) : meta.label,
        dataType: def?.dataType ?? meta.dataType,
        choices,
      };
    });

    const built: FieldGroup[] = [
      {
        key: "pinned",
        label: "Position",
        options: [
          { key: DAYS_OPTION, label: "Days in position", dataType: "DAYS_IN_POSITION" },
          ...engineOptions,
        ],
      },
    ];

    const sections = [...(catalog?.sections ?? [])].sort((a, b) => a.order - b.order);
    for (const section of sections) {
      const options = fields
        .filter(
          (field) => field.section === section.id && CONDITION_STORAGES.has(field.storage)
        )
        .map((field): FieldOption => ({
          key: field.key,
          label: fieldLabel(field),
          dataType: field.dataType,
          choices:
            field.dropdownSource?.kind === "static"
              ? field.dropdownSource.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))
              : undefined,
        }));
      if (options.length > 0) {
        built.push({ key: `section:${section.id}`, label: section.label, options });
      }
    }

    if (kpiDrivers.length > 0) {
      built.push({
        key: "kpis",
        label: "KPIs",
        options: kpiDrivers.map((driver) => ({
          key: KPI_PREFIX + driver.id,
          label: driver.label,
          dataType: "KPI",
        })),
      });
    }

    // A saved key the catalog (or driver list) lost stays selectable with a
    // warning rather than silently vanishing from the rule.
    const current = menuValueOf(term);
    if (
      current !== DAYS_OPTION &&
      !built.some((group) => group.options.some((option) => option.key === current))
    ) {
      built.push({
        key: "stale",
        label: "No longer available",
        options: [
          {
            key: current,
            label: current.startsWith(KPI_PREFIX)
              ? `KPI ${current.slice(KPI_PREFIX.length)}`
              : current,
            dataType: term.source.kind === "FIELD" ? term.source.dataType : "KPI",
            stale: true,
          },
        ],
      });
    }
    return built;
  }, [catalog, kpiDrivers, departments, term]);

  const fieldValue = menuValueOf(term);
  const option = useMemo(() => {
    for (const group of groups) {
      const hit = group.options.find((entry) => entry.key === fieldValue);
      if (hit) return hit;
    }
    return undefined;
  }, [groups, fieldValue]);
  const sourceType = ruleSourceType(term.source);
  const operators = RATE_RULE_OPERATORS[sourceType] ?? [];

  const pickField = (key: string) => {
    setListInput("");
    if (key === DAYS_OPTION) {
      const legal = RATE_RULE_OPERATORS.DAYS_IN_POSITION;
      onChange({
        source: { kind: "DAYS_IN_POSITION" },
        op: legal.includes(term.op) ? term.op : "GTE",
        value: typeof term.value === "number" ? term.value : undefined,
      });
      return;
    }
    if (key.startsWith(KPI_PREFIX)) {
      const legal = RATE_RULE_OPERATORS.KPI;
      onChange({
        source: { kind: "KPI", kpiDriverId: key.slice(KPI_PREFIX.length) },
        op: legal.includes(term.op) ? term.op : "GTE",
        value: typeof term.value === "number" ? term.value : undefined,
      });
      return;
    }
    let picked: FieldOption | undefined;
    for (const group of groups) {
      picked = group.options.find((entry) => entry.key === key);
      if (picked) break;
    }
    if (!picked || picked.dataType === "KPI" || picked.dataType === "DAYS_IN_POSITION") return;
    const legal = RATE_RULE_OPERATORS[picked.dataType];
    onChange({
      source: { kind: "FIELD", fieldKey: picked.key, dataType: picked.dataType },
      // Keep the operator when it still applies (TEXT→ENUM etc.); otherwise
      // fall back to the type's first operator ("is" everywhere but dates).
      op: legal.includes(term.op) ? term.op : legal[0],
      value: undefined,
    });
  };

  const setOp = (op: RateRuleOperator) => {
    onChange({
      ...term,
      op,
      // "is one of" holds a list, everything else a scalar; blank ops none.
      value: !operatorNeedsValue(op)
        ? undefined
        : op === "IN"
          ? Array.isArray(term.value)
            ? term.value
            : term.value !== undefined && term.value !== ""
              ? [term.value as string | number]
              : []
          : Array.isArray(term.value)
            ? term.value[0]
            : term.value,
    });
  };

  const valueEditor = () => {
    if (!operatorNeedsValue(term.op)) return null;

    if (sourceType === "DAYS_IN_POSITION" || sourceType === "KPI") {
      return (
        <TextField
          label={sourceType === "KPI" ? "Monthly value" : "Days"}
          size="small"
          type="number"
          disabled={disabled}
          value={term.value ?? ""}
          onChange={(event) => {
            const num = Number(event.target.value);
            onChange({
              ...term,
              value: event.target.value === "" || !Number.isFinite(num)
                ? undefined
                : num,
            });
          }}
          sx={{ width: 130 }}
        />
      );
    }

    if (term.op === "IN") {
      const list = Array.isArray(term.value) ? term.value : [];
      const commit = (entries: string[]) => {
        const next = [...list.map(String)];
        for (const entry of entries) {
          const trimmed = entry.trim();
          if (trimmed !== "" && !next.includes(trimmed)) next.push(trimmed);
        }
        onChange({ ...term, value: next });
      };
      return (
        <Autocomplete
          multiple
          freeSolo={!option?.choices}
          size="small"
          disabled={disabled}
          options={(option?.choices ?? []).map((choice) => String(choice.value))}
          value={list.map(String)}
          inputValue={listInput}
          onInputChange={(_event, next) => {
            // Comma commits — "blue, green, red" pastes straight into chips.
            if (next.includes(",")) {
              commit(next.split(","));
              setListInput("");
            } else {
              setListInput(next);
            }
          }}
          onChange={(_event, next) => {
            setListInput("");
            onChange({ ...term, value: next });
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Values"
              placeholder={
                option?.choices ? "Pick…" : "Type, comma or Enter to add"
              }
            />
          )}
          sx={{ flex: 1, minWidth: 180 }}
        />
      );
    }

    if (sourceType === "BOOLEAN") {
      return (
        <TextField
          select
          label="Value"
          size="small"
          disabled={disabled}
          value={term.value === true ? "yes" : term.value === false ? "no" : ""}
          onChange={(event) => onChange({ ...term, value: event.target.value === "yes" })}
          sx={{ width: 120 }}
        >
          <MenuItem value="yes">Yes</MenuItem>
          <MenuItem value="no">No</MenuItem>
        </TextField>
      );
    }

    if (option?.choices) {
      return (
        <TextField
          select
          label="Value"
          size="small"
          disabled={disabled}
          value={term.value ?? ""}
          onChange={(event) => onChange({ ...term, value: event.target.value })}
          sx={{ flex: 1, minWidth: 160 }}
        >
          {option.choices.map((choice) => (
            <MenuItem key={String(choice.value)} value={choice.value}>
              {choice.label}
            </MenuItem>
          ))}
        </TextField>
      );
    }

    if (sourceType === "DATE") {
      return (
        <TextField
          label="Date"
          size="small"
          type="date"
          disabled={disabled}
          value={typeof term.value === "string" ? term.value : ""}
          onChange={(event) => onChange({ ...term, value: event.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ width: 168 }}
        />
      );
    }

    const numeric =
      sourceType === "NUMBER" || sourceType === "INTEGER" || sourceType === "PERCENT";
    return (
      <TextField
        label={sourceType === "PERCENT" ? "Value (0.1 = 10%)" : "Value"}
        size="small"
        type={numeric ? "number" : "text"}
        disabled={disabled}
        value={term.value ?? ""}
        onChange={(event) => {
          const text = event.target.value;
          if (!numeric) return onChange({ ...term, value: text });
          const num = Number(text);
          onChange({
            ...term,
            value: text === "" ? undefined : Number.isFinite(num) ? num : text,
          });
        }}
        sx={{ flex: 1, minWidth: 120 }}
      />
    );
  };

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", minWidth: 0 }}>
      <TextField
        select
        label="Field"
        size="small"
        disabled={disabled}
        value={fieldValue}
        onChange={(event) => pickField(event.target.value)}
        sx={{ width: 210, flexShrink: 0 }}
        slotProps={{
          select: {
            renderValue: () => (
              <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", minWidth: 0 }}>
                {option?.stale && (
                  <Tooltip title="This no longer exists — the condition reads as blank. Pick another field.">
                    <WarningAmberOutlinedIcon fontSize="small" color="warning" />
                  </Tooltip>
                )}
                <Box
                  component="span"
                  sx={{ overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {fieldValue === DAYS_OPTION
                    ? "Days in position"
                    : option?.label ?? fieldValue}
                </Box>
              </Stack>
            ),
          },
        }}
      >
        {/* Keyed by group id, and the items by group+key: a field that appears
            in two groups is a menu wart, not a reason for React to omit it. */}
        {groups.flatMap((group) => [
          <ListSubheader key={`h:${group.key}`}>{group.label}</ListSubheader>,
          ...group.options.map((entry) => (
            <MenuItem key={`${group.key}:${entry.key}`} value={entry.key}>
              {entry.label}
            </MenuItem>
          )),
        ])}
      </TextField>

      <TextField
        select
        label="Comparison"
        size="small"
        disabled={disabled}
        value={term.op}
        onChange={(event) => setOp(event.target.value as RateRuleOperator)}
        sx={{ width: 136, flexShrink: 0 }}
      >
        {operators.map((op) => (
          <MenuItem key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </MenuItem>
        ))}
      </TextField>

      {valueEditor()}
    </Stack>
  );
}

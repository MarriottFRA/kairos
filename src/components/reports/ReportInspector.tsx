/**
 * ReportInspector — "how is this line built?"
 *
 * A docked panel beside the report grid (the Results inspector's shape).
 * For the selected line it shows the measure's formula and what it reads —
 * other measures, atoms, params — with each one's value under the chosen
 * series column; an atom expands into the department × account combos it
 * summed, named from the mapping tables, largest first. That is the whole
 * chain from a P&L line back to the rows of the BST or the results cache.
 */

import { useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import type { SeriesColumnSpec } from "../../shared/reports/columns";
import { isSeriesColumn } from "../../shared/reports/columns";
import type {
  ReportDefinitionDetail,
  ReportsAtomCombosResponse,
  ReportsEvaluateColumnsResponse,
} from "../../shared/reports/ipc";
import type { AtomFilter, Format } from "../../shared/reports/types";
import { AtomCombosOptions, listAtomCombos } from "../../services/reportsService";
import { formatReportValue } from "./format";

export const INSPECTOR_WIDTH = 380;

export interface ReportInspectorProps {
  detail: ReportDefinitionDetail | null;
  grid: ReportsEvaluateColumnsResponse;
  rowIndex: number;
  ou: string;
  definitionId: string;
  /** Includes `pack` for a generated page, so the atom resolves against it. */
  options: AtomCombosOptions;
  onClose: () => void;
}

function describeFilter(filter: AtomFilter): string {
  const side = filter.kind.startsWith("dept_") ? "Dept" : "Account";
  switch (filter.kind) {
    case "dept_base":
    case "acc_base":
      return `${side} in ${filter.codes.join(", ")}`;
    case "dept_base_not_in":
    case "acc_base_not_in":
      return `${side} not in ${filter.codes.join(", ")}`;
    case "dept_prefix":
    case "acc_prefix":
      return `${side} starts with ${filter.prefixes.join(", ")}`;
    case "dept_level":
    case "acc_level":
      return `${side} level ${filter.level} = ${filter.values.join(" | ")}`;
    case "dept_level_not_in":
    case "acc_level_not_in":
      return `${side} level ${filter.level} ≠ ${filter.values.join(" | ")}`;
  }
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <Typography
    component="span"
    variant="body2"
    sx={{ fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" }}
  >
    {children}
  </Typography>
);

export default function ReportInspector({
  detail,
  grid,
  rowIndex,
  ou,
  definitionId,
  options,
  onClose,
}: ReportInspectorProps) {
  const seriesColumns = useMemo(
    () => grid.columns.filter((c) => isSeriesColumn(c.spec)),
    [grid.columns]
  );
  const [columnId, setColumnId] = useState<string>(seriesColumns[0]?.id ?? "");
  useEffect(() => {
    if (!seriesColumns.some((c) => c.id === columnId)) setColumnId(seriesColumns[0]?.id ?? "");
  }, [seriesColumns, columnId]);

  const column = seriesColumns.find((c) => c.id === columnId) ?? seriesColumns[0];
  const row = grid.rows[rowIndex];
  const measureId = row?.measureId ?? null;
  const measure = detail?.definition.measures.find((m) => m.id === measureId) ?? null;
  const refs = measureId ? detail?.refs[measureId] ?? [] : [];

  const [openAtom, setOpenAtom] = useState<string | null>(null);
  const [combos, setCombos] = useState<ReportsAtomCombosResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpenAtom(null);
    setCombos(null);
  }, [rowIndex, columnId]);

  useEffect(() => {
    if (!openAtom || !column) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAtomCombos(ou, definitionId, openAtom, column.spec as SeriesColumnSpec, options)
      .then((result) => {
        if (!cancelled) setCombos(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError((err as Error).message ?? "Failed to resolve the atom");
          setCombos(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openAtom, column, ou, definitionId, options]);

  if (!row || row.type !== "measure") return null;

  const format: Format = row.format ?? "number";
  const rowValues = column ? column.values[rowIndex] : null;

  const kindOf = (id: string): "measure" | "atom" | "param" =>
    detail?.definition.measures.some((m) => m.id === id)
      ? "measure"
      : detail?.definition.params?.some((p) => p.id === id)
        ? "param"
        : "atom";

  const labelOf = (id: string): string => {
    const m = detail?.definition.measures.find((x) => x.id === id);
    if (m) return m.label ?? id;
    const a = detail?.definition.atoms.find((x) => x.id === id);
    if (a) return a.label ?? id;
    const p = detail?.definition.params?.find((x) => x.id === id);
    return p?.label ?? id;
  };

  const valueOf = (id: string): number | null => {
    if (!column) return null;
    const kind = kindOf(id);
    if (kind === "atom") return column.atoms[id]?.[12] ?? null;
    if (kind === "param") return column.params[id]?.[12] ?? null;
    const index = grid.rows.findIndex((r) => r.measureId === id);
    return index >= 0 ? column.values[index]?.[12] ?? null : null;
  };

  const formatOf = (id: string): Format => {
    const kind = kindOf(id);
    if (kind === "measure") return detail?.definition.measures.find((m) => m.id === id)?.format ?? "number";
    return "number";
  };

  return (
    <Box
      sx={{
        width: INSPECTOR_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderLeft: 1,
        borderColor: "divider",
        pl: 2,
        ml: 2,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", mb: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="overline" sx={{ color: "text.secondary", lineHeight: 1.4 }}>
            How this line is built
          </Typography>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
            {row.label}
          </Typography>
          {measure && (
            <Typography
              variant="caption"
              sx={{ fontFamily: "'IBM Plex Mono', monospace", color: "text.secondary", display: "block", mt: 0.5 }}
            >
              {measure.formula}
            </Typography>
          )}
        </Box>
        <IconButton size="small" onClick={onClose} aria-label="Close inspector">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      {seriesColumns.length > 1 && (
        <FormControl size="small" sx={{ mb: 1.5 }}>
          <InputLabel id="rep-inspector-column">Column</InputLabel>
          <Select
            labelId="rep-inspector-column"
            label="Column"
            value={column?.id ?? ""}
            onChange={(event) => setColumnId(String(event.target.value))}
          >
            {seriesColumns.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", pb: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          Total
        </Typography>
        <Mono>{formatReportValue(rowValues?.[12] ?? null, format)}</Mono>
      </Stack>
      <Divider />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: 1.5 }}>
        {!detail ? (
          <CircularProgress size={20} />
        ) : refs.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            This line reads nothing.
          </Typography>
        ) : (
          <Stack spacing={1}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              Reads
            </Typography>
            {refs.map((id) => {
              const kind = kindOf(id);
              const open = openAtom === id;
              return (
                <Box key={id}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{
                      alignItems: "center",
                      justifyContent: "space-between",
                      cursor: kind === "atom" ? "pointer" : "default",
                    }}
                    onClick={kind === "atom" ? () => setOpenAtom(open ? null : id) : undefined}
                  >
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={kind}
                        sx={{ height: 18, fontSize: "0.625rem" }}
                      />
                      <Typography variant="body2" noWrap title={id}>
                        {labelOf(id)}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                      <Mono>{formatReportValue(valueOf(id), formatOf(id))}</Mono>
                      {kind === "atom" &&
                        (open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />)}
                    </Stack>
                  </Stack>
                  {open && (
                    <Box sx={{ pl: 1, pt: 0.75 }}>
                      {loading ? (
                        <CircularProgress size={16} />
                      ) : error ? (
                        <Typography variant="body2" color="error">
                          {error}
                        </Typography>
                      ) : combos ? (
                        <AtomCombos combos={combos} />
                      ) : null}
                    </Box>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

const MAX_COMBOS = 60;

function AtomCombos({ combos }: { combos: ReportsAtomCombosResponse }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? combos.combos : combos.combos.slice(0, MAX_COMBOS);
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", rowGap: 0.5 }}>
        {combos.filters.map((filter, index) => (
          <Chip key={index} size="small" label={describeFilter(filter)} sx={{ height: 20, fontSize: "0.6875rem" }} />
        ))}
        {combos.negate && <Chip size="small" color="warning" label="negated" sx={{ height: 20, fontSize: "0.6875rem" }} />}
        <Chip
          size="small"
          variant="outlined"
          label={combos.sourceId ? `source: ${combos.sourceId}` : "source unavailable"}
          sx={{ height: 20, fontSize: "0.6875rem" }}
        />
      </Stack>
      {combos.warnings.length > 0 && (
        <Typography variant="caption" color="warning.main">
          {combos.warnings.map((w) => w.message).join(" ")}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {combos.combos.length} combo{combos.combos.length === 1 ? "" : "s"} · Total{" "}
        {formatReportValue(combos.total[12], "number")}
      </Typography>
      {shown.map((combo) => (
        <Stack
          key={`${combo.dept}|${combo.account}`}
          direction="row"
          spacing={1}
          sx={{ alignItems: "baseline", justifyContent: "space-between" }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              {combo.dept} · {combo.account}
              {combo.encoding === "LEVEL" && (
                <Chip size="small" variant="outlined" label="level" sx={{ height: 16, fontSize: "0.6rem", ml: 0.5 }} />
              )}
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
              {[combo.deptName, combo.accountName].filter(Boolean).join(" · ")}
            </Typography>
          </Box>
          <Mono>{formatReportValue(combo.values[12], "number")}</Mono>
        </Stack>
      ))}
      {combos.combos.length > MAX_COMBOS && !showAll && (
        <Typography
          variant="caption"
          sx={{ cursor: "pointer", textDecoration: "underline" }}
          onClick={() => setShowAll(true)}
        >
          Show all {combos.combos.length}
        </Typography>
      )}
    </Stack>
  );
}

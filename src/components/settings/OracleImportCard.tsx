/**
 * OracleImportCard — the Settings entry point for the Oracle report import.
 *
 * Three steps, deliberately: pick a file (which only reads it), review exactly
 * what would happen, then commit. Two things make the middle step the point of
 * the feature rather than ceremony. The macro this ports read most of its
 * columns by position rather than by heading, so the sample table is the only
 * way to see a shifted Oracle layout before it lands; and this import appends
 * into a plan someone is already working in, where there is no undo.
 *
 * Self-contained: this is the only place in the app that touches oracleImport,
 * so the whole feature can be removed by deleting its folders and this card.
 */

import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

import {
  DEFAULT_ORACLE_IMPORT_OPTIONS,
  ORACLE_BAND_KEYS,
  ORACLE_BAND_LABELS,
  OracleBandKey,
  OracleBandOverride,
  OracleImportOptions,
  OracleImportPreview,
  OracleImportReport,
  OracleSkippedRow,
} from "../../shared/oracleImport/ipc";
import {
  commitOracleImport,
  previewOracleImport,
} from "../../services/oracleImportService";

export interface OracleImportCardProps {
  /** The selected hotel; the import can only ever land here. */
  ou: string;
  /** The plan the positions are appended to. May already have positions. */
  scenarioId: string;
}

/** Sentinels for the block dropdown, which otherwise carries block ids. */
const CREATE_VALUE = "__create";
const OFF_VALUE = "__off";

const SKIP_REASON_LABELS: Record<OracleSkippedRow["reason"], string> = {
  duplicate_in_plan: "Already in this plan",
  duplicate_in_file: "Repeated in this file",
  no_emp_number: "No employee number",
  bad_days_per_week: "Days per week unusable",
  bad_contract_hours: "Contract hours unusable",
  bad_salary: "Salary unusable",
};

function formatNumber(value: number, decimals = 2): string {
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      })
    : "—";
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert severity="info">
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Worth knowing ({warnings.length})
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {warnings.map((warning) => (
          <Typography key={warning} component="li" variant="body2" sx={{ mb: 0.5 }}>
            {warning}
          </Typography>
        ))}
      </Box>
    </Alert>
  );
}

/** The skipped-row table, shared by the confirm dialog and the report. */
function SkippedTable({ rows }: { rows: OracleSkippedRow[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <Box>
      <Button size="small" sx={{ textTransform: "none", pl: 0 }} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : `${rows.length} row(s) will not be imported — show`}
      </Button>
      {open && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell align="right">Row</TableCell>
              <TableCell>Employee</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Why</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.sheetRow}-${row.empNumber}`}>
                <TableCell align="right">{row.sheetRow}</TableCell>
                <TableCell>{row.empNumber || "—"}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell sx={{ color: "text.secondary" }}>
                  <strong>{SKIP_REASON_LABELS[row.reason]}.</strong> {row.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}

/** The report as plain text, for the Copy button. */
function reportText(report: OracleImportReport): string {
  return [
    `Imported from ${report.sourceFileName}`,
    `Positions created: ${report.positionsCreated}`,
    `Rows skipped: ${report.skipped.length}`,
    `Blocks created: ${report.blocksCreated.join(", ") || "none"}`,
    `Blocks reused: ${report.blocksReused.join(", ") || "none"}`,
    "",
    "Percentages:",
    ...report.bands.map(
      (band) =>
        `  - ${band.label}: ${(band.rate * 100).toFixed(3)}% of ${band.baseSummary}` +
        `, account ${band.accountCode || "none"} (${band.disposition}), ${band.rowCount} rows`
    ),
    "",
    "Skipped rows:",
    ...report.skipped.map(
      (row) => `  - row ${row.sheetRow} ${row.empNumber} ${row.name}: ${row.detail}`
    ),
    "",
    "Worth knowing:",
    ...report.warnings.map((warning) => `  - ${warning}`),
  ].join("\n");
}

export default function OracleImportCard({ ou, scenarioId }: OracleImportCardProps) {
  const [inheritAccounts, setInheritAccounts] = useState(
    DEFAULT_ORACLE_IMPORT_OPTIONS.inheritAccounts
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    severity: "info" | "success" | "warning" | "error";
    text: string;
  } | null>(null);
  const [preview, setPreview] = useState<OracleImportPreview | null>(null);
  const [report, setReport] = useState<OracleImportReport | null>(null);
  const [bands, setBands] = useState<Record<OracleBandKey, OracleBandOverride>>(
    DEFAULT_ORACLE_IMPORT_OPTIONS.bands
  );

  const disabled = !ou || !scenarioId || busy;

  // Seed the per-band controls from whatever analyze resolved, so the dialog
  // opens on the right answer and the user only touches it to disagree.
  useEffect(() => {
    if (!preview) return;
    const seeded = {} as Record<OracleBandKey, OracleBandOverride>;
    for (const band of preview.bands) {
      seeded[band.key] = {
        mode: band.disposition === "existing" ? "existing" : band.disposition,
        blockId: band.blockId,
        rate: band.rate,
        accountCode: band.accountCode,
      };
    }
    setBands(seeded);
  }, [preview]);

  const options = (): OracleImportOptions => ({ bands, inheritAccounts });

  const setBand = (key: OracleBandKey, patch: Partial<OracleBandOverride>) =>
    setBands((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  const handlePick = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await previewOracleImport(ou, scenarioId, {
        bands: DEFAULT_ORACLE_IMPORT_OPTIONS.bands,
        inheritAccounts,
      });
      switch (result.outcome) {
        case "cancelled":
          break;
        case "not_oracle_file":
          setMessage({ severity: "error", text: result.reason });
          break;
        case "no_hotel_standards":
          setMessage({
            severity: "warning",
            text:
              `This hotel has no defaults or calendar set up for ${result.year}. ` +
              `The import prorates each row's public holidays against them, so ` +
              `set them on the Home page first.`,
          });
          break;
        case "ready":
          if (result.preview.positionCount === 0) {
            setMessage({
              severity: "info",
              text:
                `Nothing to import: all ${result.preview.fileRowCount} row(s) in ` +
                `that file are already in this plan or could not be read.`,
            });
          }
          setPreview(result.preview);
          break;
      }
    } catch (error) {
      setMessage({
        severity: "error",
        text: error instanceof Error ? error.message : "Could not read the file.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await commitOracleImport(
        ou,
        scenarioId,
        preview.filePath,
        options()
      );
      setPreview(null);
      if (result.outcome === "ok") {
        setReport(result.report);
        setMessage({
          severity: "success",
          text:
            `Imported ${result.report.positionsCreated} position(s); ` +
            `${result.report.skipped.length} row(s) skipped.`,
        });
      }
    } catch (error) {
      setPreview(null);
      setMessage({
        severity: "error",
        text: error instanceof Error ? error.message : "The import failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const bandRowValue = (key: OracleBandKey): string => {
    const band = bands[key];
    if (!band || band.mode === "off") return OFF_VALUE;
    if (band.mode === "existing" && band.blockId) return band.blockId;
    return CREATE_VALUE;
  };

  return (
    <>
      <Card
        variant="outlined"
        sx={{ mt: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}
      >
        <CardContent>
          <Stack
            direction="row"
            sx={{ justifyContent: "space-between", alignItems: "center", mb: 2 }}
          >
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Import an Oracle report
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={busy ? <CircularProgress size={16} /> : <UploadFileIcon />}
              onClick={handlePick}
              disabled={disabled}
              sx={{ borderRadius: 1, textTransform: "none", px: 2 }}
            >
              {busy ? "Reading…" : "Choose file…"}
            </Button>
          </Stack>
          <Divider sx={{ mb: 2 }} />

          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            Add the associates an Oracle HR export lists to the plan you have
            selected — name, employee number, department, contract hours, days
            off, public holidays, salary and annual leave. Anyone already in the
            plan is skipped, so you can re-run it against a refreshed extract.
            Nothing already in the plan is changed or removed.
          </Typography>

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={inheritAccounts}
                onChange={(event) => setInheritAccounts(event.target.checked)}
              />
            }
            label="Copy posting accounts from the rows already in each department"
          />

          {!scenarioId && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Select a plan on the Positions page first — the import needs
              somewhere to put the positions.
            </Alert>
          )}
          {message && (
            <Alert severity={message.severity} sx={{ mt: 2 }}>
              {message.text}
            </Alert>
          )}
          {report && (
            <Button
              size="small"
              sx={{ mt: 1, textTransform: "none" }}
              onClick={() => setReport({ ...report })}
            >
              Show the full report again
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ── Confirm: what this would do ── */}
      <Dialog
        open={!!preview}
        onClose={busy ? undefined : () => setPreview(null)}
        maxWidth="lg"
        fullWidth
      >
        <DialogTitle>Import {preview?.sourceFileName}</DialogTitle>
        <DialogContent dividers>
          {preview && (
            <Stack spacing={2}>
              <Alert severity="warning">
                This adds <strong>{preview.positionCount}</strong> position(s) to a
                plan that already has <strong>{preview.existingPositionCount}</strong>
                . Nothing already in the plan will be changed or removed. There is
                no undo.
              </Alert>

              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Chip label={`${preview.positionCount} to add`} />
                <Chip label={`${preview.skipped.length} skipped`} />
                <Chip
                  label={`sheet "${preview.sheetName}", headings on row ${preview.headerRow}`}
                />
              </Stack>

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  The first rows as they were read
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
                  The old macro read most of these columns by position rather than
                  by heading. Check them against the file before importing.
                </Typography>
                <Box sx={{ overflowX: "auto" }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell align="right">Row</TableCell>
                        <TableCell>Name</TableCell>
                        <TableCell>Employee</TableCell>
                        <TableCell>Department</TableCell>
                        <TableCell align="right">Hrs/wk</TableCell>
                        <TableCell align="right">Days/wk</TableCell>
                        <TableCell align="right">Salary</TableCell>
                        <TableCell align="right">Leave</TableCell>
                        <TableCell align="right">→ Daily hrs</TableCell>
                        <TableCell align="right">→ Monthly basic</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {preview.sampleRows.map((row) => (
                        <TableRow key={row.sheetRow}>
                          <TableCell align="right">{row.sheetRow}</TableCell>
                          <TableCell>
                            {[row.lastName, row.firstName].filter(Boolean).join(", ")}
                          </TableCell>
                          <TableCell>{row.empNumber}</TableCell>
                          <TableCell>
                            {row.departmentCode}
                            {row.departmentName ? ` ${row.departmentName}` : ""}
                          </TableCell>
                          <TableCell align="right">{formatNumber(row.weeklyHours)}</TableCell>
                          <TableCell align="right">{formatNumber(row.daysPerWeek)}</TableCell>
                          <TableCell align="right">{formatNumber(row.salary)}</TableCell>
                          <TableCell align="right">
                            {formatNumber(row.annualEntitlement)}
                          </TableCell>
                          <TableCell align="right">
                            {formatNumber(row.dailyContractHours)}
                          </TableCell>
                          <TableCell align="right">
                            {formatNumber(row.monthlyBaseSalary)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              </Box>

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Percentages the macro applied
                </Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Band</TableCell>
                      <TableCell>Goes on</TableCell>
                      <TableCell align="right">Rate</TableCell>
                      <TableCell>Account</TableCell>
                      <TableCell>Applies to</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {ORACLE_BAND_KEYS.map((key) => {
                      const band = preview.bands.find((b) => b.key === key);
                      const state = bands[key] ?? { mode: "auto" as const };
                      // Follow the dropdown, not the auto-resolved answer: the
                      // base is the whole point of this column, so it has to
                      // change when the user picks a different block.
                      const chosen =
                        state.mode === "existing" && state.blockId
                          ? preview.blockOptions.find(
                              (option) => option.blockId === state.blockId
                            )
                          : undefined;
                      const baseSummary = chosen
                        ? chosen.baseSummary
                        : state.mode === "create"
                          ? "Base Salary"
                          : (band?.baseSummary ?? "Base Salary");
                      const baseDiffers = chosen
                        ? chosen.baseSummary !== "Base Salary"
                        : state.mode === "create"
                          ? false
                          : !!band?.baseDiffers;
                      return (
                        <TableRow key={key}>
                          <TableCell>{ORACLE_BAND_LABELS[key]}</TableCell>
                          <TableCell sx={{ minWidth: 240 }}>
                            <TextField
                              select
                              size="small"
                              fullWidth
                              value={bandRowValue(key)}
                              onChange={(event) => {
                                const value = event.target.value;
                                if (value === OFF_VALUE) setBand(key, { mode: "off" });
                                else if (value === CREATE_VALUE)
                                  setBand(key, { mode: "create", blockId: undefined });
                                else setBand(key, { mode: "existing", blockId: value });
                              }}
                            >
                              <MenuItem value={CREATE_VALUE}>
                                Create a new block
                              </MenuItem>
                              {preview.blockOptions.map((option) => (
                                <MenuItem key={option.blockId} value={option.blockId}>
                                  {option.label} — % of {option.baseSummary}
                                </MenuItem>
                              ))}
                              <MenuItem value={OFF_VALUE}>Don&apos;t import</MenuItem>
                            </TextField>
                          </TableCell>
                          <TableCell align="right" sx={{ width: 120 }}>
                            <TextField
                              size="small"
                              type="number"
                              value={((state.rate ?? 0) * 100).toString()}
                              disabled={state.mode === "off"}
                              onChange={(event) => {
                                const percent = Number(event.target.value);
                                setBand(key, {
                                  rate: Number.isFinite(percent) ? percent / 100 : 0,
                                });
                              }}
                              slotProps={{ input: { endAdornment: "%" } }}
                            />
                          </TableCell>
                          <TableCell sx={{ width: 140 }}>
                            <TextField
                              size="small"
                              value={state.accountCode ?? ""}
                              disabled={state.mode === "off"}
                              onChange={(event) =>
                                setBand(key, { accountCode: event.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell sx={{ color: "text.secondary" }}>
                            {state.mode === "off" ? "—" : baseSummary}
                            {state.mode !== "off" && baseDiffers ? " ⚠" : ""}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Box>

              <SkippedTable rows={preview.skipped} />

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  What filled the gaps
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {preview.sourcedFields.map((field) => (
                    <Typography
                      key={field.label}
                      component="li"
                      variant="body2"
                      sx={{ color: "text.secondary", mb: 0.25 }}
                    >
                      <strong>{field.label}</strong> — {field.summary}
                    </Typography>
                  ))}
                </Box>
              </Box>

              {preview.unknownDepartments.length > 0 && (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Not in the mapping tables:{" "}
                  {preview.unknownDepartments.join(", ")}.
                </Typography>
              )}

              <WarningList warnings={preview.warnings} />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreview(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleConfirm}
            disabled={busy || !preview || preview.positionCount === 0}
          >
            {busy
              ? "Importing…"
              : `Import ${preview?.positionCount ?? 0} position(s)`}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Report: what it actually did ── */}
      <Dialog open={!!report} onClose={() => setReport(null)} maxWidth="lg" fullWidth>
        <DialogTitle>Imported {report?.sourceFileName}</DialogTitle>
        <DialogContent dividers>
          {report && (
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Chip color="success" label={`${report.positionsCreated} positions`} />
                <Chip label={`${report.skipped.length} skipped`} />
                {report.blocksCreated.length > 0 && (
                  <Chip
                    color="success"
                    label={`${report.blocksCreated.length} block(s) created`}
                  />
                )}
                {report.blocksReused.length > 0 && (
                  <Chip label={`${report.blocksReused.length} block(s) reused`} />
                )}
              </Stack>

              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Band</TableCell>
                    <TableCell>Block</TableCell>
                    <TableCell align="right">Rate</TableCell>
                    <TableCell>Account</TableCell>
                    <TableCell align="right">Rows</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {report.bands.map((band) => (
                    <TableRow key={band.key}>
                      <TableCell>{ORACLE_BAND_LABELS[band.key]}</TableCell>
                      <TableCell>
                        {band.disposition === "off" ? "not imported" : band.label}
                      </TableCell>
                      <TableCell align="right">
                        {(band.rate * 100).toFixed(3)}%
                      </TableCell>
                      <TableCell>{band.accountCode || "—"}</TableCell>
                      <TableCell align="right">{band.rowCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <SkippedTable rows={report.skipped} />
              <WarningList warnings={report.warnings} />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<ContentCopyIcon />}
            sx={{ textTransform: "none" }}
            onClick={() => report && navigator.clipboard.writeText(reportText(report))}
          >
            Copy report
          </Button>
          <Button variant="contained" onClick={() => setReport(null)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

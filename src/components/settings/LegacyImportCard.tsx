/**
 * LegacyImportCard — the Settings entry point for the one-shot migration off
 * the Excel "Payroll Budget Tool".
 *
 * Three steps, deliberately: pick a file (which only reads it), review exactly
 * what would be created, then commit. An import stands a whole hotel up — ~160
 * positions, a dozen blocks, the manual-input sheet — and there is no undo, so
 * the middle step is the point of the feature rather than ceremony.
 *
 * Self-contained: this is the only place in the app that touches legacyImport,
 * so the whole feature can be removed by deleting its folders and this card.
 */

import { useState } from "react";
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
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

import {
  DEFAULT_LEGACY_IMPORT_OPTIONS,
  LegacyBlockPreview,
  LegacyImportOptions,
  LegacyImportPreview,
  LegacyImportReport,
} from "../../shared/legacyImport/ipc";
import {
  commitLegacyImport,
  previewLegacyImport,
} from "../../services/legacyImportService";

export interface LegacyImportCardProps {
  /** The selected hotel; the import can only ever land here. */
  ou: string;
  /** The plan the positions go into. Must have no positions yet. */
  scenarioId: string;
}

/** The block table, shared by the confirm dialog and the report. */
function BlockTable({ blocks }: { blocks: LegacyBlockPreview[] }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Block</TableCell>
          <TableCell>How it calculates</TableCell>
          <TableCell>Account</TableCell>
          <TableCell align="right">Rows</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {blocks.map((block) => (
          <TableRow key={block.label}>
            <TableCell>{block.label}</TableCell>
            <TableCell sx={{ color: "text.secondary" }}>
              {block.baseSummary
                ? `% of ${block.baseSummary}`
                : block.spreadSummary ?? "—"}
            </TableCell>
            <TableCell sx={{ color: "text.secondary" }}>
              {block.accountSummary}
            </TableCell>
            <TableCell align="right">{block.usedRows}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert severity="info" sx={{ mt: 2 }}>
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

/** The report as plain text, for the Copy button. */
function reportText(report: LegacyImportReport): string {
  const lines = [
    `Imported from ${report.sourceFileName}`,
    `Positions: ${report.positionsCreated}`,
    `Manual input rows: ${report.manualInputRowsCreated}`,
    `Allocations: ${report.allocationsCreated.join(", ") || "none"}`,
    `Calendar months updated: ${report.calendarMonthsUpdated}`,
    `Full-time weekly hours: ${report.weeklyHoursUpdated ?? "unchanged"}`,
    "",
    "Blocks:",
    ...report.blocksCreated.map(
      (block) =>
        `  - ${block.label} (${block.blockType}) — ${
          block.baseSummary ? `% of ${block.baseSummary}` : block.spreadSummary ?? ""
        }; account ${block.accountSummary}; ${block.usedRows} rows`
    ),
    "",
    "Worth knowing:",
    ...report.warnings.map((warning) => `  - ${warning}`),
  ];
  return lines.join("\n");
}

export default function LegacyImportCard({ ou, scenarioId }: LegacyImportCardProps) {
  const [options, setOptions] = useState<LegacyImportOptions>(
    DEFAULT_LEGACY_IMPORT_OPTIONS
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    severity: "info" | "success" | "warning" | "error";
    text: string;
  } | null>(null);
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [report, setReport] = useState<LegacyImportReport | null>(null);

  const disabled = !ou || !scenarioId || busy;

  const setOption = (key: keyof LegacyImportOptions, value: boolean) =>
    setOptions((current) => ({ ...current, [key]: value }));

  const handlePick = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await previewLegacyImport(ou, scenarioId, options);
      switch (result.outcome) {
        case "cancelled":
          break;
        case "not_legacy_file":
          setMessage({ severity: "error", text: result.reason });
          break;
        case "scenario_not_empty":
          setMessage({
            severity: "warning",
            text:
              `This plan already has ${result.positionCount} position(s). The ` +
              `import only runs into an empty plan — create a new one and select ` +
              `it first.`,
          });
          break;
        case "ready":
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
      const result = await commitLegacyImport(
        ou,
        scenarioId,
        preview.filePath,
        options
      );
      setPreview(null);
      if (result.outcome === "ok") {
        setReport(result.report);
        setMessage({
          severity: "success",
          text: `Imported ${result.report.positionsCreated} positions and ${result.report.blocksCreated.length} blocks.`,
        });
      } else if (result.outcome === "scenario_not_empty") {
        setMessage({
          severity: "warning",
          text: `This plan now has ${result.positionCount} position(s) — nothing was imported.`,
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
              Import from the Excel tool
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={
                busy ? <CircularProgress size={16} /> : <UploadFileIcon />
              }
              onClick={handlePick}
              disabled={disabled}
              sx={{ borderRadius: 1, textTransform: "none", px: 2 }}
            >
              {busy ? "Reading…" : "Choose file…"}
            </Button>
          </Stack>
          <Divider sx={{ mb: 2 }} />

          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            Bring an existing Payroll Budget Tool workbook (.xlsm) across in one
            go: every associate, the benefit blocks the file actually uses, the
            manual-input sheet, allocations, public holidays and the full-time
            week. Nothing is written until you have seen exactly what it would
            create. It only runs into a plan that has no positions yet.
          </Typography>

          <Stack>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={options.calendarAndHours}
                  onChange={(event) =>
                    setOption("calendarAndHours", event.target.checked)
                  }
                />
              }
              label="Public holidays and full-time weekly hours"
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={options.manualInput}
                  onChange={(event) =>
                    setOption("manualInput", event.target.checked)
                  }
                />
              }
              label="Buyout & Manual Input sheet"
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={options.allocations}
                  onChange={(event) =>
                    setOption("allocations", event.target.checked)
                  }
                />
              }
              label="Allocations sheet"
            />
          </Stack>

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

      {/* ── Confirm: what this would create ── */}
      <Dialog
        open={!!preview}
        onClose={busy ? undefined : () => setPreview(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Import {preview?.sourceFileName}</DialogTitle>
        <DialogContent dividers>
          {preview && (
            <Stack spacing={2}>
              <Alert severity="warning">
                This workbook was last used for{" "}
                <strong>{preview.fileHotelName ?? "an unnamed hotel"}</strong>
                {preview.fileOu ? ` (${preview.fileOu})` : ""}
                {preview.fileYear ? `, budget year ${preview.fileYear}` : ""}.
                Everything below will be created against the hotel and plan you
                currently have selected. There is no undo.
              </Alert>

              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Chip label={`${preview.positionCount} positions`} />
                <Chip label={`${preview.blocks.length} blocks`} />
                <Chip label={`${preview.manualInputRowCount} manual rows`} />
                <Chip
                  label={`${preview.allocationNames.length} allocations`}
                />
                {preview.fullTimeWeeklyHours != null && (
                  <Chip label={`${preview.fullTimeWeeklyHours}h week`} />
                )}
              </Stack>

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Blocks it would create
                </Typography>
                <BlockTable blocks={preview.blocks} />
              </Box>

              {preview.skippedBlocks.length > 0 && (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Empty in this file, so not created:{" "}
                  {preview.skippedBlocks.join(", ")}.
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
          <Button variant="contained" onClick={handleConfirm} disabled={busy}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Report: what it actually did ── */}
      <Dialog
        open={!!report}
        onClose={() => setReport(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Imported {report?.sourceFileName}</DialogTitle>
        <DialogContent dividers>
          {report && (
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Chip
                  color="success"
                  label={`${report.positionsCreated} positions`}
                />
                <Chip
                  color="success"
                  label={`${report.blocksCreated.length} blocks`}
                />
                <Chip
                  color="success"
                  label={`${report.manualInputRowsCreated} manual rows`}
                />
                {report.allocationsCreated.length > 0 && (
                  <Chip
                    color="success"
                    label={`${report.allocationsCreated.length} allocations`}
                  />
                )}
              </Stack>
              <BlockTable blocks={report.blocksCreated} />
              <WarningList warnings={report.warnings} />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<ContentCopyIcon />}
            sx={{ textTransform: "none" }}
            onClick={() =>
              report && navigator.clipboard.writeText(reportText(report))
            }
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

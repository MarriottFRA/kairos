import { useState, useEffect, useRef, useCallback } from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Stack,
  Divider,
  Alert,
  AlertTitle,
  Paper,
  Chip,
  LinearProgress,
  FormControl,
  FormControlLabel,
  Switch,
  InputLabel,
  Select,
  MenuItem,
  SelectChangeEvent,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import LockIcon from "@mui/icons-material/Lock";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import { useSettingsStore } from "../../store/settings";
import authService from "../../services/auth";
import financialDataService from "../../services/financialDataService";
import submissionWindowService, {
  SubmissionWindow,
  deriveWindowMonths,
} from "../../services/submissionWindowService";
import {
  parseAndTransformBstFile,
  validateOwnerBudgetRows,
  uploadOwnerBudget,
  BstTransformResult,
  OwnerBudgetUploadResponse,
} from "../../services/bstImport/ownerBudgetUpload";

const StyledCard = styled(Card)(({ theme }) => ({
  marginBottom: theme.spacing(3),
  boxShadow: theme.shadows[3],
}));

const ACCEPTED_FILE_TYPES = ".xlsm";

const formatDateTime = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : "—";

/** Prominent read-only display of a single metadata value. */
function MetaStat({ label, value }: { label: string; value: string }) {
  return (
    <Paper
      variant="outlined"
      sx={(theme) => ({
        flex: 1,
        minWidth: 160,
        p: 2,
        borderRadius: 2,
        background: alpha(theme.palette.primary.main, 0.04),
      })}
    >
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" fontWeight={700} sx={{ lineHeight: 1.2 }}>
        {value}
      </Typography>
    </Paper>
  );
}

/** Smaller informational label/value pair. */
function MetaInfo({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 160 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={600}>
        {value}
      </Typography>
    </Box>
  );
}

/** A labelled count chip used in the review summary. */
function CountChip({ label, value, color }: { label: string; value: number; color?: "default" | "warning" | "error" | "success" }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color ?? "default"}
      label={`${label}: ${value.toLocaleString()}`}
    />
  );
}

export default function BstImport() {
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);

  const [windows, setWindows] = useState<SubmissionWindow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [selectedWindowId, setSelectedWindowId] = useState<number | "">("");
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [confirmed, setConfirmed] = useState<boolean>(false);

  // Hotel currency (3-char) resolved from hotel metadata; required for upload.
  const [currency, setCurrency] = useState<string | null>(null);

  // ETL / upload state.
  const [ignore700304, setIgnore700304] = useState<boolean>(true);
  const [ignoreReservationAllocation, setIgnoreReservationAllocation] = useState<boolean>(true);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState<boolean>(false);
  const [parseResult, setParseResult] = useState<BstTransformResult | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string>("");
  const [uploadResult, setUploadResult] = useState<OwnerBudgetUploadResponse | null>(null);
  const [syncMessage, setSyncMessage] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch submission windows for the currently selected hotel.
  const loadWindows = useCallback(async () => {
    if (!selectedHotelOu) return;
    setLoading(true);
    setError("");
    try {
      const data = await submissionWindowService.fetchSubmissionWindows(selectedHotelOu);
      setWindows(data);
    } catch (err) {
      console.error("Error fetching submission windows:", err);
      setError(err instanceof Error ? err.message : "Failed to load submission windows");
      setWindows([]);
    } finally {
      setLoading(false);
    }
  }, [selectedHotelOu]);

  const resetUploadState = useCallback(() => {
    setSelectedFile(null);
    setParseResult(null);
    setValidationErrors([]);
    setUploadError("");
    setUploadResult(null);
    setSyncMessage("");
  }, []);

  useEffect(() => {
    // Reset selection whenever the hotel changes, then (re)load its windows.
    setSelectedWindowId("");
    setConfirmed(false);
    resetUploadState();
    loadWindows();
  }, [loadWindows, resetUploadState]);

  // Resolve the selected hotel's currency from hotel metadata.
  useEffect(() => {
    let cancelled = false;
    setCurrency(null);
    if (!selectedHotelOu) return;
    (async () => {
      try {
        const hotels = await authService.getHotels();
        if (cancelled) return;
        const hotel = hotels.find((h) => h.ou === selectedHotelOu);
        setCurrency(hotel?.currency ?? null);
      } catch (err) {
        console.error("Error resolving hotel currency:", err);
        if (!cancelled) setCurrency(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHotelOu]);

  const unlockedWindows = windows.filter((w) => !w.is_locked);
  const hasUnlockedWindow = unlockedWindows.length > 0;
  const selectedWindow = windows.find((w) => w.id === selectedWindowId) ?? null;
  const months = selectedWindow
    ? deriveWindowMonths(selectedWindow.start_period, selectedWindow.period_count)
    : [];
  const periodRange =
    months.length > 0 ? `${months[0].label} – ${months[months.length - 1].label}` : "—";
  const currencyValid = !!currency && currency.length === 3;

  const handleWindowChange = (event: SelectChangeEvent<number | "">) => {
    const value = event.target.value;
    setSelectedWindowId(value === "" ? "" : Number(value));
    // Any change to the window invalidates a prior confirmation / parse.
    setConfirmed(false);
    resetUploadState();
  };

  const handleConfirm = () => {
    setConfirmed(true);
    setConfirmOpen(false);
  };

  // Read + transform the file in the renderer, then pre-flight validate.
  const runParse = useCallback(
    async (file: File, ignore700304Flag: boolean, ignoreResAllocFlag: boolean) => {
      if (!selectedWindow || !currencyValid || !currency) return;
      setParsing(true);
      setUploadError("");
      setUploadResult(null);
      try {
        const result = await parseAndTransformBstFile(file, selectedWindow, {
          currency,
          ignore700304: ignore700304Flag,
          ignoreReservationAllocation: ignoreResAllocFlag,
        });
        setParseResult(result);
        setValidationErrors(validateOwnerBudgetRows(result.rows, selectedWindow));
      } catch (err) {
        console.error("BST parse error:", err);
        setParseResult(null);
        setValidationErrors([]);
        setUploadError(err instanceof Error ? err.message : "Failed to read the file");
      } finally {
        setParsing(false);
      }
    },
    [selectedWindow, currency, currencyValid],
  );

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later.
    event.target.value = "";
    if (!file) return;
    setSelectedFile(file);
    runParse(file, ignore700304, ignoreReservationAllocation);
  };

  const handleToggleIgnore = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    setIgnore700304(next);
    // Re-derive the rows against the same file with the new rule.
    if (selectedFile) runParse(selectedFile, next, ignoreReservationAllocation);
  };

  const handleToggleReservationAllocation = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    setIgnoreReservationAllocation(next);
    // Re-derive the rows against the same file with the new rule.
    if (selectedFile) runParse(selectedFile, ignore700304, next);
  };

  const handleUpload = async () => {
    if (!parseResult || !selectedWindow) return;
    setUploading(true);
    setUploadError("");
    setSyncMessage("");
    try {
      const res = await uploadOwnerBudget(parseResult.rows);
      setUploadResult(res);
      setParseResult(null);
      setSelectedFile(null);
      // last_submission_date / last_submitted_by change on success — refresh.
      await loadWindows();

      // Pull the just-written budget back into the local cache: the affected
      // periods now carry newer server stamps, so the incremental sync detects
      // the divergence and refetches only those periods. A sync failure must not
      // mask the successful upload.
      if (selectedHotelOu) {
        try {
          const sync = await financialDataService.importFinancialDataIncremental(selectedHotelOu);
          setSyncMessage(
            sync.updatedPeriods.length > 0
              ? `Local cache refreshed — updated ${sync.updatedPeriods.length} period(s).`
              : "Local cache already up to date.",
          );
        } catch (syncErr) {
          console.error("Post-upload cache sync failed:", syncErr);
          setSyncMessage(
            "Upload succeeded, but the local cache refresh failed — use “Check for Updates”.",
          );
        }
      }
    } catch (err) {
      console.error("BST upload error:", err);
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const canUpload =
    !!parseResult && parseResult.emitted > 0 && validationErrors.length === 0 && !uploading;

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        BST Import
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Upload a single BST planning extract into an open Owner-Budget submission window.
      </Typography>

      {/* No hotel selected */}
      {!selectedHotelOu && (
        <Alert severity="info">
          Select a hotel from the toolbar to see its available upload windows.
        </Alert>
      )}

      {selectedHotelOu && (
        <>
          {/* Window selection */}
          <StyledCard>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Upload Window
              </Typography>
              <Divider sx={{ mb: 2 }} />

              {loading ? (
                <LinearProgress />
              ) : error ? (
                <Alert severity="error" icon={<ErrorIcon />}>
                  {error}
                </Alert>
              ) : (
                <>
                  {!hasUnlockedWindow && (
                    <Alert severity="warning" sx={{ mb: 2 }}>
                      No open upload window is available for this hotel. Uploads are disabled
                      until an administrator opens a window.
                    </Alert>
                  )}

                  <FormControl fullWidth disabled={!hasUnlockedWindow} sx={{ maxWidth: 480 }}>
                    <InputLabel id="bst-window-label">Submission Window</InputLabel>
                    <Select
                      labelId="bst-window-label"
                      id="bst-window-select"
                      value={selectedWindowId}
                      label="Submission Window"
                      onChange={handleWindowChange}
                    >
                      <MenuItem value="" disabled>
                        <em>Select a window</em>
                      </MenuItem>
                      {windows.map((w) => (
                        <MenuItem key={w.id} value={w.id} disabled={w.is_locked}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            {w.is_locked && <LockIcon sx={{ fontSize: 16 }} />}
                            <Typography variant="body2">{w.name}</Typography>
                          </Stack>
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </>
              )}
            </CardContent>
          </StyledCard>

          {/* Metadata review (read-only) */}
          {selectedWindow && (
            <StyledCard>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Review Window Details
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  These values are fixed by the window and cannot be edited. Confirm they are
                  correct before uploading — this prevents loading the wrong data (e.g. forecast
                  into a budget window).
                </Typography>
                <Divider sx={{ mb: 2 }} />

                {/* Prominent: scenario + version */}
                <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
                  <MetaStat label="Scenario" value={selectedWindow.scenario} />
                  <MetaStat label="Version" value={selectedWindow.version} />
                </Stack>

                {/* Informational */}
                <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
                  <MetaInfo label="Window" value={selectedWindow.name} />
                  <MetaInfo label="Operating Unit" value={selectedWindow.ou} />
                  <MetaInfo label="Currency" value={currency ?? "—"} />
                  <MetaInfo
                    label="Last Uploaded"
                    value={formatDateTime(selectedWindow.last_submission_date)}
                  />
                  <MetaInfo
                    label="Last Uploaded By"
                    value={
                      selectedWindow.last_submitted_by != null
                        ? String(selectedWindow.last_submitted_by)
                        : "—"
                    }
                  />
                </Stack>

                {/* Periods table: M1..Mn → contiguous months */}
                <Typography variant="subtitle2" gutterBottom>
                  Periods ({periodRange})
                </Typography>
                <Box sx={{ overflowX: "auto" }}>
                  <Table size="small" sx={{ width: "auto", "& td, & th": { textAlign: "center", whiteSpace: "nowrap" } }}>
                    <TableHead>
                      <TableRow>
                        {months.map((m) => (
                          <TableCell key={m.col} sx={{ fontWeight: 700 }}>
                            {m.col}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        {months.map((m) => (
                          <TableCell key={m.col}>
                            <Typography variant="body2" fontWeight={600}>
                              {m.label}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {m.period}
                            </Typography>
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableBody>
                  </Table>
                </Box>

                {!confirmed && (
                  <Button
                    variant="contained"
                    sx={{ mt: 3 }}
                    onClick={() => setConfirmOpen(true)}
                  >
                    Continue
                  </Button>
                )}
              </CardContent>
            </StyledCard>
          )}

          {/* File upload — only after the user confirms the metadata */}
          {selectedWindow && confirmed && (
            <StyledCard>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Upload File
                </Typography>
                <Divider sx={{ mb: 2 }} />

                {!currencyValid ? (
                  <Alert severity="error" icon={<ErrorIcon />}>
                    Hotel currency is not configured (a 3-character code is required). Please
                    contact an administrator before uploading.
                  </Alert>
                ) : (
                  <>
                    <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mb: 2 }}>
                      Confirmed: {selectedWindow.scenario} · {selectedWindow.version} ·{" "}
                      {periodRange} · {currency}. Select the BST extract to upload.
                    </Alert>

                    <FormControlLabel
                      control={
                        <Switch checked={ignore700304} onChange={handleToggleIgnore} />
                      }
                      label="Ignore account 700304"
                      sx={{ mb: 1, display: "block" }}
                    />

                    <FormControlLabel
                      control={
                        <Switch
                          checked={ignoreReservationAllocation}
                          onChange={handleToggleReservationAllocation}
                        />
                      }
                      label="Ignore reservation allocation"
                      sx={{ mb: 1, display: "block" }}
                    />

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={ACCEPTED_FILE_TYPES}
                      onChange={handleFileSelected}
                      style={{ display: "none" }}
                    />
                    <Button
                      variant="outlined"
                      startIcon={<UploadFileIcon />}
                      disabled={parsing || uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {parsing ? "Reading file…" : selectedFile ? "Choose a different file" : "Select File"}
                    </Button>
                    {parsing && <LinearProgress sx={{ mt: 2 }} />}

                    {uploadError && (
                      <Alert severity="error" icon={<ErrorIcon />} sx={{ mt: 2, whiteSpace: "pre-line" }}>
                        {uploadError}
                      </Alert>
                    )}

                    {/* Review summary (parsed, not yet uploaded) */}
                    {parseResult && !uploadResult && (
                      <Box sx={{ mt: 3 }}>
                        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                          Review — {selectedFile?.name}
                        </Typography>

                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
                          <CountChip label="Rows to upload" value={parseResult.emitted} color="success" />
                          <CountChip label="Source rows" value={parseResult.sourceRows} />
                          <CountChip label="Empty/zero skipped" value={parseResult.skippedZeroBlank} />
                          {ignore700304 && (
                            <CountChip label="700304 ignored" value={parseResult.ignoredCount} />
                          )}
                          {ignoreReservationAllocation && (
                            <CountChip
                              label="Res. allocation ignored"
                              value={parseResult.reservationAllocationIgnored}
                            />
                          )}
                          {parseResult.ouMismatch > 0 && (
                            <CountChip label="Wrong OU skipped" value={parseResult.ouMismatch} color="warning" />
                          )}
                          {parseResult.skippedNonNumeric > 0 && (
                            <CountChip label="Non-numeric skipped" value={parseResult.skippedNonNumeric} color="warning" />
                          )}
                        </Stack>

                        <Alert severity="warning" sx={{ mb: 2 }}>
                          <AlertTitle>This replaces existing data</AlertTitle>
                          Uploading will <strong>delete and replace</strong> existing{" "}
                          {selectedWindow.scenario}/{selectedWindow.version} rows for{" "}
                          <strong>{periodRange}</strong> at {selectedWindow.ou}. Lines not present
                          in this file are removed; periods outside this window are untouched.
                        </Alert>

                        {parseResult.ouMismatch > 0 && parseResult.emitted === 0 && (
                          <Alert severity="error" sx={{ mb: 2 }}>
                            Every row in this file is for a different operating unit than the
                            selected window ({selectedWindow.ou}). This looks like the wrong file.
                          </Alert>
                        )}

                        {parseResult.emitted === 0 && parseResult.ouMismatch === 0 && (
                          <Alert severity="info" sx={{ mb: 2 }}>
                            No rows to upload — all month cells were empty, zero, or excluded.
                          </Alert>
                        )}

                        {validationErrors.length > 0 && (
                          <Alert severity="error" sx={{ mb: 2, whiteSpace: "pre-line" }}>
                            <AlertTitle>Validation failed ({validationErrors.length} shown)</AlertTitle>
                            {validationErrors.join("\n")}
                          </Alert>
                        )}

                        <Button
                          variant="contained"
                          color="primary"
                          startIcon={<UploadFileIcon />}
                          disabled={!canUpload}
                          onClick={handleUpload}
                        >
                          {uploading ? "Uploading…" : `Upload ${parseResult.emitted.toLocaleString()} rows`}
                        </Button>
                        {uploading && <LinearProgress sx={{ mt: 2 }} />}
                      </Box>
                    )}

                    {/* Success summary */}
                    {uploadResult && (
                      <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mt: 3 }}>
                        <AlertTitle>Upload complete</AlertTitle>
                        Inserted {uploadResult.inserted_count.toLocaleString()} row(s); replaced{" "}
                        {uploadResult.deleted_count.toLocaleString()}. Periods:{" "}
                        {uploadResult.periods.join(", ")}.
                        <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
                          Load ID: {uploadResult.load_id}
                        </Typography>
                      </Alert>
                    )}

                    {uploadResult && syncMessage && (
                      <Alert
                        severity={syncMessage.includes("failed") ? "warning" : "info"}
                        sx={{ mt: 2 }}
                      >
                        {syncMessage}
                      </Alert>
                    )}
                  </>
                )}
              </CardContent>
            </StyledCard>
          )}
        </>
      )}

      {/* Confirmation dialog */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 600 }}>Is this metadata correct?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Typography variant="body1" color="text.secondary" mb={2}>
              You are about to upload into the following window. Please confirm the scenario,
              version and periods are correct so you don't load the wrong data.
            </Typography>
            {selectedWindow && (
              <Stack spacing={1} sx={{ mb: 1 }}>
                <Chip
                  color="primary"
                  variant="outlined"
                  label={`Scenario: ${selectedWindow.scenario}`}
                  sx={{ width: "fit-content" }}
                />
                <Chip
                  color="primary"
                  variant="outlined"
                  label={`Version: ${selectedWindow.version}`}
                  sx={{ width: "fit-content" }}
                />
                <Typography variant="body2" color="text.secondary">
                  Periods: {periodRange}
                </Typography>
              </Stack>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button variant="outlined" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleConfirm}>
            Yes, metadata is correct
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

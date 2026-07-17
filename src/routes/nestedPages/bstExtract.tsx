/**
 * BST Extract Settings Page
 * ===========================
 * Lets users map each of the 24 BST CSV period columns (LY PD1..12, TY PD1..12)
 * to a concrete (year, month, scenario, version) tuple, persist the mapping
 * globally (per user, across all OUs), and generate the BST Extract CSV for
 * the currently selected hotel (OU).
 *
 * Mapping is stored as a single JSON blob under the `bstExtractMapping`
 * key in user_settings — piggybacks the existing settings IPC channels.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Box, Typography, Card, CardContent, FormControl, InputLabel, Select, MenuItem,
  Button, Stack, Alert, CircularProgress, Divider, Paper,
  Table, TableHead, TableBody, TableRow, TableCell,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useSettingsStore } from "../../store/settings";

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type Scenario = 'ACT' | 'BUD';
type Version = 'MAIN' | 'OWNR';

interface ColumnMapping {
  year: number;
  month: number;
  scenario: Scenario;
  version: Version;
}

type Mapping = Record<string, ColumnMapping>;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COLUMN_IDS = [
  ...Array.from({ length: 12 }, (_, i) => `LY_PD${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `TY_PD${i + 1}`),
];
const COLUMN_LABELS: Record<string, string> = COLUMN_IDS.reduce((acc, id) => {
  acc[id] = id.replace('_', ' ');
  return acc;
}, {} as Record<string, string>);

const SETTINGS_KEY = 'bstExtractMapping';
const MAPPING_VERSION = 1;
const CURRENT_YEAR = new Date().getFullYear();
const YEAR_RANGE = Array.from({ length: 7 }, (_, i) => CURRENT_YEAR - 3 + i);

// Default mapping: empty until user fills it (validation prevents generate).
const EMPTY_MAPPING: Mapping = {};

// ============================================================================
// STYLES (mirrored from proteaBudgetPack for consistency)
// ============================================================================

const StyledCard = styled(Card)(({ theme }) => ({
  marginBottom: theme.spacing(3),
  boxShadow: theme.shadows[3],
}));

const SectionPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  marginBottom: theme.spacing(2),
  backgroundColor: theme.palette.mode === 'dark'
    ? alpha(theme.palette.background.paper, 0.6)
    : theme.palette.background.paper,
}));

const GenerateButton = styled(Button)(({ theme }) => ({
  minWidth: 200,
  padding: theme.spacing(1.5, 4),
  fontSize: '1rem',
  fontWeight: 600,
  borderRadius: theme.spacing(1),
  boxShadow: theme.shadows[2],
  '&:hover': { boxShadow: theme.shadows[4] },
}));

// ============================================================================
// HELPERS
// ============================================================================

/** Walk a year/month pair forward by n months. */
function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  // month is 1-12; normalise via 0-11 then convert back
  const total = (year * 12) + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** ACT forces version=MAIN. Use this anywhere a scenario change happens. */
function normaliseVersion(scenario: Scenario, version: Version): Version {
  return scenario === 'ACT' ? 'MAIN' : version;
}

// ============================================================================
// MAPPING TABLE COMPONENT
// ============================================================================

interface MappingTableProps {
  ids: string[];                          // subset of COLUMN_IDS to render
  mapping: Mapping;
  onChange: (id: string, next: ColumnMapping) => void;
}

function MappingTable({ ids, mapping, onChange }: MappingTableProps) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: '15%', fontWeight: 600 }}>Column</TableCell>
          <TableCell sx={{ width: '20%', fontWeight: 600 }}>Year</TableCell>
          <TableCell sx={{ width: '25%', fontWeight: 600 }}>Month</TableCell>
          <TableCell sx={{ width: '20%', fontWeight: 600 }}>Scenario</TableCell>
          <TableCell sx={{ width: '20%', fontWeight: 600 }}>Version</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {ids.map((id) => {
          const m = mapping[id];
          return (
            <TableRow key={id} hover>
              <TableCell sx={{ fontWeight: 500 }}>{COLUMN_LABELS[id]}</TableCell>
              <TableCell>
                <FormControl size="small" fullWidth>
                  <Select
                    value={m?.year ?? ''}
                    displayEmpty
                    onChange={(e) => onChange(id, {
                      year: Number(e.target.value),
                      month: m?.month ?? 1,
                      scenario: m?.scenario ?? 'ACT',
                      version: normaliseVersion(m?.scenario ?? 'ACT', m?.version ?? 'MAIN'),
                    })}
                  >
                    <MenuItem value=""><em>—</em></MenuItem>
                    {YEAR_RANGE.map(y => <MenuItem key={y} value={y}>{y}</MenuItem>)}
                  </Select>
                </FormControl>
              </TableCell>
              <TableCell>
                <FormControl size="small" fullWidth>
                  <Select
                    value={m?.month ?? ''}
                    displayEmpty
                    onChange={(e) => onChange(id, {
                      year: m?.year ?? CURRENT_YEAR,
                      month: Number(e.target.value),
                      scenario: m?.scenario ?? 'ACT',
                      version: normaliseVersion(m?.scenario ?? 'ACT', m?.version ?? 'MAIN'),
                    })}
                  >
                    <MenuItem value=""><em>—</em></MenuItem>
                    {MONTH_NAMES.map((n, i) => <MenuItem key={i + 1} value={i + 1}>{n}</MenuItem>)}
                  </Select>
                </FormControl>
              </TableCell>
              <TableCell>
                <FormControl size="small" fullWidth>
                  <Select
                    value={m?.scenario ?? 'ACT'}
                    onChange={(e) => {
                      const scenario = e.target.value as Scenario;
                      onChange(id, {
                        year: m?.year ?? CURRENT_YEAR,
                        month: m?.month ?? 1,
                        scenario,
                        version: normaliseVersion(scenario, m?.version ?? 'MAIN'),
                      });
                    }}
                  >
                    <MenuItem value="ACT">ACT</MenuItem>
                    <MenuItem value="BUD">BUD</MenuItem>
                  </Select>
                </FormControl>
              </TableCell>
              <TableCell>
                <FormControl size="small" fullWidth disabled={(m?.scenario ?? 'ACT') === 'ACT'}>
                  <Select
                    value={m?.scenario === 'ACT' ? 'MAIN' : (m?.version ?? 'MAIN')}
                    onChange={(e) => onChange(id, {
                      year: m?.year ?? CURRENT_YEAR,
                      month: m?.month ?? 1,
                      scenario: m?.scenario ?? 'BUD',
                      version: e.target.value as Version,
                    })}
                  >
                    <MenuItem value="MAIN">MAIN</MenuItem>
                    <MenuItem value="OWNR">OWNR</MenuItem>
                  </Select>
                </FormControl>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ============================================================================
// BULK-FILL DIALOG
// ============================================================================

interface BulkFillDialogProps {
  open: boolean;
  block: 'LY' | 'TY';
  onClose: () => void;
  onApply: (start: ColumnMapping) => void;
}

function BulkFillDialog({ open, block, onClose, onApply }: BulkFillDialogProps) {
  const [year, setYear] = useState<number>(CURRENT_YEAR);
  const [month, setMonth] = useState<number>(1);
  const [scenario, setScenario] = useState<Scenario>('ACT');
  const [version, setVersion] = useState<Version>('MAIN');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Fill {block} PD1..PD12 from starting period</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Walks 12 entries forward from this period (handles year rollover automatically).
            Useful for hotels with offset fiscal years — pick the month that maps to PD1.
          </Typography>
          <FormControl size="small" fullWidth>
            <InputLabel>Start Year</InputLabel>
            <Select value={year} label="Start Year" onChange={(e) => setYear(Number(e.target.value))}>
              {YEAR_RANGE.map(y => <MenuItem key={y} value={y}>{y}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Start Month</InputLabel>
            <Select value={month} label="Start Month" onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((n, i) => <MenuItem key={i + 1} value={i + 1}>{n}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Scenario</InputLabel>
            <Select
              value={scenario}
              label="Scenario"
              onChange={(e) => {
                const s = e.target.value as Scenario;
                setScenario(s);
                if (s === 'ACT') setVersion('MAIN');
              }}
            >
              <MenuItem value="ACT">ACT</MenuItem>
              <MenuItem value="BUD">BUD</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth disabled={scenario === 'ACT'}>
            <InputLabel>Version</InputLabel>
            <Select value={version} label="Version" onChange={(e) => setVersion(e.target.value as Version)}>
              <MenuItem value="MAIN">MAIN</MenuItem>
              <MenuItem value="OWNR">OWNR</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<AutoFixHighIcon />}
          onClick={() => onApply({ year, month, scenario, version: normaliseVersion(scenario, version) })}
        >
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function BSTExtract() {
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);

  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [loadingMapping, setLoadingMapping] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fillDialog, setFillDialog] = useState<null | 'LY' | 'TY'>(null);

  // --- Load persisted mapping on mount ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await window.ipcApi.sendIpcRequest('settings-get-single', { key: SETTINGS_KEY });
        if (cancelled) return;
        const value = resp?.data;
        if (value && typeof value === 'object' && value.columns) {
          // Tolerate unknown shapes — only accept the version we know.
          if (value.version === MAPPING_VERSION) {
            setMapping(value.columns as Mapping);
          }
        }
      } catch (e) {
        console.error('Failed to load BST mapping:', e);
      } finally {
        if (!cancelled) setLoadingMapping(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // --- Auto-save mapping (debounced) ---
  useEffect(() => {
    if (loadingMapping) return;  // skip the initial load
    const handle = window.setTimeout(() => {
      window.ipcApi.sendIpcRequest('settings-set-single', {
        key: SETTINGS_KEY,
        value: { version: MAPPING_VERSION, columns: mapping },
      }).catch((e) => console.error('Failed to save BST mapping:', e));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [mapping, loadingMapping]);

  // --- Row edit handler ---
  const handleRowChange = (id: string, next: ColumnMapping) => {
    setMapping(prev => ({ ...prev, [id]: next }));
  };

  // --- Bulk-fill apply ---
  const handleBulkApply = (start: ColumnMapping) => {
    if (!fillDialog) return;
    const prefix = fillDialog === 'LY' ? 'LY_PD' : 'TY_PD';
    const next: Mapping = { ...mapping };
    for (let i = 0; i < 12; i++) {
      const { year, month } = addMonths(start.year, start.month, i);
      next[`${prefix}${i + 1}`] = {
        year,
        month,
        scenario: start.scenario,
        version: normaliseVersion(start.scenario, start.version),
      };
    }
    setMapping(next);
    setFillDialog(null);
  };

  // --- Validation: all 24 columns must be fully filled ---
  const mappingComplete = useMemo(() => {
    return COLUMN_IDS.every(id => {
      const m = mapping[id];
      return m && Number.isFinite(m.year) && Number.isFinite(m.month) && !!m.scenario && !!m.version;
    });
  }, [mapping]);

  const canGenerate = !!selectedHotelOu && mappingComplete && !generating && !loadingMapping;

  // --- Generate ---
  const handleGenerate = async () => {
    if (!selectedHotelOu) { setError('Please select a hotel first'); return; }
    if (!mappingComplete) { setError('Please fill in all 24 period mappings'); return; }
    setGenerating(true); setError(null); setSuccess(null);
    try {
      const resp: any = await window.ipcApi.sendIpcRequest('protea:generate-bst-extract', {
        ou: selectedHotelOu,
        mapping,
      });
      if (resp?.success && resp.data?.filePath) {
        setSuccess(`Extract saved to: ${resp.data.filePath}`);
      } else if (resp?.error === 'Save cancelled by user') {
        // user dismissed — silent
      } else {
        setError(resp?.error || 'Failed to generate BST Extract');
      }
    } catch (e: any) {
      setError(e?.message || 'An error occurred while generating the BST Extract');
    } finally {
      setGenerating(false);
    }
  };

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <Box sx={{ p: 3, maxWidth: 1100 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 600 }}>
          BST Extract
        </Typography>
      </Box>

      <StyledCard>
        <CardContent>
          <SectionPaper elevation={0}>
            <Typography variant="h6" gutterBottom>
              Period Mapping
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Map each of the 24 BST period columns to a real (Year, Month, Scenario, Version) tuple.
              Prior2YR YTD is always zero in the output. Use the bulk-fill buttons to populate a block
              of 12 columns from a starting period — handy for offset fiscal years.
              Mapping is saved automatically and reused across all hotels.
            </Typography>

            <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<AutoFixHighIcon />}
                onClick={() => setFillDialog('LY')}
              >
                Fill LY PD1..PD12
              </Button>
              <Button
                variant="outlined"
                size="small"
                startIcon={<AutoFixHighIcon />}
                onClick={() => setFillDialog('TY')}
              >
                Fill TY PD1..PD12
              </Button>
            </Stack>

            <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2, mb: 1 }}>
              LY Periods
            </Typography>
            <MappingTable
              ids={COLUMN_IDS.slice(0, 12)}
              mapping={mapping}
              onChange={handleRowChange}
            />

            <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 3, mb: 1 }}>
              TY Periods
            </Typography>
            <MappingTable
              ids={COLUMN_IDS.slice(12)}
              mapping={mapping}
              onChange={handleRowChange}
            />
          </SectionPaper>

          <Divider sx={{ my: 3 }} />

          <SectionPaper elevation={0} sx={{ backgroundColor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.info.main, 0.1)
              : alpha(theme.palette.info.main, 0.05)
          }}>
            <Typography variant="h6" gutterBottom>
              Extract Contents
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
                <strong>One row per dept-account</strong> from the selected OU's General Ledger.
              </Typography>
              <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
                <strong>Raw GL values</strong> — Protea repoints/movements are NOT applied.
              </Typography>
              <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
                <strong>Balance-sheet accounts excluded</strong> (A1xxx, A2xxx).
              </Typography>
              <Typography component="li" variant="body2">
                <strong>Rows where every period value is zero are skipped.</strong>
              </Typography>
            </Box>
          </SectionPaper>

          {error && (
            <Alert severity="error" icon={<ErrorIcon />} sx={{ mt: 3 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {success && (
            <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mt: 3 }} onClose={() => setSuccess(null)}>
              {success}
            </Alert>
          )}

          <Stack direction="row" justifyContent="center" sx={{ mt: 3 }}>
            <GenerateButton
              variant="contained"
              color="primary"
              size="large"
              startIcon={generating ? <CircularProgress size={20} color="inherit" /> : <FileDownloadIcon />}
              onClick={handleGenerate}
              disabled={!canGenerate}
            >
              {generating ? 'Generating...' : 'Generate BST Extract'}
            </GenerateButton>
          </Stack>

          {!selectedHotelOu && (
            <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ mt: 2 }}>
              Please select a hotel from the top navigation.
            </Typography>
          )}
          {selectedHotelOu && !mappingComplete && (
            <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ mt: 2 }}>
              Fill all 24 period mappings to enable generation.
            </Typography>
          )}
        </CardContent>
      </StyledCard>

      <BulkFillDialog
        open={!!fillDialog}
        block={fillDialog ?? 'LY'}
        onClose={() => setFillDialog(null)}
        onApply={handleBulkApply}
      />
    </Box>
  );
}

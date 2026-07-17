/**
 * Protea Report Pack Settings Page
 * ==================================
 * Allows users to configure and generate Protea Report Pack Excel reports.
 * Settings are persisted to SQLite and restored on page load.
 */

import { useState } from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Stack,
  Alert,
  CircularProgress,
  Divider,
  Grid,
  Paper,
  FormControlLabel,
  Switch,
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import { useSettingsStore, useFinancialDataVersion } from "../../store/settings";
import CheckForUpdatesButton from "../../components/CheckForUpdatesButton";
// ============================================================================
// STYLES
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
  '&:hover': {
    boxShadow: theme.shadows[4],
  },
}));

// ============================================================================
// CONSTANTS
// ============================================================================

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const YEARS = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i);

// ============================================================================
// COMPONENT
// ============================================================================

export default function ProteaReportPack() {
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const financialDataVersion = useFinancialDataVersion();
  const setFinancialDataVersion = useSettingsStore((s) => s.setFinancialDataVersion);

  // Use persisted settings from store
  const selectedMonth = useSettingsStore((s) => s.proteaReportPackSelectedMonth);
  const selectedYear = useSettingsStore((s) => s.proteaReportPackSelectedYear);
  const ytdStartMonth = useSettingsStore((s) => s.proteaReportPackYtdStartMonth);
  const ytdStartYear = useSettingsStore((s) => s.proteaReportPackYtdStartYear);
  const ytdEndMonth = useSettingsStore((s) => s.proteaReportPackYtdEndMonth);
  const ytdEndYear = useSettingsStore((s) => s.proteaReportPackYtdEndYear);

  // Setters from store (persist to SQLite)
  const setSelectedMonth = useSettingsStore((s) => s.setProteaReportPackSelectedMonth);
  const setSelectedYear = useSettingsStore((s) => s.setProteaReportPackSelectedYear);
  const setYtdStartMonth = useSettingsStore((s) => s.setProteaReportPackYtdStartMonth);
  const setYtdStartYear = useSettingsStore((s) => s.setProteaReportPackYtdStartYear);
  const setYtdEndMonth = useSettingsStore((s) => s.setProteaReportPackYtdEndMonth);
  const setYtdEndYear = useSettingsStore((s) => s.setProteaReportPackYtdEndYear);

  // Local UI state
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const includeDetailBreakdown = useSettingsStore((s) => s.includeDetailBreakdown);
  const setIncludeDetailBreakdown = useSettingsStore((s) => s.setIncludeDetailBreakdown);
  const includeBanquetingBreakdown = useSettingsStore((s) => s.includeBanquetingBreakdown);
  const setIncludeBanquetingBreakdown = useSettingsStore((s) => s.setIncludeBanquetingBreakdown);

  // Validation: end period must be >= start period
  const isDateRangeValid = (): boolean => {
    const startDate = ytdStartYear * 12 + ytdStartMonth;
    const endDate = ytdEndYear * 12 + ytdEndMonth;
    return endDate >= startDate;
  };

  const handleGenerate = async () => {
    if (!selectedHotelOu) {
      setError('Please select a hotel first');
      return;
    }

    if (!isDateRangeValid()) {
      setError('End period must be after or equal to start period');
      return;
    }

    setGenerating(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await window.ipcApi.sendIpcRequest('protea:generate-report', {
        ou: selectedHotelOu,
        hotelName: selectedHotelOu.replace(/[^a-zA-Z0-9]/g, '_'),
        selectedMonth,
        selectedYear,
        ytdStartMonth,
        ytdStartYear,
        ytdEndMonth,
        ytdEndYear,
        version: financialDataVersion || 'MAIN',
        generateDetailTabs: includeDetailBreakdown,
        includeBanquetingBreakdown,
      });

      if (response.success && response.data?.filePath) {
        setSuccess(`Report saved to: ${response.data.filePath}`);
      } else if (response.error === 'Save cancelled by user') {
        // User cancelled, don't show error
        setError(null);
      } else {
        setError(response.error || 'Failed to generate report');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while generating the report');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1000 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 600 }}>
          Protea Report Pack
        </Typography>
        <CheckForUpdatesButton />
      </Box>

      <StyledCard>
        <CardContent>
          {/* Budget Version Selection */}
          <SectionPaper elevation={0} sx={{ mb: 3 }}>
            <Typography variant="h6" gutterBottom sx={{ mb: 2 }}>
              Budget Version
            </Typography>
            <FormControl sx={{ minWidth: 250 }}>
              <InputLabel>Budget Version</InputLabel>
              <Select
                value={financialDataVersion || 'MAIN'}
                label="Budget Version"
                onChange={(e) => setFinancialDataVersion(e.target.value)}
              >
                <MenuItem value="MAIN">Marriott Planning</MenuItem>
                <MenuItem value="OWNR">Owner Planning</MenuItem>
              </Select>
            </FormControl>
          </SectionPaper>

          <Divider sx={{ my: 3 }} />

          {/* Selected Month Section */}
          <SectionPaper elevation={0}>
            <Typography variant="h6" gutterBottom sx={{ mb: 2 }}>
              Selected Month
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              All report tabs will include a section showing data for this single month.
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth>
                  <InputLabel>Month</InputLabel>
                  <Select
                    value={selectedMonth}
                    label="Month"
                    onChange={(e) => setSelectedMonth(Number(e.target.value))}
                  >
                    {MONTH_NAMES.map((name, index) => (
                      <MenuItem key={index + 1} value={index + 1}>
                        {name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth>
                  <InputLabel>Year</InputLabel>
                  <Select
                    value={selectedYear}
                    label="Year"
                    onChange={(e) => setSelectedYear(Number(e.target.value))}
                  >
                    {YEARS.map((year) => (
                      <MenuItem key={year} value={year}>
                        {year}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
            </Grid>
          </SectionPaper>

          <Divider sx={{ my: 3 }} />

          {/* YTD / Date Range Section */}
          <SectionPaper elevation={0}>
            <Typography variant="h6" gutterBottom sx={{ mb: 2 }}>
              Year-to-Date / Custom Range
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              All report tabs will include a second section for this date range.
              Select the start and end periods for this section.
            </Typography>

            <Typography variant="subtitle2" sx={{ mb: 1, mt: 2, color: 'text.secondary' }}>
              Start Period
            </Typography>
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth>
                  <InputLabel>Month</InputLabel>
                  <Select
                    value={ytdStartMonth}
                    label="Month"
                    onChange={(e) => setYtdStartMonth(Number(e.target.value))}
                  >
                    {MONTH_NAMES.map((name, index) => (
                      <MenuItem key={index + 1} value={index + 1}>
                        {name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth>
                  <InputLabel>Year</InputLabel>
                  <Select
                    value={ytdStartYear}
                    label="Year"
                    onChange={(e) => setYtdStartYear(Number(e.target.value))}
                  >
                    {YEARS.map((year) => (
                      <MenuItem key={year} value={year}>
                        {year}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
            </Grid>

            <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary' }}>
              End Period
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth error={!isDateRangeValid()}>
                  <InputLabel>Month</InputLabel>
                  <Select
                    value={ytdEndMonth}
                    label="Month"
                    onChange={(e) => setYtdEndMonth(Number(e.target.value))}
                  >
                    {MONTH_NAMES.map((name, index) => (
                      <MenuItem key={index + 1} value={index + 1}>
                        {name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth error={!isDateRangeValid()}>
                  <InputLabel>Year</InputLabel>
                  <Select
                    value={ytdEndYear}
                    label="Year"
                    onChange={(e) => setYtdEndYear(Number(e.target.value))}
                  >
                    {YEARS.map((year) => (
                      <MenuItem key={year} value={year}>
                        {year}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
            </Grid>

            {!isDateRangeValid() && (
              <Alert severity="error" sx={{ mt: 2 }}>
                End period must be after or equal to start period
              </Alert>
            )}
          </SectionPaper>

          <Divider sx={{ my: 3 }} />

          {/* Report Toggles */}
          <SectionPaper elevation={0}>
            <Typography variant="h6" gutterBottom sx={{ mb: 2 }}>
              Detail Level
            </Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={includeBanquetingBreakdown}
                  onChange={(e) => setIncludeBanquetingBreakdown(e.target.checked)}
                />
              }
              label="Banqueting breakdown"
              sx={{ display: 'block', mb: 1 }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={includeDetailBreakdown}
                  onChange={(e) => setIncludeDetailBreakdown(e.target.checked)}
                />
              }
              label="Include detailed breakdown"
            />
          </SectionPaper>

          <Divider sx={{ my: 3 }} />

          {/* Report Contents Info */}
          <SectionPaper elevation={0} sx={{ backgroundColor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.info.main, 0.1)
              : alpha(theme.palette.info.main, 0.05)
          }}>
            <Typography variant="h6" gutterBottom sx={{ mb: 2 }}>
              Report Contents
            </Typography>
            <Typography variant="body2" sx={{ mb: 1 }}>
              The generated Protea Report Pack will contain:
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
                <strong>F90 Report</strong> - Full P&L with Selected Month and period range sections
              </Typography>
              <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
                <strong>Room Segments</strong> - Room revenue breakdown with Selected Month and period range sections
              </Typography>
              <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
                <strong>Department Tabs</strong> - Account-level detail with Selected Month and period range sections
              </Typography>
              <Typography component="li" variant="body2">
                <strong>Comments Column</strong> - Empty column on each sheet for your notes
              </Typography>
            </Box>
          </SectionPaper>

          {/* Status Messages */}
          {error && (
            <Alert
              severity="error"
              icon={<ErrorIcon />}
              sx={{ mt: 3 }}
              onClose={() => setError(null)}
            >
              {error}
            </Alert>
          )}

          {success && (
            <Alert
              severity="success"
              icon={<CheckCircleIcon />}
              sx={{ mt: 3 }}
              onClose={() => setSuccess(null)}
            >
              {success}
            </Alert>
          )}

          {/* Generate Button */}
          <Stack direction="row" justifyContent="center" sx={{ mt: 2 }}>
            <GenerateButton
              variant="contained"
              color="primary"
              size="large"
              startIcon={generating ? <CircularProgress size={20} color="inherit" /> : <FileDownloadIcon />}
              onClick={handleGenerate}
              disabled={generating || !selectedHotelOu || !isDateRangeValid()}
            >
              {generating ? 'Generating...' : 'Generate Protea Report Pack'}
            </GenerateButton>
          </Stack>

          {!selectedHotelOu && (
            <Typography
              variant="body2"
              color="text.secondary"
              textAlign="center"
              sx={{ mt: 2 }}
            >
              Please select a hotel from the top navigation to generate a report.
            </Typography>
          )}
        </CardContent>
      </StyledCard>
    </Box>
  );
}

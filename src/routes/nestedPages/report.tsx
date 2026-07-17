import { useEffect, useState, useMemo, useRef } from "react";
import {
  DataGridPremium,
  GridColDef,
  GridToolbarContainer,
  GridToolbarExport,
  GridToolbarFilterButton,
  GridToolbarColumnsButton,
  GridToolbarDensitySelector,
  GridToolbarQuickFilter,
  GridAggregationModel,
} from "@mui/x-data-grid-premium";
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
  Paper,
  Divider,
  Snackbar,
  Alert,
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import { useSettingsStore, useFinancialDataVersion } from "../../store/settings";
import dailyFinancialSyncService from "../../services/dailyFinancialSyncService";
import CheckForUpdatesButton from "../../components/CheckForUpdatesButton";

interface FinancialReportRow {
  id: number;
  combo: string;
  base_account: string;
  account_level_4: string;
  account_level_6: string;
  account_level_9: string;
  department_level_4: string;
  department_level_5: string;
  department_level_7: string;
  act_p1: number;
  act_p2: number;
  act_p3: number;
  act_p4: number;
  act_p5: number;
  act_p6: number;
  act_p7: number;
  act_p8: number;
  act_p9: number;
  act_p10: number;
  act_p11: number;
  act_p12: number;
  bud_p1: number;
  bud_p2: number;
  bud_p3: number;
  bud_p4: number;
  bud_p5: number;
  bud_p6: number;
  bud_p7: number;
  bud_p8: number;
  bud_p9: number;
  bud_p10: number;
  bud_p11: number;
  bud_p12: number;
  [key: string]: any; // Allow dynamic indexing
}

const StyledCard = styled(Card)(({ theme }) => ({
  marginBottom: theme.spacing(3),
  boxShadow: theme.shadows[3],
}));

const CustomToolbar = () => {
  return (
    <GridToolbarContainer
      sx={{
        p: 1.5,
        gap: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        minHeight: 56,
        backgroundColor: (theme) => theme.palette.mode === 'dark'
          ? alpha('#ffffff', 0.01)
          : alpha('#000000', 0.005),
        '& .MuiButton-root': {
          fontSize: '0.8125rem',
          fontWeight: 500,
          textTransform: 'none',
          borderRadius: 1.5,
          px: 1.5,
          color: 'text.secondary',
        },
      }}
    >
      <GridToolbarColumnsButton />
      <GridToolbarFilterButton />
      <GridToolbarDensitySelector />
      <GridToolbarExport
        csvOptions={{
          fileName: `financial-report-${new Date().toISOString().split('T')[0]}`,
          delimiter: ',',
          utf8WithBom: true,
        }}
        printOptions={{
          hideFooter: true,
          hideToolbar: true,
        }}
      />
      <Box sx={{ flex: 1 }} />
      <GridToolbarQuickFilter
        debounceMs={300}
        sx={{
          width: { xs: 200, sm: 280 },
          '& .MuiOutlinedInput-root': {
            borderRadius: 2,
            height: 36,
            fontSize: '0.875rem',
            backgroundColor: (theme) => alpha(theme.palette.background.default, 0.5),
            transition: 'background-color 0.2s ease',
            '&:hover': {
              backgroundColor: (theme) => alpha(theme.palette.background.default, 0.7),
            },
            '&.Mui-focused': {
              backgroundColor: (theme) => theme.palette.background.default,
            },
          },
          '& .MuiInputBase-input::placeholder': {
            fontSize: '0.875rem',
          },
        }}
      />
    </GridToolbarContainer>
  );
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Report() {
  const [rows, setRows] = useState<FinancialReportRow[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [startingMonth, setStartingMonth] = useState<number>(1); // 1-based month
  const [loading, setLoading] = useState<boolean>(false);
  const [settingsLoaded, setSettingsLoaded] = useState<boolean>(false);
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const financialDataVersion = useFinancialDataVersion();
  const setFinancialDataVersion = useSettingsStore((s) => s.setFinancialDataVersion);

  // Daily sync check state
  const [syncNotification, setSyncNotification] = useState<{
    open: boolean;
    message: string;
    severity: 'info' | 'success';
  } | null>(null);
  const syncCheckPerformed = useRef<string | null>(null); // Track which OU we've checked

  const fetchReportData = async () => {
    setLoading(true);
    try {
      const startPeriod = `${selectedYear}-${String(startingMonth).padStart(2, '0')}`;

      const response = await window.ipcApi.sendIpcRequest("db:get-financial-report-data", {
        startPeriod,
        ou: selectedHotelOu,
        version: financialDataVersion,
      });

      // console.log('[Report] Response:', response);
      // console.log('[Report] Response.data type:', typeof response.data);
      // console.log('[Report] Response.data:', response.data);
      if (response.success && response.data) {
        const data = JSON.parse(response.data as string) as FinancialReportRow[];
        // console.log('[Report] Parsed data:', data);
        // console.log('[Report] Number of rows:', data.length);
        setRows(data);
      } else {
        console.error("Failed to fetch report data");
        setRows([]);
      }
    } catch (error) {
      console.error("Error fetching report data:", error);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const handleYearChange = async (year: number) => {
    setSelectedYear(year);
    try {
      if (window.ipcApi) {
        await window.ipcApi.sendIpcRequest("settings-set-single", { key: "reportYear", value: year });
      }
    } catch (error) {
      console.error("Error saving report year:", error);
    }
  };

  const handleStartingMonthChange = async (month: number) => {
    setStartingMonth(month);
    try {
      if (window.ipcApi) {
        await window.ipcApi.sendIpcRequest("settings-set-single", { key: "reportStartingMonth", value: month });
      }
    } catch (error) {
      console.error("Error saving report starting month:", error);
    }
  };

  // Load saved settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        if (window.ipcApi) {
          const yearResponse = await window.ipcApi.sendIpcRequest("settings-get-single", { key: "reportYear" });
          const monthResponse = await window.ipcApi.sendIpcRequest("settings-get-single", { key: "reportStartingMonth" });

          if (yearResponse.success && yearResponse.data !== undefined && yearResponse.data !== null) {
            setSelectedYear(yearResponse.data);
          }

          if (monthResponse.success && monthResponse.data !== undefined && monthResponse.data !== null) {
            setStartingMonth(monthResponse.data);
          }
        }
      } catch (error) {
        console.error("Error loading report settings:", error);
      } finally {
        setSettingsLoaded(true);
      }
    };

    loadSettings();
  }, []);

  // Fetch data when settings are loaded and when year/month/OU/version changes
  useEffect(() => {
    if (settingsLoaded && selectedHotelOu) {
      fetchReportData();
    }
  }, [selectedYear, startingMonth, settingsLoaded, selectedHotelOu, financialDataVersion]);

  // Daily financial data sync check - runs once per OU per page visit
  useEffect(() => {
    if (settingsLoaded && selectedHotelOu && syncCheckPerformed.current !== selectedHotelOu) {
      // Mark that we're checking this OU (prevents duplicate checks on re-renders)
      syncCheckPerformed.current = selectedHotelOu;

      dailyFinancialSyncService.performDailyCheck(selectedHotelOu)
        .then(result => {
          if (result.hasUpdates) {
            setSyncNotification({
              open: true,
              message: `Financial data updated (${result.updatedPeriods.length} period${result.updatedPeriods.length !== 1 ? 's' : ''})`,
              severity: 'success'
            });
            // Refresh the report data to show updated values
            fetchReportData();
          }
        })
        .catch(() => {
          // Silent fail for background check - don't disrupt user
        });
    }
  }, [settingsLoaded, selectedHotelOu]);

  const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  });

  // Generate month labels based on starting month
  const monthLabels = useMemo(() => {
    const labels: string[] = [];
    for (let i = 0; i < 12; i++) {
      const monthIndex = (startingMonth - 1 + i) % 12;
      labels.push(MONTH_NAMES[monthIndex]);
    }
    return labels;
  }, [startingMonth]);

  const columns: GridColDef[] = useMemo(() => {
    const cols: GridColDef[] = [
      {
        field: 'department_level_4',
        headerName: 'Dept L4',
        width: 120,
      },
      {
        field: 'department_level_5',
        headerName: 'Dept L5',
        width: 120,
      },
      {
        field: 'department_level_7',
        headerName: 'Dept L7',
        width: 120,
      },
      {
        field: 'base_account',
        headerName: 'Base Account',
        width: 120,
      },
      {
        field: 'account_level_4',
        headerName: 'Acct L4',
        width: 120,
      },
      {
        field: 'account_level_6',
        headerName: 'Acct L6',
        width: 120,
      },
      {
        field: 'account_level_9',
        headerName: 'Acct L9',
        width: 120,
      },
    ];

    // Add monthly columns (Actuals vs Budget for each month)
    for (let i = 1; i <= 12; i++) {
      const monthLabel = monthLabels[i - 1];

      // Actuals column
      cols.push({
        field: `act_p${i}`,
        headerName: `${monthLabel} Act`,
        type: 'number',
        width: 110,
        valueGetter: (_value, row) => -(row[`act_p${i}`] || 0),
        valueFormatter: (value) => currencyFormatter.format(value || 0),
      });

      // Budget column
      cols.push({
        field: `bud_p${i}`,
        headerName: `${monthLabel} Bud`,
        type: 'number',
        width: 110,
        valueGetter: (_value, row) => -(row[`bud_p${i}`] || 0),
        valueFormatter: (value) => currencyFormatter.format(value || 0),
        cellClassName: 'budget-column',
      });

      // Variance column
      cols.push({
        field: `var_p${i}`,
        headerName: `${monthLabel} Var`,
        type: 'number',
        width: 110,
        valueGetter: (_value, row) => -(row[`act_p${i}`] || 0) - (-(row[`bud_p${i}`] || 0)),
        valueFormatter: (value) => currencyFormatter.format(value || 0),
        cellClassName: (params) =>
          params.value > 0 ? 'positive-variance' : params.value < 0 ? 'negative-variance' : '',
      });
    }

    // Add total columns
    cols.push({
      field: 'total_actuals',
      headerName: 'Total Actuals',
      type: 'number',
      width: 130,
      valueGetter: (_value, row) => {
        let total = 0;
        for (let i = 1; i <= 12; i++) {
          total += row[`act_p${i}`] || 0;
        }
        return -total;
      },
      valueFormatter: (value) => currencyFormatter.format(value || 0),
      cellClassName: 'total-column',
    });

    cols.push({
      field: 'total_budget',
      headerName: 'Total Budget',
      type: 'number',
      width: 130,
      valueGetter: (_value, row) => {
        let total = 0;
        for (let i = 1; i <= 12; i++) {
          total += row[`bud_p${i}`] || 0;
        }
        return -total;
      },
      valueFormatter: (value) => currencyFormatter.format(value || 0),
      cellClassName: 'total-column',
    });

    cols.push({
      field: 'total_variance',
      headerName: 'Total Variance',
      type: 'number',
      width: 140,
      valueGetter: (_value, row) => {
        let actTotal = 0;
        let budTotal = 0;
        for (let i = 1; i <= 12; i++) {
          actTotal += row[`act_p${i}`] || 0;
          budTotal += row[`bud_p${i}`] || 0;
        }
        return (-actTotal) - (-budTotal);
      },
      valueFormatter: (value) => currencyFormatter.format(value || 0),
      cellClassName: (params) =>
        params.value > 0 ? 'positive-variance' : params.value < 0 ? 'negative-variance' : '',
    });

    return cols;
  }, [monthLabels]);


  const aggregationModel: GridAggregationModel = useMemo(() => {
    const model: GridAggregationModel = {};

    for (let i = 1; i <= 12; i++) {
      model[`act_p${i}`] = 'sum';
      model[`bud_p${i}`] = 'sum';
      model[`var_p${i}`] = 'sum';
    }

    model['total_actuals'] = 'sum';
    model['total_budget'] = 'sum';
    model['total_variance'] = 'sum';

    return model;
  }, []);

  const filteredRows = useMemo(() => {
    // No department filter needed as filtering is now done in backend
    return rows;
  }, [rows]);

  const summary = useMemo(() => {
    let totalActuals = 0;
    let totalBudget = 0;

    filteredRows.forEach(row => {
      for (let i = 1; i <= 12; i++) {
        totalActuals += row[`act_p${i}`] || 0;
        totalBudget += row[`bud_p${i}`] || 0;
      }
    });

    // Invert signs to match the inverted display
    totalActuals = -totalActuals;
    totalBudget = -totalBudget;
    const totalVariance = totalActuals - totalBudget;

    return {
      totalActuals,
      totalBudget,
      totalVariance,
      recordCount: filteredRows.length,
    };
  }, [filteredRows]);

  // Generate year options (current year ± 5 years)
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 11 }, (_, i) => currentYear - 5 + i);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Typography variant="h4">
          Financial Report Dashboard
        </Typography>
        <CheckForUpdatesButton onDataUpdated={fetchReportData} />
      </Box>

      <StyledCard>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Report Summary
          </Typography>
          <Stack direction="row" spacing={3} divider={<Divider orientation="vertical" flexItem />}>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Total Actuals
              </Typography>
              <Typography variant="h6" color="primary.main">
                {currencyFormatter.format(summary.totalActuals)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Total Budget
              </Typography>
              <Typography variant="h6">
                {currencyFormatter.format(summary.totalBudget)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Total Variance
              </Typography>
              <Typography
                variant="h6"
                color={summary.totalVariance > 0 ? "success.main" : summary.totalVariance < 0 ? "error.main" : "text.primary"}
              >
                {currencyFormatter.format(summary.totalVariance)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Records
              </Typography>
              <Typography variant="h6">
                {summary.recordCount}
              </Typography>
            </Box>
          </Stack>
        </CardContent>
      </StyledCard>

      <Box sx={{ mb: 3, display: 'flex', gap: 2, alignItems: 'center' }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Year</InputLabel>
          <Select
            value={selectedYear}
            label="Year"
            onChange={(e) => handleYearChange(e.target.value as number)}
          >
            {yearOptions.map((year) => (
              <MenuItem key={year} value={year}>
                {year}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Starting Month</InputLabel>
          <Select
            value={startingMonth}
            label="Starting Month"
            onChange={(e) => handleStartingMonthChange(e.target.value as number)}
          >
            {MONTH_NAMES.map((month, index) => (
              <MenuItem key={index + 1} value={index + 1}>
                {month}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel>Data Version</InputLabel>
          <Select
            value={financialDataVersion || 'MAIN'}
            label="Data Version"
            onChange={(e) => setFinancialDataVersion(e.target.value as string)}
          >
            <MenuItem value="MAIN">Marriott Planning</MenuItem>
            <MenuItem value="OWNR">Owner Planning</MenuItem>
          </Select>
        </FormControl>

        <Button
          variant="outlined"
          onClick={fetchReportData}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Refresh Data'}
        </Button>
      </Box>

      <Paper sx={{ height: 700, width: '100%' }}>
        <DataGridPremium
          rows={filteredRows}
          columns={columns}
          aggregationModel={aggregationModel}
          slots={{
            toolbar: CustomToolbar,
          }}
          initialState={{
            aggregation: {
              model: aggregationModel,
            },
            pagination: {
              paginationModel: { pageSize: 25 },
            },
            rowGrouping: {
              model: ['department_level_4', 'department_level_5', 'department_level_7', 'account_level_4', 'account_level_6', 'account_level_9', 'base_account'],
            },
            columns: {
              columnVisibilityModel: {
                department_level_4: false,
                department_level_5: false,
                department_level_7: false,
                account_level_4: false,
                account_level_6: false,
                account_level_9: false,
                base_account: false,
              },
            },
          }}
          pageSizeOptions={[25, 50, 100]}
          density="compact"
          cellSelection
          sx={{
            '& .MuiDataGrid-columnHeaders': {
              backgroundColor: (theme) => theme.palette.mode === 'dark'
                ? alpha('#ffffff', 0.02)
                : alpha('#000000', 0.015),
              borderBottom: '1px solid',
              borderColor: 'divider',
              minHeight: '48px !important',
              maxHeight: '48px !important',
            },
            '& .MuiDataGrid-columnHeader': {
              fontWeight: 600,
              fontSize: '0.8125rem',
              letterSpacing: '0.01em',
              color: 'text.secondary',
            },
            '& .total-column': {
              fontWeight: 'bold',
              borderLeft: '2px solid',
              borderColor: 'divider',
            },
            '& .budget-column': {
              fontStyle: 'italic',
            },
            '& .positive-variance': {
              color: 'success.main',
              fontWeight: 'bold',
            },
            '& .negative-variance': {
              color: 'error.main',
              fontWeight: 'bold',
            },
            '& .MuiDataGrid-columnHeaderTitle': {
              fontWeight: 'bold',
            },
          }}
        />
      </Paper>

      {/* Daily sync notification */}
      <Snackbar
        open={syncNotification?.open ?? false}
        autoHideDuration={5000}
        onClose={() => setSyncNotification(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          onClose={() => setSyncNotification(null)}
          severity={syncNotification?.severity ?? 'info'}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {syncNotification?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}

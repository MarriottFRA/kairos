import { useEffect, useState } from "react";
import {
  DataGridPremium,
  GridColDef,
  GridToolbarContainer,
  GridToolbarExport,
  GridToolbarFilterButton,
  GridToolbarColumnsButton,
  GridToolbarDensitySelector,
  GridToolbarQuickFilter,
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
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import { PLCalculationResult } from "../../types/plReportTypes";
import { useSettingsStore, useFinancialDataVersion } from "../../store/settings";
import CheckForUpdatesButton from "../../components/CheckForUpdatesButton";
interface F90PLRow extends PLCalculationResult {
  id: number;
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
          fileName: `f90-pl-${new Date().toISOString().split('T')[0]}`,
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

export default function F90PL() {
  const [rows, setRows] = useState<F90PLRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [settingsLoaded, setSettingsLoaded] = useState<boolean>(false);
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const financialDataVersion = useFinancialDataVersion();
  const setFinancialDataVersion = useSettingsStore((s) => s.setFinancialDataVersion);

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const [startMonth, setStartMonth] = useState<number>(1);
  const [startYear, setStartYear] = useState<number>(currentYear);
  const [endMonth, setEndMonth] = useState<number>(currentMonth);
  const [endYear, setEndYear] = useState<number>(currentYear);

  const fetchPLData = async () => {
    setLoading(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:get-f90-pl-data", {
        startMonth,
        startYear,
        endMonth,
        endYear,
        ou: selectedHotelOu,
        version: financialDataVersion,
      });

      if (response.success && response.data) {
        const data = JSON.parse(response.data as string) as PLCalculationResult[];
        const rowsWithId = data.map((row) => ({
          ...row,
          id: row.rowId,
        }));
        setRows(rowsWithId);
      } else {
        console.error("Failed to fetch F90 P&L data");
        setRows([]);
      }
    } catch (error) {
      console.error("Error fetching F90 P&L data:", error);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const handleStartMonthChange = async (month: number) => {
    setStartMonth(month);
    try {
      if (window.ipcApi) {
        await window.ipcApi.sendIpcRequest("settings-set-single", { key: "f90PLStartMonth", value: month });
      }
    } catch (error) {
      console.error("Error saving start month:", error);
    }
  };

  const handleStartYearChange = async (year: number) => {
    setStartYear(year);
    try {
      if (window.ipcApi) {
        await window.ipcApi.sendIpcRequest("settings-set-single", { key: "f90PLStartYear", value: year });
      }
    } catch (error) {
      console.error("Error saving start year:", error);
    }
  };

  const handleEndMonthChange = async (month: number) => {
    setEndMonth(month);
    try {
      if (window.ipcApi) {
        await window.ipcApi.sendIpcRequest("settings-set-single", { key: "f90PLEndMonth", value: month });
      }
    } catch (error) {
      console.error("Error saving end month:", error);
    }
  };

  const handleEndYearChange = async (year: number) => {
    setEndYear(year);
    try {
      if (window.ipcApi) {
        await window.ipcApi.sendIpcRequest("settings-set-single", { key: "f90PLEndYear", value: year });
      }
    } catch (error) {
      console.error("Error saving end year:", error);
    }
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        if (window.ipcApi) {
          const [startMonthResp, startYearResp, endMonthResp, endYearResp] = await Promise.all([
            window.ipcApi.sendIpcRequest("settings-get-single", { key: "f90PLStartMonth" }),
            window.ipcApi.sendIpcRequest("settings-get-single", { key: "f90PLStartYear" }),
            window.ipcApi.sendIpcRequest("settings-get-single", { key: "f90PLEndMonth" }),
            window.ipcApi.sendIpcRequest("settings-get-single", { key: "f90PLEndYear" }),
          ]);

          if (startMonthResp.success && startMonthResp.data !== undefined && startMonthResp.data !== null) {
            setStartMonth(startMonthResp.data);
          }
          if (startYearResp.success && startYearResp.data !== undefined && startYearResp.data !== null) {
            setStartYear(startYearResp.data);
          }
          if (endMonthResp.success && endMonthResp.data !== undefined && endMonthResp.data !== null) {
            setEndMonth(endMonthResp.data);
          }
          if (endYearResp.success && endYearResp.data !== undefined && endYearResp.data !== null) {
            setEndYear(endYearResp.data);
          }
        }
      } catch (error) {
        console.error("Error loading F90 P&L settings:", error);
      } finally {
        setSettingsLoaded(true);
      }
    };

    loadSettings();
  }, []);

  useEffect(() => {
    if (settingsLoaded && selectedHotelOu) {
      fetchPLData();
    }
  }, [startMonth, startYear, endMonth, endYear, settingsLoaded, selectedHotelOu, financialDataVersion]);

  const numberFormatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const percentFormatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const formatValue = (value: number | null, formatting: string): string => {
    if (value === null) return '';

    if (formatting === 'percentage') {
      return `${percentFormatter.format(value)}%`;
    }

    return numberFormatter.format(value);
  };

  const getVarianceClass = (value: number | null, invertVariance = false) => {
    if (value === null) return '';
    // For expense rows (invertVariance=true) and COS % rows: higher value = worse = red.
    // For revenue/profit rows: higher value = better = green.
    if (value > 0) return invertVariance ? 'negative-variance' : 'positive-variance';
    if (value < 0) return invertVariance ? 'positive-variance' : 'negative-variance';
    return '';
  };

  // COS percentage rows: a higher cost % vs budget/LY is bad (red), lower is good (green).
  const shouldInvertVariance = (row: F90PLRow) =>
    !!row.invertVariance || row.label.includes('COS');

  const columns: GridColDef<F90PLRow>[] = [
    {
      field: 'label',
      headerName: 'P&L Line',
      width: 300,
      renderCell: (params) => {
        const indent = params.row.indentLevel || 0;
        const isHeader = params.row.type === 'header';

        return (
          <Box
            sx={{
              paddingLeft: `${indent * 20}px`,
              fontWeight: isHeader ? 700 : 400,
              fontSize: isHeader ? '0.95rem' : '0.875rem',
              color: isHeader ? 'text.primary' : 'text.secondary',
              letterSpacing: isHeader ? 0.5 : 0,
            }}
          >
            {params.value}
          </Box>
        );
      },
    },
    {
      field: 'actuals',
      headerName: 'Actuals',
      type: 'number',
      width: 120,
      valueFormatter: (value, row) => {
        if (!row.label) return ''; // Empty spacing rows
        return formatValue(value, row.formatting);
      },
    },
    {
      field: 'budget',
      headerName: 'Budget',
      type: 'number',
      width: 120,
      valueFormatter: (value, row) => {
        if (!row.label) return ''; // Empty spacing rows
        return formatValue(value, row.formatting);
      },
    },
    {
      field: 'vs_bud',
      headerName: 'vs Bud',
      type: 'number',
      width: 120,
      valueFormatter: (value, row) => {
        if (!row.label) return ''; // Empty spacing rows
        // For percentage-formatted rows, show variance in points (not percentage)
        if (row.formatting === 'percentage') {
          if (value === null) return '';
          return `${percentFormatter.format(value)} pts`;
        }
        return formatValue(value, row.formatting);
      },
      cellClassName: (params) => {
        if (!params.row.label) return ''; // Empty spacing rows
        return getVarianceClass(params.value, shouldInvertVariance(params.row));
      },
    },
    {
      field: 'vs_bud_pct',
      headerName: 'vs Bud %',
      type: 'number',
      width: 120,
      valueFormatter: (value, row) => {
        if (!row.label) return ''; // Empty spacing rows
        // For percentage-formatted rows, don't show vs % (variance is already shown in points)
        if (row.formatting === 'percentage') return '';
        if (value === null) return '';
        return `${percentFormatter.format(value)}%`;
      },
      cellClassName: (params) => {
        if (!params.row.label) return ''; // Empty spacing rows
        return getVarianceClass(params.value, shouldInvertVariance(params.row));
      },
    },
    {
      field: 'ly',
      headerName: 'LY',
      type: 'number',
      width: 120,
      valueFormatter: (value, row) => {
        if (!row.label) return ''; // Empty spacing rows
        return formatValue(value, row.formatting);
      },
    },
    {
      field: 'vs_ly',
      headerName: 'vs LY',
      type: 'number',
      width: 120,
      valueFormatter: (value, row) => {
        if (!row.label) return ''; // Empty spacing rows
        // For percentage-formatted rows, show variance in points (not percentage)
        if (row.formatting === 'percentage') {
          if (value === null) return '';
          return `${percentFormatter.format(value)} pts`;
        }
        return formatValue(value, row.formatting);
      },
      cellClassName: (params) => {
        if (!params.row.label) return ''; // Empty spacing rows
        return getVarianceClass(params.value, shouldInvertVariance(params.row));
      },
    },
    {
      field: 'vs_ly_pct',
      headerName: 'vs LY %',
      type: 'number',
      width: 120,
      valueFormatter: (value, row) => {
        if (!row.label) return ''; // Empty spacing rows
        // For percentage-formatted rows, don't show vs % (variance is already shown in points)
        if (row.formatting === 'percentage') return '';
        if (value === null) return '';
        return `${percentFormatter.format(value)}%`;
      },
      cellClassName: (params) => {
        if (!params.row.label) return ''; // Empty spacing rows
        return getVarianceClass(params.value, shouldInvertVariance(params.row));
      },
    },
  ];

  const yearOptions = Array.from({ length: 10 }, (_, i) => currentYear - 5 + i);

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          F90 P&L Report
        </Typography>
        <CheckForUpdatesButton onDataUpdated={fetchPLData} />
      </Box>

      <StyledCard>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
            Fiscal Year Selection
          </Typography>

          <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
            <FormControl sx={{ minWidth: 150 }}>
              <InputLabel>Start Month</InputLabel>
              <Select
                value={startMonth}
                label="Start Month"
                onChange={(e) => handleStartMonthChange(e.target.value as number)}
              >
                {MONTH_NAMES.map((month, idx) => (
                  <MenuItem key={idx} value={idx + 1}>
                    {month}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl sx={{ minWidth: 120 }}>
              <InputLabel>Start Year</InputLabel>
              <Select
                value={startYear}
                label="Start Year"
                onChange={(e) => handleStartYearChange(e.target.value as number)}
              >
                {yearOptions.map((year) => (
                  <MenuItem key={year} value={year}>
                    {year}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Divider orientation="vertical" flexItem sx={{ mx: 2 }} />

            <FormControl sx={{ minWidth: 150 }}>
              <InputLabel>End Month</InputLabel>
              <Select
                value={endMonth}
                label="End Month"
                onChange={(e) => handleEndMonthChange(e.target.value as number)}
              >
                {MONTH_NAMES.map((month, idx) => (
                  <MenuItem key={idx} value={idx + 1}>
                    {month}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl sx={{ minWidth: 120 }}>
              <InputLabel>End Year</InputLabel>
              <Select
                value={endYear}
                label="End Year"
                onChange={(e) => handleEndYearChange(e.target.value as number)}
              >
                {yearOptions.map((year) => (
                  <MenuItem key={year} value={year}>
                    {year}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Divider orientation="vertical" flexItem sx={{ mx: 2 }} />

            <FormControl sx={{ minWidth: 180 }}>
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
              variant="contained"
              onClick={fetchPLData}
              disabled={loading}
              sx={{ ml: 2 }}
            >
              Refresh
            </Button>
          </Stack>

          <Typography variant="body2" color="text.secondary">
            Selected Period: {MONTH_NAMES[startMonth - 1]} {startYear} - {MONTH_NAMES[endMonth - 1]} {endYear}
          </Typography>
        </CardContent>
      </StyledCard>

      <Paper sx={{ width: '100%', mb: 2, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 800 }}>
        <DataGridPremium
          rows={rows}
          columns={columns}
          loading={loading}
          density="compact"
          pagination
          pageSizeOptions={[25, 50, 100]}
          initialState={{
            pagination: { paginationModel: { pageSize: 100 } },
          }}
          slots={{
            toolbar: CustomToolbar,
          }}
          disableRowSelectionOnClick
          sx={{
            flex: 1,
            '& .MuiDataGrid-cell': {
              fontSize: '0.875rem',
            },
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
            '& .positive-variance': {
              color: 'success.main',
              fontWeight: 600,
            },
            '& .negative-variance': {
              color: 'error.main',
              fontWeight: 600,
            },
            '& .MuiDataGrid-row:hover': {
              backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.04),
            },
          }}
        />
      </Paper>
    </Box>
  );
}

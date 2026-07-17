import { useEffect, useState, useMemo } from "react";
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
  Button,
  Stack,
  Paper,
  Divider,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import { useSettingsStore, useFinancialDataVersion } from "../../store/settings";
import CheckForUpdatesButton from "../../components/CheckForUpdatesButton";
interface StagingVsBudgetRow {
  id: number;
  combo: string;
  account_desc: string;
  account_level_4: string;
  account_level_6: string;
  account_level_9: string;
  department_level_4: string;
  department_level_5: string;
  department_level_7: string;
  staging_actual: number;
  budget: number;
  variance: number;
  period: string;
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
          fileName: `upload-review-${new Date().toISOString().split('T')[0]}`,
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

export default function DataTable() {
  const [rows, setRows] = useState<StagingVsBudgetRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [period, setPeriod] = useState<string>('');
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const financialDataVersion = useFinancialDataVersion();
  const setFinancialDataVersion = useSettingsStore((s) => s.setFinancialDataVersion);

  const fetchStagingData = async () => {
    setLoading(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:get-staging-vs-budget-data", {
        ou: selectedHotelOu,
        version: financialDataVersion,
      });

      // console.log('[DataTable] Response:', response);
      // console.log('[DataTable] Response.data type:', typeof response.data);
      if (response.success && response.data) {
        const data = JSON.parse(response.data as string) as StagingVsBudgetRow[];
        // console.log('[DataTable] Parsed data:', data);
        // console.log('[DataTable] Number of rows:', data.length);
        setRows(data);

        // Set the period from the first row if available
        if (data.length > 0 && data[0].period) {
          setPeriod(data[0].period);
        }
      } else {
        console.error("Failed to fetch staging vs budget data");
        setRows([]);
      }
    } catch (error) {
      console.error("Error fetching staging vs budget data:", error);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  // Fetch data when component mounts or OU/version changes
  useEffect(() => {
    if (selectedHotelOu) {
      fetchStagingData();
    }
  }, [selectedHotelOu, financialDataVersion]);

  const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  });

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
      {
        field: 'account_desc',
        headerName: 'Account Desc',
        width: 200,
      },
      {
        field: 'staging_actual',
        headerName: 'Staging Actual',
        type: 'number',
        width: 140,
        valueGetter: (_value, row) => -(row.staging_actual || 0),
        valueFormatter: (value) => currencyFormatter.format(value || 0),
        cellClassName: 'staging-column',
      },
      {
        field: 'budget',
        headerName: 'Budget',
        type: 'number',
        width: 140,
        valueGetter: (_value, row) => -(row.budget || 0),
        valueFormatter: (value) => currencyFormatter.format(value || 0),
        cellClassName: 'budget-column',
      },
      {
        field: 'variance',
        headerName: 'Variance',
        type: 'number',
        width: 140,
        valueGetter: (_value, row) => -(row.variance || 0),
        valueFormatter: (value) => currencyFormatter.format(value || 0),
        cellClassName: (params) =>
          params.value > 0 ? 'positive-variance' : params.value < 0 ? 'negative-variance' : '',
      },
    ];

    return cols;
  }, []);

  const aggregationModel: GridAggregationModel = useMemo(() => {
    return {
      staging_actual: 'sum',
      budget: 'sum',
      variance: 'sum',
    };
  }, []);

  const summary = useMemo(() => {
    let totalStaging = 0;
    let totalBudget = 0;

    rows.forEach(row => {
      totalStaging += row.staging_actual || 0;
      totalBudget += row.budget || 0;
    });

    // Invert signs to match the inverted display
    totalStaging = -totalStaging;
    totalBudget = -totalBudget;
    const totalVariance = totalStaging - totalBudget;

    return {
      totalStaging,
      totalBudget,
      totalVariance,
      recordCount: rows.length,
    };
  }, [rows]);

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Typography variant="h4">
          Upload Review
        </Typography>
        <CheckForUpdatesButton onDataUpdated={fetchStagingData} />
      </Box>

      <StyledCard>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Data Summary {period && `- Period: ${period}`}
          </Typography>
          <Stack direction="row" spacing={3} divider={<Divider orientation="vertical" flexItem />}>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Total Staging Actuals
              </Typography>
              <Typography variant="h6" color="primary.main">
                {currencyFormatter.format(summary.totalStaging)}
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
          onClick={fetchStagingData}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Refresh Data'}
        </Button>
      </Box>

      <Paper sx={{ height: 700, width: '100%' }}>
        <DataGridPremium
          rows={rows}
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
              model: ['department_level_4', 'department_level_5', 'department_level_7', 'account_level_4', 'account_level_6', 'account_level_9'],
            },
            columns: {
              columnVisibilityModel: {
                department_level_4: false,
                department_level_5: false,
                department_level_7: false,
                account_level_4: false,
                account_level_6: false,
                account_level_9: false,
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
            '& .staging-column': {
              fontWeight: 'bold',
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
    </Box>
  );
}

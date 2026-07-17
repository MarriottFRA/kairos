import { useEffect, useState, useMemo, useCallback } from "react";
import {
  DataGridPremium,
  GridColDef,
  GridToolbarContainer,
  GridToolbarExport,
  GridToolbarFilterButton,
  GridToolbarColumnsButton,
  GridToolbarDensitySelector,
  GridToolbarQuickFilter,
  GridRowClassNameParams,
  GridActionsCellItem,
} from "@mui/x-data-grid-premium";
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Stack,
  Paper,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
  Autocomplete,
  CircularProgress,
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import AddIcon from "@mui/icons-material/Add";
import { useSettingsStore, useCurrency } from "../../store/settings";

interface StagingDataRow {
  id: number;
  rowid: number;
  dep_acc_combo_id: string;
  month: number;
  year: number;
  period_combo: string;
  scenario: string;
  amount: number;
  currency: string;
  ou: string;
  department: string;
  account: string;
  version: string;
  source_account: string;
  source_department: string;
  source_description: string;
  mapping_status: string;
  import_batch_id: string;
  last_modified: string;
  is_valid_combo: number; // 1 = valid, 0 = invalid combo
}

interface FormData {
  month: number;
  year: number;
  period_combo: string;
  scenario: string;
  amount: string;
  currency: string;
  department: string;
  account: string;
  version: string;
}

const StyledCard = styled(Card)(({ theme }) => ({
  marginBottom: theme.spacing(2),
  boxShadow: theme.shadows[3],
  flexShrink: 0,
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
          fileName: `staging-data-review-${new Date().toISOString().split('T')[0]}`,
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

export default function StagingDataReview() {
  const [rows, setRows] = useState<StagingDataRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const userCurrency = useCurrency();

  // State for responsive design - force grid remount when window shrinks
  const [gridKey, setGridKey] = useState(0);

  // Dialog states
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedRow, setSelectedRow] = useState<StagingDataRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importsExist, setImportsExist] = useState(false);
  const [rowFilter, setRowFilter] = useState<'all' | 'unmapped' | 'invalid_combo'>('all');

  // Separate account/department lists for better UX
  const [accounts, setAccounts] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [validDepartmentsForAccount, setValidDepartmentsForAccount] = useState<string[]>([]);
  const [validAccountsForDepartment, setValidAccountsForDepartment] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [isComboValid, setIsComboValid] = useState<boolean | null>(null);

  // Form state
  const [formData, setFormData] = useState<FormData>({
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    period_combo: '',
    scenario: 'Actual',
    amount: '',
    currency: userCurrency,
    department: '',
    account: '',
    version: 'Working',
  });

  // Force DataGrid remount when window shrinks to recalculate dimensions
  useEffect(() => {
    let previousWidth = window.innerWidth;
    let resizeTimeout: NodeJS.Timeout;

    const handleResize = () => {
      clearTimeout(resizeTimeout);

      resizeTimeout = setTimeout(() => {
        const currentWidth = window.innerWidth;

        // Force DataGrid to remount when window shrinks significantly
        if (currentWidth < previousWidth - 10) {
          setGridKey(prev => prev + 1);
        }

        previousWidth = currentWidth;
      }, 300); // Debounce resize events
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, []);

  const fetchStagingData = async () => {
    setLoading(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:get-staging-data", {
        ou: selectedHotelOu,
      });

      // console.log('[StagingDataReview] Response:', response);
      if (response.success && response.data) {
        const data = JSON.parse(response.data as string);
        // Add unique ID for DataGrid
        const dataWithIds = data.map((row: any, index: number) => ({
          ...row,
          id: index,
        }));
        // console.log('[StagingDataReview] Parsed data:', dataWithIds);
        // console.log('[StagingDataReview] Number of rows:', dataWithIds.length);
        setRows(dataWithIds);
      } else {
        console.error("Failed to fetch staging data");
        setRows([]);
      }
    } catch (error) {
      console.error("Error fetching staging data:", error);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  // Fetch data when component mounts or hotel changes
  useEffect(() => {
    if (selectedHotelOu) {
      fetchStagingData();
      checkImportsExist();
      fetchAccounts();
      fetchDepartments();
    }
  }, [selectedHotelOu]);

  // Check if imports exist for the selected hotel
  const checkImportsExist = async () => {
    if (!selectedHotelOu) return;
    try {
      const response = await window.ipcApi.sendIpcRequest("db:check-imports-exist", {
        ou: selectedHotelOu,
      });
      setImportsExist(response.success && response.data === true);
    } catch (error) {
      console.error("Error checking imports exist:", error);
      setImportsExist(false);
    }
  };

  // Fetch unique accounts for autocomplete
  const fetchAccounts = async () => {
    setAccountsLoading(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:get-unique-accounts", {});
      if (response.success && response.data) {
        setAccounts(response.data as string[]);
      }
    } catch (error) {
      console.error("Error fetching accounts:", error);
    } finally {
      setAccountsLoading(false);
    }
  };

  // Fetch unique departments for autocomplete
  const fetchDepartments = async () => {
    setDepartmentsLoading(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:get-unique-departments", {});
      if (response.success && response.data) {
        setDepartments(response.data as string[]);
      }
    } catch (error) {
      console.error("Error fetching departments:", error);
    } finally {
      setDepartmentsLoading(false);
    }
  };

  // Validate combo when account or department changes
  const validateCombo = async (account: string, department: string) => {
    if (!account || !department) {
      setIsComboValid(null);
      return;
    }
    try {
      const response = await window.ipcApi.sendIpcRequest("db:is-valid-combo", {
        account,
        department,
      });
      setIsComboValid(response.success && response.data === true);
    } catch (error) {
      console.error("Error validating combo:", error);
      setIsComboValid(false);
    }
  };

  // Get valid departments when account is selected
  const fetchDepartmentsForAccount = async (account: string) => {
    if (!account) {
      setValidDepartmentsForAccount([]);
      return;
    }
    try {
      const response = await window.ipcApi.sendIpcRequest("db:get-departments-for-account", { account });
      if (response.success && response.data) {
        setValidDepartmentsForAccount(response.data as string[]);
      }
    } catch (error) {
      console.error("Error fetching departments for account:", error);
    }
  };

  // Get valid accounts when department is selected
  const fetchAccountsForDepartment = async (department: string) => {
    if (!department) {
      setValidAccountsForDepartment([]);
      return;
    }
    try {
      const response = await window.ipcApi.sendIpcRequest("db:get-accounts-for-department", { department });
      if (response.success && response.data) {
        setValidAccountsForDepartment(response.data as string[]);
      }
    } catch (error) {
      console.error("Error fetching accounts for department:", error);
    }
  };

  // Get default period from existing data
  const getDefaultPeriod = useCallback(() => {
    if (rows.length > 0) {
      const firstRow = rows[0];
      return {
        month: firstRow.month,
        year: firstRow.year,
        period_combo: firstRow.period_combo,
        scenario: firstRow.scenario || 'Actual',
        currency: firstRow.currency || userCurrency,
        version: firstRow.version || 'Working',
      };
    }
    const now = new Date();
    return {
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      period_combo: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      scenario: 'Actual',
      currency: userCurrency,
      version: 'Working',
    };
  }, [rows, userCurrency]);

  // Open Add dialog
  const handleOpenAddDialog = () => {
    const defaults = getDefaultPeriod();
    setFormData({
      month: defaults.month,
      year: defaults.year,
      period_combo: defaults.period_combo,
      scenario: defaults.scenario,
      amount: '',
      currency: defaults.currency,
      department: '',
      account: '',
      version: defaults.version,
    });
    setIsComboValid(null);
    setValidDepartmentsForAccount([]);
    setValidAccountsForDepartment([]);
    setAddDialogOpen(true);
  };

  // Open Edit dialog
  const handleOpenEditDialog = (row: StagingDataRow) => {
    setSelectedRow(row);
    // Strip A/D prefixes from account and department values for the form
    // Database stores them with prefixes (e.g., "A701110", "D0480")
    const rawAccount = row.account?.startsWith('A') ? row.account.substring(1) : (row.account || '');
    const rawDepartment = row.department?.startsWith('D') ? row.department.substring(1) : (row.department || '');

    setFormData({
      month: row.month,
      year: row.year,
      period_combo: row.period_combo,
      scenario: row.scenario,
      amount: row.amount.toString(),
      currency: row.currency,
      department: rawDepartment,
      account: rawAccount,
      version: row.version || 'Working',
    });
    // Validate existing combo and fetch related options
    if (rawAccount && rawDepartment) {
      validateCombo(rawAccount, rawDepartment);
      fetchDepartmentsForAccount(rawAccount);
      fetchAccountsForDepartment(rawDepartment);
    } else {
      setIsComboValid(null);
      setValidDepartmentsForAccount([]);
      setValidAccountsForDepartment([]);
    }
    setEditDialogOpen(true);
  };

  // Open Delete dialog
  const handleOpenDeleteDialog = (row: StagingDataRow) => {
    setSelectedRow(row);
    setDeleteDialogOpen(true);
  };

  // Close all dialogs
  const handleCloseDialogs = () => {
    setAddDialogOpen(false);
    setEditDialogOpen(false);
    setDeleteDialogOpen(false);
    setSelectedRow(null);
  };

  // Handle Add submit
  const handleAddSubmit = async () => {
    if (!selectedHotelOu || !formData.account || !formData.department) return;

    setSubmitting(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:add-staging-row", {
        month: formData.month,
        year: formData.year,
        period_combo: formData.period_combo,
        scenario: formData.scenario,
        amount: parseFloat(formData.amount) || 0,
        currency: formData.currency,
        ou: selectedHotelOu,
        department: formData.department,
        account: formData.account,
        version: formData.version,
      });

      if (response.success) {
        handleCloseDialogs();
        await fetchStagingData();
      } else {
        console.error("Failed to add staging row:", response.error);
      }
    } catch (error) {
      console.error("Error adding staging row:", error);
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Edit submit
  const handleEditSubmit = async () => {
    if (!selectedRow || !formData.account || !formData.department) return;

    setSubmitting(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:update-staging-row", {
        rowid: selectedRow.rowid,
        month: formData.month,
        year: formData.year,
        period_combo: formData.period_combo,
        scenario: formData.scenario,
        amount: parseFloat(formData.amount) || 0,
        currency: formData.currency,
        department: formData.department,
        account: formData.account,
        version: formData.version,
      });

      if (response.success) {
        handleCloseDialogs();
        await fetchStagingData();
      } else {
        console.error("Failed to update staging row:", response.error);
      }
    } catch (error) {
      console.error("Error updating staging row:", error);
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Delete confirm
  const handleDeleteConfirm = async () => {
    if (!selectedRow) return;

    setSubmitting(true);
    try {
      const response = await window.ipcApi.sendIpcRequest("db:delete-staging-row", {
        rowid: selectedRow.rowid,
      });

      if (response.success) {
        handleCloseDialogs();
        await fetchStagingData();
      } else {
        console.error("Failed to delete staging row:", response.error);
      }
    } catch (error) {
      console.error("Error deleting staging row:", error);
    } finally {
      setSubmitting(false);
    }
  };

  // Handle account selection
  const handleAccountChange = (_event: any, value: string | null) => {
    const newAccount = value || '';
    setFormData(prev => ({ ...prev, account: newAccount }));
    fetchDepartmentsForAccount(newAccount);
    validateCombo(newAccount, formData.department);
  };

  // Handle department selection
  const handleDepartmentChange = (_event: any, value: string | null) => {
    const newDepartment = value || '';
    setFormData(prev => ({ ...prev, department: newDepartment }));
    fetchAccountsForDepartment(newDepartment);
    validateCombo(formData.account, newDepartment);
  };

  const numberFormatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const columns: GridColDef[] = useMemo(() => {
    const cols: GridColDef[] = [
      {
        field: 'actions',
        type: 'actions',
        headerName: 'Actions',
        width: 80,
        getActions: (params) => [
          <GridActionsCellItem
            icon={<EditIcon />}
            label="Edit"
            onClick={() => handleOpenEditDialog(params.row)}
          />,
          <GridActionsCellItem
            icon={<DeleteIcon />}
            label="Delete"
            onClick={() => handleOpenDeleteDialog(params.row)}
          />,
        ],
      },
      {
        field: 'period_combo',
        headerName: 'Period',
        width: 100,
      },
      {
        field: 'scenario',
        headerName: 'Scenario',
        width: 100,
      },
      {
        field: 'source_account',
        headerName: 'Source Account',
        width: 150,
      },
      {
        field: 'source_department',
        headerName: 'Source Dept',
        width: 150,
      },
      {
        field: 'source_description',
        headerName: 'Description',
        width: 200,
      },
      {
        field: 'account',
        headerName: 'Mapped Account',
        width: 150,
      },
      {
        field: 'department',
        headerName: 'Mapped Dept',
        width: 150,
      },
      {
        field: 'dep_acc_combo_id',
        headerName: 'Combo ID',
        width: 120,
      },
      {
        field: 'amount',
        headerName: 'Amount',
        type: 'number',
        width: 140,
        valueFormatter: (value) => numberFormatter.format(value || 0),
      },
      {
        field: 'mapping_status',
        headerName: 'Status',
        width: 120,
        renderCell: (params) => {
          const status = params.value as string;
          let color: "success" | "warning" | "error" | "default" = "default";

          if (status?.toLowerCase().includes("mapped")) {
            color = "success";
          } else if (status?.toLowerCase().includes("unmapped")) {
            color = "warning";
          } else if (status?.toLowerCase().includes("error")) {
            color = "error";
          }

          return <Chip label={status || 'N/A'} color={color} size="small" />;
        },
      },
      {
        field: 'currency',
        headerName: 'Currency',
        width: 100,
      },
      {
        field: 'month',
        headerName: 'Month',
        type: 'number',
        width: 80,
      },
      {
        field: 'year',
        headerName: 'Year',
        type: 'number',
        width: 80,
      },
      {
        field: 'version',
        headerName: 'Version',
        width: 100,
      },
      {
        field: 'import_batch_id',
        headerName: 'Batch ID',
        width: 200,
      },
      {
        field: 'last_modified',
        headerName: 'Last Modified',
        width: 180,
        valueFormatter: (value) => {
          try {
            return dateFormatter.format(new Date(value));
          } catch {
            return value;
          }
        },
      },
    ];

    return cols;
  }, []);

  const filteredRows = useMemo(() => {
    if (rowFilter === 'unmapped') {
      return rows.filter(r => r.mapping_status?.toLowerCase().includes('unmapped'));
    }
    if (rowFilter === 'invalid_combo') {
      return rows.filter(r => r.is_valid_combo === 0);
    }
    return rows;
  }, [rows, rowFilter]);

  const issueCounts = useMemo(() => {
    const unmapped = rows.filter(r => r.mapping_status?.toLowerCase().includes('unmapped')).length;
    const invalidCombo = rows.filter(r => r.is_valid_combo === 0).length;
    return { unmapped, invalidCombo };
  }, [rows]);

  const summary = useMemo(() => {
    let totalAmount = 0;
    const uniquePeriods = new Set<string>();
    const uniqueBatches = new Set<string>();

    rows.forEach(row => {
      totalAmount += row.amount || 0;
      if (row.period_combo) uniquePeriods.add(row.period_combo);
      if (row.import_batch_id) uniqueBatches.add(row.import_batch_id);
    });

    return {
      totalAmount,
      recordCount: rows.length,
      periodCount: uniquePeriods.size,
      batchCount: uniqueBatches.size,
    };
  }, [rows]);

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', overflow: 'hidden', boxSizing: 'border-box' }}>
      <StyledCard>
        <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
          {/* Row 1: Actions left, stats right */}
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                variant="outlined"
                size="small"
                onClick={fetchStagingData}
                disabled={loading}
              >
                {loading ? 'Loading...' : 'Refresh Data'}
              </Button>
              <Button
                variant="contained"
                size="small"
                startIcon={<AddIcon />}
                onClick={handleOpenAddDialog}
                disabled={!importsExist || loading}
                title={!importsExist ? 'Import data first to enable adding new rows' : ''}
              >
                Add New
              </Button>
            </Stack>
            <Stack direction="row" spacing={2.5} alignItems="center">
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary">Records</Typography>
                <Typography variant="subtitle2" color="primary.main" fontWeight={600}>
                  {summary.recordCount}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary">Amount</Typography>
                <Typography variant="subtitle2" fontWeight={600}>
                  {numberFormatter.format(summary.totalAmount)}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary">Periods</Typography>
                <Typography variant="subtitle2" fontWeight={600}>
                  {summary.periodCount}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="caption" color="text.secondary">Batches</Typography>
                <Typography variant="subtitle2" fontWeight={600}>
                  {summary.batchCount}
                </Typography>
              </Box>
            </Stack>
          </Stack>
          {/* Row 2: Legend + Filter chips */}
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }} flexWrap="wrap">
            <Typography variant="caption" color="text.secondary">Filter:</Typography>
            <Chip
              label="All"
              size="small"
              variant={rowFilter === 'all' ? 'filled' : 'outlined'}
              color={rowFilter === 'all' ? 'primary' : 'default'}
              onClick={() => setRowFilter('all')}
            />
            <Chip
              label={`Unmapped (${issueCounts.unmapped})`}
              size="small"
              variant={rowFilter === 'unmapped' ? 'filled' : 'outlined'}
              color="warning"
              onClick={() => setRowFilter('unmapped')}
              sx={issueCounts.unmapped > 0 ? { fontWeight: 600 } : { opacity: 0.5 }}
              disabled={issueCounts.unmapped === 0}
            />
            <Chip
              label={`Invalid Combo (${issueCounts.invalidCombo})`}
              size="small"
              variant={rowFilter === 'invalid_combo' ? 'filled' : 'outlined'}
              color="error"
              onClick={() => setRowFilter('invalid_combo')}
              sx={issueCounts.invalidCombo > 0 ? { fontWeight: 600 } : { opacity: 0.5 }}
              disabled={issueCounts.invalidCombo === 0}
            />
          </Stack>
        </CardContent>
      </StyledCard>

      <Paper sx={{ flex: 1, minHeight: 0, width: '100%' }}>
        <DataGridPremium
          key={gridKey}
          rows={filteredRows}
          columns={columns}
          slots={{
            toolbar: CustomToolbar,
          }}
          getRowClassName={(params: GridRowClassNameParams<StagingDataRow>) => {
            // Invalid combo takes priority (red)
            if (params.row.is_valid_combo === 0) {
              return 'row-invalid-combo';
            }
            // Unmapped rows (orange)
            if (params.row.mapping_status?.toLowerCase().includes('unmapped')) {
              return 'row-unmapped';
            }
            return '';
          }}
          initialState={{
            pagination: {
              paginationModel: { pageSize: 25 },
            },
            columns: {
              columnVisibilityModel: {
                dep_acc_combo_id: false,
                month: false,
                year: false,
                version: false,
                import_batch_id: false,
                currency: false,
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
            '& .MuiDataGrid-columnHeaderTitle': {
              fontWeight: 'bold',
            },
            // Row styling for unmapped rows (orange/warning)
            '& .row-unmapped': {
              backgroundColor: (theme) => alpha(theme.palette.warning.main, 0.15),
              '&:hover': {
                backgroundColor: (theme) => alpha(theme.palette.warning.main, 0.25),
              },
            },
            // Row styling for invalid combo rows (red/error)
            '& .row-invalid-combo': {
              backgroundColor: (theme) => alpha(theme.palette.error.main, 0.15),
              '&:hover': {
                backgroundColor: (theme) => alpha(theme.palette.error.main, 0.25),
              },
            },
          }}
        />
      </Paper>

      {/* Add/Edit Dialog */}
      <Dialog
        open={addDialogOpen || editDialogOpen}
        onClose={handleCloseDialogs}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {addDialogOpen ? 'Add New Staging Row' : 'Edit Staging Row'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {addDialogOpen && (
              <Alert severity="info" sx={{ fontSize: '0.8rem' }}>
                This will add a manual entry. Source will be marked as "Manual User Entry".
              </Alert>
            )}
            {editDialogOpen && (
              <Alert severity="warning" sx={{ fontSize: '0.8rem' }}>
                Editing will mark the row as edited. Consider adding a new correcting entry instead.
              </Alert>
            )}

            <Stack direction="row" spacing={2}>
              <Autocomplete
                options={validAccountsForDepartment.length > 0 ? validAccountsForDepartment : accounts}
                loading={accountsLoading}
                value={formData.account || null}
                onChange={handleAccountChange}
                freeSolo
                selectOnFocus
                handleHomeEndKeys
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Account"
                    required
                    size="small"
                    error={isComboValid === false}
                    InputProps={{
                      ...params.InputProps,
                      endAdornment: (
                        <>
                          {accountsLoading ? <CircularProgress size={20} /> : null}
                          {params.InputProps.endAdornment}
                        </>
                      ),
                    }}
                  />
                )}
                fullWidth
              />
              <Autocomplete
                options={validDepartmentsForAccount.length > 0 ? validDepartmentsForAccount : departments}
                loading={departmentsLoading}
                value={formData.department || null}
                onChange={handleDepartmentChange}
                freeSolo
                selectOnFocus
                handleHomeEndKeys
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Department"
                    required
                    size="small"
                    error={isComboValid === false}
                    InputProps={{
                      ...params.InputProps,
                      endAdornment: (
                        <>
                          {departmentsLoading ? <CircularProgress size={20} /> : null}
                          {params.InputProps.endAdornment}
                        </>
                      ),
                    }}
                  />
                )}
                fullWidth
              />
            </Stack>

            {isComboValid === false && (
              <Alert severity="error" sx={{ fontSize: '0.8rem' }}>
                Invalid combination. This account and department combo does not exist.
              </Alert>
            )}
            {isComboValid === true && (
              <Alert severity="success" sx={{ fontSize: '0.8rem' }}>
                Valid combination: D{formData.department}_A{formData.account}
              </Alert>
            )}

            <Stack direction="row" spacing={2}>
              <TextField
                label="Amount"
                type="number"
                value={formData.amount}
                onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                size="small"
                required
                fullWidth
              />
            </Stack>

            <Stack direction="row" spacing={2}>
              <TextField
                label="Period"
                value={formData.period_combo}
                onChange={(e) => setFormData(prev => ({ ...prev, period_combo: e.target.value }))}
                size="small"
                fullWidth
              />
              <TextField
                label="Scenario"
                value={formData.scenario}
                onChange={(e) => setFormData(prev => ({ ...prev, scenario: e.target.value }))}
                size="small"
                fullWidth
              />
            </Stack>

            <Stack direction="row" spacing={2}>
              <TextField
                label="Month"
                type="number"
                value={formData.month}
                onChange={(e) => setFormData(prev => ({ ...prev, month: parseInt(e.target.value) || 1 }))}
                size="small"
                inputProps={{ min: 1, max: 12 }}
                fullWidth
              />
              <TextField
                label="Year"
                type="number"
                value={formData.year}
                onChange={(e) => setFormData(prev => ({ ...prev, year: parseInt(e.target.value) || 2024 }))}
                size="small"
                fullWidth
              />
            </Stack>

            <Stack direction="row" spacing={2}>
              <TextField
                label="Currency"
                value={formData.currency}
                onChange={(e) => setFormData(prev => ({ ...prev, currency: e.target.value }))}
                size="small"
                fullWidth
              />
              <TextField
                label="Version"
                value={formData.version}
                onChange={(e) => setFormData(prev => ({ ...prev, version: e.target.value }))}
                size="small"
                fullWidth
              />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialogs} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={addDialogOpen ? handleAddSubmit : handleEditSubmit}
            disabled={submitting || !formData.account || !formData.department || isComboValid !== true}
          >
            {submitting ? 'Saving...' : (addDialogOpen ? 'Add' : 'Save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={handleCloseDialogs}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Confirm Delete</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete this staging row?
          </Typography>
          {selectedRow && (
            <Box sx={{ mt: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
              <Typography variant="body2" color="text.secondary">
                <strong>Account:</strong> {selectedRow.account}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <strong>Department:</strong> {selectedRow.department}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <strong>Amount:</strong> {numberFormatter.format(selectedRow.amount)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <strong>Period:</strong> {selectedRow.period_combo}
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialogs} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDeleteConfirm}
            disabled={submitting}
          >
            {submitting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

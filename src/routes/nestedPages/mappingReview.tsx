/**
 * Mapping Review Page
 * ===================
 *
 * Clean, Apple-inspired design for reviewing mapping configurations.
 * Features premium DataGrid with export, filtering, and column management.
 * Redesigned with minimalist approach and optimized viewport management.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Stack,
  Typography,
  Alert,
  Fade,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  SelectChangeEvent,
  Chip,
  Tooltip,
  Paper,
  alpha,
  IconButton,
  Card,
  Button,
} from '@mui/material';
import {
  DataGridPremium,
  GridColDef,
  GridToolbarContainer,
  GridToolbarColumnsButton,
  GridToolbarFilterButton,
  GridToolbarExport,
  GridToolbarDensitySelector,
  GridToolbarQuickFilter,
} from '@mui/x-data-grid-premium';
import { styled, useTheme, keyframes } from '@mui/material/styles';
import {
  Sync as SyncIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
  Refresh as RefreshIcon,
  TrendingFlat as TrendingFlatIcon,
  HourglassEmpty as PendingIcon,
  Block as BlockIcon,
  Add as AddIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import mappingConfigService, { MappingConfigResponse, MappingEntry, ApprovalStatus } from '../../services/mappingConfigService';
import importConfigService from '../../services/importConfigService';
import authService from '../../services/auth';
import RequestMappingDialog from '../../components/RequestMappingDialog';

// ────────────────────────────────────────────────────────────
// ANIMATIONS
// ────────────────────────────────────────────────────────────

const slideIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

// ────────────────────────────────────────────────────────────
// STYLED COMPONENTS
// ────────────────────────────────────────────────────────────

const PageContainer = styled(Box)(({ theme }) => ({
  display: 'flex',
  flexDirection: 'column',
  height: 'calc(100vh - 64px)',
  width: '100%',
  maxWidth: '100%',
  background: theme.palette.background.default,
  padding: theme.spacing(3),
  overflow: 'hidden',
  boxSizing: 'border-box',
  [theme.breakpoints.down('sm')]: {
    padding: theme.spacing(2),
  },
}));

const Header = styled(Card)(({ theme }) => ({
  borderRadius: 16,
  background: theme.palette.mode === 'dark'
    ? `linear-gradient(135deg, ${alpha('#ffffff', 0.05)} 0%, ${alpha('#8b5cf6', 0.08)} 100%)`
    : `linear-gradient(135deg, ${alpha('#ffffff', 0.9)} 0%, ${alpha('#8b5cf6', 0.05)} 100%)`,
  backdropFilter: 'blur(20px)',
  border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
  boxShadow: theme.palette.mode === 'dark'
    ? `0 8px 32px ${alpha('#000000', 0.3)}`
    : `0 8px 32px ${alpha('#8b5cf6', 0.08)}`,
  flexShrink: 0,
  width: '100%',
  boxSizing: 'border-box',
  marginBottom: theme.spacing(2),
  padding: theme.spacing(3),
  [theme.breakpoints.down('sm')]: {
    padding: theme.spacing(2),
  },
}));

const ContentArea = styled(Box)(() => ({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0, // Important for flex children
  overflow: 'hidden', // Remove the extra scrollbar
}));

const ControlBar = styled(Paper)(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: theme.spacing(1.5),
  flexShrink: 0,
  marginBottom: theme.spacing(2),
  padding: theme.spacing(2),
  borderRadius: 12,
  background: alpha(theme.palette.background.paper, 0.7),
  backdropFilter: 'blur(20px)',
  border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
}));

const StatsChip = styled(Chip)(({ theme }) => ({
  fontWeight: 600,
  fontSize: '0.75rem',
  height: 26,
  borderRadius: 8,
  transition: 'all 0.2s ease',
  '& .MuiChip-label': {
    paddingLeft: theme.spacing(1.25),
    paddingRight: theme.spacing(1.25),
  },
}));

const DataGridWrapper = styled(Box)(({ theme }) => ({
  height: 'calc(100vh - 400px)',
  minHeight: 400,
  width: '100%',
  borderRadius: 12,
  overflow: 'hidden',
  position: 'relative',
  background: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
  boxShadow: theme.palette.mode === 'dark'
    ? '0 4px 12px rgba(0,0,0,0.3)'
    : '0 2px 8px rgba(0,0,0,0.08)',
  animation: `${slideIn} 0.3s ease-out`,
}));

const StyledDataGrid = styled(DataGridPremium)(({ theme }) => ({
  height: '100%',
  width: '100%',
  border: 'none',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  '& .MuiDataGrid-virtualScroller': {
    backgroundColor: 'transparent',
  },
  '& .MuiDataGrid-columnHeaders': {
    backgroundColor: theme.palette.mode === 'dark'
      ? alpha('#ffffff', 0.02)
      : alpha('#000000', 0.015),
    borderBottom: `1px solid ${theme.palette.divider}`,
    borderRadius: 0,
    minHeight: '48px !important',
    maxHeight: '48px !important',
  },
  '& .MuiDataGrid-columnHeader': {
    fontWeight: 600,
    fontSize: '0.8125rem',
    letterSpacing: '0.01em',
    color: theme.palette.text.secondary,
    '&:focus, &:focus-within': {
      outline: 'none',
    },
  },
  '& .MuiDataGrid-columnHeaderTitle': {
    fontWeight: 600,
  },
  '& .MuiDataGrid-columnSeparator': {
    opacity: 0,
  },
  '& .MuiDataGrid-row': {
    cursor: 'default',
    transition: 'background-color 0.15s ease',
    '&:hover': {
      backgroundColor: alpha(theme.palette.primary.main, 0.04),
    },
    '&.Mui-selected': {
      backgroundColor: alpha(theme.palette.primary.main, 0.08),
      '&:hover': {
        backgroundColor: alpha(theme.palette.primary.main, 0.12),
      },
    },
  },
  '& .MuiDataGrid-cell': {
    borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
    fontSize: '0.875rem',
    display: 'flex',
    alignItems: 'center',
    '&:focus, &:focus-within': {
      outline: 'none',
    },
  },
  '& .MuiDataGrid-footerContainer': {
    borderTop: `1px solid ${theme.palette.divider}`,
    backgroundColor: theme.palette.mode === 'dark'
      ? alpha('#ffffff', 0.02)
      : alpha('#000000', 0.01),
    minHeight: '52px',
  },
  '& .MuiTablePagination-root': {
    fontSize: '0.8125rem',
  },
}));

// ────────────────────────────────────────────────────────────
// CUSTOM TOOLBAR
// ────────────────────────────────────────────────────────────

function CustomToolbar() {
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
          fileName: `mapping-config-${new Date().toISOString().split('T')[0]}`,
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
}

// ────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────

const MappingReview: React.FC = () => {
  const theme = useTheme();

  // State for responsive design - using state to force re-renders
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [gridKey, setGridKey] = useState(0);

  // Update window width on resize and force grid refresh when shrinking
  useEffect(() => {
    let previousWidth = window.innerWidth;
    let resizeTimeout: NodeJS.Timeout;

    const handleResize = () => {
      clearTimeout(resizeTimeout);

      resizeTimeout = setTimeout(() => {
        const currentWidth = window.innerWidth;
        setWindowWidth(currentWidth);

        // Force DataGrid to remount when window shrinks significantly
        if (currentWidth < previousWidth - 10) { // Add threshold to avoid too many remounts
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

  // Calculate responsive breakpoints based on window width
  const isMobile = windowWidth < theme.breakpoints.values.sm;
  const isTablet = windowWidth < theme.breakpoints.values.md;
  const isDesktop = windowWidth >= theme.breakpoints.values.lg;

  // State
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [mappingConfigs, setMappingConfigs] = useState<MappingConfigResponse[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string>('');
  const [selectedConfig, setSelectedConfig] = useState<MappingConfigResponse | null>(null);
  const [mappings, setMappings] = useState<MappingEntry[]>([]);
  const [error, setError] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [approvalFilter, setApprovalFilter] = useState<ApprovalStatus | 'ALL'>('ALL');
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<MappingEntry | null>(null);

  // Fetch mapping configs
  const fetchMappingConfigs = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const configs = await mappingConfigService.getAllStoredMappingConfigs();

      if (configs && configs.length > 0) {
        setMappingConfigs(configs);

        if (!selectedConfigId || !configs.find(c => String(c.config_id || c.id) === selectedConfigId)) {
          const firstConfig = configs[0];
          const configId = String(firstConfig.config_id || firstConfig.id);
          setSelectedConfigId(configId);
          setSelectedConfig(firstConfig);
        } else {
          // Always update selectedConfig with fresh data so mappings useEffect re-triggers
          const freshConfig = configs.find(c => String(c.config_id || c.id) === selectedConfigId);
          if (freshConfig) {
            setSelectedConfig(freshConfig);
          }
        }
      } else {
        setError('No mapping configurations found. Click sync to load configurations.');
      }
    } catch (err) {
      console.error('Error fetching mapping configs:', err);
      setError('Failed to load mapping configurations');
    } finally {
      setLoading(false);
    }
  }, [selectedConfigId]);

  // Fetch mappings for selected config
  useEffect(() => {
    const fetchMappings = async () => {
      if (!selectedConfig) return;

      setError('');

      try {
        const configId = selectedConfig.config_id || selectedConfig.id;
        const storedMappings = await mappingConfigService.getStoredMappings(configId);

        if (storedMappings && storedMappings.length > 0) {
          setMappings(storedMappings);
        } else {
          try {
            const apiMappings = await mappingConfigService.getMappingsFromAPI(configId);
            setMappings(apiMappings);
            await mappingConfigService.replaceMappings(configId, apiMappings);
          } catch (apiError) {
            setMappings([]);
            setError('No mappings available for this configuration');
          }
        }
      } catch (err) {
        console.error('Error fetching mappings:', err);
        setError('Failed to load mappings');
        setMappings([]);
      }
    };

    fetchMappings();
  }, [selectedConfig]);

  // Initial load - check if cache is stale, sync from server if needed, then load from local DB
  useEffect(() => {
    const syncAndLoad = async () => {
      try {
        // Only auto-sync if import groups cache is older than 30 minutes
        // This avoids hitting the API every time the page is opened
        let shouldSync = true;
        if (window.ipcApi) {
          const hotels = await authService.getHotels();
          if (hotels && hotels.length > 0) {
            const currentOU = hotels[0].ou;
            const shouldRefresh = await window.ipcApi.sendIpcRequest('db:should-refresh-cache', {
              key: `import_groups_${currentOU}`,
              maxAgeMinutes: 30
            });

            if (shouldRefresh.data) {
              await importConfigService.syncMappingConfigsForOU(currentOU);
            }
          }
        }
      } catch (err) {
        // Silent fail - still load from local DB
        console.warn('Failed to sync mapping configs on page open:', err);
      }
      await fetchMappingConfigs();
    };

    syncAndLoad();
  }, []);

  // Handle config selection
  const handleConfigSelect = useCallback((event: SelectChangeEvent) => {
    const configId = event.target.value;
    setSelectedConfigId(configId);

    const config = mappingConfigs.find(c => String(c.config_id || c.id) === configId);
    setSelectedConfig(config || null);
  }, [mappingConfigs]);

  // Sync mapping configs
  const handleSyncMappingConfigs = useCallback(async () => {
    setSyncing(true);
    setError('');
    setSuccessMessage('');

    try {
      // Capture local version of selected config before sync
      const configId = selectedConfig?.config_id || selectedConfig?.id;
      const localVersion = selectedConfig?.version;
      const configLabel = selectedConfig?.description || `config #${configId}`;

      const hotels = await authService.getHotels();
      if (!hotels || hotels.length === 0) {
        throw new Error('No hotels available');
      }

      const currentOU = hotels[0].ou;
      await importConfigService.syncMappingConfigsForOU(currentOU);

      // Also sync the selected config directly — syncMappingConfigsForOU only
      // syncs configs linked to import groups, which may not include the selected one
      if (configId) {
        await mappingConfigService.syncMappingConfig(configId as number);
      }

      await fetchMappingConfigs();

      if (configId) {
        const syncedConfig = await mappingConfigService.getStoredMappingConfig(configId);
        const apiVersion = syncedConfig?.version;

        if (localVersion && apiVersion && localVersion !== apiVersion) {
          setSuccessMessage(`[id=${configId}] ${configLabel} updated: local ${localVersion} → API ${apiVersion}`);
        } else if (localVersion && apiVersion) {
          setSuccessMessage(`[id=${configId}] ${configLabel} already up-to-date (local: ${localVersion}, API: ${apiVersion})`);
        } else {
          setSuccessMessage(`[id=${configId}] ${configLabel} synced (API: ${apiVersion || 'unknown'})`);
        }
      } else {
        setSuccessMessage('Sync complete');
      }
    } catch (err) {
      console.error('Error syncing mapping configs:', err);
      setError('Failed to sync mapping configurations: ' + (err as Error).message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSuccessMessage(''), 5000);
    }
  }, [fetchMappingConfigs, selectedConfig]);

  // Handle edit mapping
  const handleEditMapping = useCallback((mapping: MappingEntry) => {
    setEditingMapping(mapping);
    setEditDialogOpen(true);
  }, []);

  // Handle successful mapping edit - refresh mappings from API
  const handleEditMappingSuccess = useCallback(async () => {
    if (!selectedConfig) return;

    try {
      const configId = selectedConfig.config_id || selectedConfig.id;
      const apiMappings = await mappingConfigService.getMappingsFromAPI(configId);
      await mappingConfigService.replaceMappings(configId, apiMappings);
      setMappings(apiMappings);
      setSuccessMessage('Modification request submitted and list refreshed');
      setTimeout(() => setSuccessMessage(''), 5000);
    } catch (err) {
      console.error('Error refreshing mappings after edit:', err);
      setSuccessMessage('Modification request submitted. Sync to see it in the list.');
      setTimeout(() => setSuccessMessage(''), 5000);
    }
  }, [selectedConfig]);

  // Handle successful mapping request - refresh mappings from API
  const handleMappingRequestSuccess = useCallback(async () => {
    if (!selectedConfig) return;

    try {
      const configId = selectedConfig.config_id || selectedConfig.id;
      // Fetch fresh mappings from API
      const apiMappings = await mappingConfigService.getMappingsFromAPI(configId);
      // Update local database
      await mappingConfigService.replaceMappings(configId, apiMappings);
      // Update state
      setMappings(apiMappings);
      setSuccessMessage('Mapping request submitted and list refreshed');
      setTimeout(() => setSuccessMessage(''), 5000);
    } catch (err) {
      console.error('Error refreshing mappings:', err);
      // Still show success for the request, just note refresh failed
      setSuccessMessage('Mapping request submitted. Sync to see it in the list.');
      setTimeout(() => setSuccessMessage(''), 5000);
    }
  }, [selectedConfig]);

  // Define columns with responsive widths
  const columns: GridColDef[] = [
    {
      field: 'id',
      headerName: 'ID',
      width: 70,
      type: 'number',
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => (
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            fontSize: '0.75rem',
            color: theme.palette.text.secondary,
            fontFamily: 'monospace',
          }}
        >
          {params.value}
        </Typography>
      ),
    },
    {
      field: 'priority',
      headerName: 'Priority',
      width: 80,
      type: 'number',
      renderCell: (params) => (
        <Chip
          label={params.value}
          size="small"
          sx={{
            fontWeight: 700,
            fontSize: '0.6875rem',
            height: 22,
            minWidth: 40,
            borderRadius: 1.5,
            backgroundColor: params.value <= 10
              ? alpha(theme.palette.error.main, 0.12)
              : params.value <= 50
              ? alpha(theme.palette.warning.main, 0.12)
              : alpha(theme.palette.grey[500], 0.12),
            color: params.value <= 10
              ? theme.palette.error.main
              : params.value <= 50
              ? theme.palette.warning.main
              : theme.palette.text.secondary,
            border: 'none',
          }}
        />
      ),
    },
    {
      field: 'source_account',
      headerName: 'Source Account',
      flex: 1,
      minWidth: 80,
      renderCell: (params) => params.value || (
        <Typography variant="body2" sx={{ fontStyle: 'italic', opacity: 0.5 }}>
          Any
        </Typography>
      ),
    },
    {
      field: 'source_department',
      headerName: 'Source Dept',
      flex: 1,
      minWidth: 80,
      renderCell: (params) => params.value || (
        <Typography variant="body2" sx={{ fontStyle: 'italic', opacity: 0.5 }}>
          Any
        </Typography>
      ),
    },
    {
      field: 'source_account_department',
      headerName: 'Source Acct+Dept',
      flex: 1,
      minWidth: 90,
      renderCell: (params) => params.value || (
        <Typography variant="body2" sx={{ fontStyle: 'italic', opacity: 0.5 }}>
          N/A
        </Typography>
      ),
    },
    {
      field: 'arrow',
      headerName: '',
      width: 50,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      disableExport: true,
      align: 'center',
      renderCell: () => (
        <TrendingFlatIcon
          sx={{
            color: theme.palette.text.disabled,
            fontSize: 18,
            opacity: 0.5,
          }}
        />
      ),
    },
    {
      field: 'target_account',
      headerName: 'Target Account',
      flex: 1,
      minWidth: 80,
      renderCell: (params) => params.value || (
        <Typography variant="body2" sx={{ fontStyle: 'italic', opacity: 0.5 }}>
          No mapping
        </Typography>
      ),
    },
    {
      field: 'target_department',
      headerName: 'Target Dept',
      flex: 1,
      minWidth: 80,
      renderCell: (params) => params.value || (
        <Typography variant="body2" sx={{ fontStyle: 'italic', opacity: 0.5 }}>
          No mapping
        </Typography>
      ),
    },
    {
      field: 'target_account_department',
      headerName: 'Target Acct+Dept',
      flex: 1,
      minWidth: 90,
      renderCell: (params) => params.value || (
        <Typography variant="body2" sx={{ fontStyle: 'italic', opacity: 0.5 }}>
          N/A
        </Typography>
      ),
    },
    {
      field: 'is_active',
      headerName: 'Active',
      width: 85,
      type: 'boolean',
      renderCell: (params) => (
        <Chip
          icon={params.value ? <CheckCircleIcon /> : <CancelIcon />}
          label={params.value ? 'Yes' : 'No'}
          size="small"
          sx={{
            fontWeight: 700,
            fontSize: '0.6875rem',
            height: 22,
            borderRadius: 1.5,
            backgroundColor: params.value
              ? alpha(theme.palette.success.main, 0.12)
              : alpha(theme.palette.error.main, 0.12),
            color: params.value
              ? theme.palette.success.main
              : theme.palette.error.main,
            border: 'none',
            '& .MuiChip-icon': {
              fontSize: 14,
              marginLeft: '4px',
            },
          }}
        />
      ),
    },
    {
      field: 'approval_status',
      headerName: 'Approval',
      width: 130,
      renderCell: (params) => {
        const status = params.value as ApprovalStatus;
        const getStatusConfig = () => {
          switch (status) {
            case 'APPROVED':
              return {
                icon: <CheckCircleIcon />,
                label: 'Approved',
                bgColor: alpha(theme.palette.success.main, 0.12),
                color: theme.palette.success.main,
              };
            case 'REJECTED':
              return {
                icon: <BlockIcon />,
                label: 'Rejected',
                bgColor: alpha(theme.palette.error.main, 0.12),
                color: theme.palette.error.main,
              };
            case 'PENDING_APPROVAL':
              return {
                icon: <PendingIcon />,
                label: 'Pending',
                bgColor: alpha(theme.palette.warning.main, 0.12),
                color: theme.palette.warning.main,
              };
            case 'DRAFT':
              return {
                icon: <PendingIcon />,
                label: 'Draft',
                bgColor: alpha(theme.palette.grey[500], 0.12),
                color: theme.palette.grey[600],
              };
            default:
              return {
                icon: <PendingIcon />,
                label: status || 'Unknown',
                bgColor: alpha(theme.palette.grey[500], 0.12),
                color: theme.palette.grey[600],
              };
          }
        };

        const config = getStatusConfig();
        return (
          <Chip
            icon={config.icon}
            label={config.label}
            size="small"
            sx={{
              fontWeight: 700,
              fontSize: '0.6875rem',
              height: 22,
              borderRadius: 1.5,
              backgroundColor: config.bgColor,
              color: config.color,
              border: 'none',
              '& .MuiChip-icon': {
                fontSize: 14,
                marginLeft: '4px',
                color: config.color,
              },
            }}
          />
        );
      },
    },
    {
      field: 'actions',
      headerName: '',
      width: 60,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      disableExport: true,
      align: 'center',
      renderCell: (params) => {
        const isLocked = selectedConfig?.is_locked;

        return (
          <Tooltip title={isLocked ? 'Config is locked' : 'Edit mapping'} arrow placement="top">
            <span>
              <IconButton
                size="small"
                onClick={() => handleEditMapping(params.row as MappingEntry)}
                disabled={syncing || isLocked}
                sx={{
                  width: 28,
                  height: 28,
                  color: theme.palette.info.main,
                  '&:hover': {
                    backgroundColor: alpha(theme.palette.info.main, 0.12),
                  },
                  '&.Mui-disabled': {
                    color: alpha(theme.palette.text.disabled, 0.4),
                  },
                }}
              >
                <EditIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
        );
      },
    },
  ];

  // Stats
  const activeCount = mappings.filter(m => m.is_active).length;
  const inactiveCount = mappings.length - activeCount;
  const pendingCount = mappings.filter(m => m.approval_status === 'PENDING_APPROVAL').length;
  const approvedCount = mappings.filter(m => m.approval_status === 'APPROVED').length;
  const rejectedCount = mappings.filter(m => m.approval_status === 'REJECTED').length;

  // Filter mappings based on approval filter
  const filteredMappings = approvalFilter === 'ALL'
    ? mappings
    : mappings.filter(m => m.approval_status === approvalFilter);

  if (loading && mappingConfigs.length === 0) {
    return (
      <PageContainer>
        <Box display="flex" justifyContent="center" alignItems="center" height="100%">
          <CircularProgress />
        </Box>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <Header>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
          <Box>
            <Typography
              variant="h5"
              fontWeight={700}
              sx={{
                fontSize: { xs: '1.25rem', sm: '1.5rem' },
                letterSpacing: '-0.01em',
                mb: 0.25,
                color: 'text.primary',
              }}
            >
              Mapping Review
            </Typography>
            <Typography variant="body2" color="text.secondary" fontSize="0.875rem">
              Review and export account mapping configurations
            </Typography>
          </Box>

          {/* Stats */}
          {selectedConfig && mappings.length > 0 && !isTablet && (
            <Stack direction="row" spacing={1}>
              <StatsChip
                label={`${mappings.length} Total`}
                sx={{
                  backgroundColor: alpha(theme.palette.primary.main, 0.08),
                  color: theme.palette.primary.main,
                  border: 'none',
                }}
              />
              <StatsChip
                label={`${approvedCount} Approved`}
                sx={{
                  backgroundColor: alpha(theme.palette.success.main, 0.12),
                  color: theme.palette.success.main,
                  border: 'none',
                }}
              />
              {pendingCount > 0 && (
                <StatsChip
                  label={`${pendingCount} Pending`}
                  sx={{
                    backgroundColor: alpha(theme.palette.warning.main, 0.12),
                    color: theme.palette.warning.main,
                    border: 'none',
                  }}
                />
              )}
              {rejectedCount > 0 && (
                <StatsChip
                  label={`${rejectedCount} Rejected`}
                  sx={{
                    backgroundColor: alpha(theme.palette.error.main, 0.12),
                    color: theme.palette.error.main,
                    border: 'none',
                  }}
                />
              )}
            </Stack>
          )}
        </Stack>
      </Header>

      {/* Content Area */}
      <ContentArea>
        {/* Control Bar */}
        <ControlBar elevation={0}>
          <FormControl sx={{ minWidth: isMobile ? 160 : 280 }} size="small">
            <InputLabel sx={{ fontSize: '0.875rem' }}>Configuration</InputLabel>
            <Select
              value={selectedConfigId}
              label="Configuration"
              onChange={handleConfigSelect}
              disabled={loading || mappingConfigs.length === 0 || syncing}
              sx={{
                fontSize: '0.875rem',
                '& .MuiSelect-select': {
                  py: 1,
                },
              }}
            >
              {mappingConfigs.map((config) => {
                const configId = config.config_id || config.id;
                return (
                  <MenuItem key={configId} value={String(configId)} sx={{ fontSize: '0.875rem' }}>
                    {config.description || `Config ${configId}`}
                  </MenuItem>
                );
              })}
            </Select>
          </FormControl>

          {!isMobile && (
            <FormControl sx={{ minWidth: 140 }} size="small">
              <InputLabel sx={{ fontSize: '0.875rem' }}>Approval Status</InputLabel>
              <Select
                value={approvalFilter}
                label="Approval Status"
                onChange={(e) => setApprovalFilter(e.target.value as ApprovalStatus | 'ALL')}
                disabled={loading || syncing}
                sx={{
                  fontSize: '0.875rem',
                  '& .MuiSelect-select': {
                    py: 1,
                  },
                }}
              >
                <MenuItem value="ALL" sx={{ fontSize: '0.875rem' }}>All</MenuItem>
                <MenuItem value="APPROVED" sx={{ fontSize: '0.875rem' }}>Approved</MenuItem>
                <MenuItem value="PENDING_APPROVAL" sx={{ fontSize: '0.875rem' }}>Pending</MenuItem>
                <MenuItem value="REJECTED" sx={{ fontSize: '0.875rem' }}>Rejected</MenuItem>
                <MenuItem value="DRAFT" sx={{ fontSize: '0.875rem' }}>Draft</MenuItem>
              </Select>
            </FormControl>
          )}

          {selectedConfig && (
            <>
              {!isMobile && (
                <StatsChip
                  label={`Version: ${selectedConfig.version}`}
                  size="small"
                  sx={{
                    backgroundColor: alpha(theme.palette.info.main, 0.1),
                    color: theme.palette.info.main,
                    border: 'none',
                  }}
                />
              )}
              {!isMobile && (
                <StatsChip
                  icon={selectedConfig.is_locked ? <CancelIcon /> : <CheckCircleIcon />}
                  label={selectedConfig.is_locked ? 'Locked' : 'Unlocked'}
                  size="small"
                  sx={{
                    backgroundColor: selectedConfig.is_locked
                      ? alpha(theme.palette.error.main, 0.12)
                      : alpha(theme.palette.success.main, 0.12),
                    color: selectedConfig.is_locked
                      ? theme.palette.error.main
                      : theme.palette.success.main,
                    border: 'none',
                    '& .MuiChip-icon': {
                      fontSize: 14,
                      marginLeft: '4px',
                    },
                  }}
                />
              )}
              {selectedConfig.updated_at && isDesktop && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontSize: '0.75rem' }}
                >
                  Updated {new Date(selectedConfig.updated_at).toLocaleDateString()}
                </Typography>
              )}
            </>
          )}

          <Box flex={1} />

          {/* Request New Mapping Button */}
          {selectedConfig && (
            <Tooltip title={selectedConfig.is_locked ? 'Config is locked' : 'Request a new mapping line'} arrow placement="top">
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => setRequestDialogOpen(true)}
                  disabled={syncing || loading || selectedConfig.is_locked}
                  sx={{
                    textTransform: 'none',
                    borderRadius: 2,
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    px: 2,
                    height: 36,
                    borderColor: 'divider',
                    color: 'text.primary',
                    '&:hover': {
                      borderColor: theme.palette.primary.main,
                      backgroundColor: alpha(theme.palette.primary.main, 0.04),
                    },
                  }}
                >
                  {isMobile ? 'Request' : 'Request Mapping'}
                </Button>
              </span>
            </Tooltip>
          )}

          <Tooltip title="Sync configurations from server" arrow placement="top">
            <span>
              <IconButton
                onClick={handleSyncMappingConfigs}
                disabled={syncing || loading}
                size="small"
                sx={{
                  width: 36,
                  height: 36,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 2,
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    backgroundColor: alpha(theme.palette.primary.main, 0.08),
                    borderColor: theme.palette.primary.main,
                  },
                  '&.Mui-disabled': {
                    opacity: 0.5,
                  },
                }}
              >
                {syncing ? (
                  <CircularProgress size={18} thickness={4} />
                ) : (
                  <RefreshIcon sx={{ fontSize: 18 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
        </ControlBar>

        {/* Messages */}
        {successMessage && (
          <Fade in>
            <Alert
              severity="success"
              icon={<CheckCircleIcon sx={{ fontSize: 20 }} />}
              sx={{
                mb: 2,
                borderRadius: 2.5,
                fontSize: '0.875rem',
                fontWeight: 500,
                border: '1px solid',
                borderColor: alpha(theme.palette.success.main, 0.3),
              }}
              onClose={() => setSuccessMessage('')}
            >
              {successMessage}
            </Alert>
          </Fade>
        )}

        {error && (
          <Fade in>
            <Alert
              severity="error"
              sx={{
                mb: 2,
                borderRadius: 2.5,
                fontSize: '0.875rem',
                fontWeight: 500,
                border: '1px solid',
                borderColor: alpha(theme.palette.error.main, 0.3),
              }}
              onClose={() => setError('')}
            >
              {error}
            </Alert>
          </Fade>
        )}

        {/* Data Grid */}
        {selectedConfig && mappings.length > 0 ? (
          <DataGridWrapper>
            <StyledDataGrid
              key={gridKey} // Force remount when window shrinks
              rows={filteredMappings}
              columns={columns}
              pagination
              autoPageSize={false}
              pageSizeOptions={[25, 50, 100]}
              disableColumnResize
              initialState={{
                pagination: { paginationModel: { pageSize: 25 } },
                sorting: {
                  sortModel: [{ field: 'priority', sort: 'asc' }],
                },
                columns: {
                  columnVisibilityModel: {
                    // Hide less important columns on mobile/tablet
                    source_account_department: !isMobile && !isTablet,
                    target_account_department: !isMobile && !isTablet,
                    source_department: !isMobile,
                    target_department: !isMobile,
                  },
                },
              }}
              disableRowSelectionOnClick
              slots={{
                toolbar: CustomToolbar,
              }}
              sx={{
                minWidth: isMobile ? '100%' : 'auto',
              }}
            />
          </DataGridWrapper>
        ) : (
          !error && (
            <Box
              display="flex"
              alignItems="center"
              justifyContent="center"
              flex={1}
              minHeight={400}
              sx={{
                borderRadius: 3,
                border: '2px dashed',
                borderColor: alpha(theme.palette.divider, 0.5),
                backgroundColor: alpha(theme.palette.background.paper, 0.3),
              }}
            >
              <Stack spacing={2.5} alignItems="center" textAlign="center" sx={{ maxWidth: 380, px: 3 }}>
                <Box
                  sx={{
                    width: 80,
                    height: 80,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: alpha(theme.palette.primary.main, 0.06),
                  }}
                >
                  <SyncIcon sx={{ fontSize: 40, color: theme.palette.primary.main, opacity: 0.4 }} />
                </Box>
                <Typography variant="h6" color="text.primary" fontWeight={600} fontSize="1.125rem">
                  No Configuration Selected
                </Typography>
                <Typography variant="body2" color="text.secondary" lineHeight={1.6} fontSize="0.875rem">
                  {mappingConfigs.length === 0
                    ? 'Click the sync button in the control bar to load configurations from the server'
                    : 'Select a configuration from the dropdown above to view and export mappings'}
                </Typography>
              </Stack>
            </Box>
          )
        )}
      </ContentArea>

      {/* Request Mapping Dialog */}
      {selectedConfig && (
        <RequestMappingDialog
          open={requestDialogOpen}
          onClose={() => setRequestDialogOpen(false)}
          configId={selectedConfig.config_id || selectedConfig.id || 0}
          configDescription={selectedConfig.description}
          onSuccess={handleMappingRequestSuccess}
        />
      )}

      {/* Edit Mapping Dialog */}
      {selectedConfig && editingMapping && (
        <RequestMappingDialog
          open={editDialogOpen}
          onClose={() => {
            setEditDialogOpen(false);
            setEditingMapping(null);
          }}
          configId={selectedConfig.config_id || selectedConfig.id || 0}
          configDescription={selectedConfig.description}
          onSuccess={handleEditMappingSuccess}
          mode="edit"
          existingMapping={editingMapping}
        />
      )}
    </PageContainer>
  );
};

export default MappingReview;

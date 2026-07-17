/**
 * Data Import Page
 * ================
 *
 * Manages the import of various data files using the import processor system.
 * Uses the ImportCard component for file selection and processing.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Stack,
  Alert,
  Fade,
  useMediaQuery,
  alpha,
  Divider,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  SelectChangeEvent,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
} from '@mui/material';
import { styled, useTheme, keyframes } from '@mui/material/styles';
import {
  CheckCircle as CheckCircleIcon,
  Refresh as RefreshIcon,
  Info as InfoIcon,
  TaskAlt as TaskAltIcon,
  Lock as LockIcon,
  DeleteSweep as DeleteSweepIcon,
} from '@mui/icons-material';
import { useBlocker } from 'react-router-dom';
import ImportCard from '../../components/dataImport/ImportCard';
import { ImportFile, ImportStatus } from '../../types/dataImport';
import importConfigService, { ImportGroup } from '../../services/importConfigService';
import authService from '../../services/auth';
import uploadPeriodsService, { UploadPeriod } from '../../services/uploadPeriodsService';
import { useSettingsStore } from '../../store/settings';

// ────────────────────────────────────────────────────────────
// ANIMATIONS
// ────────────────────────────────────────────────────────────

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
`;

// ────────────────────────────────────────────────────────────
// STYLED COMPONENTS
// ────────────────────────────────────────────────────────────

const PageContainer = styled(Box)(({ theme }) => ({
  minHeight: 'calc(100vh - 64px)',
  background: theme.palette.mode === 'dark'
    ? 'linear-gradient(180deg, rgba(139, 92, 246, 0.03) 0%, rgba(6, 182, 212, 0.03) 100%)'
    : 'linear-gradient(180deg, rgba(139, 92, 246, 0.02) 0%, rgba(6, 182, 212, 0.02) 100%)',
  padding: theme.spacing(3),
  [theme.breakpoints.down('sm')]: {
    padding: theme.spacing(2),
  },
}));

const HeaderCard = styled(Card)(({ theme }) => ({
  borderRadius: 16,
  background: theme.palette.mode === 'dark'
    ? `linear-gradient(135deg, ${alpha('#ffffff', 0.05)} 0%, ${alpha('#8b5cf6', 0.08)} 100%)`
    : `linear-gradient(135deg, ${alpha('#ffffff', 0.9)} 0%, ${alpha('#8b5cf6', 0.05)} 100%)`,
  backdropFilter: 'blur(20px)',
  border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
  boxShadow: theme.palette.mode === 'dark'
    ? `0 8px 32px ${alpha('#000000', 0.3)}`
    : `0 8px 32px ${alpha('#8b5cf6', 0.08)}`,
  marginBottom: theme.spacing(2),
}));

// ────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────

const DataImport: React.FC = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  // State
  const [loading, setLoading] = useState(true);
  const [importFiles, setImportFiles] = useState<ImportFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'importing' | 'complete'>('idle');
  const [importSessionStarted, setImportSessionStarted] = useState(false);
  const [currentImportSessionId, setCurrentImportSessionId] = useState<number | null>(null);
  const [importCompleted, setImportCompleted] = useState(false);
  const [showResetConfirmModal, setShowResetConfirmModal] = useState(false);
  const [showResetAllHotelsModal, setShowResetAllHotelsModal] = useState(false);
  const [showLockedMessage, setShowLockedMessage] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // Used to force re-initialization after reset

  // Import Groups state
  const [importGroups, setImportGroups] = useState<ImportGroup[]>([]);
  const [selectedImportGroup, setSelectedImportGroup] = useState<string>('');
  const [loadingImportGroups, setLoadingImportGroups] = useState(false);
  const selectedOU = useSettingsStore((s) => s.selectedHotelOu);
  const setSelectedPeriodGlobal = useSettingsStore((s) => s.setSelectedPeriod);
  const globalSelectedPeriod = useSettingsStore((s) => s.selectedPeriod);
  const [hotels, setHotels] = useState<any[]>([]);

  // Upload Periods state (required for imports - must be set before importing)
  const [uploadPeriods, setUploadPeriods] = useState<UploadPeriod[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<string>(globalSelectedPeriod || '');
  const [loadingUploadPeriods, setLoadingUploadPeriods] = useState(false);

  // Sequential processing state
  const [currentProcessingId, setCurrentProcessingId] = useState<string | null>(null);
  const [currentActiveIndex, setCurrentActiveIndex] = useState(0); // Track which import is currently active
  const [completedImports, setCompletedImports] = useState<Set<string>>(new Set()); // Track completed imports

  // Error notification state
  const [errorSnackbar, setErrorSnackbar] = useState<{ open: boolean; message: string }>({ open: false, message: '' });

  // Cache status state
  const [dataFreshness, setDataFreshness] = useState<'cached' | 'fresh' | 'fetching'>('cached');

  // Block navigation only when data has actually been written to staging (processing/complete)
  // but hasn't been finalized yet. Users just browsing or who already completed can leave freely.
  const hasUnsavedImportWork = !importCompleted &&
    importFiles.some(f => f.status === ImportStatus.Complete || f.status === ImportStatus.Processing);
  const blocker = useBlocker(hasUnsavedImportWork);

  // Check if imports are already completed for this OU
  // refreshKey is included to re-run this effect after a reset
  useEffect(() => {
    const checkImportState = async () => {
      if (!selectedOU) return;

      try {
        // @ts-ignore
        const result = await window.ipcApi.sendIpcRequest('db:get-import-completed-state', { ou: selectedOU });
        if (result?.success) {
          const isCompleted = result.data as boolean;
          setImportCompleted(isCompleted);
          if (isCompleted) {
            setShowLockedMessage(true);
          } else {
            setShowLockedMessage(false);
          }
        }
      } catch (error) {
        console.error('Failed to check import state:', error);
      }
    };

    checkImportState();
  }, [selectedOU, refreshKey]);

  // Fetch upload periods when OU is selected or changes
  useEffect(() => {
    const fetchUploadPeriods = async () => {
      if (!selectedOU) return;

      setLoadingUploadPeriods(true);

      try {
        // Fetch all periods (including locked ones) to show them with indicators
        const allPeriods = await uploadPeriodsService.getUploadPeriods(selectedOU, true);
        setUploadPeriods(allPeriods);

        // Try to load the saved period for this OU from SQLite
        // @ts-ignore
        const savedPeriodResult = await window.ipcApi.sendIpcRequest('db:get-selected-period-for-ou', { ou: selectedOU });
        if (savedPeriodResult?.success && savedPeriodResult.data) {
          const savedPeriod = savedPeriodResult.data as string;
          // Only use the saved period if it's still available in the list
          const periodExists = allPeriods.some(p => p.period === savedPeriod);
          if (periodExists) {
            setSelectedPeriod(savedPeriod);
            setSelectedPeriodGlobal(savedPeriod);
          } else {
            // Saved period no longer available, clear it
            setSelectedPeriod('');
            setSelectedPeriodGlobal(null);
          }
        } else {
          // No saved period, clear the selection
          setSelectedPeriod('');
          setSelectedPeriodGlobal(null);
        }
      } catch (error) {
        console.error('Failed to fetch upload periods:', error);
        setUploadPeriods([]);
        setSelectedPeriod('');
        setSelectedPeriodGlobal(null);
      } finally {
        setLoadingUploadPeriods(false);
      }
    };

    fetchUploadPeriods();
  }, [selectedOU, setSelectedPeriodGlobal, refreshKey]);

  // Sync local period state with global settings store
  useEffect(() => {
    if (globalSelectedPeriod && globalSelectedPeriod !== selectedPeriod) {
      setSelectedPeriod(globalSelectedPeriod);
    }
  }, [globalSelectedPeriod]);

  // Fetch import groups when OU is selected or changes
  useEffect(() => {
    const fetchImportGroups = async () => {
      if (!selectedOU) return;

      // Reset import group selection when hotel changes
      setSelectedImportGroup('');

      try {
        // Use cache-first strategy: load cached data immediately, then fetch fresh in background
        setDataFreshness('fetching');

        const groups = await importConfigService.getImportGroupsCacheFirst(
          selectedOU,
          // Callback when fresh data arrives
          (freshGroups) => {
            // console.log('Fresh import groups received, updating UI...');
            setImportGroups(freshGroups);
            setDataFreshness('fresh');

            // Update selected group if needed
            if (freshGroups.length > 0 && !selectedImportGroup) {
              const uniqueGroups = importConfigService.getUniqueGroupNames(freshGroups);
              setSelectedImportGroup(uniqueGroups[0]);
            }

            // Auto-hide "fresh" indicator after 3 seconds
            setTimeout(() => {
              setDataFreshness('cached');
            }, 3000);
          }
        );

        // Set initial data from cache (or empty if no cache)
        setImportGroups(groups);

        // Set the first group as default if we have data
        if (groups.length > 0) {
          const uniqueGroups = importConfigService.getUniqueGroupNames(groups);
          setSelectedImportGroup(uniqueGroups[0]);
          setLoadingImportGroups(false);
          setDataFreshness('cached'); // Data is from cache
        } else {
          // No cached data, need to wait for fresh fetch
          setLoadingImportGroups(true);

          // Trigger a fresh fetch since cache is empty
          try {
            const freshGroups = await importConfigService.fetchAndSyncImportGroups(selectedOU);
            setImportGroups(freshGroups);
            if (freshGroups.length > 0) {
              const uniqueGroups = importConfigService.getUniqueGroupNames(freshGroups);
              setSelectedImportGroup(uniqueGroups[0]);
            }
            setDataFreshness('fresh');
            setTimeout(() => setDataFreshness('cached'), 3000);
          } catch (error) {
            console.error('Failed to fetch import groups:', error);
          } finally {
            setLoadingImportGroups(false);
          }
        }
      } catch (error) {
        console.error('Error in fetchImportGroups:', error);
        setLoadingImportGroups(false);
        setDataFreshness('cached');
      }
    };

    fetchImportGroups();
  }, [selectedOU]);

  // Update import files when import group is selected
  useEffect(() => {
    if (selectedImportGroup && importGroups.length > 0) {
      const imports = importConfigService.getImportsByGroup(importGroups, selectedImportGroup);

      // Convert imports to ImportFile format
      // Use a combination of import name and index to ensure unique IDs
      const files: ImportFile[] = imports.map((imp, index) => ({
        id: `${imp.name}_${index}_${Date.now()}`, // Ensure unique ID even for duplicate names
        name: imp.name, // Keep the original import name for IPC calls
        displayName: imp.displayName,
        description: imp.description,
        fileTypes: imp.fileTypes,
        required: imp.required,
        order: imp.order,
        requiredColumns: imp.requiredColumns,
        optionalColumns: imp.optionalColumns,
        validationRules: imp.validationRules,
        status: ImportStatus.Pending,
      }));

      setImportFiles(files);
    }
  }, [selectedImportGroup, importGroups]);

  // Fetch initial data on mount
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        setLoading(true);

        let hasCachedHotels = false;

        // Load from cache first and unblock the page immediately
        try {
          // @ts-ignore
          const cachedResult = await window.ipcApi.sendIpcRequest('db:get-cached-hotels');

          if (cachedResult?.success && cachedResult.data) {
            const hotelsList = JSON.parse(cachedResult.data);
            if (hotelsList.length > 0) {
              setHotels(hotelsList);
              hasCachedHotels = true;
            }
          }
        } catch (error) {
          console.error('Failed to get cached hotels:', error);
        }

        // If cache had hotels, unblock the page now and refresh in the background
        if (hasCachedHotels) {
          setLoading(false);
        }

        // Refresh hotels from API (blocking on fresh install, background otherwise)
        try {
          const freshHotels = await authService.getHotels();
          if (freshHotels.length > 0) {
            setHotels(freshHotels);
          }
        } catch (error) {
          console.error('Failed to fetch fresh hotels:', error);
        }

        // Always unblock after API attempt completes
        setLoading(false);
      } catch (error) {
        console.error('Failed to load initial data:', error);
        setLoading(false);
      }
    };

    fetchInitialData();
  }, []);

  // Handle file selection from ImportCard
  const handleFileSelect = useCallback((importId: string, file: File) => {
    // console.log(`File selected for import ${importId}:`, file.name);
    // The ImportCard component handles its own state
    // We just track the overall session status here
  }, []);

  // Handle file removal from ImportCard
  const handleRemoveFile = useCallback((importId: string) => {
    // console.log(`File removed for import ${importId}`);
    // The ImportCard component handles its own state
  }, []);

  // Create import session when first import starts
  const createImportSession = useCallback(async () => {
    if (currentImportSessionId !== null || !selectedPeriod || !selectedOU || !selectedImportGroup) {
      return; // Session already created or missing required data
    }

    try {
      // Parse the period (format: "YYYY-MM")
      const [year, month] = selectedPeriod.split('-').map(Number);

      // @ts-ignore
      const result = await window.ipcApi.sendIpcRequest('db:create-import-session', {
        ou: selectedOU,
        import_group_name: selectedImportGroup,
        year: year,
        month: month,
        period_combo: selectedPeriod,
      });

      if (result && result.success && result.data) {
        const sessionId = result.data as number;
        setCurrentImportSessionId(sessionId);
        // console.log(`Import session created: ${sessionId} for period ${selectedPeriod}`);
      }
    } catch (error) {
      console.error('Failed to create import session:', error);
    }
  }, [currentImportSessionId, selectedPeriod, selectedOU, selectedImportGroup]);

  // Handle status change from ImportCard
  const handleStatusChange = useCallback(async (importId: string, status: ImportStatus, additionalData?: { fileName?: string; rowCount?: number; error?: string }) => {
    // console.log(`Status changed for import ${importId}:`, status, additionalData);
    setImportFiles(prev =>
      prev.map(file =>
        file.id === importId
          ? {
              ...file,
              status,
              ...additionalData,
              // Explicitly clear error on success
              error: status === ImportStatus.Complete ? undefined : additionalData?.error
            }
          : file
      )
    );

    // Show error snackbar if status is Failed
    if (status === ImportStatus.Failed && additionalData?.error) {
      setErrorSnackbar({ open: true, message: additionalData.error });
    }

    // Create import session when first import starts processing
    if (status === ImportStatus.Processing && !importSessionStarted) {
      await createImportSession();
    }

    // Handle completion and unlock next import
    if (status === ImportStatus.Complete) {
      // Add to completed set
      setCompletedImports(prev => new Set(prev).add(importId));

      // Find and activate next import in sequence
      const sortedImports = [...importFiles].sort((a, b) => a.order - b.order);
      const currentIndex = sortedImports.findIndex(f => f.id === importId);
      const nextImport = sortedImports[currentIndex + 1];

      if (nextImport) {
        // Move to next import
        setCurrentProcessingId(nextImport.id);
        setCurrentActiveIndex(currentIndex + 1);
        setIsProcessing(false); // Allow the next import to be processed
      } else {
        // All imports complete
        setCurrentProcessingId(null);
        setSessionStatus('complete');
        setImportSessionStarted(false);
        setIsProcessing(false);
        setCurrentActiveIndex(-1);
      }

      // Check if all required imports are complete
      const allRequiredComplete = importFiles
        .filter(f => f.required)
        .every(f => f.id === importId || f.status === ImportStatus.Complete || completedImports.has(f.id));

      if (allRequiredComplete && !nextImport) {
        setSessionStatus('complete');
        setImportSessionStarted(false);
        setIsProcessing(false);

        // Update import session status to completed
        if (currentImportSessionId !== null) {
          try {
            // @ts-ignore
            await window.ipcApi.sendIpcRequest('db:update-import-session-status', {
              sessionId: currentImportSessionId,
              status: 'completed',
            });
            // console.log(`Import session ${currentImportSessionId} marked as completed`);
          } catch (error) {
            console.error('Failed to update import session status:', error);
          }
        }
      }
    } else if (status === ImportStatus.Processing) {
      // Set as processing
      setIsProcessing(true);
      setCurrentProcessingId(importId);
    } else if (status === ImportStatus.Failed) {
      // Stop processing on failure
      setIsProcessing(false);
      // Keep the current import active for retry

      // Update import session status to failed
      if (currentImportSessionId !== null) {
        try {
          // @ts-ignore
          await window.ipcApi.sendIpcRequest('db:update-import-session-status', {
            sessionId: currentImportSessionId,
            status: 'failed',
          });
          // console.log(`Import session ${currentImportSessionId} marked as failed`);
        } catch (error) {
          console.error('Failed to update import session status:', error);
        }
      }
    }
  }, [importFiles, completedImports, currentImportSessionId]);

  // Handle restart
  const handleRestart = useCallback(async () => {
    // Use the unified reset function to clear all completion states and cached data
    if (selectedOU) {
      try {
        // @ts-ignore
        await window.ipcApi.sendIpcRequest('db:reset-all-completion-states', { ou: selectedOU });
        setImportCompleted(false);
        setShowLockedMessage(false);
      } catch (error) {
        console.error('Failed to reset completion states:', error);
      }
    }

    setImportFiles(prev =>
      prev.map(imp => ({
        ...imp,
        file: undefined as File | undefined,
        fileName: undefined as string | undefined,
        status: ImportStatus.Pending,
        rowCount: undefined as number | undefined,
        error: undefined as string | undefined,
      }))
    );
    setImportSessionStarted(false);
    setSessionStatus('idle');
    setIsProcessing(false);
    setCurrentProcessingId(null);
    setCurrentActiveIndex(0);
    setCompletedImports(new Set());
    setCurrentImportSessionId(null); // Clear the import session ID for a fresh start

    // Increment refreshKey to force re-initialization of useEffects
    setRefreshKey(prev => prev + 1);
  }, [selectedOU]);

  // Handle restart (all hotels / entire staging table)
  const handleRestartAllHotels = useCallback(async () => {
    try {
      // @ts-ignore
      await window.ipcApi.sendIpcRequest('db:reset-all-completion-states-all-ous', {});
      setImportCompleted(false);
      setShowLockedMessage(false);
    } catch (error) {
      console.error('Failed to reset completion states for all OUs:', error);
    }

    setImportFiles(prev =>
      prev.map(imp => ({
        ...imp,
        file: undefined as File | undefined,
        fileName: undefined as string | undefined,
        status: ImportStatus.Pending,
        rowCount: undefined as number | undefined,
        error: undefined as string | undefined,
      }))
    );
    setImportSessionStarted(false);
    setSessionStatus('idle');
    setIsProcessing(false);
    setCurrentProcessingId(null);
    setCurrentActiveIndex(0);
    setCompletedImports(new Set());
    setCurrentImportSessionId(null);
    setRefreshKey(prev => prev + 1);
  }, []);

  // Handle start import session or validate import
  const handleStartImport = useCallback(async () => {
    // Check if all imports are complete
    const allComplete = importFiles.every(f => f.status === ImportStatus.Complete);

    if (allComplete && !importCompleted) {
      // Mark imports as completed and show locked state
      if (selectedOU) {
        try {
          // @ts-ignore
          await window.ipcApi.sendIpcRequest('db:set-import-completed-state', { ou: selectedOU, completed: true });
          setImportCompleted(true);
          setShowLockedMessage(true);
        } catch (error) {
          console.error('Failed to set import completed state:', error);
        }
      }
    } else {
      // Normal import start
      setImportSessionStarted(true);
      setSessionStatus('importing');
      setIsProcessing(false); // Don't block the first import

      // In sequential mode, set the first import as current
      const sortedImports = [...importFiles].sort((a, b) => a.order - b.order);
      if (sortedImports.length > 0) {
        setCurrentProcessingId(sortedImports[0].id);
        setCurrentActiveIndex(0);
      }
    }
  }, [importFiles, importCompleted, selectedOU]);

  // Stats calculation
  const stats = {
    completed: importFiles.filter((f) => f.status === ImportStatus.Complete).length,
    total: importFiles.length,
    uploaded: importFiles.filter((f) => f.fileName).length,
  };

  const allImportsComplete = importFiles.every(f => f.status === ImportStatus.Complete);
  const canStartImport =
    importFiles.filter((f) => f.required).every((f) => f.fileName) &&
    !importSessionStarted;
  const canCompleteImport = allImportsComplete && !importCompleted;

  if (loading) {
    return (
      <PageContainer>
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
          <CircularProgress />
        </Box>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header Section */}
      <HeaderCard>
        <CardContent sx={{ p: 2.5 }}>
          <Stack direction={isMobile ? 'column' : 'row'} alignItems="flex-start" justifyContent="space-between" spacing={2}>
            <Box>
              <Typography
                variant="h5"
                fontWeight={800}
                sx={{
                  background: `linear-gradient(135deg, #667eea, #764ba2)`,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontSize: { xs: '1.25rem', sm: '1.5rem' },
                }}
              >
                Import Data
              </Typography>
              <Typography variant="body2" color="text.secondary" fontWeight={500} fontSize="0.8rem">
                Upload and process your data files
              </Typography>
            </Box>

            {/* Stats */}
            <Stack direction="row" spacing={2}>
              <Box textAlign="center">
                <Typography variant="h6" fontWeight={700} color="primary">
                  {stats.completed}
                </Typography>
                <Typography variant="caption" color="text.secondary" fontSize="0.7rem">
                  Completed
                </Typography>
              </Box>
              <Divider orientation="vertical" flexItem />
              <Box textAlign="center">
                <Typography variant="h6" fontWeight={700}>
                  {stats.total}
                </Typography>
                <Typography variant="caption" color="text.secondary" fontSize="0.7rem">
                  Total Files
                </Typography>
              </Box>
            </Stack>
          </Stack>
        </CardContent>
      </HeaderCard>

      {/* Locked State Message - Top of Page */}
      {importCompleted && showLockedMessage && (
        <Alert
          severity="warning"
          onClose={() => setShowLockedMessage(false)}
          sx={{
            mb: 2,
            borderRadius: 3,
            border: `1px solid ${alpha(theme.palette.warning.main, 0.3)}`,
          }}
        >
          <Typography variant="body2" fontWeight={600} mb={0.5}>
            Import Session Locked
          </Typography>
          <Typography variant="caption" color="text.secondary">
            This import session has been completed and locked. To start a new import, click "Reset Imports" below.
          </Typography>
        </Alert>
      )}

      {/* Import Groups and Period Selector */}
      <Card
        sx={{
          mb: 2,
          borderRadius: 3,
          background: alpha(theme.palette.background.paper, 0.7),
          backdropFilter: 'blur(20px)',
          border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
        }}
      >
        <CardContent sx={{ p: 2 }}>
          <Stack direction={isMobile ? 'column' : 'row'} spacing={2} alignItems="center">
            {/* Import Group selector */}
            <FormControl fullWidth={isMobile} sx={{ minWidth: 200 }}>
              <InputLabel id="import-group-select-label">Import Group</InputLabel>
              <Select
                labelId="import-group-select-label"
                id="import-group-select"
                value={selectedImportGroup}
                label="Import Group"
                onChange={(event: SelectChangeEvent) => {
                  setSelectedImportGroup(event.target.value);
                }}
                disabled={loadingImportGroups || importSessionStarted || importCompleted}
              >
                {importConfigService.getUniqueGroupNames(importGroups).map((groupName) => (
                  <MenuItem key={groupName} value={groupName}>
                    {groupName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Upload Period selector */}
            <FormControl
              fullWidth={isMobile}
              sx={{ minWidth: 180 }}
              required
              error={selectedPeriod === '' && importFiles.length > 0}
            >
              <InputLabel id="period-select-label">Upload Period *</InputLabel>
              <Select
                labelId="period-select-label"
                id="period-select"
                value={selectedPeriod}
                label="Upload Period *"
                onChange={async (event: SelectChangeEvent) => {
                  const newPeriod = event.target.value;
                  setSelectedPeriod(newPeriod);
                  // Also save to global settings store so it's available on other pages
                  setSelectedPeriodGlobal(newPeriod || null);
                  // Persist the period per OU to SQLite
                  if (selectedOU) {
                    try {
                      // @ts-ignore
                      await window.ipcApi.sendIpcRequest('db:set-selected-period-for-ou', {
                        ou: selectedOU,
                        period: newPeriod || null
                      });
                    } catch (error) {
                      console.error('Failed to save selected period:', error);
                    }
                  }
                }}
                disabled={loadingUploadPeriods || importSessionStarted || importCompleted}
              >
                <MenuItem value="" disabled>
                  <em>Select Period</em>
                </MenuItem>
                {uploadPeriods.map((period) => (
                  <MenuItem
                    key={period.id}
                    value={period.period}
                    disabled={period.is_locked}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      {period.is_locked && (
                        <LockIcon sx={{ fontSize: 16, color: 'warning.main' }} />
                      )}
                      <Typography variant="body2">
                        {period.period}
                      </Typography>
                      {period.is_locked && (
                        <Typography variant="caption" color="text.secondary">
                          (Locked)
                        </Typography>
                      )}
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Loading and Info Display */}
            {(loadingImportGroups || loadingUploadPeriods) && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={20} />
                <Typography variant="body2" color="text.secondary">
                  Loading...
                </Typography>
              </Stack>
            )}

            {!loadingImportGroups && !loadingUploadPeriods && selectedImportGroup && (
              <Box flex={isMobile ? undefined : 1}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" color="text.secondary">
                    {importFiles.length} imports • {importFiles.filter(f => f.required).length} required
                    {selectedPeriod && ` • Period: ${selectedPeriod}`}
                  </Typography>
                  {dataFreshness === 'fresh' && (
                    <Fade in>
                      <Typography
                        variant="caption"
                        sx={{
                          color: 'success.main',
                          fontWeight: 600,
                          fontSize: '0.7rem'
                        }}
                      >
                        ✓ Updated
                      </Typography>
                    </Fade>
                  )}
                  {dataFreshness === 'fetching' && (
                    <CircularProgress size={12} />
                  )}
                </Stack>
              </Box>
            )}
          </Stack>
        </CardContent>
      </Card>

      {/* Status Banner */}
      {sessionStatus !== 'idle' && (
        <Fade in>
          <Alert
            severity={sessionStatus === 'complete' ? 'success' : 'info'}
            icon={
              sessionStatus === 'complete' ? (
                <CheckCircleIcon />
              ) : (
                <RefreshIcon sx={{ animation: `${pulse} 1.5s ease-in-out infinite` }} />
              )
            }
            sx={{
              mb: 3,
              borderRadius: 3,
              fontSize: '0.95rem',
              fontWeight: 600,
            }}
          >
            {sessionStatus === 'complete'
              ? 'Import complete! All data has been successfully processed.'
              : 'Processing imports...'}
          </Alert>
        </Fade>
      )}

      {/* Import Cards */}
      {selectedImportGroup && importFiles.length > 0 ? (
        <Stack spacing={2} mb={3} sx={{ pl: 7, position: 'relative' }}>
          {importFiles
            .sort((a, b) => a.order - b.order)
            .map((importFile, idx) => {
              // Check if period is selected (required for all imports)
              const isPeriodSelected = selectedPeriod !== '';

              // Determine if this card should be locked and next in line
              let isLocked = false;
              let isNextInLine = false;

              // If period is not selected, lock ALL imports
              if (!isPeriodSelected) {
                isLocked = true;
                isNextInLine = false;
              } else if (importSessionStarted) {
                // Sequential mode: lock all cards except the current active one
                if (importFile.status === ImportStatus.Complete) {
                  // Completed imports stay locked
                  isLocked = true;
                } else if (currentProcessingId === importFile.id) {
                  // Current active import is unlocked and marked as next
                  isLocked = false;
                  isNextInLine = true;
                } else {
                  // All other imports are locked
                  isLocked = true;
                }
              } else {
                // Before starting import session, enforce sequential order
                // Only the first incomplete import should be unlocked
                const sortedImports = [...importFiles].sort((a, b) => a.order - b.order);

                // Find the first import that isn't complete
                const firstIncompleteIndex = sortedImports.findIndex(f => f.status !== ImportStatus.Complete);

                if (firstIncompleteIndex !== -1) {
                  // Lock all imports except the first incomplete one
                  isLocked = sortedImports[firstIncompleteIndex].id !== importFile.id;
                  isNextInLine = sortedImports[firstIncompleteIndex].id === importFile.id;
                } else {
                  // All imports are complete, lock everything
                  isLocked = true;
                }
              }

              return (
                <Box
                  key={importFile.id}
                  sx={{ position: 'relative', mb: idx < importFiles.length - 1 ? 2 : 0 }}
                >
                  {/* Step indicator */}
                  <Box
                    sx={{
                      position: 'absolute',
                      left: -50,
                      top: 16, // Fixed offset from top of card
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: importFile.status === ImportStatus.Complete
                        ? theme.palette.success.main
                        : isNextInLine
                        ? theme.palette.primary.main
                        : alpha(theme.palette.action.disabled, 0.12),
                      color: importFile.status === ImportStatus.Complete || isNextInLine
                        ? 'white'
                        : theme.palette.text.disabled,
                      fontWeight: 700,
                      fontSize: '0.875rem',
                      border: `2px solid ${
                        importFile.status === ImportStatus.Complete
                          ? theme.palette.success.dark
                          : isNextInLine
                          ? theme.palette.primary.dark
                          : 'transparent'
                      }`,
                      boxShadow: isNextInLine
                        ? `0 0 0 4px ${alpha(theme.palette.primary.main, 0.2)}`
                        : 'none',
                    }}
                  >
                    {importFile.status === ImportStatus.Complete ? (
                      <CheckCircleIcon sx={{ fontSize: 18 }} />
                    ) : (
                      idx + 1
                    )}
                  </Box>

                  {/* Connecting line */}
                  {idx < importFiles.length - 1 && (
                    <Box
                      sx={{
                        position: 'absolute',
                        left: -35,
                        top: 48, // Start even further down from the circle
                        height: 'calc(100% - 24px)', // Reduced height to compensate for the lower starting point
                        width: 2,
                        background: idx < completedImports.size
                          ? theme.palette.success.main
                          : alpha(theme.palette.divider, 0.3),
                        zIndex: -1,
                      }}
                    />
                  )}

                  <ImportCard
                    importFile={importFile}
                    importProcessorName={importFile.name} // Use the original import name for IPC
                    onFileSelect={handleFileSelect}
                    onRemoveFile={handleRemoveFile}
                    onStatusChange={handleStatusChange}
                    isProcessing={isProcessing && currentProcessingId === importFile.id}
                    isLocked={isLocked}
                    isNextInLine={isNextInLine}
                    importOptions={{
                      ou: selectedOU,
                      year: selectedPeriod ? Number(selectedPeriod.split('-')[0]) : undefined,
                      month: selectedPeriod ? Number(selectedPeriod.split('-')[1]) : undefined,
                      localId1: hotels.find(h => h.ou === selectedOU)?.local_id_1
                    }}
                  />
                </Box>
              );
            })}
        </Stack>
      ) : (
        <Card
          sx={{
            mb: 3,
            borderRadius: 3,
            background: alpha(theme.palette.background.paper, 0.5),
            border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
            textAlign: 'center',
            p: 4,
          }}
        >
          <Typography variant="body1" color="text.secondary">
            {loadingImportGroups ? 'Loading import groups...' : 'Please select an import group to begin'}
          </Typography>
        </Card>
      )}

      {/* Action Buttons */}
      {!importCompleted ? (
        <Stack
          direction={isMobile ? 'column' : 'row'}
          spacing={2}
          justifyContent="flex-end"
          sx={{
            position: 'sticky',
            bottom: 16,
            background: alpha(theme.palette.background.default, 0.8),
            backdropFilter: 'blur(20px)',
            p: 2,
            borderRadius: 3,
            border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
          }}
        >
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={handleRestart}
            disabled={isProcessing}
            fullWidth={isMobile}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
            }}
          >
            Restart Import
          </Button>

          <Button
            variant="contained"
            startIcon={allImportsComplete ? <CheckCircleIcon /> : <TaskAltIcon />}
            onClick={handleStartImport}
            disabled={(!canStartImport && !canCompleteImport) || isProcessing}
            fullWidth={isMobile}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
              background: 'linear-gradient(135deg, #667eea, #764ba2)',
              '&:hover': {
                background: 'linear-gradient(135deg, #764ba2, #667eea)',
              },
            }}
          >
            Complete Import
          </Button>
        </Stack>
      ) : (
        <Stack spacing={2}>
          <Alert
            severity="success"
            icon={<CheckCircleIcon />}
            sx={{
              borderRadius: 3,
              background: alpha(theme.palette.success.main, 0.1),
              border: `1px solid ${alpha(theme.palette.success.main, 0.3)}`,
            }}
          >
            <Typography variant="body1" fontWeight={600} mb={0.5}>
              Data Import Stage Completed
            </Typography>
            <Typography variant="body2" color="text.secondary">
              All data has been successfully imported. You can now proceed to the Validations stage to run data checks.
            </Typography>
          </Alert>

          <Stack
            direction={isMobile ? 'column' : 'row'}
            spacing={2}
            justifyContent="center"
            sx={{
              position: 'sticky',
              bottom: 16,
              background: alpha(theme.palette.background.default, 0.8),
              backdropFilter: 'blur(20px)',
              p: 2,
              borderRadius: 3,
              border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
            }}
          >
            <Button
              variant="contained"
              color="warning"
              startIcon={<LockIcon />}
              onClick={() => setShowResetConfirmModal(true)}
              fullWidth={isMobile}
              sx={{
                borderRadius: 2,
                textTransform: 'none',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Reset Current Hotel Only
            </Button>
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteSweepIcon />}
              onClick={() => setShowResetAllHotelsModal(true)}
              fullWidth={isMobile}
              sx={{
                borderRadius: 2,
                textTransform: 'none',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Reset Entire Staging Table
            </Button>
          </Stack>
        </Stack>
      )}

      {/* Info Section */}
      <Box mt={3}>
        <Alert
          severity="info"
          icon={<InfoIcon />}
          sx={{
            borderRadius: 3,
            background: alpha(theme.palette.info.main, 0.05),
            border: `1px solid ${alpha(theme.palette.info.main, 0.2)}`,
          }}
        >
          <Typography variant="body2" fontWeight={600} mb={1}>
            Import Process
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            • Files are processed using the import processor system<br />
            • Test imports use quick row counting without validation<br />
            • Required files must be uploaded before starting import<br />
            • Each import includes validation and processing steps
          </Typography>
        </Alert>
      </Box>

      {/* Error Notification Snackbar */}
      <Snackbar
        open={errorSnackbar.open}
        autoHideDuration={8000}
        onClose={() => setErrorSnackbar({ open: false, message: '' })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          onClose={() => setErrorSnackbar({ open: false, message: '' })}
          severity="error"
          variant="filled"
          sx={{
            maxWidth: 600,
            boxShadow: 8,
          }}
        >
          <Typography variant="caption" sx={{ fontSize: '0.7rem' }}>
            {errorSnackbar.message}
          </Typography>
        </Alert>
      </Snackbar>

      {/* Reset Current Hotel Confirmation Modal */}
      <Dialog
        open={showResetConfirmModal}
        onClose={() => setShowResetConfirmModal(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 600, color: 'warning.main' }}>
          Reset Current Hotel Only?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            <Typography variant="body1" color="text.secondary" mb={2}>
              Are you sure you want to reset the current hotel? This will:
            </Typography>
            <Typography variant="body2" color="text.secondary" component="ul" sx={{ pl: 2 }}>
              <li>Clear imported data from the staging table for the currently selected hotel only</li>
              <li>Reset import, validation, and sign-off completion states for this hotel</li>
              <li>Clear all validation results for this hotel</li>
              <li>Require you to re-import all data and re-run validations for this hotel</li>
            </Typography>
            <Typography variant="body2" color="error.main" mt={2} fontWeight={600}>
              This action cannot be undone. Other hotels will not be affected.
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button
            variant="outlined"
            onClick={() => setShowResetConfirmModal(false)}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              setShowResetConfirmModal(false);
              handleRestart();
            }}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Yes, Reset Current Hotel
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reset Entire Staging Table Confirmation Modal */}
      <Dialog
        open={showResetAllHotelsModal}
        onClose={() => setShowResetAllHotelsModal(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 600, color: 'error.main' }}>
          Reset Entire Staging Table?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            <Typography variant="body1" color="text.secondary" mb={2}>
              Are you sure you want to reset the entire staging table? This will:
            </Typography>
            <Typography variant="body2" color="text.secondary" component="ul" sx={{ pl: 2 }}>
              <li>Clear all imported data from the staging table for ALL hotels</li>
              <li>Reset import, validation, and sign-off completion states for all hotels</li>
              <li>Clear all validation results for all hotels</li>
              <li>Require you to re-import all data and re-run validations for every hotel</li>
            </Typography>
            <Typography variant="body2" color="error.main" mt={2} fontWeight={600}>
              This action cannot be undone. All hotels will be affected.
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button
            variant="outlined"
            onClick={() => setShowResetAllHotelsModal(false)}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              setShowResetAllHotelsModal(false);
              handleRestartAllHotels();
            }}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Yes, Reset All Hotels
          </Button>
        </DialogActions>
      </Dialog>
      {/* Leave Page Confirmation Dialog */}
      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 600, color: 'warning.main' }}>
          Leave Import Page?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            <Typography variant="body1" color="text.secondary" mb={2}>
              You have an import session in progress that hasn't been validated yet.
              Leaving now will reset your import progress to prevent duplicate data.
            </Typography>
            <Typography variant="body2" color="text.secondary" component="ul" sx={{ pl: 2 }}>
              <li>All imported data in the staging table will be cleared</li>
              <li>You will need to re-import your files when you return</li>
            </Typography>
            <Typography variant="body2" color="error.main" mt={2} fontWeight={600}>
              To keep your progress, stay on this page and click "Complete Import" after all imports finish.
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button
            variant="contained"
            onClick={() => blocker.reset?.()}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Stay on Page
          </Button>
          <Button
            variant="outlined"
            color="warning"
            onClick={async () => {
              await handleRestart();
              blocker.proceed?.();
            }}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Leave & Reset
          </Button>
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
};

export default DataImport;
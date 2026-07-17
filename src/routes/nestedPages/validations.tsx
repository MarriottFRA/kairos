/**
 * Validations Page
 * ================
 *
 * Manages data validation checks for imported data.
 * Displays validation requirements from API and executes them via IPC.
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
  LinearProgress,
  Chip,
  Collapse,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Tooltip,
} from '@mui/material';
import { styled, useTheme } from '@mui/material/styles';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Warning as WarningIcon,
  PlayArrow as PlayArrowIcon,
  Refresh as RefreshIcon,
  ExpandMore as ExpandMoreIcon,
  Info as InfoIcon,
  Lock as LockIcon,
  Assignment as AssignmentIcon,
  HourglassEmpty as HourglassEmptyIcon,
  CheckCircleOutline as CheckCircleOutlineIcon,
  DeleteSweep as DeleteSweepIcon,
} from '@mui/icons-material';
import validationService, { Validation } from '../../services/validationService';
import validationOverrideService, { ValidationOverrideStatus } from '../../services/validationOverrideService';
import { useSettingsStore } from '../../store/settings';
import { useNavigate } from 'react-router-dom';

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

const ValidationCard = styled(Card)(({ theme }) => ({
  borderRadius: 12,
  background: alpha(theme.palette.background.paper, 0.7),
  backdropFilter: 'blur(20px)',
  border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
  transition: 'all 0.3s ease',
  '&:hover': {
    transform: 'translateY(-2px)',
    boxShadow: theme.palette.mode === 'dark'
      ? `0 8px 24px ${alpha('#000000', 0.3)}`
      : `0 8px 24px ${alpha('#8b5cf6', 0.1)}`,
  },
}));

// ────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────

interface ValidationResult {
  status: 'idle' | 'running' | 'success' | 'warning' | 'error';
  errors?: string[];
  warnings?: string[];
  recordCount?: number;
  expanded?: boolean;
}

interface OverrideRequestDialogState {
  open: boolean;
  validationName: string;
  displayName: string;
}

// ────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────

const Validations: React.FC = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();

  // State
  const [loading, setLoading] = useState(true);
  const [validations, setValidations] = useState<Validation[]>([]);
  const [validationResults, setValidationResults] = useState<Map<string, ValidationResult>>(new Map());
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [dataFreshness, setDataFreshness] = useState<'cached' | 'fresh' | 'fetching'>('cached');
  const [importCompleted, setImportCompleted] = useState(false);
  const [showAccessDeniedModal, setShowAccessDeniedModal] = useState(false);
  const [validationCompleted, setValidationCompleted] = useState(false);
  const [showResetConfirmModal, setShowResetConfirmModal] = useState(false);
  const [showResetAllHotelsModal, setShowResetAllHotelsModal] = useState(false);

  // Override state
  const [overrideStatuses, setOverrideStatuses] = useState<Map<string, ValidationOverrideStatus>>(new Map());
  const [overrideRequestDialog, setOverrideRequestDialog] = useState<OverrideRequestDialogState>({
    open: false,
    validationName: '',
    displayName: '',
  });
  const [overrideReason, setOverrideReason] = useState('');
  const [submittingOverride, setSubmittingOverride] = useState(false);
  const [checkingOverrideStatus, setCheckingOverrideStatus] = useState(false);

  const selectedOU = useSettingsStore((s) => s.selectedHotelOu);
  const selectedPeriod = useSettingsStore((s) => s.selectedPeriod);
  const setSelectedPeriod = useSettingsStore((s) => s.setSelectedPeriod);

  // Check if imports and validations are completed for this OU
  useEffect(() => {
    const checkCompletionStates = async () => {
      if (!selectedOU) return;

      try {
        // Check import completion
        // @ts-ignore
        const importResult = await window.ipcApi.sendIpcRequest('db:get-import-completed-state', { ou: selectedOU });
        if (importResult?.success) {
          const isImportCompleted = importResult.data as boolean;
          setImportCompleted(isImportCompleted);

          // If imports are not completed, show modal
          if (!isImportCompleted) {
            setShowAccessDeniedModal(true);
          }

          // If imports are completed but no period is selected, try to load it from SQLite or import session
          if (isImportCompleted && !selectedPeriod) {
            try {
              // First try to get the saved period for this OU from SQLite
              // @ts-ignore
              const savedPeriodResult = await window.ipcApi.sendIpcRequest('db:get-selected-period-for-ou', { ou: selectedOU });
              if (savedPeriodResult?.success && savedPeriodResult.data) {
                setSelectedPeriod(savedPeriodResult.data);
              } else {
                // Fall back to getting period from the latest import session
                // @ts-ignore
                const sessionResult = await window.ipcApi.sendIpcRequest('db:get-latest-import-session', { ou: selectedOU });
                if (sessionResult?.success && sessionResult.data?.period_combo) {
                  setSelectedPeriod(sessionResult.data.period_combo);
                }
              }
            } catch (sessionError) {
              console.error('Failed to get period:', sessionError);
            }
          }
        }

        // Check validation completion
        // @ts-ignore
        const validationResult = await window.ipcApi.sendIpcRequest('db:get-validation-completed-state', { ou: selectedOU });
        if (validationResult?.success) {
          const isValidationCompleted = validationResult.data as boolean;
          setValidationCompleted(isValidationCompleted);
        }
      } catch (error) {
        console.error('Failed to check completion states:', error);
      }
    };

    checkCompletionStates();
  }, [selectedOU, selectedPeriod, setSelectedPeriod]);

  // Fetch validations when OU is selected or changes
  useEffect(() => {
    const fetchValidations = async () => {
      if (!selectedOU) {
        setLoading(false);
        return;
      }

      try {
        setDataFreshness('fetching');
        setLoading(true);

        // Use cache-first strategy: load cached data immediately, then fetch fresh in background
        const vals = await validationService.getValidationsCacheFirst(
          selectedOU,
          // Callback when fresh data arrives
          (freshValidations) => {
            // console.log('Fresh validations received, updating UI...');
            setValidations(freshValidations);
            setDataFreshness('fresh');

            // Auto-hide "fresh" indicator after 3 seconds
            setTimeout(() => {
              setDataFreshness('cached');
            }, 3000);
          }
        );

        // Set initial data from cache (or empty if no cache)
        setValidations(vals);

        if (vals.length > 0) {
          // We have cached data
          setDataFreshness('cached');
          setLoading(false);
        } else {
          // No cached data, need to wait for fresh fetch
          // console.log('No cached validations found, fetching from API...');
          try {
            const freshVals = await validationService.fetchAndSyncValidations(selectedOU);
            setValidations(freshVals);
            setDataFreshness('fresh');
            setTimeout(() => setDataFreshness('cached'), 3000);
          } catch (error) {
            console.error('Failed to fetch validations:', error);
            // Set empty array on error
            setValidations([]);
          } finally {
            setLoading(false);
          }
        }
      } catch (error) {
        console.error('Error in fetchValidations:', error);
        setValidations([]);
        setLoading(false);
        setDataFreshness('cached');
      }
    };

    fetchValidations();
  }, [selectedOU]);

  // Run a single validation
  const handleRunValidation = useCallback(async (validation: Validation) => {
    if (!selectedOU) return;

    setValidationResults(prev => {
      const newMap = new Map(prev);
      newMap.set(validation.name, { status: 'running' });
      return newMap;
    });

    try {
      const result = await validationService.runValidation(validation.name, selectedOU);

      let status: ValidationResult['status'] = 'success';
      if (result.errors && result.errors.length > 0) {
        status = 'error';
      } else if (result.warnings && result.warnings.length > 0) {
        status = 'warning';
      }

      setValidationResults(prev => {
        const newMap = new Map(prev);
        newMap.set(validation.name, {
          status,
          errors: result.errors,
          warnings: result.warnings,
          recordCount: result.recordCount,
          expanded: false,
        });
        return newMap;
      });
    } catch (error) {
      setValidationResults(prev => {
        const newMap = new Map(prev);
        newMap.set(validation.name, {
          status: 'error',
          errors: [error instanceof Error ? error.message : 'Unknown error'],
          expanded: false,
        });
        return newMap;
      });
    }
  }, [selectedOU]);

  // Run all validations
  const handleRunAllValidations = useCallback(async () => {
    if (!selectedOU || validations.length === 0) return;

    setIsRunningAll(true);

    // Set all to running
    const runningMap = new Map<string, ValidationResult>();
    validations.forEach(v => {
      runningMap.set(v.name, { status: 'running' });
    });
    setValidationResults(runningMap);

    // Run validations sequentially
    for (const validation of validations) {
      await handleRunValidation(validation);
    }

    setIsRunningAll(false);
  }, [selectedOU, validations, handleRunValidation]);

  // Toggle expansion of validation result
  const handleToggleExpand = useCallback((validationName: string) => {
    setValidationResults(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(validationName);
      if (current) {
        newMap.set(validationName, { ...current, expanded: !current.expanded });
      }
      return newMap;
    });
  }, []);

  // Clear all results
  const handleClearResults = useCallback(() => {
    setValidationResults(new Map());
  }, []);

  // Handle marking validations as done
  const handleMarkAsDone = useCallback(async () => {
    if (!selectedOU) return;

    try {
      // @ts-ignore
      await window.ipcApi.sendIpcRequest('db:set-validation-completed-state', { ou: selectedOU, completed: true });
      setValidationCompleted(true);
      // Navigate to sign-off page
      navigate('/signed-in-landing/sign-off-upload');
    } catch (error) {
      console.error('Failed to mark validations as done:', error);
    }
  }, [selectedOU, navigate]);

  // Handle reset
  const handleReset = useCallback(async () => {
    if (!selectedOU) return;

    try {
      // @ts-ignore
      await window.ipcApi.sendIpcRequest('db:reset-all-completion-states', { ou: selectedOU });
      setValidationCompleted(false);
      setImportCompleted(false);
      setValidationResults(new Map());
      // Navigate back to imports
      navigate('/signed-in-landing/data-import');
    } catch (error) {
      console.error('Failed to reset completion states:', error);
    }
  }, [selectedOU, navigate]);

  // Handle reset (all hotels / entire staging table)
  const handleResetAllHotels = useCallback(async () => {
    try {
      // @ts-ignore
      await window.ipcApi.sendIpcRequest('db:reset-all-completion-states-all-ous', {});
      setValidationCompleted(false);
      setImportCompleted(false);
      setValidationResults(new Map());
      navigate('/signed-in-landing/data-import');
    } catch (error) {
      console.error('Failed to reset completion states for all OUs:', error);
    }
  }, [navigate]);

  // Load override statuses for all required validations
  const loadOverrideStatuses = useCallback(async () => {
    if (!selectedOU || !selectedPeriod) return;

    const requiredValidations = validations.filter(v => v.is_required);
    if (requiredValidations.length === 0) return;

    const contexts = requiredValidations.map(v =>
      validationOverrideService.getContextForValidation(v.name, selectedOU, selectedPeriod)
    );

    try {
      const statusMap = await validationOverrideService.checkMultipleOverrideStatuses(contexts);
      setOverrideStatuses(statusMap);
    } catch (error) {
      console.error('Failed to load override statuses:', error);
    }
  }, [selectedOU, selectedPeriod, validations]);

  // Load override statuses when validations are loaded
  useEffect(() => {
    if (validations.length > 0 && selectedOU && selectedPeriod) {
      loadOverrideStatuses();
    }
  }, [validations, selectedOU, selectedPeriod, loadOverrideStatuses]);

  // Open override request dialog
  const handleOpenOverrideDialog = useCallback((validation: Validation) => {
    setOverrideRequestDialog({
      open: true,
      validationName: validation.name,
      displayName: validation.display_name,
    });
    setOverrideReason('');
  }, []);

  // Close override request dialog
  const handleCloseOverrideDialog = useCallback(() => {
    setOverrideRequestDialog({
      open: false,
      validationName: '',
      displayName: '',
    });
    setOverrideReason('');
  }, []);

  // Submit override request
  const handleSubmitOverrideRequest = useCallback(async () => {
    if (!selectedOU || !selectedPeriod || !overrideRequestDialog.validationName || !overrideReason.trim()) {
      return;
    }

    setSubmittingOverride(true);

    try {
      const context = validationOverrideService.getContextForValidation(
        overrideRequestDialog.validationName,
        selectedOU,
        selectedPeriod
      );

      const result = validationResults.get(overrideRequestDialog.validationName);
      const state = result?.status === 'error' ? 'failed' : result?.status === 'warning' ? 'warning' : 'unknown';

      await validationOverrideService.requestOverride(
        context,
        [{ name: overrideRequestDialog.validationName, state }],
        overrideReason.trim()
      );

      // Refresh override status for this validation
      const status = await validationOverrideService.checkOverrideStatus(context);
      setOverrideStatuses(prev => {
        const newMap = new Map(prev);
        newMap.set(context, status);
        return newMap;
      });

      handleCloseOverrideDialog();
    } catch (error) {
      console.error('Failed to submit override request:', error);
      alert('Failed to submit override request. Please try again.');
    } finally {
      setSubmittingOverride(false);
    }
  }, [selectedOU, selectedPeriod, overrideRequestDialog, overrideReason, validationResults, handleCloseOverrideDialog]);

  // Refresh all override statuses
  const handleRefreshOverrideStatuses = useCallback(async () => {
    if (!selectedOU || !selectedPeriod) return;

    setCheckingOverrideStatus(true);
    try {
      await loadOverrideStatuses();
    } finally {
      setCheckingOverrideStatus(false);
    }
  }, [selectedOU, selectedPeriod, loadOverrideStatuses]);

  // Get override status for a specific validation
  const getOverrideStatusForValidation = useCallback((validationName: string): ValidationOverrideStatus | undefined => {
    if (!selectedOU || !selectedPeriod) return undefined;
    const context = validationOverrideService.getContextForValidation(validationName, selectedOU, selectedPeriod);
    return overrideStatuses.get(context);
  }, [selectedOU, selectedPeriod, overrideStatuses]);

  // Stats calculation and validation checks
  const stats = {
    total: validations.length,
    required: validations.filter(v => v.is_required).length,
    passed: Array.from(validationResults.values()).filter(r => r.status === 'success').length,
    failed: Array.from(validationResults.values()).filter(r => r.status === 'error').length,
    warnings: Array.from(validationResults.values()).filter(r => r.status === 'warning').length,
  };

  // Check if all required validations have passed (or have approved overrides)
  const requiredValidations = validations.filter(v => v.is_required);
  const allRequiredValidationsPassed = requiredValidations.length > 0 && requiredValidations.every(v => {
    const result = validationResults.get(v.name);
    const overrideStatus = getOverrideStatusForValidation(v.name);

    // Pass if validation succeeded OR if there's an approved override
    return result?.status === 'success' || overrideStatus?.is_approved;
  });

  // Can mark as done if all required validations have passed (or have approved overrides)
  const canMarkAsDone = allRequiredValidationsPassed && !validationCompleted;

  if (loading) {
    return (
      <PageContainer>
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
          <CircularProgress />
        </Box>
      </PageContainer>
    );
  }

  if (!selectedOU) {
    return (
      <PageContainer>
        <Alert severity="info" sx={{ borderRadius: 3 }}>
          Please select a hotel to view validations
        </Alert>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header Section */}
      <HeaderCard>
        <CardContent sx={{ p: 2.5 }}>
          <Stack direction={isMobile ? 'column' : 'row'} alignItems="flex-start" justifyContent="space-between" spacing={2}>
            <Box flex={1}>
              <Stack direction="row" alignItems="center" spacing={1}>
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
                  Data Validations
                </Typography>
                <IconButton
                  size="small"
                  onClick={async () => {
                    if (!selectedOU) return;
                    try {
                      setDataFreshness('fetching');
                      const freshValidations = await validationService.fetchAndSyncValidations(selectedOU);
                      setValidations(freshValidations);
                      setDataFreshness('fresh');
                      setTimeout(() => setDataFreshness('cached'), 3000);
                    } catch (error) {
                      console.error('Failed to refresh validations:', error);
                      setDataFreshness('cached');
                    }
                  }}
                  disabled={!selectedOU || dataFreshness === 'fetching'}
                  sx={{
                    color: 'text.secondary',
                    '&:hover': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.08)
                    }
                  }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Stack>
              <Typography variant="body2" color="text.secondary" fontWeight={500} fontSize="0.8rem">
                Run validation checks on imported data
              </Typography>
            </Box>

            {/* Stats */}
            <Stack direction="row" spacing={2}>
              <Box textAlign="center">
                <Typography variant="h6" fontWeight={700} color="success.main">
                  {stats.passed}
                </Typography>
                <Typography variant="caption" color="text.secondary" fontSize="0.7rem">
                  Passed
                </Typography>
              </Box>
              <Divider orientation="vertical" flexItem />
              <Box textAlign="center">
                <Typography variant="h6" fontWeight={700} color="error.main">
                  {stats.failed}
                </Typography>
                <Typography variant="caption" color="text.secondary" fontSize="0.7rem">
                  Failed
                </Typography>
              </Box>
              <Divider orientation="vertical" flexItem />
              <Box textAlign="center">
                <Typography variant="h6" fontWeight={700}>
                  {stats.total}
                </Typography>
                <Typography variant="caption" color="text.secondary" fontSize="0.7rem">
                  Total
                </Typography>
              </Box>
            </Stack>
          </Stack>
        </CardContent>
      </HeaderCard>

      {/* Freshness indicator */}
      {dataFreshness === 'fresh' && (
        <Fade in>
          <Alert severity="success" sx={{ mb: 2, borderRadius: 3 }}>
            ✓ Validations updated from server
          </Alert>
        </Fade>
      )}

      {dataFreshness === 'fetching' && validations.length > 0 && (
        <Fade in>
          <Alert severity="info" sx={{ mb: 2, borderRadius: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={16} />
              <Typography variant="body2">Checking for updates...</Typography>
            </Stack>
          </Alert>
        </Fade>
      )}

      {/* Validation Cards */}
      {validations.length > 0 ? (
        <Stack spacing={2} mb={3}>
          {validations
            .sort((a, b) => a.sequence - b.sequence)
            .map((validation) => {
              const result = validationResults.get(validation.name);
              const hasErrors = result?.errors && result.errors.length > 0;
              const hasWarnings = result?.warnings && result.warnings.length > 0;
              const overrideStatus = getOverrideStatusForValidation(validation.name);
              const hasOverrideRequest = overrideStatus && overrideStatus.requested_at !== null;
              const isOverrideApproved = overrideStatus?.is_approved || false;

              return (
                <ValidationCard key={validation.id}>
                  <CardContent sx={{ p: 2 }}>
                    <Stack spacing={2}>
                      {/* Header row */}
                      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
                        <Stack direction="row" alignItems="center" spacing={2} flex={1}>
                          {/* Status icon */}
                          <Box>
                            {result?.status === 'running' && <CircularProgress size={24} />}
                            {result?.status === 'success' && <CheckCircleIcon color="success" />}
                            {result?.status === 'error' && <ErrorIcon color="error" />}
                            {result?.status === 'warning' && <WarningIcon color="warning" />}
                            {result?.status === 'idle' && <InfoIcon color="disabled" />}
                          </Box>

                          {/* Title and description */}
                          <Box flex={1}>
                            <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                              <Typography variant="h6" fontWeight={600} fontSize="1rem">
                                {validation.display_name}
                              </Typography>
                              {validation.is_required ? (
                                <Chip label="Required" size="small" color="primary" sx={{ height: 20, fontSize: '0.7rem' }} />
                              ) : (
                                <Chip label="Optional" size="small" variant="outlined" sx={{ height: 20, fontSize: '0.7rem', color: 'text.secondary', borderColor: 'divider' }} />
                              )}
                              {isOverrideApproved && (
                                <Tooltip title="Override approved - validation bypassed">
                                  <Chip
                                    icon={<CheckCircleOutlineIcon />}
                                    label="Override Approved"
                                    size="small"
                                    color="success"
                                    sx={{ height: 20, fontSize: '0.7rem' }}
                                  />
                                </Tooltip>
                              )}
                              {hasOverrideRequest && !isOverrideApproved && (
                                <Tooltip title="Override request pending approval">
                                  <Chip
                                    icon={<HourglassEmptyIcon />}
                                    label="Override Pending"
                                    size="small"
                                    color="warning"
                                    sx={{ height: 20, fontSize: '0.7rem' }}
                                  />
                                </Tooltip>
                              )}
                            </Stack>
                            <Typography variant="body2" color="text.secondary" fontSize="0.85rem">
                              {validation.description}
                            </Typography>
                            {result?.recordCount !== undefined && (
                              <Typography variant="caption" color="text.secondary" fontSize="0.75rem">
                                Records checked: {result.recordCount}
                              </Typography>
                            )}
                          </Box>

                          {/* Expand button for errors/warnings */}
                          {(hasErrors || hasWarnings) && (
                            <IconButton
                              size="small"
                              onClick={() => handleToggleExpand(validation.name)}
                              sx={{
                                transform: result?.expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 0.3s',
                              }}
                            >
                              <ExpandMoreIcon />
                            </IconButton>
                          )}
                        </Stack>
                      </Stack>

                      {/* Progress bar when running */}
                      {result?.status === 'running' && (
                        <LinearProgress sx={{ borderRadius: 1 }} />
                      )}

                      {/* Errors and Warnings */}
                      {(hasErrors || hasWarnings) && (
                        <Collapse in={result?.expanded}>
                          <Stack spacing={1} sx={{ mt: 1 }}>
                            {hasErrors && (
                              <Alert severity="error" sx={{ borderRadius: 2 }}>
                                <Typography variant="subtitle2" fontWeight={600} mb={0.5}>
                                  Errors:
                                </Typography>
                                {result!.errors!.map((error, idx) => (
                                  <Typography key={idx} variant="body2" fontSize="0.8rem">
                                    • {error}
                                  </Typography>
                                ))}
                              </Alert>
                            )}
                            {hasWarnings && (
                              <Alert severity="warning" sx={{ borderRadius: 2 }}>
                                <Typography variant="subtitle2" fontWeight={600} mb={0.5}>
                                  Warnings:
                                </Typography>
                                {result!.warnings!.map((warning, idx) => (
                                  <Typography key={idx} variant="body2" fontSize="0.8rem">
                                    • {warning}
                                  </Typography>
                                ))}
                              </Alert>
                            )}

                            {/* Request Override Button - only show for required validations with errors */}
                            {validation.is_required && hasErrors && !validationCompleted && (
                              <Box sx={{ mt: 1 }}>
                                {isOverrideApproved ? (
                                  <Alert severity="success" sx={{ borderRadius: 2 }}>
                                    <Typography variant="body2" fontSize="0.85rem">
                                      Override approved - this validation has been bypassed
                                    </Typography>
                                  </Alert>
                                ) : hasOverrideRequest ? (
                                  <Alert severity="info" sx={{ borderRadius: 2 }}>
                                    <Typography variant="body2" fontSize="0.85rem">
                                      Override request submitted. Awaiting admin approval.
                                    </Typography>
                                  </Alert>
                                ) : (
                                  <Button
                                    variant="outlined"
                                    color="warning"
                                    size="small"
                                    startIcon={<AssignmentIcon />}
                                    onClick={() => handleOpenOverrideDialog(validation)}
                                    sx={{
                                      borderRadius: 2,
                                      textTransform: 'none',
                                      fontWeight: 600,
                                      fontSize: '0.85rem',
                                    }}
                                  >
                                    Request Override
                                  </Button>
                                )}
                              </Box>
                            )}
                          </Stack>
                        </Collapse>
                      )}
                    </Stack>
                  </CardContent>
                </ValidationCard>
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
            No validations available for this hotel
          </Typography>
        </Card>
      )}

      {/* Action Buttons */}
      {validations.length > 0 && !validationCompleted && (
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
            onClick={handleClearResults}
            disabled={isRunningAll || validationResults.size === 0}
            fullWidth={isMobile}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
            }}
          >
            Clear Results
          </Button>

          <Button
            variant="outlined"
            startIcon={<PlayArrowIcon />}
            onClick={handleRunAllValidations}
            disabled={isRunningAll}
            fullWidth={isMobile}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
            }}
          >
            {isRunningAll ? 'Running Validations...' : 'Run All Validations'}
          </Button>

          <Button
            variant="outlined"
            color="info"
            startIcon={checkingOverrideStatus ? <CircularProgress size={16} /> : <RefreshIcon />}
            onClick={handleRefreshOverrideStatuses}
            disabled={checkingOverrideStatus}
            fullWidth={isMobile}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
            }}
          >
            {checkingOverrideStatus ? 'Checking...' : 'Check Override Status'}
          </Button>

          <Button
            variant="contained"
            startIcon={<CheckCircleIcon />}
            onClick={handleMarkAsDone}
            disabled={!canMarkAsDone}
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
            Mark as Done
          </Button>
        </Stack>
      )}

      {/* Locked State - Completion Message & Reset Button */}
      {validations.length > 0 && validationCompleted && (
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
              Validation Stage Completed
            </Typography>
            <Typography variant="body2" color="text.secondary">
              All required validations have been completed and marked as done. You can now proceed to the Sign-Off & Upload stage.
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
            Validation Information
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary" sx={{ lineHeight: 1.6 }}>
            • Validations check imported data for errors and inconsistencies<br />
            • Required validations must pass before data can be used<br />
            • Expand failed validations to see detailed error messages<br />
            • If a required validation fails, you can request an override (requires admin approval)<br />
            • Click "Check Override Status" to refresh and see if your override request has been approved
          </Typography>
        </Alert>
      </Box>

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
              handleReset();
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
              handleResetAllHotels();
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

      {/* Access Denied Modal */}
      <Dialog
        open={showAccessDeniedModal}
        onClose={() => {
          setShowAccessDeniedModal(false);
          navigate('/signed-in-landing/data-import');
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 600 }}>
          Imports Not Completed
        </DialogTitle>
        <DialogContent>
          <Typography variant="body1" color="text.secondary" mb={2}>
            You need to complete all data imports before accessing the validations page.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Please go to the Data Import page and complete your import session first.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button
            variant="contained"
            onClick={() => {
              setShowAccessDeniedModal(false);
              navigate('/signed-in-landing/data-import');
            }}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
              background: 'linear-gradient(135deg, #667eea, #764ba2)',
              '&:hover': {
                background: 'linear-gradient(135deg, #764ba2, #667eea)',
              },
            }}
          >
            Go to Data Import
          </Button>
        </DialogActions>
      </Dialog>

      {/* Override Request Dialog */}
      <Dialog
        open={overrideRequestDialog.open}
        onClose={handleCloseOverrideDialog}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 600, color: 'warning.main' }}>
          Request Validation Override
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body1" color="text.secondary">
              You are requesting an override for:
            </Typography>
            <Alert severity="warning" sx={{ borderRadius: 2 }}>
              <Typography variant="subtitle2" fontWeight={600}>
                {overrideRequestDialog.displayName}
              </Typography>
            </Alert>
            {(!selectedOU || !selectedPeriod) && (
              <Alert severity="error" sx={{ borderRadius: 2 }}>
                <Typography variant="body2" fontSize="0.85rem">
                  {!selectedOU && 'Please select an organizational unit (OU) before requesting an override.'}
                  {!selectedPeriod && 'Please select a period before requesting an override.'}
                </Typography>
              </Alert>
            )}
            <Typography variant="body2" color="text.secondary">
              Please provide a reason for this override request. An administrator will review and approve or deny your request.
            </Typography>
            <TextField
              label="Reason for Override (Required)"
              multiline
              rows={4}
              fullWidth
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g., Partial data submission approved by manager, awaiting missing information..."
              required
              disabled={!selectedOU || !selectedPeriod}
              sx={{
                '& .MuiOutlinedInput-root': {
                  borderRadius: 2,
                }
              }}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button
            variant="outlined"
            onClick={handleCloseOverrideDialog}
            disabled={submittingOverride}
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
            onClick={handleSubmitOverrideRequest}
            disabled={!overrideReason.trim() || submittingOverride || !selectedOU || !selectedPeriod}
            startIcon={submittingOverride ? <CircularProgress size={16} /> : <AssignmentIcon />}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            {submittingOverride ? 'Submitting...' : 'Submit Override Request'}
          </Button>
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
};

export default Validations;

/**
 * Request / Edit Mapping Dialog
 * =============================
 *
 * Dual-mode dialog for creating new mapping lines or editing existing ones.
 * Source fields are free-text (unknown external systems), target fields use
 * Autocomplete with combo validation against valid account-department pairs.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Autocomplete,
  Box,
  Typography,
  Alert,
  CircularProgress,
  Stack,
  Divider,
  IconButton,
  alpha,
  Chip,
  Collapse,
} from '@mui/material';
import {
  Close as CloseIcon,
  TrendingFlat as ArrowIcon,
  CheckCircle as ValidIcon,
  Error as InvalidIcon,
  Add as AddIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import { styled } from '@mui/material/styles';
import mappingTablesService from '../services/mappingTablesService';
import mappingConfigService, {
  CreateMappingRequest,
  MappingEntry,
} from '../services/mappingConfigService';

// ────────────────────────────────────────────────────────────
// STYLED COMPONENTS
// ────────────────────────────────────────────────────────────

const StyledDialog = styled(Dialog)(({ theme }) => ({
  '& .MuiDialog-paper': {
    borderRadius: 16,
    maxWidth: 600,
    width: '100%',
    background: theme.palette.mode === 'dark'
      ? alpha(theme.palette.background.paper, 0.95)
      : theme.palette.background.paper,
    backdropFilter: 'blur(20px)',
  },
}));

const StyledDialogTitle = styled(DialogTitle)(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: theme.spacing(2, 3),
  borderBottom: `1px solid ${theme.palette.divider}`,
}));

const StyledDialogContent = styled(DialogContent)(({ theme }) => ({
  padding: theme.spacing(3),
}));

const StyledDialogActions = styled(DialogActions)(({ theme }) => ({
  padding: theme.spacing(2, 3),
  borderTop: `1px solid ${theme.palette.divider}`,
  gap: theme.spacing(1),
}));

const SectionLabel = styled(Typography)(({ theme }) => ({
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: theme.palette.text.secondary,
  marginBottom: theme.spacing(1.5),
}));

const FieldRow = styled(Box)(({ theme }) => ({
  display: 'flex',
  gap: theme.spacing(2),
  alignItems: 'flex-start',
  [theme.breakpoints.down('sm')]: {
    flexDirection: 'column',
  },
}));

const ValidationChip = styled(Chip)<{ valid?: boolean }>(({ theme, valid }) => ({
  height: 24,
  fontSize: '0.6875rem',
  fontWeight: 600,
  backgroundColor: valid
    ? alpha(theme.palette.success.main, 0.12)
    : alpha(theme.palette.warning.main, 0.12),
  color: valid ? theme.palette.success.main : theme.palette.warning.main,
  '& .MuiChip-icon': {
    fontSize: 14,
    color: 'inherit',
  },
}));

// ────────────────────────────────────────────────────────────
// INTERFACES
// ────────────────────────────────────────────────────────────

interface RequestMappingDialogProps {
  open: boolean;
  onClose: () => void;
  configId: number;
  configDescription?: string;
  onSuccess?: () => void;
  mode?: 'create' | 'edit';
  existingMapping?: MappingEntry | null;
}

// ────────────────────────────────────────────────────────────
// COMPONENT
// ────────────────────────────────────────────────────────────

const RequestMappingDialog: React.FC<RequestMappingDialogProps> = ({
  open,
  onClose,
  configId,
  configDescription,
  onSuccess,
  mode = 'create',
  existingMapping = null,
}) => {
  const isEditMode = mode === 'edit';

  // Form state
  const [sourceAccount, setSourceAccount] = useState<string>('');
  const [sourceDepartment, setSourceDepartment] = useState<string>('');
  const [targetAccount, setTargetAccount] = useState<string>('');
  const [targetDepartment, setTargetDepartment] = useState<string>('');
  const [priority, setPriority] = useState<number>(100);

  // Options state (for target Autocomplete only)
  const [accounts, setAccounts] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [targetAccountOptions, setTargetAccountOptions] = useState<string[]>([]);
  const [targetDepartmentOptions, setTargetDepartmentOptions] = useState<string[]>([]);

  // Validation state
  const [isTargetComboValid, setIsTargetComboValid] = useState<boolean | null>(null);
  const [validatingCombo, setValidatingCombo] = useState(false);

  // UI state
  const [loading, setLoading] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState(false);

  // Helper: strip A/D prefix from target values for DB lookups
  const stripAccountPrefix = (val: string) => val.startsWith('A') ? val.slice(1) : val;
  const stripDepartmentPrefix = (val: string) => val.startsWith('D') ? val.slice(1) : val;

  // Load unique accounts and departments for target Autocomplete
  // Prefix with A/D to match how mappings store target values
  useEffect(() => {
    const loadOptions = async () => {
      if (!open) return;

      setLoadingOptions(true);
      try {
        const [accountList, departmentList] = await Promise.all([
          mappingTablesService.getUniqueAccounts(),
          mappingTablesService.getUniqueDepartments(),
        ]);
        const prefixedAccounts = accountList.map(a => `A${a}`);
        const prefixedDepartments = departmentList.map(d => `D${d}`);
        setAccounts(prefixedAccounts);
        setDepartments(prefixedDepartments);
        setTargetAccountOptions(prefixedAccounts);
        setTargetDepartmentOptions(prefixedDepartments);
      } catch (err) {
        console.error('Failed to load options:', err);
        setError('Failed to load account/department options. Please try syncing mapping tables.');
      } finally {
        setLoadingOptions(false);
      }
    };

    loadOptions();
  }, [open]);

  // Update target department options when target account changes
  useEffect(() => {
    const updateTargetDepartments = async () => {
      if (!targetAccount) {
        setTargetDepartmentOptions(departments);
        return;
      }

      try {
        // Strip "A" prefix for the DB lookup
        const rawAccount = stripAccountPrefix(targetAccount);
        const validDepts = await mappingTablesService.getDepartmentsForAccount(rawAccount);
        if (validDepts.length > 0) {
          setTargetDepartmentOptions(validDepts.map(d => `D${d}`));
        } else {
          setTargetDepartmentOptions(departments);
        }
      } catch (err) {
        console.error('Failed to get departments for account:', err);
        setTargetDepartmentOptions(departments);
      }
    };

    updateTargetDepartments();
  }, [targetAccount, departments]);

  // Update target account options when target department changes
  useEffect(() => {
    const updateTargetAccounts = async () => {
      if (!targetDepartment) {
        setTargetAccountOptions(accounts);
        return;
      }

      try {
        // Strip "D" prefix for the DB lookup
        const rawDepartment = stripDepartmentPrefix(targetDepartment);
        const validAccts = await mappingTablesService.getAccountsForDepartment(rawDepartment);
        if (validAccts.length > 0) {
          setTargetAccountOptions(validAccts.map(a => `A${a}`));
        } else {
          setTargetAccountOptions(accounts);
        }
      } catch (err) {
        console.error('Failed to get accounts for department:', err);
        setTargetAccountOptions(accounts);
      }
    };

    updateTargetAccounts();
  }, [targetDepartment, accounts]);

  // Validate target combo when both are selected
  useEffect(() => {
    const validateCombo = async () => {
      if (!targetAccount || !targetDepartment) {
        setIsTargetComboValid(null);
        return;
      }

      setValidatingCombo(true);
      try {
        // Strip A/D prefixes for the DB validation lookup
        const rawAccount = stripAccountPrefix(targetAccount);
        const rawDepartment = stripDepartmentPrefix(targetDepartment);
        const isValid = await mappingTablesService.isValidCombo(rawAccount, rawDepartment);
        setIsTargetComboValid(isValid);
      } catch (err) {
        console.error('Failed to validate combo:', err);
        setIsTargetComboValid(null);
      } finally {
        setValidatingCombo(false);
      }
    };

    validateCombo();
  }, [targetAccount, targetDepartment]);

  // Reset or pre-populate form when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSourceAccount('');
      setSourceDepartment('');
      setTargetAccount('');
      setTargetDepartment('');
      setPriority(100);
      setIsTargetComboValid(null);
      setError('');
      setSuccess(false);
    } else if (mode === 'edit' && existingMapping) {
      setSourceAccount(existingMapping.source_account || '');
      setSourceDepartment(existingMapping.source_department || '');
      setTargetAccount(existingMapping.target_account || '');
      setTargetDepartment(existingMapping.target_department || '');
      setPriority(existingMapping.priority);
    }
  }, [open, mode, existingMapping]);

  const handleSubmit = useCallback(async () => {
    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      if (!sourceAccount && !sourceDepartment && !targetAccount && !targetDepartment) {
        throw new Error('Please fill in at least one source or target field');
      }

      if (isTargetComboValid === false) {
        const proceed = window.confirm(
          'The target account-department combination is not in the valid combos list. ' +
          'Do you still want to submit this mapping request?'
        );
        if (!proceed) {
          setLoading(false);
          return;
        }
      }

      // Compute concatenated fields
      // Format: dept first, acct second, no separator
      // Target values carry A/D prefix (e.g., D0100A390001)
      // Source values are free text, clean concat (e.g., 0100390001)
      const srcAcct = sourceAccount || null;
      const srcDept = sourceDepartment || null;
      const tgtAcct = targetAccount || null;
      const tgtDept = targetDepartment || null;
      const sourceAcctDept = srcDept && srcAcct ? `${srcDept}${srcAcct}` : null;
      const targetAcctDept = tgtDept && tgtAcct ? `${tgtDept}${tgtAcct}` : null;

      const mappingData: CreateMappingRequest = {
        source_account: srcAcct,
        source_department: srcDept,
        source_account_department: sourceAcctDept,
        target_account: tgtAcct,
        target_department: tgtDept,
        target_account_department: targetAcctDept,
        priority,
        // Edit mode: new inactive line (original stays untouched)
        // Create mode: active line
        is_active: isEditMode ? false : true,
      };

      await mappingConfigService.createMapping(configId, mappingData);
      setSuccess(true);
      setTimeout(() => {
        onClose();
        onSuccess?.();
      }, 1500);
    } catch (err) {
      console.error('Failed to submit mapping:', err);
      setError(err instanceof Error ? err.message : 'Failed to submit mapping');
    } finally {
      setLoading(false);
    }
  }, [
    sourceAccount, sourceDepartment, targetAccount, targetDepartment,
    priority, isTargetComboValid, configId, onClose, onSuccess, isEditMode,
  ]);

  const canSubmit = !loading && !success && (
    sourceAccount || sourceDepartment || targetAccount || targetDepartment
  );

  return (
    <StyledDialog open={open} onClose={loading ? undefined : onClose} maxWidth="sm" fullWidth>
      <StyledDialogTitle>
        <Box>
          <Typography variant="h6" fontWeight={600}>
            {isEditMode ? 'Edit Mapping' : 'Request New Mapping'}
          </Typography>
          {configDescription && (
            <Typography variant="caption" color="text.secondary">
              For: {configDescription}
            </Typography>
          )}
        </Box>
        <IconButton onClick={onClose} disabled={loading} size="small">
          <CloseIcon />
        </IconButton>
      </StyledDialogTitle>

      <StyledDialogContent>
        {loadingOptions ? (
          <Box display="flex" justifyContent="center" alignItems="center" py={6}>
            <CircularProgress size={32} />
          </Box>
        ) : (
          <Stack spacing={3}>
            {/* Info Alert */}
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              {isEditMode
                ? 'Submit a modified mapping request. The original mapping will remain active until an admin approves this change.'
                : 'Request a new mapping line. It will be submitted for approval and won\'t be active until approved.'}
            </Alert>

            {/* Source Fields — plain text inputs */}
            <Box>
              <SectionLabel>Source (What to map from)</SectionLabel>
              <FieldRow>
                <TextField
                  label="Source Account"
                  placeholder="e.g., 4100"
                  size="small"
                  value={sourceAccount}
                  onChange={(e) => setSourceAccount(e.target.value)}
                  helperText="Leave empty to match any"
                  sx={{ flex: 1 }}
                />
                <TextField
                  label="Source Department"
                  placeholder="e.g., 100"
                  size="small"
                  value={sourceDepartment}
                  onChange={(e) => setSourceDepartment(e.target.value)}
                  helperText="Leave empty to match any"
                  sx={{ flex: 1 }}
                />
              </FieldRow>
            </Box>

            {/* Arrow */}
            <Box display="flex" justifyContent="center" alignItems="center">
              <ArrowIcon sx={{ fontSize: 24, color: 'text.disabled' }} />
            </Box>

            {/* Target Fields — Autocomplete with combo validation */}
            <Box>
              <SectionLabel>
                Target (What to map to)
                {isTargetComboValid !== null && (
                  <ValidationChip
                    valid={isTargetComboValid}
                    icon={isTargetComboValid ? <ValidIcon /> : <InvalidIcon />}
                    label={isTargetComboValid ? 'Valid combo' : 'Not in combos'}
                    size="small"
                    sx={{ ml: 1 }}
                  />
                )}
                {validatingCombo && (
                  <CircularProgress size={12} sx={{ ml: 1 }} />
                )}
              </SectionLabel>
              <FieldRow>
                <Autocomplete
                  freeSolo
                  options={targetAccountOptions}
                  value={targetAccount}
                  onInputChange={(_, value) => setTargetAccount(value)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Target Account"
                      placeholder="e.g., A5100"
                      size="small"
                    />
                  )}
                  sx={{ flex: 1 }}
                />
                <Autocomplete
                  freeSolo
                  options={targetDepartmentOptions}
                  value={targetDepartment}
                  onInputChange={(_, value) => setTargetDepartment(value)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Target Department"
                      placeholder="e.g., D200"
                      size="small"
                    />
                  )}
                  sx={{ flex: 1 }}
                />
              </FieldRow>
            </Box>

            <Divider />

            {/* Priority */}
            <Box>
              <SectionLabel>Priority</SectionLabel>
              <TextField
                type="number"
                value={priority}
                onChange={(e) => setPriority(Math.max(0, parseInt(e.target.value) || 0))}
                size="small"
                helperText="Higher priority mappings are applied first (default: 100)"
                inputProps={{ min: 0, max: 9999 }}
                sx={{ width: 120 }}
              />
            </Box>

            {/* Error/Success Messages */}
            <Collapse in={!!error || success}>
              {error && (
                <Alert severity="error" sx={{ borderRadius: 2 }}>
                  {error}
                </Alert>
              )}
              {success && (
                <Alert severity="success" sx={{ borderRadius: 2 }}>
                  {isEditMode
                    ? 'Modification request submitted. Original mapping remains active.'
                    : 'Mapping request submitted successfully! It is now pending approval.'}
                </Alert>
              )}
            </Collapse>
          </Stack>
        )}
      </StyledDialogContent>

      <StyledDialogActions>
        <Button
          onClick={onClose}
          disabled={loading}
          sx={{ textTransform: 'none' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : (isEditMode ? <EditIcon /> : <AddIcon />)}
          sx={{
            textTransform: 'none',
            borderRadius: 2,
            px: 3,
          }}
        >
          {loading ? 'Submitting...' : (isEditMode ? 'Complete' : 'Submit Request')}
        </Button>
      </StyledDialogActions>
    </StyledDialog>
  );
};

export default RequestMappingDialog;

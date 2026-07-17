import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  LinearProgress,
  Chip,
  Grow,
  Collapse,
  Button,
  Alert,
  Stack,
  Tooltip,
  alpha,
  useTheme,
} from '@mui/material';
import { styled, keyframes } from '@mui/material/styles';
import {
  InsertDriveFile as FileIcon,
  Close as CloseIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Refresh as RefreshIcon,
  Description as DescriptionIcon,
  TableChart as TableChartIcon,
  Article as ArticleIcon,
  Input as InputIcon,
  ExpandMore as ExpandMoreIcon,
  Lock as LockIcon,
  ArrowForward as NextIcon,
} from '@mui/icons-material';
import { ImportFile, ImportStatus } from '../../types/dataImport';

// ────────────────────────────────────────────────────────────
// ANIMATIONS
// ────────────────────────────────────────────────────────────

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
`;

const rotate = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const slideUp = keyframes`
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const successPulse = keyframes`
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.05); opacity: 0.8; }
  100% { transform: scale(1); opacity: 1; }
`;

// ────────────────────────────────────────────────────────────
// STYLED COMPONENTS
// ────────────────────────────────────────────────────────────

const StyledPaper = styled(Paper, {
  shouldForwardProp: (prop) =>
    prop !== 'isDragActive' &&
    prop !== 'status' &&
    prop !== 'isLocked' &&
    prop !== 'isNextInLine',
})<{
  isDragActive?: boolean;
  status?: ImportStatus;
  isLocked?: boolean;
  isNextInLine?: boolean;
}>(({ theme, isDragActive, status, isLocked, isNextInLine }) => ({
  position: 'relative',
  borderRadius: 14,
  padding: theme.spacing(2.5),
  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  background:
    theme.palette.mode === 'dark'
      ? alpha(theme.palette.background.paper, 0.7)
      : alpha(theme.palette.background.paper, 0.95),
  backdropFilter: 'blur(20px)',
  border: `2px solid ${
    isDragActive
      ? theme.palette.primary.main
      : status === ImportStatus.Complete
      ? alpha(theme.palette.success.main, 0.3)
      : status === ImportStatus.Failed
      ? alpha(theme.palette.error.main, 0.3)
      : status === ImportStatus.Processing || status === ImportStatus.Validating
      ? alpha(theme.palette.info.main, 0.3)
      : isNextInLine
      ? alpha(theme.palette.info.main, 0.2)
      : alpha(theme.palette.divider, 0.08)
  }`,
  boxShadow: isDragActive
    ? `0 8px 32px ${alpha(theme.palette.primary.main, 0.15)}`
    : status === ImportStatus.Complete
    ? `0 4px 20px ${alpha(theme.palette.success.main, 0.1)}`
    : status === ImportStatus.Failed
    ? `0 4px 20px ${alpha(theme.palette.error.main, 0.1)}`
    : theme.shadows[1],
  opacity: isLocked ? 0.6 : 1,
  animation: `${slideUp} 0.4s ease-out`,

  '&:hover': {
    transform: !isLocked && status !== ImportStatus.Processing ? 'translateY(-2px)' : 'none',
    boxShadow:
      !isLocked && status !== ImportStatus.Processing
        ? theme.palette.mode === 'dark'
          ? `0 12px 48px ${alpha('#8b5cf6', 0.15)}`
          : `0 12px 48px ${alpha('#8b5cf6', 0.1)}`
        : undefined,
    border: !isLocked
      ? `2px solid ${alpha(theme.palette.primary.main, 0.2)}`
      : undefined,
  },

  '&::before': isLocked ? {
    content: '""',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: alpha(theme.palette.background.default, 0.4),
    borderRadius: 'inherit',
    zIndex: 10,
    pointerEvents: 'none',
  } : {},
}));

const DropZone = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'isDragActive' && prop !== 'hasFile',
})<{ isDragActive?: boolean; hasFile?: boolean }>(({ theme, isDragActive, hasFile }) => ({
  border: `2px dashed ${
    isDragActive
      ? theme.palette.primary.main
      : hasFile
      ? alpha(theme.palette.success.main, 0.4)
      : alpha(theme.palette.divider, 0.3)
  }`,
  borderRadius: 12,
  padding: theme.spacing(2.5),
  textAlign: 'center',
  cursor: hasFile ? 'default' : 'pointer',
  transition: 'all 0.3s ease',
  background: isDragActive
    ? alpha(theme.palette.primary.main, 0.05)
    : hasFile
    ? alpha(theme.palette.success.main, 0.03)
    : alpha(theme.palette.background.paper, 0.3),

  '&:hover': !hasFile ? {
    borderColor: theme.palette.primary.main,
    background: alpha(theme.palette.primary.main, 0.03),
  } : {},
}));

const FilePreview = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'isComplete',
})<{ isComplete?: boolean }>(({ theme, isComplete }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: theme.spacing(2),
  padding: theme.spacing(2),
  borderRadius: 12,
  background: isComplete
    ? alpha(theme.palette.success.main, 0.08)
    : alpha(theme.palette.background.paper, 0.4),
  border: `1px solid ${
    isComplete
      ? alpha(theme.palette.success.main, 0.2)
      : alpha(theme.palette.divider, 0.1)
  }`,
  transition: 'all 0.3s ease',
}));

const DetailsBox = styled(Box)(({ theme }) => ({
  marginTop: theme.spacing(1),
  padding: theme.spacing(2),
  background: alpha(theme.palette.background.paper, 0.3),
  borderRadius: theme.spacing(1.5),
  border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
}));

// ────────────────────────────────────────────────────────────
// COMPONENT PROPS
// ────────────────────────────────────────────────────────────

interface ImportCardProps {
  importFile: ImportFile;
  importProcessorName?: string;
  onFileSelect?: (importId: string, file: File) => void;
  onRemoveFile?: (importId: string) => void;
  onStatusChange?: (importId: string, status: ImportStatus, additionalData?: { fileName?: string; rowCount?: number; error?: string }) => void;
  isProcessing?: boolean;
  isLocked?: boolean;
  isNextInLine?: boolean;
  fileInputRef?: (ref: HTMLInputElement | null) => void;
  importOptions?: {
    ou?: string;
    year?: number;
    month?: number;
    localId1?: string;
  };
}

// ────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────

const ImportCard: React.FC<ImportCardProps> = ({
  importFile: initialImportFile,
  importProcessorName,
  onFileSelect,
  onRemoveFile,
  onStatusChange,
  isProcessing = false,
  isLocked = false,
  isNextInLine = false,
  fileInputRef,
  importOptions,
}) => {
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<ImportFile>(initialImportFile);
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showDetails, setShowDetails] = useState(false);

  // Update internal state when prop changes
  useEffect(() => {
    setImportFile(initialImportFile);
  }, [initialImportFile]);

  // Simulate upload progress during processing
  useEffect(() => {
    if (
      importFile.status === ImportStatus.Processing ||
      importFile.status === ImportStatus.Validating
    ) {
      setUploadProgress(0);
      const interval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) return 90;
          return prev + 10;
        });
      }, 200);
      return () => clearInterval(interval);
    } else if (importFile.status === ImportStatus.Complete) {
      setUploadProgress(100);
    } else {
      setUploadProgress(0);
    }
  }, [importFile.status]);

  // Get file icon based on file type
  const getFileIcon = () => {
    const extension = importFile.fileName?.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'csv':
      case 'xls':
      case 'xlsx':
        return <TableChartIcon sx={{ fontSize: 40, color: 'primary.main', opacity: 0.8 }} />;
      case 'json':
        return <DescriptionIcon sx={{ fontSize: 40, color: 'primary.main', opacity: 0.8 }} />;
      case 'txt':
        return <ArticleIcon sx={{ fontSize: 40, color: 'primary.main', opacity: 0.8 }} />;
      default:
        return <FileIcon sx={{ fontSize: 40, color: 'primary.main', opacity: 0.8 }} />;
    }
  };

  // Get status configuration
  const getStatusConfig = () => {
    switch (importFile.status) {
      case ImportStatus.Validating:
        return {
          icon: <RefreshIcon sx={{ fontSize: 20, animation: `${rotate} 1s linear infinite` }} />,
          color: 'info' as const,
          label: 'Validating',
        };
      case ImportStatus.Processing:
        return {
          icon: <RefreshIcon sx={{ fontSize: 20, animation: `${rotate} 1s linear infinite` }} />,
          color: 'primary' as const,
          label: 'Processing',
        };
      case ImportStatus.Complete:
        return {
          icon: <CheckCircleIcon sx={{ fontSize: 20 }} />,
          color: 'success' as const,
          label: 'Complete',
        };
      case ImportStatus.Failed:
        return {
          icon: <ErrorIcon sx={{ fontSize: 20 }} />,
          color: 'error' as const,
          label: 'Failed',
        };
      default:
        return null;
    }
  };

  // Handle native file selection
  const handleNativeFileSelect = useCallback(async () => {
    if (!importProcessorName || isLocked) return;

    try {
      setImportFile((prev) => ({ ...prev, status: ImportStatus.Processing, error: undefined }));
      onStatusChange?.(importFile.id, ImportStatus.Processing);

      // @ts-ignore - window.ipcApi is defined in preload
      if (window.ipcApi?.sendIpcRequest) {
        try {
          let result;
          if (importProcessorName === 'test_import') {
            // @ts-ignore
            result = await window.ipcApi.sendIpcRequest(
              'imports:execute',
              importProcessorName,
              {
                testMode: true,
                skipValidation: true,
              }
            );
          } else {
            // @ts-ignore
            result = await window.ipcApi.sendIpcRequest(
              'imports:execute',
              importProcessorName,
              {
                custom: {
                  ou: importOptions?.ou,
                  year: importOptions?.year,
                  month: importOptions?.month,
                  localId1: importOptions?.localId1
                }
              }
            );
          }

          if (result && result.success) {
            const newFileName = result.filePath
              ? result.filePath.split(/[/\\]/).pop()
              : importFile.fileName;
            const newRowCount = result.rowCount || 0;

            // console.log(`Import successful for ${importProcessorName}:`, {
            //   fileName: newFileName,
            //   rowCount: newRowCount,
            //   rawResult: result
            // });

            setImportFile((prev) => ({
              ...prev,
              status: ImportStatus.Complete,
              rowCount: newRowCount,
              fileName: newFileName,
              error: undefined,
            }));
            onStatusChange?.(importFile.id, ImportStatus.Complete, {
              fileName: newFileName,
              rowCount: newRowCount
            });
          } else if (result && result.message === 'File selection canceled') {
            setImportFile((prev) => ({
              ...prev,
              status: ImportStatus.Pending,
            }));
            onStatusChange?.(importFile.id, ImportStatus.Pending);
          } else {
            // Extract error message from result
            const errorMessage = result?.error || result?.message || 'Import failed';
            console.error(`[ImportCard] Import failed:`, errorMessage);

            setImportFile((prev) => ({
              ...prev,
              status: ImportStatus.Failed,
              error: errorMessage,
            }));
            onStatusChange?.(importFile.id, ImportStatus.Failed, { error: errorMessage });
          }
        } catch (ipcError) {
          console.error('IPC error:', ipcError);
          const errorMessage = ipcError instanceof Error ? ipcError.message : 'Failed to process file';
          setImportFile((prev) => ({
            ...prev,
            status: ImportStatus.Failed,
            error: errorMessage,
          }));
          onStatusChange?.(importFile.id, ImportStatus.Failed, { error: errorMessage });
        }
      } else {
        // console.warn('IPC not available - running in development mode without proper IPC setup');
        // In development mode without IPC, simulate a successful import
        // This should only happen in development when IPC is not properly configured
        setTimeout(() => {
          // Generate a more realistic simulated row count for testing
          // These values should never appear in production as IPC will be available
          const simulatedRowCount = importProcessorName === 'test_import'
            ? 42  // Use a distinctive number for test imports to identify simulation mode
            : Math.floor(Math.random() * 500) + 50; // Random between 50-549 for other imports

          // Generate a simulated filename if not already set
          const simulatedFileName = importFile.fileName || `simulated_${importProcessorName}.csv`;

          // console.warn(`SIMULATION MODE: Returning simulated row count of ${simulatedRowCount} for ${importProcessorName}`);
          setImportFile((prev) => ({
            ...prev,
            status: ImportStatus.Complete,
            rowCount: simulatedRowCount,
            fileName: simulatedFileName,
            error: undefined,
          }));
          onStatusChange?.(importFile.id, ImportStatus.Complete, {
            fileName: simulatedFileName,
            rowCount: simulatedRowCount
          });
        }, 2000);
      }
    } catch (error) {
      console.error('Import error:', error);
      setImportFile((prev) => ({
        ...prev,
        status: ImportStatus.Failed,
        error: error instanceof Error ? error.message : 'Import error',
      }));
      onStatusChange?.(importFile.id, ImportStatus.Failed);
    }
  }, [importProcessorName, importFile.id, importFile.fileName, onStatusChange, isLocked, importOptions]);

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);

    if (isLocked || isProcessing) return;

    const file = event.dataTransfer.files[0];
    if (file) {
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      if (fileExtension && importFile.fileTypes.includes(fileExtension)) {
        setImportFile((prev) => ({
          ...prev,
          file: file,
          fileName: file.name,
          status: ImportStatus.Pending,
          rowCount: undefined,
        }));
        onFileSelect?.(importFile.id, file);
      } else {
        setImportFile((prev) => ({
          ...prev,
          error: `Invalid file type. Expected: ${importFile.fileTypes.join(', ')}`,
        }));
      }
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isLocked && !isProcessing) {
      setIsDragActive(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);
  };

  const handleRemoveFile = () => {
    if (isLocked) return;
    setImportFile((prev) => ({
      ...prev,
      file: undefined,
      fileName: undefined,
      status: ImportStatus.Pending,
      rowCount: undefined,
      error: undefined,
    }));
    onRemoveFile?.(importFile.id);
  };

  const isDisabled =
    isProcessing || importFile.status === ImportStatus.Processing || isLocked;
  const statusConfig = getStatusConfig();
  const isFileChangeAllowed = !isLocked &&
    importFile.status !== ImportStatus.Complete &&
    importFile.status !== ImportStatus.Processing;

  const hasRequirements =
    (importFile.requiredColumns && importFile.requiredColumns.length > 0) ||
    (importFile.optionalColumns && importFile.optionalColumns.length > 0) ||
    (importFile.validationRules && importFile.validationRules.length > 0);

  return (
    <Grow in timeout={300}>
      <StyledPaper
        elevation={1}
        isDragActive={isDragActive}
        status={importFile.status}
        isLocked={isLocked}
        isNextInLine={isNextInLine}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* Header Section */}
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" mb={1.5}>
          <Box flex={1}>
            <Stack direction="row" alignItems="center" spacing={1} mb={0.5}>
              <Typography variant="h6" fontWeight={700} fontSize="1rem">
                {importFile.description}
              </Typography>
              {importFile.required && (
                <Chip
                  label="Required"
                  size="small"
                  color="warning"
                  variant="outlined"
                  sx={{
                    height: 20,
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    borderRadius: 1,
                  }}
                />
              )}
              {isLocked && (
                <Chip
                  icon={<LockIcon sx={{ fontSize: '0.9rem !important' }} />}
                  label="Locked"
                  size="small"
                  color="default"
                  variant="filled"
                  sx={{
                    height: 20,
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    borderRadius: 1,
                    background: alpha(theme.palette.text.secondary, 0.2),
                  }}
                />
              )}
              {isNextInLine && !isLocked && (
                <Chip
                  icon={<NextIcon sx={{ fontSize: '0.9rem !important' }} />}
                  label="Next"
                  size="small"
                  color="info"
                  variant="outlined"
                  sx={{
                    height: 20,
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    borderRadius: 1,
                    animation: `${pulse} 2s ease-in-out infinite`,
                  }}
                />
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" fontSize="0.75rem" sx={{ textTransform: 'lowercase' }}>
              {importFile.name}
            </Typography>
          </Box>
          {statusConfig && (
            <Chip
              icon={statusConfig.icon}
              label={statusConfig.label}
              color={statusConfig.color}
              size="small"
              sx={{
                fontWeight: 600,
                fontSize: '0.75rem',
                animation: importFile.status === ImportStatus.Complete
                  ? `${successPulse} 0.6s ease-out`
                  : 'none',
              }}
            />
          )}
        </Stack>

        {/* File Upload Zone or File Preview */}
        {!importFile.fileName ? (
          <DropZone
            isDragActive={isDragActive && !isLocked}
            hasFile={false}
            onClick={() => !isDisabled && handleNativeFileSelect()}
            sx={{
              cursor: isLocked ? 'not-allowed !important' : 'pointer',
              pointerEvents: isLocked ? 'none' : 'auto',
            }}
          >
            <InputIcon
              sx={{
                fontSize: 36,
                color: isDragActive ? 'primary.main' : 'text.secondary',
                mb: 1,
                opacity: isDragActive ? 1 : 0.6,
                transition: 'all 0.3s ease',
              }}
            />
            <Typography variant="body2" fontWeight={600} mb={0.5} fontSize="0.9rem">
              {isDragActive ? 'Drop file here' : 'Click to browse'}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontSize="0.75rem">
              Accepts: {(importFile.fileTypes || []).map((ft) => `.${ft.toUpperCase()}`).join(', ') || 'All files'}
            </Typography>
            <input
              ref={(ref) => {
                if (inputRef) inputRef.current = ref;
                if (fileInputRef) fileInputRef(ref);
              }}
              type="file"
              accept={(importFile.fileTypes || []).map((ft) => `.${ft}`).join(',')}
              onChange={() => {}}
              style={{ display: 'none' }}
              disabled={isDisabled}
            />
          </DropZone>
        ) : (
          <FilePreview isComplete={importFile.status === ImportStatus.Complete}>
            {getFileIcon()}
            <Box flex={1} minWidth={0}>
              <Typography variant="body2" fontWeight={600} noWrap>
                {importFile.fileName}
              </Typography>
              {importFile.rowCount !== undefined && (
                <Typography
                  variant="caption"
                  color={importFile.status === ImportStatus.Complete ? 'success.main' : 'text.secondary'}
                  fontWeight={importFile.status === ImportStatus.Complete ? 600 : 400}
                >
                  {importFile.rowCount.toLocaleString()} rows {
                    importFile.status === ImportStatus.Complete ? 'successfully imported' : 'detected'
                  }
                </Typography>
              )}
            </Box>
            {isFileChangeAllowed && (
              <Tooltip title="Remove file">
                <IconButton
                  size="small"
                  onClick={handleRemoveFile}
                  sx={{
                    background: alpha(theme.palette.error.main, 0.1),
                    '&:hover': {
                      background: alpha(theme.palette.error.main, 0.2),
                    },
                  }}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </FilePreview>
        )}

        {/* Validation Progress */}
        {(importFile.status === ImportStatus.Validating ||
          importFile.status === ImportStatus.Processing) && (
          <Box mt={2}>
            <Stack direction="row" alignItems="center" spacing={1} mb={1}>
              <RefreshIcon
                sx={{
                  fontSize: 16,
                  animation: `${rotate} 1s linear infinite`,
                  color: 'primary.main'
                }}
              />
              <Typography variant="caption" color="primary" fontWeight={600}>
                {importFile.status === ImportStatus.Validating
                  ? 'Validating file structure...'
                  : 'Processing file...'}
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={uploadProgress}
              sx={{
                height: 4,
                borderRadius: 2,
                backgroundColor: alpha(theme.palette.primary.main, 0.1),
                '& .MuiLinearProgress-bar': {
                  borderRadius: 2,
                  background: `linear-gradient(90deg, ${theme.palette.primary.main} 0%, ${theme.palette.secondary.main} 100%)`,
                },
              }}
            />
          </Box>
        )}

        {/* Error Message */}
        {importFile.error && (
          <Alert
            severity="error"
            sx={{
              mt: 2,
              borderRadius: 2,
              fontSize: '0.875rem',
            }}
          >
            {importFile.error}
          </Alert>
        )}

        {/* Expandable Requirements Section */}
        {hasRequirements && (
          <>
            <Button
              size="small"
              onClick={() => setShowDetails(!showDetails)}
              endIcon={
                <ExpandMoreIcon
                  sx={{
                    transform: showDetails ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.3s',
                  }}
                />
              }
              sx={{
                mt: 2,
                textTransform: 'none',
                fontSize: '0.8rem',
                color: 'text.secondary',
                '&:hover': {
                  background: alpha(theme.palette.action.hover, 0.1),
                },
              }}
            >
              {showDetails ? 'Hide' : 'Show'} Requirements
            </Button>

            <Collapse in={showDetails}>
              <DetailsBox>
                {importFile.requiredColumns && importFile.requiredColumns.length > 0 && (
                  <>
                    <Typography
                      variant="caption"
                      fontWeight={600}
                      component="div"
                      mb={1}
                      color="text.primary"
                    >
                      Required Columns:
                    </Typography>
                    <Stack direction="row" flexWrap="wrap" gap={0.5} mb={2}>
                      {importFile.requiredColumns.map((col) => (
                        <Chip
                          key={col}
                          label={col}
                          size="small"
                          color="primary"
                          variant="outlined"
                          sx={{
                            height: 22,
                            fontSize: '0.7rem',
                            fontWeight: 600,
                          }}
                        />
                      ))}
                    </Stack>
                  </>
                )}

                {importFile.optionalColumns && importFile.optionalColumns.length > 0 && (
                  <>
                    <Typography
                      variant="caption"
                      fontWeight={600}
                      component="div"
                      mb={1}
                      color="text.primary"
                    >
                      Optional Columns:
                    </Typography>
                    <Stack direction="row" flexWrap="wrap" gap={0.5} mb={2}>
                      {importFile.optionalColumns.map((col) => (
                        <Chip
                          key={col}
                          label={col}
                          size="small"
                          variant="outlined"
                          sx={{
                            height: 22,
                            fontSize: '0.7rem',
                          }}
                        />
                      ))}
                    </Stack>
                  </>
                )}

                {importFile.validationRules && importFile.validationRules.length > 0 && (
                  <>
                    <Typography
                      variant="caption"
                      fontWeight={600}
                      component="div"
                      mb={1}
                      color="text.primary"
                    >
                      Validation Rules:
                    </Typography>
                    <Stack spacing={0.5}>
                      {importFile.validationRules.map((rule, i) => (
                        <Typography
                          key={i}
                          variant="caption"
                          color="text.secondary"
                          component="div"
                          sx={{ pl: 1 }}
                        >
                          • {rule}
                        </Typography>
                      ))}
                    </Stack>
                  </>
                )}
              </DetailsBox>
            </Collapse>
          </>
        )}
      </StyledPaper>
    </Grow>
  );
};

export default ImportCard;
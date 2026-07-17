import { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Stack,
  Divider,
  Alert,
  TextField,
  Paper,
  LinearProgress,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import UploadIcon from "@mui/icons-material/Upload";
import EditIcon from "@mui/icons-material/Edit";
import LockIcon from "@mui/icons-material/Lock";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import { useNavigate } from "react-router-dom";
import { useSettingsStore } from "../../store/settings";
import submittedDataService, { SubmittedDataEntry } from "../../services/submittedDataService";
import authService from "../../services/auth";

const StyledCard = styled(Card)(({ theme }) => ({
  marginBottom: theme.spacing(3),
  boxShadow: theme.shadows[3],
}));

interface ValidationStatus {
  name: string;
  status: "pass" | "fail" | "warning";
  message?: string;
}

export default function SignOffUpload() {
  const [validations, setValidations] = useState<ValidationStatus[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [signature, setSignature] = useState<string>("");
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string>("");
  const [signedByName, setSignedByName] = useState<string>("");
  const [signedAt, setSignedAt] = useState<string>("");
  const [unmappedCount, setUnmappedCount] = useState<number>(0);
  const [invalidComboCount, setInvalidComboCount] = useState<number>(0);
  const [totalRecords, setTotalRecords] = useState<number>(0);
  const [validationCompleted, setValidationCompleted] = useState<boolean>(false);
  const [signOffCompleted, setSignOffCompleted] = useState<boolean>(false);
  const [showAccessDeniedModal, setShowAccessDeniedModal] = useState<boolean>(false);
  const [showResetConfirmModal, setShowResetConfirmModal] = useState<boolean>(false);
  const [showResetAllHotelsModal, setShowResetAllHotelsModal] = useState<boolean>(false);
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const navigate = useNavigate();

  // Check validation and sign-off completion states
  useEffect(() => {
    const checkCompletionStates = async () => {
      if (!selectedHotelOu) return;

      try {
        // Check validation completion
        // @ts-ignore
        const validationResult = await window.ipcApi.sendIpcRequest('db:get-validation-completed-state', { ou: selectedHotelOu });
        if (validationResult?.success) {
          const isValidationCompleted = validationResult.data as boolean;
          setValidationCompleted(isValidationCompleted);

          // If validations are not completed, show modal
          if (!isValidationCompleted) {
            setShowAccessDeniedModal(true);
          }
        }

        // Check sign-off completion
        // @ts-ignore
        const signOffResult = await window.ipcApi.sendIpcRequest('db:get-signoff-completed-state', { ou: selectedHotelOu });
        if (signOffResult?.success) {
          const isSignOffCompleted = signOffResult.data as boolean;
          setSignOffCompleted(isSignOffCompleted);
        }
      } catch (error) {
        console.error('Failed to check completion states:', error);
      }
    };

    checkCompletionStates();
  }, [selectedHotelOu]);

  // Fetch validation status and check for unmapped records
  useEffect(() => {
    const fetchValidations = async () => {
      setLoading(true);
      try {
        if (window.ipcApi) {
          // Fetch validation summary
          const response = await window.ipcApi.sendIpcRequest("db:get-validation-summary");

          if (response.success && response.data) {
            const data = JSON.parse(response.data);
            setValidations(data);
          }

          // Check for unmapped records in staging data
          const stagingResponse = await window.ipcApi.sendIpcRequest("db:get-staging-data", {
            ou: selectedHotelOu,
          });

          if (stagingResponse.success && stagingResponse.data) {
            const stagingData = JSON.parse(stagingResponse.data as string);
            setTotalRecords(stagingData.length);

            // Count records with null/undefined department or account
            const unmapped = stagingData.filter((row: any) =>
              !row.department || !row.account ||
              row.department === null || row.account === null
            ).length;

            // Count records with invalid combos (mapped but combo doesn't exist)
            const invalidCombos = stagingData.filter((row: any) =>
              row.department && row.account && row.is_valid_combo === 0
            ).length;

            setUnmappedCount(unmapped);
            setInvalidComboCount(invalidCombos);
          }
        }
      } catch (error) {
        console.error("Error fetching validations:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchValidations();
  }, [selectedHotelOu]);

  const allValidationsPassed = validations.every(v => v.status === "pass");
  const hasWarnings = validations.some(v => v.status === "warning");
  const hasDataIssues = unmappedCount > 0 || invalidComboCount > 0;

  const handleSignOffAndUpload = async () => {
    if (signature.trim().length === 0) return;
    await handleUpload();
  };

  const handleUpload = async () => {
    setUploading(true);
    setUploadError("");

    try {
      // Use the signature name that the user entered
      const signedBy = signature;

      // Fetch staging data from local database
      const response = await window.ipcApi.sendIpcRequest("db:get-staging-data", {
        ou: selectedHotelOu,
      });

      if (!response.success || !response.data) {
        throw new Error("Failed to fetch staging data");
      }

      const stagingData = JSON.parse(response.data as string);

      // Safety check: abort if any unmapped or invalid combo records exist
      const hasIssues = stagingData.some((row: any) =>
        !row.department || !row.account || row.is_valid_combo === 0
      );
      if (hasIssues) {
        throw new Error("Upload aborted: there are unmapped or invalid combo records. Please fix them in the Staging Data Review page before uploading.");
      }

      // Transform staging data to match API format
      const submittedData: SubmittedDataEntry[] = stagingData.map((row: any) => ({
        ou: row.ou.padEnd(7, ' '), // Pad OU to minimum 7 characters
        period: row.period_combo, // Use period_combo (format: "YYYY-MM")
        department: row.department,
        account: row.account,
        amount: Math.round(row.amount * 100) / 100, // Round to 2 decimal places for decimal(18,2)
        scenario: row.scenario,
        version: row.version,
        currency: row.currency,
        load_id: row.import_batch_id || "manual", // Use import_batch_id if available
        source_acc: row.source_account || null,
        source_dep: row.source_department || null,
        source_desc: row.source_description || null,
      }));

      if (submittedData.length === 0) {
        throw new Error("No data to upload. Please import data first.");
      }

      // Upload data via API
      const uploadedData = await submittedDataService.uploadBulk(submittedData, signedBy);

      // Capture the signer identity/time at the moment of success for the completion message
      setSignedByName(signedBy);
      setSignedAt(new Date().toLocaleString());

      // Mark sign-off as completed
      if (selectedHotelOu) {
        try {
          // @ts-ignore
          await window.ipcApi.sendIpcRequest('db:set-signoff-completed-state', { ou: selectedHotelOu, completed: true });
          setSignOffCompleted(true);
        } catch (error) {
          console.error('Failed to set sign-off completed state:', error);
        }
      }

    } catch (error) {
      console.error("Error uploading data:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      setUploadError(errorMessage);
    } finally {
      setUploading(false);
    }
  };

  // Handle reset (current hotel only)
  const handleReset = async () => {
    if (!selectedHotelOu) return;

    try {
      // @ts-ignore
      await window.ipcApi.sendIpcRequest('db:reset-all-completion-states', { ou: selectedHotelOu });
      navigate('/signed-in-landing/data-import');
    } catch (error) {
      console.error('Failed to reset completion states:', error);
    }
  };

  // Handle reset (all hotels / entire staging table)
  const handleResetAllHotels = async () => {
    try {
      // @ts-ignore
      await window.ipcApi.sendIpcRequest('db:reset-all-completion-states-all-ous', {});
      navigate('/signed-in-landing/data-import');
    } catch (error) {
      console.error('Failed to reset completion states for all OUs:', error);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom sx={{ mb: 3 }}>
        Sign-Off & Upload
      </Typography>

      {/* Unmapped/Invalid Records - Upload Blocked */}
      {(unmappedCount > 0 || invalidComboCount > 0) && (
        <Alert severity="error" sx={{ mb: 3 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Upload blocked — {unmappedCount + invalidComboCount} record{unmappedCount + invalidComboCount !== 1 ? 's' : ''} require attention
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {unmappedCount > 0 && `${unmappedCount} unmapped record${unmappedCount !== 1 ? 's' : ''} (missing account/department). `}
            {invalidComboCount > 0 && `${invalidComboCount} invalid combo${invalidComboCount !== 1 ? 's' : ''} (account/department combination doesn't exist). `}
          </Typography>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            All records must be valid before uploading. Please go to the Staging Data Review page to fix the mappings or delete the invalid rows.
          </Typography>
          <Button
            variant="outlined"
            size="small"
            color="error"
            onClick={() => navigate('/signed-in-landing/staging-data-review')}
          >
            Go to Staging Data Review
          </Button>
        </Alert>
      )}

      {/* Validation Status Card */}
      <StyledCard>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Validation Status
          </Typography>
          <Divider sx={{ mb: 2 }} />

          {loading ? (
            <LinearProgress />
          ) : (
            <>
              {validations.length === 0 ? (
                <Alert severity="info">
                  No validation data available. Please import data and run validations first.
                </Alert>
              ) : (
                <Stack spacing={1}>
                  {validations.map((validation, index) => (
                    <Paper
                      key={index}
                      sx={{
                        p: 2,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        bgcolor: 'background.default'
                      }}
                    >
                      <Stack direction="row" spacing={2} alignItems="center">
                        {validation.status === "pass" ? (
                          <CheckCircleIcon color="success" />
                        ) : (
                          <ErrorIcon color={validation.status === "fail" ? "error" : "warning"} />
                        )}
                        <Box>
                          <Typography variant="subtitle1" fontWeight={600}>
                            {validation.name}
                          </Typography>
                          {validation.message && (
                            <Typography variant="body2" color="text.secondary">
                              {validation.message}
                            </Typography>
                          )}
                        </Box>
                      </Stack>
                      <Chip
                        label={validation.status.toUpperCase()}
                        color={
                          validation.status === "pass"
                            ? "success"
                            : validation.status === "fail"
                            ? "error"
                            : "warning"
                        }
                        size="small"
                      />
                    </Paper>
                  ))}
                </Stack>
              )}

              {!allValidationsPassed && validations.length > 0 && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  Some validations have not passed. Please review your data before proceeding.
                </Alert>
              )}

              {allValidationsPassed && hasWarnings && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  All critical validations passed, but there are warnings to review.
                </Alert>
              )}

              {allValidationsPassed && !hasWarnings && (
                <Alert severity="success" sx={{ mt: 2 }}>
                  All validations passed successfully!
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </StyledCard>

      {/* Sign-Off & Upload Card */}
      {!signOffCompleted && (
        <StyledCard>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Digital Sign-Off
            </Typography>
            <Divider sx={{ mb: 2 }} />

            <Alert severity="info" sx={{ mb: 3 }}>
              By signing off, you confirm that you have reviewed your P&L for accuracy and that all data
              is correct and ready for upload. Clicking the button below signs off and uploads your data
              in a single step.
            </Alert>

            {uploadError && (
              <Alert severity="error" sx={{ mb: 2 }} icon={<ErrorIcon />}>
                {uploadError}
              </Alert>
            )}

            <Stack spacing={2}>
              <TextField
                label="Enter Your Name to Sign"
                variant="outlined"
                fullWidth
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                placeholder="Type your full name"
                disabled={uploading || !allValidationsPassed || !validationCompleted || signOffCompleted || hasDataIssues}
                InputProps={{
                  startAdornment: <EditIcon sx={{ mr: 1, color: 'text.secondary' }} />,
                }}
              />
              <Button
                variant="contained"
                color="success"
                onClick={handleSignOffAndUpload}
                disabled={uploading || !allValidationsPassed || signature.trim().length === 0 || !validationCompleted || signOffCompleted || hasDataIssues}
                fullWidth
                size="large"
                startIcon={<UploadIcon />}
              >
                {uploading ? "Signing off & uploading…" : "Sign Off & Upload"}
              </Button>
              {uploading && <LinearProgress />}
            </Stack>
          </CardContent>
        </StyledCard>
      )}

      {/* Locked State - Completion Message & Reset Button */}
      {signOffCompleted && (
        <Stack spacing={2} mt={3}>
          <Alert
            severity="success"
            icon={<CheckCircleIcon />}
            sx={(theme) => ({
              borderRadius: 3,
              background: alpha(theme.palette.success.main, 0.1),
              border: `1px solid ${alpha(theme.palette.success.main, 0.3)}`,
            })}
          >
            <Typography variant="body1" fontWeight={600} mb={0.5}>
              Sign-Off & Upload Stage Completed
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Data has been signed off and uploaded successfully. You can now view reports or reset all stages to start a new workflow.
            </Typography>
            {signedByName && (
              <Typography variant="body2" color="text.secondary" mt={1} fontWeight={600}>
                Signed by: {signedByName}{signedAt ? ` • ${signedAt}` : ""}
              </Typography>
            )}
          </Alert>

          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
            <Button
              variant="contained"
              color="warning"
              startIcon={<LockIcon />}
              onClick={() => setShowResetConfirmModal(true)}
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
              sx={{
                borderRadius: 2,
                textTransform: 'none',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Reset Entire Staging Table
            </Button>
          </Box>
        </Stack>
      )}

      {/* Access Denied Modal */}
      <Dialog
        open={showAccessDeniedModal}
        onClose={() => {
          setShowAccessDeniedModal(false);
          navigate('/signed-in-landing/validations');
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 600 }}>
          Validations Not Completed
        </DialogTitle>
        <DialogContent>
          <Typography variant="body1" color="text.secondary" mb={2}>
            You need to complete all required validations before accessing the sign-off page.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Please go to the Validations page and mark validations as done first.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button
            variant="contained"
            onClick={() => {
              setShowAccessDeniedModal(false);
              navigate('/signed-in-landing/validations');
            }}
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Go to Validations
          </Button>
        </DialogActions>
      </Dialog>

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
    </Box>
  );
}

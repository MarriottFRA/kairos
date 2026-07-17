import { useState, useEffect } from "react";
import { Box, Typography, Card, CardContent, Stack, Grid, Button, LinearProgress, Chip } from "@mui/material";
import { styled, alpha } from "@mui/material/styles";
import { useNavigate } from "react-router-dom";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import AssessmentIcon from "@mui/icons-material/Assessment";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import { useSettingsStore } from "../../store/settings";

const StyledCard = styled(Card)(({ theme }) => ({
  height: "100%",
  borderRadius: 16,
  transition: "all 0.3s ease",
  border: `1px solid ${theme.palette.divider}`,
  "&:hover": {
    boxShadow: theme.shadows[4],
    transform: "translateY(-2px)",
  },
}));

const WorkflowCard = styled(Card)<{ active?: boolean; completed?: boolean }>(({ theme, active, completed }) => ({
  borderRadius: 12,
  border: `2px solid ${
    completed
      ? theme.palette.success.main
      : active
      ? theme.palette.primary.main
      : theme.palette.divider
  }`,
  backgroundColor: completed
    ? alpha(theme.palette.success.main, 0.05)
    : active
    ? alpha(theme.palette.primary.main, 0.05)
    : theme.palette.background.paper,
  transition: "all 0.3s ease",
  cursor: "pointer",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  "&:hover": {
    boxShadow: theme.shadows[3],
    transform: "translateY(-2px)",
  },
}));

const StepNumber = styled(Box)<{ active?: boolean; completed?: boolean }>(({ theme, active, completed }) => ({
  width: 48,
  height: 48,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: completed
    ? theme.palette.success.main
    : active
    ? theme.palette.primary.main
    : theme.palette.divider,
  color: completed || active ? theme.palette.common.white : theme.palette.text.secondary,
  fontWeight: 700,
  fontSize: "1.25rem",
}));

export default function Home() {
  const navigate = useNavigate();
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const [workflowProgress, setWorkflowProgress] = useState(0);
  const [loading, setLoading] = useState(true);

  // Workflow completion states
  const [stats, setStats] = useState({
    importCompleted: false,
    validationCompleted: false,
    signOffCompleted: false,
  });

  const workflowSteps = [
    {
      id: 1,
      title: "Import Data",
      description: "Upload your financial data files",
      icon: FileUploadIcon,
      route: "/signed-in-landing/data-import",
      completed: stats.importCompleted,
      active: !stats.importCompleted,
    },
    {
      id: 2,
      title: "Run Validations",
      description: "Ensure data meets requirements",
      icon: CheckCircleIcon,
      route: "/signed-in-landing/validations",
      completed: stats.validationCompleted,
      active: stats.importCompleted && !stats.validationCompleted,
    },
    {
      id: 3,
      title: "Sign-Off & Upload",
      description: "Review reports and submit your data",
      icon: CloudUploadIcon,
      route: "/signed-in-landing/sign-off-upload",
      completed: stats.signOffCompleted,
      active: stats.validationCompleted && !stats.signOffCompleted,
    },
  ];

  // Fetch completion states from database
  useEffect(() => {
    const fetchCompletionStates = async () => {
      if (!selectedHotelOu) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);

        // Fetch all completion states
        // @ts-ignore
        const importResult = await window.ipcApi.sendIpcRequest('db:get-import-completed-state', { ou: selectedHotelOu });
        // @ts-ignore
        const validationResult = await window.ipcApi.sendIpcRequest('db:get-validation-completed-state', { ou: selectedHotelOu });
        // @ts-ignore
        const signOffResult = await window.ipcApi.sendIpcRequest('db:get-signoff-completed-state', { ou: selectedHotelOu });

        setStats({
          importCompleted: importResult?.success ? (importResult.data as boolean) : false,
          validationCompleted: validationResult?.success ? (validationResult.data as boolean) : false,
          signOffCompleted: signOffResult?.success ? (signOffResult.data as boolean) : false,
        });
      } catch (error) {
        console.error('Failed to fetch completion states:', error);
        setStats({
          importCompleted: false,
          validationCompleted: false,
          signOffCompleted: false,
        });
      } finally {
        setLoading(false);
      }
    };

    fetchCompletionStates();
  }, [selectedHotelOu]);

  useEffect(() => {
    // Calculate workflow progress
    const completedSteps = workflowSteps.filter((step) => step.completed).length;
    const progress = (completedSteps / workflowSteps.length) * 100;
    setWorkflowProgress(progress);
  }, [stats]);

  return (
    <Box sx={{ p: 3, maxWidth: 1400, mx: "auto" }}>
      <Box sx={{ mb: 4 }}>
        <Typography variant="h4" fontWeight={700} gutterBottom>
          Welcome to PSLoader
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Track your data submission workflow and monitor progress
        </Typography>
      </Box>

      {/* Workflow Progress */}
      <Card sx={{ mb: 4, borderRadius: 3, border: 1, borderColor: "divider" }}>
        <CardContent sx={{ p: 3 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
            <Typography variant="h6" fontWeight={600}>
              Workflow Progress
            </Typography>
            <Chip
              label={`${Math.round(workflowProgress)}% Complete`}
              color={workflowProgress === 100 ? "success" : "primary"}
              size="small"
            />
          </Stack>
          <LinearProgress
            variant="determinate"
            value={workflowProgress}
            sx={{
              height: 8,
              borderRadius: 4,
              backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.1),
              "& .MuiLinearProgress-bar": {
                borderRadius: 4,
              },
            }}
          />
        </CardContent>
      </Card>

      {/* Workflow Steps */}
      <Grid container spacing={3} sx={{ mb: 4, alignItems: "stretch" }}>
        {workflowSteps.map((step, index) => (
          <Grid item xs={12} sm={6} md={3} key={step.id} sx={{ display: "flex" }}>
            <WorkflowCard
              active={step.active}
              completed={step.completed}
              onClick={() => navigate(step.route)}
            >
              <CardContent sx={{ p: 3 }}>
                <Stack spacing={2}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                    <StepNumber active={step.active} completed={step.completed}>
                      {step.completed ? <CheckCircleIcon /> : step.id}
                    </StepNumber>
                    <step.icon
                      sx={{
                        fontSize: 32,
                        color: step.completed
                          ? "success.main"
                          : step.active
                          ? "primary.main"
                          : "text.disabled",
                      }}
                    />
                  </Stack>
                  <Box>
                    <Typography variant="h6" fontWeight={600} gutterBottom>
                      {step.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {step.description}
                    </Typography>
                  </Box>
                </Stack>
              </CardContent>
            </WorkflowCard>
          </Grid>
        ))}
      </Grid>

      {/* Quick Stats */}
      <Grid container spacing={3}>
        <Grid item xs={12} md={4}>
          <StyledCard>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="overline" color="text.secondary" fontWeight={600}>
                Data Import
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1, mb: 1 }}>
                <Typography variant="h4" fontWeight={700}>
                  {stats.importCompleted ? 'Completed' : 'Not Started'}
                </Typography>
                {stats.importCompleted && <CheckCircleIcon color="success" sx={{ fontSize: 32 }} />}
              </Stack>
              <Button
                size="small"
                endIcon={<ArrowForwardIcon />}
                onClick={() => navigate("/signed-in-landing/data-import")}
                sx={{ mt: 1 }}
              >
                {stats.importCompleted ? 'View Import' : 'Start Import'}
              </Button>
            </CardContent>
          </StyledCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <StyledCard>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="overline" color="text.secondary" fontWeight={600}>
                Validations
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1, mb: 1 }}>
                <Typography variant="h4" fontWeight={700}>
                  {stats.validationCompleted ? 'Completed' : stats.importCompleted ? 'Pending' : 'Locked'}
                </Typography>
                {stats.validationCompleted && <CheckCircleIcon color="success" sx={{ fontSize: 32 }} />}
              </Stack>
              <Button
                size="small"
                endIcon={<ArrowForwardIcon />}
                onClick={() => navigate("/signed-in-landing/validations")}
                sx={{ mt: 1 }}
                disabled={!stats.importCompleted}
              >
                {stats.validationCompleted ? 'View Validations' : 'Run Validations'}
              </Button>
            </CardContent>
          </StyledCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <StyledCard>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="overline" color="text.secondary" fontWeight={600}>
                Sign-Off & Upload
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1, mb: 1 }}>
                <Typography variant="h4" fontWeight={700}>
                  {stats.signOffCompleted ? 'Completed' : stats.validationCompleted ? 'Pending' : 'Locked'}
                </Typography>
                {stats.signOffCompleted && <CheckCircleIcon color="success" sx={{ fontSize: 32 }} />}
              </Stack>
              <Button
                size="small"
                endIcon={<ArrowForwardIcon />}
                onClick={() => navigate("/signed-in-landing/sign-off-upload")}
                sx={{ mt: 1 }}
                disabled={!stats.validationCompleted}
              >
                {stats.signOffCompleted ? 'View Sign-Off' : 'Sign Off & Upload'}
              </Button>
            </CardContent>
          </StyledCard>
        </Grid>
      </Grid>

      {/* Reports Access Card - Always Available */}
      <Box sx={{ mt: 3 }}>
        <StyledCard>
          <CardContent sx={{ p: 3 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Stack direction="row" alignItems="center" spacing={2}>
                <AssessmentIcon sx={{ fontSize: 40, color: "primary.main" }} />
                <Box>
                  <Typography variant="h6" fontWeight={600}>
                    Financial Reports
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    View P&L reports and financial data analysis
                  </Typography>
                </Box>
              </Stack>
              <Button
                variant="contained"
                endIcon={<ArrowForwardIcon />}
                onClick={() => navigate("/signed-in-landing/report")}
                sx={{
                  borderRadius: 2,
                  textTransform: "none",
                  fontWeight: 600,
                }}
              >
                View Reports
              </Button>
            </Stack>
          </CardContent>
        </StyledCard>
      </Box>

      {/* Generate Marriott Excel Report Pack Card */}
      <Box sx={{ mt: 2 }}>
        <StyledCard>
          <CardContent sx={{ p: 3 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Stack direction="row" alignItems="center" spacing={2}>
                <FileDownloadIcon sx={{ fontSize: 40, color: "success.main" }} />
                <Box>
                  <Typography variant="h6" fontWeight={600}>
                    Marriott Excel Report Pack
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Export F90 P&L, room segments, and department details to Excel
                  </Typography>
                </Box>
              </Stack>
              <Button
                variant="outlined"
                color="success"
                endIcon={<ArrowForwardIcon />}
                onClick={() => navigate("/signed-in-landing/excel-export")}
                sx={{
                  borderRadius: 2,
                  textTransform: "none",
                  fontWeight: 600,
                }}
              >
                Generate Export
              </Button>
            </Stack>
          </CardContent>
        </StyledCard>
      </Box>
    </Box>
  );
}

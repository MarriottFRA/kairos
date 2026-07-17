import { Box, Typography, Card, CardContent, Stack } from "@mui/material";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";

export default function Home() {
  return (
    <Box sx={{ p: 3, maxWidth: 1400, mx: "auto" }}>
      <Box sx={{ mb: 4 }}>
        <Typography variant="h4" fontWeight={700} gutterBottom>
          Welcome to Kairos
        </Typography>
        <Typography variant="body1" color="text.secondary">
          You're signed in. This is the starting point for building out the app.
        </Typography>
      </Box>

      <Card sx={{ borderRadius: 3, border: 1, borderColor: "divider" }}>
        <CardContent sx={{ p: 4 }}>
          <Stack direction="row" alignItems="center" spacing={2}>
            <RocketLaunchIcon sx={{ fontSize: 40, color: "primary.main" }} />
            <Box>
              <Typography variant="h6" fontWeight={600}>
                Clean slate
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Authentication and auto-update are wired up. Add new features from here.
              </Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

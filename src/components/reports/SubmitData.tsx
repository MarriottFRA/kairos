/**
 * Submit data — where a hotel will submit its budget. Opened from the top of
 * the Reports rail, but it is not a report: it has none of the settings bar
 * and evaluates nothing.
 *
 * A placeholder (2026-09-10): one Submit page replaced the disabled "Submit
 * budget" button that sat on every report's settings bar. What gets submitted
 * is still being worked out, so nothing here sends anything yet.
 */

import { Box, Paper, Stack, Typography } from "@mui/material";
import SendOutlinedIcon from "@mui/icons-material/SendOutlined";

export interface SubmitDataProps {
  hotelName: string;
}

export default function SubmitData({ hotelName }: SubmitDataProps) {
  return (
    <Box sx={{ maxWidth: 720, pt: 1 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", mb: 2 }}>
        <SendOutlinedIcon color="primary" />
        <Box>
          <Typography variant="h6" component="h1">
            Submit data
          </Typography>
          {hotelName && (
            <Typography variant="body2" color="text.secondary">
              {hotelName}
            </Typography>
          )}
        </Box>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="body1" sx={{ mb: 1 }}>
          This is where your hotel will submit its budget data.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          What needs to be submitted is still being finalised, so nothing can be sent from here yet. Once it is
          settled, this page will show what is included, check it is complete, and send it.
        </Typography>
      </Paper>
    </Box>
  );
}

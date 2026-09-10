/**
 * The Reports beta notice — the banner across the top of the Reports page
 * and the constants that go with it (the "Beta" chip in the drawer, the
 * greyed placeholder reports in the rail).
 *
 * One date, one place (decided 2026-09-09). The banner names the day the
 * testing round is expected to finish, and a date on a screen goes stale the
 * moment it passes — so the copy is written twice and swaps itself over at
 * the end of that day. Nobody should ever read "expected to complete EOD
 * Thursday the 10th" on the 15th; after the date the banner keeps saying
 * Reports are in beta and stops making a promise about when.
 *
 * To move the date, change FINAL_TEST_DAY and FINAL_TEST_LABEL below and
 * nothing else. To end the beta entirely, drop <BetaNotice /> from the
 * Reports page, the badge from the drawer row and the two placeholder rail
 * entries — see reports.tsx and signedinLanding.tsx.
 */

import { Alert, AlertTitle, Box, Typography } from "@mui/material";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";

/** End of this day (local time) is when the round is expected to be done. */
export const FINAL_TEST_DAY = "2026-09-10";
/** How that day is written on screen. Keep the two in step. */
export const FINAL_TEST_LABEL = "Thursday the 10th";

/** True until midnight at the end of FINAL_TEST_DAY, local time. */
export function withinTestWindow(now: Date = new Date()): boolean {
  const [year, month, day] = FINAL_TEST_DAY.split("-").map(Number);
  // Local midnight of the following day: "EOD the 10th" includes all of the 10th.
  return now.getTime() < new Date(year, month - 1, day + 1).getTime();
}

export default function BetaNotice() {
  const testing = withinTestWindow();
  return (
    <Alert severity="info" icon={<ScienceOutlinedIcon fontSize="inherit" />} sx={{ mb: 1 }}>
      <AlertTitle sx={{ mb: 0.25 }}>Reports are in testing</AlertTitle>
      <Box>
        <Typography variant="body2" component="span">
          {testing
            ? `We are testing Reports with the team to find and fix any bugs. The final round of testing is expected to complete end of day ${FINAL_TEST_LABEL}. Figures here should be checked against the BST before they are relied on, and anything that looks wrong is worth reporting — that is what this round is for.`
            : "Reports are still in beta. Figures here should be checked against the BST before they are relied on, and anything that looks wrong is worth reporting."}
        </Typography>{" "}
        <Typography variant="body2" component="span" color="text.secondary">
          Submitting your data will have its own page — Submit data, at the top of the report list.
        </Typography>
      </Box>
    </Alert>
  );
}

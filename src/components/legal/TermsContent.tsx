/**
 * The rendered terms text. Shared by the one-time acceptance gate and the
 * Settings card's "Review terms" dialog so the two can never drift apart.
 */

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { TERMS_SECTIONS, TERMS_VERSION } from "../../shared/legal/terms";

export default function TermsContent() {
  return (
    <Stack spacing={2.5}>
      {TERMS_SECTIONS.map((section) => (
        <Box key={section.heading}>
          <Typography
            variant="subtitle2"
            sx={{ fontWeight: 700, mb: 0.5 }}
          >
            {section.heading}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {section.body}
          </Typography>
        </Box>
      ))}
      <Typography variant="caption" sx={{ color: "text.disabled" }}>
        Terms version {TERMS_VERSION}
      </Typography>
    </Stack>
  );
}

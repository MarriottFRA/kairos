import React from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  Divider,
  Stack,
  Button,
  Link,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import EmailIcon from "@mui/icons-material/Email";
import DescriptionIcon from "@mui/icons-material/Description";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";

export default function HelpSupport() {
  const supportEmail = "emeapowerBIsupport@marriott.com";

  return (
    <Box sx={{ maxWidth: 800, mx: "auto" }}>
      <Typography variant="h4" sx={{ mb: 3, fontWeight: 600 }}>
        Help & Support
      </Typography>
      {/* Contact Support */}
      <Card variant="outlined" sx={{ mb: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
              mb: 2
            }}>
            <EmailIcon color="primary" />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Contact Support
            </Typography>
          </Stack>
          <Divider sx={{ mb: 3 }} />

          <Typography variant="body1" sx={{ mb: 2 }}>
            Need help? Our support team is here to assist you with any questions or issues.
          </Typography>

          <Button
            variant="contained"
            startIcon={<EmailIcon />}
            href={`mailto:${supportEmail}`}
            sx={{
              borderRadius: 1,
              textTransform: "none",
            }}
          >
            Email Support
          </Button>

          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 2
            }}>
            Email: <Link href={`mailto:${supportEmail}`}>{supportEmail}</Link>
          </Typography>
        </CardContent>
      </Card>
      {/* Required Import Files */}
      <Card variant="outlined" sx={{ mb: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
              mb: 2
            }}>
            <DescriptionIcon color="primary" />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Required Import Files
            </Typography>
          </Stack>
          <Divider sx={{ mb: 3 }} />

          <Typography variant="body1" sx={{ mb: 2 }}>
            The following files are required for data import. Detailed instructions on how to obtain and format these files will be provided soon.
          </Typography>

          <List>
            <ListItem sx={{ px: 0 }}>
              <ListItemIcon>
                <InfoOutlinedIcon color="action" />
              </ListItemIcon>
              <ListItemText
                primary="Financial Data File"
                secondary="Details coming soon..."
              />
            </ListItem>
            <ListItem sx={{ px: 0 }}>
              <ListItemIcon>
                <InfoOutlinedIcon color="action" />
              </ListItemIcon>
              <ListItemText
                primary="Room Revenue File"
                secondary="Details coming soon..."
              />
            </ListItem>
            <ListItem sx={{ px: 0 }}>
              <ListItemIcon>
                <InfoOutlinedIcon color="action" />
              </ListItemIcon>
              <ListItemText
                primary="Statistics File"
                secondary="Details coming soon..."
              />
            </ListItem>
          </List>

          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 2,
              fontStyle: "italic"
            }}>
            This section will be updated with detailed file specifications and instructions.
          </Typography>
        </CardContent>
      </Card>
      {/* FAQ / Getting Started */}
      <Card variant="outlined" sx={{ borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
              mb: 2
            }}>
            <HelpOutlineIcon color="primary" />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Getting Started
            </Typography>
          </Stack>
          <Divider sx={{ mb: 3 }} />

          <Typography variant="body1" sx={{ mb: 2 }}>
            New to Kairos? Here are some quick tips to get you started:
          </Typography>

          <List>
            <ListItem sx={{ px: 0 }}>
              <ListItemText
                primary="1. Select your hotel"
                secondary="Go to Settings and select your hotel from the dropdown menu."
              />
            </ListItem>
            <ListItem sx={{ px: 0 }}>
              <ListItemText
                primary="2. Sync your data"
                secondary="Use the Data Synchronization options in Settings to sync mapping configurations and tables."
              />
            </ListItem>
            <ListItem sx={{ px: 0 }}>
              <ListItemText
                primary="3. Import your files"
                secondary="Navigate to Data Import to upload your financial data files."
              />
            </ListItem>
            <ListItem sx={{ px: 0 }}>
              <ListItemText
                primary="4. Review and validate"
                secondary="Check your data in the Validations section before finalizing."
              />
            </ListItem>
          </List>
        </CardContent>
      </Card>
    </Box>
  );
}

import React from 'react';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { alpha, useTheme } from '@mui/material/styles';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { useAccountPortal } from './useAccountPortal';

interface Props {
  /** Primary button label. Defaults to the generic "Open Atlas portal". */
  label?: string;
  /** Tighter spacing for use inside an alert or a menu-sized surface. */
  dense?: boolean;
  /** Stretch the buttons to the container width (terminal auth cards). */
  fullWidth?: boolean;
}

/**
 * The standard "take me to the Atlas portal" control: open in the default
 * browser, copy the link, and the URL in plain text. All three are offered
 * together on purpose — a machine with no default browser, or a locked-down
 * clipboard, still leaves the user a way to reach the portal.
 */
const AccountPortalActions: React.FC<Props> = ({
  label = 'Open Atlas portal',
  dense = false,
  fullWidth = false,
}) => {
  const theme = useTheme();
  const { url, open, copy, copied, failed } = useAccountPortal();

  return (
    <Box sx={{ width: '100%' }}>
      <Stack
        direction={fullWidth ? 'column' : { xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: fullWidth ? 'stretch' : { xs: 'stretch', sm: 'center' } }}
      >
        <Button
          variant="contained"
          size={dense ? 'small' : 'medium'}
          startIcon={<OpenInNewRoundedIcon />}
          onClick={() => void open()}
          fullWidth={fullWidth}
        >
          {label}
        </Button>
        <Button
          variant="outlined"
          size={dense ? 'small' : 'medium'}
          startIcon={copied ? <CheckRoundedIcon /> : <ContentCopyRoundedIcon />}
          onClick={() => void copy()}
          fullWidth={fullWidth}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </Stack>

      {failed && (
        <Typography
          variant="caption"
          sx={{ display: 'block', mt: 1, color: theme.palette.warning.main }}
        >
          Could not open your browser. Copy the link below and paste it in manually.
        </Typography>
      )}

      <Typography
        variant="caption"
        sx={{
          display: 'block',
          mt: dense ? 0.75 : 1.25,
          fontFamily: 'monospace',
          fontSize: '0.72rem',
          wordBreak: 'break-all',
          color: theme.palette.text.secondary,
          userSelect: 'text',
          px: 1,
          py: 0.5,
          borderRadius: 1,
          background: alpha(theme.palette.text.primary, 0.04),
        }}
      >
        {url}
      </Typography>
    </Box>
  );
};

export default AccountPortalActions;

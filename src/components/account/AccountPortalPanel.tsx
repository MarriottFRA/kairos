import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded';
import AccountPortalActions from './AccountPortalActions';

interface Props {
  title: string;
  /** Main explanation. Keep it to a sentence or two. */
  message: string;
  /** Primary button label — e.g. "Register on Atlas", "Request access". */
  actionLabel?: string;
  /** Icon shown in the badge. Defaults to a "launch" glyph. */
  icon?: React.ReactNode;
  /** Badge gradient. Defaults to the Kairos teal accent. */
  accent?: [string, string];
  /** Optional trailing content — e.g. a "Back to Welcome" button. */
  children?: React.ReactNode;
}

/**
 * Full-card "this lives on the Atlas portal" screen, used wherever the desktop
 * app dead-ends on something only the browser can do: registering an account,
 * requesting access, or chasing an approval.
 *
 * It always states that the link opens in the user's default browser, because
 * the app cannot render the portal itself and a button that silently throws
 * the user into another window is disorienting.
 */
const AccountPortalPanel: React.FC<Props> = ({
  title,
  message,
  actionLabel,
  icon,
  accent,
  children,
}) => {
  const theme = useTheme();
  const [from, to] = accent ?? [theme.palette.primary.main, theme.palette.primary.dark];

  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Box
        sx={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: `linear-gradient(135deg, ${from}, ${to})`,
          boxShadow: `0 20px 40px ${from}40`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon ?? <LaunchRoundedIcon sx={{ color: '#ffffff', fontSize: 32 }} />}
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700, textAlign: 'center' }}>
        {title}
      </Typography>

      <Typography
        variant="body2"
        sx={{ textAlign: 'center', color: theme.palette.text.secondary }}
      >
        {message}
      </Typography>

      <AccountPortalActions label={actionLabel} fullWidth />

      <Typography
        variant="caption"
        sx={{ textAlign: 'center', color: theme.palette.text.secondary, opacity: 0.8 }}
      >
        This opens in your default web browser. Sign in there with the same
        company account you use here.
      </Typography>

      {children}
    </Stack>
  );
};

export default AccountPortalPanel;

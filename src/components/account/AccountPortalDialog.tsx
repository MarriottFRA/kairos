import React from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import AccountPortalActions from './AccountPortalActions';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Replaces the default explanation when a specific situation prompted this. */
  message?: string;
  /** Primary button label passed through to the actions. */
  actionLabel?: string;
}

const DEFAULT_MESSAGE =
  'Your account details, access requests and permissions are managed on the ' +
  'Atlas portal. This opens in your default web browser — sign in there with ' +
  'the same company account you use here.';

/**
 * Explains why the browser is about to open, then offers the portal actions.
 * Used where a click should not yank the user out of the app unannounced —
 * the account menu, and the "you don't have access to this" case.
 */
const AccountPortalDialog: React.FC<Props> = ({
  open,
  onClose,
  title = 'Account & access',
  message = DEFAULT_MESSAGE,
  actionLabel,
}) => (
  <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
    <DialogTitle sx={{ fontWeight: 700 }}>{title}</DialogTitle>
    <DialogContent>
      <Stack spacing={2}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {message}
        </Typography>
        <AccountPortalActions label={actionLabel} />
      </Stack>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Close</Button>
    </DialogActions>
  </Dialog>
);

export default AccountPortalDialog;

import React, { Suspense, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import authService, { brokerErrorCode, describeBrokerError } from '../services/auth';
import { useAuthStatus } from '../hooks/useAuthStatus';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
  CircularProgress,
  useMediaQuery,
  Link,
  Divider,
  alpha,
} from '@mui/material';
import { styled, useTheme } from '@mui/material/styles';
import LoginIcon from '@mui/icons-material/Login';
import PersonAddAltRoundedIcon from '@mui/icons-material/PersonAddAltRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';

// Styled Components — Kairos teal aesthetic (lightweight, no WebGL / liquid orbs)
const PageRoot = styled('div')(({ theme }) => ({
  minHeight: '100vh',
  position: 'relative',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',

  background: theme.palette.mode === 'dark'
    ? `radial-gradient(ellipse at top left, #10202a 0%, #0a0d13 45%, #0a0d13 100%)`
    : `radial-gradient(ellipse at top left, #eef4f3 0%, #f4f6f8 45%, #f4f6f8 100%)`,
}));

const HolographicCard = styled(Card)(({ theme }) => ({
  width: '100%',
  maxWidth: 480,
  borderRadius: 24,
  position: 'relative',
  overflow: 'visible',
  backdropFilter: 'blur(20px) saturate(140%)',
  background: theme.palette.mode === 'dark'
    ? alpha('#0f141d', 0.82)
    : alpha('#ffffff', 0.9),
  border: `1px solid ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.14)}`,
  boxShadow: theme.palette.mode === 'dark'
    ? `0 40px 90px -30px rgba(0,0,0,0.6), inset 0 1px 0 ${alpha('#ffffff', 0.06)}`
    : `0 40px 90px -30px ${alpha(theme.palette.primary.main, 0.18)}, inset 0 1px 0 ${alpha('#ffffff', 0.9)}`,
  transition: 'all 0.4s cubic-bezier(0.23, 1, 0.32, 1)',

  '&:hover': {
    transform: 'translateY(-3px)',
    boxShadow: theme.palette.mode === 'dark'
      ? `0 50px 110px -30px rgba(0,0,0,0.7)`
      : `0 50px 110px -30px ${alpha(theme.palette.primary.main, 0.26)}`,
  },
}));

const PremiumButton = styled(Button)(({ theme }) => ({
  borderRadius: 12,
  textTransform: 'none',
  fontWeight: 600,
  fontSize: '1rem',
  letterSpacing: 0.2,
  padding: '14px 32px',
  position: 'relative',
  overflow: 'hidden',
  background: theme.palette.primary.main,
  color: theme.palette.primary.contrastText,
  boxShadow: `0 10px 34px -14px ${alpha(theme.palette.primary.main, 0.9)}`,
  transition: 'all 0.2s ease',

  '&:hover': {
    background: theme.palette.primary.main,
    filter: 'brightness(1.06)',
    transform: 'translateY(-1px)',
  },

  '&:active': {
    transform: 'translateY(0)',
  },

  '&.Mui-disabled': {
    background: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
    opacity: 0.65,
  },
}));

const SecondaryButton = styled(Button)(({ theme }) => ({
  borderRadius: 18,
  textTransform: 'none',
  fontWeight: 600,
  fontSize: '0.95rem',
  letterSpacing: 0.3,
  padding: '14px 28px',
  position: 'relative',
  background: alpha(theme.palette.primary.main, 0.08),
  border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
  backdropFilter: 'blur(10px)',
  transition: 'all 0.3s cubic-bezier(0.23, 1, 0.32, 1)',

  '&:hover': {
    background: alpha(theme.palette.primary.main, 0.12),
    borderColor: alpha(theme.palette.primary.main, 0.3),
    transform: 'translateY(-1px)',
  },
}));

const StyledTextField = styled(TextField)(({ theme }) => ({
  '& .MuiOutlinedInput-root': {
    borderRadius: 16,
    backgroundColor: theme.palette.mode === 'dark'
      ? alpha('#ffffff', 0.05)
      : alpha('#000000', 0.03),
    transition: 'all 0.3s ease',

    '&:hover': {
      backgroundColor: theme.palette.mode === 'dark'
        ? alpha('#ffffff', 0.08)
        : alpha('#000000', 0.05),
    },

    '&.Mui-focused': {
      backgroundColor: theme.palette.mode === 'dark'
        ? alpha('#ffffff', 0.08)
        : '#ffffff',
      boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.1)}`,
    },
  },

  '& .MuiOutlinedInput-notchedOutline': {
    borderColor: alpha(theme.palette.divider, 0.1),
  },

  '& .MuiInputLabel-root': {
    fontWeight: 500,
  },
}));

const BackButton = styled(IconButton)(({ theme }) => ({
  position: 'absolute',
  top: 20,
  left: 20,
  backgroundColor: alpha(theme.palette.background.paper, 0.1),
  backdropFilter: 'blur(10px)',
  border: `1px solid ${alpha(theme.palette.divider, 0.2)}`,
  transition: 'all 0.3s',

  '&:hover': {
    backgroundColor: alpha(theme.palette.background.paper, 0.2),
    transform: 'translateX(-4px)',
  },
}));

const Login: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();

  // The verified company email arrives from the Microsoft entrance on the landing
  // page (router state). If we're here without it (deep link / browser back), we
  // fall back to an in-place "Sign in with Microsoft" button before the password.
  const verifiedEmail = (location.state as { msEmail?: string } | null)?.msEmail;
  const [email, setEmail] = useState(verifiedEmail ?? '');
  const [msVerified, setMsVerified] = useState(!!verifiedEmail);
  const [msVerifying, setMsVerifying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(''); // non-error notices
  // Terminal "waiting for admin approval" message (account requested / pending).
  const [pendingMsg, setPendingMsg] = useState('');

  // Background cold-start resume state — drives the "Continue session" button.
  const { status: authStatus, resolving, resumable } = useAuthStatus();

  // In-place Microsoft verification (fallback when landed here without an email).
  const handleMicrosoftVerify = async () => {
    if (!window.authApi) {
      setError('Auth bridge unavailable. Please restart the app.');
      return;
    }
    setError('');
    setInfo('');
    setMsVerifying(true);
    try {
      const result = await window.authApi.beginMicrosoftSignIn();
      setEmail(result.email);
      setMsVerified(true);
    } catch (err) {
      const code = brokerErrorCode(err);
      if (code !== 'cancelled') {
        setError(
          code
            ? describeBrokerError(code)
            : err instanceof Error
            ? err.message
            : 'Marriott SSO sign-in failed.'
        );
      }
    } finally {
      setMsVerifying(false);
    }
  };

  // Switch account: clear the SWA session (cookies) so a different Microsoft
  // account can sign in, then return to the Welcome page to start over.
  const handleUseDifferentAccount = async () => {
    setError('');
    setInfo('');
    setMsVerified(false);
    setEmail('');
    try {
      await authService.microsoftSignOut();
    } catch {
      /* best-effort */
    }
    navigate('/');
  };

  // Only show "Continue session" once a live session is actually confirmed —
  // never a "Checking…" placeholder that could vanish if the resume fails.
  const showContinueSession = resumable && !resolving && authStatus.isActive;

  const handleContinueSession = () => {
    // A restored session grants full access (device already verified) — go in.
    navigate('/signed-in-landing/home', { replace: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setIsLoading(true);

    try {
      // Passwordless: the broker token (held in main) is the credential.
      await authService.login(email);
      navigate('/auth/device-verify');
    } catch (err: any) {
      console.error('Login error:', err);

      const code = brokerErrorCode(err);
      if (code) {
        // Broker-gate failure — the Microsoft identity step must be redone.
        setError(describeBrokerError(code));
        if (code === 'domain_not_allowed' || code === 'no_principal') {
          setMsVerified(false);
          setEmail('');
        }
        setIsLoading(false);
        return;
      }

      const msg: string = err?.message ?? '';
      if (/not a registered user|not registered/i.test(msg)) {
        // First-time user: request an account with the same broker token, then
        // show the terminal "waiting for approval" screen.
        try {
          await authService.register(email);
          setPendingMsg(
            'Your account has been requested. An administrator must approve it before you can sign in.'
          );
        } catch (regErr: any) {
          const regMsg: string = regErr?.message ?? '';
          if (/pending approval/i.test(regMsg)) {
            setPendingMsg('Your account is pending administrator approval.');
          } else {
            setError(regMsg || 'Could not request an account. Please try again.');
          }
        }
      } else if (/pending approval/i.test(msg)) {
        setPendingMsg('Your account is pending administrator approval.');
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setError('Cannot connect to server. Please check your connection and try again.');
      } else {
        setError(msg || 'Sign-in failed. Please try again.');
      }

      setIsLoading(false);
    }
  };

  return (
    <PageRoot>
      {/* Back button */}
      <BackButton onClick={() => navigate('/')} aria-label="Go back">
        <ArrowBackIcon />
      </BackButton>
      <Box sx={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 480, px: 2 }}>
        <HolographicCard elevation={0}>
          <CardContent sx={{ p: 5 }}>
            <Stack
              spacing={2}
              sx={{
                alignItems: "center",
                mb: 4
              }}>
              <Box
                sx={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: theme.palette.primary.main,
                  boxShadow: `0 20px 40px ${alpha(theme.palette.primary.main, 0.4)}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <LoginIcon sx={{ color: theme.palette.primary.contrastText, fontSize: 28 }} />
              </Box>
              <Typography
                variant="h4"
                sx={{
                  fontWeight: 800,
                  fontSize: '2.2rem',
                  lineHeight: 1.1,
                  background: theme.palette.mode === 'dark'
                    ? `linear-gradient(135deg, #ffffff, ${theme.palette.primary.main})`
                    : `linear-gradient(135deg, #0f1620, ${theme.palette.primary.main})`,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                Welcome Back
              </Typography>
            </Stack>

            <Box sx={{ textAlign: 'center', mb: 4 }}>
              <Typography
                variant="body1"
                sx={{
                  color: theme.palette.text.secondary,
                  opacity: 0.9,
                  fontSize: '1.05rem',
                  fontWeight: 500,
                }}
              >
                Sign in to continue
              </Typography>
            </Box>

            {showContinueSession && (
              <Box sx={{ mb: 3 }}>
                <PremiumButton
                  fullWidth
                  size="large"
                  onClick={handleContinueSession}
                  startIcon={<ShieldRoundedIcon />}
                >
                  Continue session
                </PremiumButton>
                {authStatus.lastUserEmail && (
                  <Typography
                    variant="caption"
                    sx={{
                      display: 'block',
                      textAlign: 'center',
                      mt: 1,
                      color: theme.palette.text.secondary,
                    }}
                  >
                    Resume as {authStatus.lastUserEmail}
                  </Typography>
                )}
                <Divider sx={{ my: 2, fontSize: '0.8rem', color: theme.palette.text.secondary }}>
                  or sign in
                </Divider>
              </Box>
            )}

            {error && (
              <Alert
                severity="error"
                sx={{
                  mb: 3,
                  borderRadius: 4,
                  background: alpha('#ef4444', 0.08),
                  border: `1px solid ${alpha('#ef4444', 0.2)}`,
                  backdropFilter: 'blur(10px)',
                  '& .MuiAlert-icon': {
                    color: '#ef4444',
                  },
                }}
                onClose={() => setError('')}
              >
                {error}
              </Alert>
            )}

            {info && (
              <Alert
                severity="info"
                sx={{ mb: 3, borderRadius: 4, backdropFilter: 'blur(10px)' }}
                onClose={() => setInfo('')}
              >
                {info}
              </Alert>
            )}

            {pendingMsg ? (
              // Terminal state: account requested / pending admin approval. The
              // approval is out-of-band, so this is a clear "wait" screen — no spinner.
              (<Stack spacing={3} sx={{
                alignItems: "center"
              }}>
                <Box
                  sx={{
                    width: 64,
                    height: 64,
                    borderRadius: '50%',
                    background: `linear-gradient(135deg, #f59e0b, #f97316)`,
                    boxShadow: `0 20px 40px rgba(245,158,11,0.35)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <HourglassTopRoundedIcon sx={{ color: '#ffffff', fontSize: 32 }} />
                </Box>
                <Typography variant="h6" sx={{ fontWeight: 700, textAlign: 'center' }}>
                  Awaiting approval
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ textAlign: 'center', color: theme.palette.text.secondary }}
                >
                  {pendingMsg}
                </Typography>
                <PremiumButton fullWidth size="large" onClick={() => navigate('/')}>
                  Back to Welcome
                </PremiumButton>
              </Stack>)
            ) : !msVerified ? (
              // Fallback entrance: reached /login without a verified email (deep
              // link / back). Verify the company Microsoft account in place first.
              (<Stack spacing={3}>
                <Typography
                  variant="body2"
                  sx={{ textAlign: 'center', color: theme.palette.text.secondary }}
                >
                  Verify your company Marriott SSO account to continue.
                </Typography>
                <PremiumButton
                  fullWidth
                  size="large"
                  onClick={handleMicrosoftVerify}
                  disabled={msVerifying}
                  startIcon={
                    msVerifying ? (
                      <CircularProgress size={20} color="inherit" />
                    ) : (
                      <LoginIcon />
                    )
                  }
                >
                  {msVerifying ? 'Verifying with Marriott SSO…' : 'Sign in with Marriott SSO'}
                </PremiumButton>
                <SecondaryButton
                  fullWidth
                  size="large"
                  startIcon={<PersonAddAltRoundedIcon />}
                  onClick={() => navigate('/register')}
                  disabled={msVerifying}
                >
                  Request New Account
                </SecondaryButton>
              </Stack>)
            ) : (
              <form onSubmit={handleSubmit}>
                <Stack spacing={3}>
                  <StyledTextField
                    fullWidth
                    label="Email"
                    type="email"
                    value={email}
                    slotProps={{
                      input: {
                        readOnly: true,
                        endAdornment: (
                          <InputAdornment position="end">
                            <CheckCircleRoundedIcon
                              fontSize="small"
                              sx={{ color: '#10b981' }}
                            />
                          </InputAdornment>
                        ),
                      },
                    }}
                    helperText="Verified via Marriott SSO"
                    autoComplete="email"
                  />

                  <Box sx={{ textAlign: 'center', mt: -1 }}>
                    <Link
                      component="button"
                      type="button"
                      variant="caption"
                      onClick={handleUseDifferentAccount}
                      disabled={isLoading}
                      sx={{
                        color: theme.palette.text.secondary,
                        textDecoration: 'none',
                        fontWeight: 600,
                        cursor: 'pointer',
                        opacity: isLoading ? 0.5 : 1,
                        '&:hover': { textDecoration: 'underline' },
                      }}
                    >
                      Not you? Sign in as a different account
                    </Link>
                  </Box>

                  <PremiumButton
                    fullWidth
                    size="large"
                    type="submit"
                    startIcon={
                      isLoading ? (
                        <CircularProgress size={20} color="inherit" />
                      ) : (
                        <LoginIcon />
                      )
                    }
                    disabled={isLoading}
                  >
                    {isLoading ? 'Signing in…' : 'Continue'}
                  </PremiumButton>
                </Stack>
              </form>
            )}

            <Divider sx={{ my: 3, opacity: 0.2 }} />

            <Stack spacing={2}>
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: 0.8
                }}>
                <LockRoundedIcon fontSize="small" sx={{ color: theme.palette.text.secondary }} />
                <Typography
                  variant="caption"
                  sx={{
                    color: theme.palette.text.secondary,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                  }}
                >
                  Marriott SSO • Device-linked authentication
                </Typography>
              </Stack>

              <Typography
                variant="caption"
                align="center"
                sx={{
                  color: theme.palette.text.secondary,
                  opacity: 0.6,
                  mt: 1,
                }}
              >
                Made by EMEA FR&A
              </Typography>
            </Stack>
          </CardContent>
        </HolographicCard>
      </Box>
    </PageRoot>
  );
};

export default Login;

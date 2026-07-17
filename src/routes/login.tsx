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
import { styled, useTheme, keyframes } from '@mui/material/styles';
import LoginIcon from '@mui/icons-material/Login';
import PersonAddAltRoundedIcon from '@mui/icons-material/PersonAddAltRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import marriottLogo from '../images/marriott_logo.png';

// Animations from landing page
const liquidMorph = keyframes`
  0%, 100% {
    border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%;
    transform: rotate(0deg) scale(1);
  }
  25% {
    border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%;
    transform: rotate(90deg) scale(1.05);
  }
  50% {
    border-radius: 50% 50% 50% 50% / 60% 40% 60% 40%;
    transform: rotate(180deg) scale(0.95);
  }
  75% {
    border-radius: 40% 60% 30% 70% / 70% 30% 60% 40%;
    transform: rotate(270deg) scale(1.02);
  }
`;

const chromaticWave = keyframes`
  0% {
    background-position: 0% 50%;
    filter: hue-rotate(0deg);
  }
  50% {
    background-position: 100% 50%;
    filter: hue-rotate(30deg);
  }
  100% {
    background-position: 0% 50%;
    filter: hue-rotate(0deg);
  }
`;

const hologramPulse = keyframes`
  0%, 100% { opacity: 0.3; transform: scale(1) translateY(0); }
  50% { opacity: 0.6; transform: scale(1.02) translateY(-2px); }
`;

const magneticFloat = keyframes`
  0%, 100% { transform: translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg); }
  25% { transform: translate3d(10px, -15px, 20px) rotateX(5deg) rotateY(10deg); }
  50% { transform: translate3d(-10px, -20px, 30px) rotateX(-5deg) rotateY(-10deg); }
  75% { transform: translate3d(5px, -10px, 15px) rotateX(3deg) rotateY(5deg); }
`;

// Styled Components
const PageRoot = styled('div')(({ theme }) => ({
  minHeight: '100vh',
  position: 'relative',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  perspective: '2000px',
  transformStyle: 'preserve-3d',

  background: theme.palette.mode === 'dark'
    ? `radial-gradient(ellipse at top left, #1a1b3a 0%, #090a1f 25%, #000511 50%, #090a1f 75%, #1a1b3a 100%)`
    : `radial-gradient(ellipse at top left, #f0f4ff 0%, #e8ecff 25%, #dce2ff 50%, #e8ecff 75%, #f0f4ff 100%)`,

  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    background: `conic-gradient(from 180deg at 50% 50%,
      ${alpha('#ff00ff', 0.03)},
      ${alpha('#00ffff', 0.03)},
      ${alpha('#ffff00', 0.03)},
      ${alpha('#ff00ff', 0.03)})`,
    backgroundSize: '400% 400%',
    animation: `${chromaticWave} 20s ease-in-out infinite`,
    mixBlendMode: theme.palette.mode === 'dark' ? 'screen' : 'multiply',
    pointerEvents: 'none',
  },
}));

const LiquidMetalOrbs = styled('div')<{ $reduceMotion: boolean }>(({ theme, $reduceMotion }) => ({
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',

  '.metal-orb': {
    position: 'absolute',
    background: theme.palette.mode === 'dark'
      ? `radial-gradient(circle at 30% 30%,
          ${alpha('#ffffff', 0.8)},
          ${alpha('#8b5cf6', 0.4)},
          ${alpha('#06b6d4', 0.3)},
          ${alpha('#000000', 0.2)})`
      : `radial-gradient(circle at 30% 30%,
          ${alpha('#ffffff', 0.9)},
          ${alpha('#8b5cf6', 0.3)},
          ${alpha('#06b6d4', 0.2)},
          ${alpha('#000000', 0.1)})`,
    filter: 'blur(40px) contrast(1.5)',
    animation: $reduceMotion ? 'none' : `${liquidMorph} 18s ease-in-out infinite`,
    willChange: 'transform, border-radius',
  },

  '.orb1': {
    width: 500,
    height: 500,
    top: '-15%',
    left: '-10%',
    animationDelay: '0s',
  },
  '.orb2': {
    width: 400,
    height: 400,
    bottom: '-10%',
    right: '-8%',
    animationDelay: '-6s',
    animationDuration: '20s',
  },
  '.orb3': {
    width: 350,
    height: 350,
    top: '35%',
    right: '10%',
    animationDelay: '-12s',
    animationDuration: '16s',
  },
}));

const HolographicCard = styled(Card)(({ theme }) => ({
  width: '100%',
  maxWidth: 480,
  borderRadius: 32,
  position: 'relative',
  overflow: 'visible',
  backdropFilter: 'blur(40px) saturate(200%)',
  background: theme.palette.mode === 'dark'
    ? `linear-gradient(135deg,
        ${alpha('#ffffff', 0.08)} 0%,
        ${alpha('#ffffff', 0.03)} 40%,
        ${alpha('#8b5cf6', 0.05)} 100%)`
    : `linear-gradient(135deg,
        ${alpha('#ffffff', 0.95)} 0%,
        ${alpha('#ffffff', 0.85)} 40%,
        ${alpha('#8b5cf6', 0.08)} 100%)`,

  border: `1px solid ${alpha('#ffffff', theme.palette.mode === 'dark' ? 0.15 : 0.25)}`,

  boxShadow: theme.palette.mode === 'dark'
    ? `0 50px 100px -20px rgba(139, 92, 246, 0.25),
       0 30px 60px -30px rgba(6, 182, 212, 0.3),
       inset 0 1px 0 rgba(255, 255, 255, 0.1),
       inset 0 -1px 0 rgba(0, 0, 0, 0.2)`
    : `0 50px 100px -20px rgba(139, 92, 246, 0.15),
       0 30px 60px -30px rgba(6, 182, 212, 0.2),
       inset 0 1px 0 rgba(255, 255, 255, 0.9)`,

  transformStyle: 'preserve-3d',
  transition: 'all 0.6s cubic-bezier(0.23, 1, 0.32, 1)',

  '&:hover': {
    transform: 'translateY(-4px) rotateX(2deg)',
    boxShadow: theme.palette.mode === 'dark'
      ? `0 60px 120px -20px rgba(139, 92, 246, 0.35),
         0 40px 80px -30px rgba(6, 182, 212, 0.4),
         inset 0 1px 0 rgba(255, 255, 255, 0.15)`
      : `0 60px 120px -20px rgba(139, 92, 246, 0.25),
         0 40px 80px -30px rgba(6, 182, 212, 0.3)`,
  },

  '&::before': {
    content: '""',
    position: 'absolute',
    inset: -2,
    borderRadius: 32,
    padding: 2,
    background: `linear-gradient(45deg,
      ${alpha('#ff00ff', 0.3)},
      ${alpha('#00ffff', 0.3)},
      ${alpha('#ffff00', 0.3)},
      ${alpha('#ff00ff', 0.3)})`,
    backgroundSize: '300% 300%',
    animation: `${chromaticWave} 8s ease-in-out infinite`,
    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    WebkitMaskComposite: 'xor',
    maskComposite: 'exclude',
    opacity: theme.palette.mode === 'dark' ? 0.6 : 0.3,
    pointerEvents: 'none',
  },

  '&::after': {
    content: '""',
    position: 'absolute',
    inset: -50,
    background: `radial-gradient(circle at 50% 50%,
      ${alpha('#8b5cf6', 0.1)} 0%,
      transparent 70%)`,
    animation: `${hologramPulse} 4s ease-in-out infinite`,
    pointerEvents: 'none',
    zIndex: -1,
  },
}));

const PremiumButton = styled(Button)(({ theme }) => ({
  borderRadius: 18,
  textTransform: 'none',
  fontWeight: 700,
  fontSize: '1rem',
  letterSpacing: 0.3,
  padding: '16px 32px',
  position: 'relative',
  overflow: 'hidden',
  background: `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`,
  boxShadow: `0 20px 40px -10px rgba(103, 126, 234, 0.35)`,
  transform: 'translateZ(0)',
  transition: 'all 0.3s cubic-bezier(0.23, 1, 0.32, 1)',
  color: 'white',

  '&:hover': {
    transform: 'translateY(-2px) scale(1.02)',
    boxShadow: `0 25px 50px -10px rgba(103, 126, 234, 0.45)`,
    background: `linear-gradient(135deg, #764ba2 0%, #667eea 100%)`,
  },

  '&:active': {
    transform: 'translateY(0) scale(0.98)',
  },

  '&::before': {
    content: '""',
    position: 'absolute',
    top: -2,
    left: -2,
    right: -2,
    bottom: -2,
    background: `linear-gradient(45deg,
      transparent,
      ${alpha('#ffffff', 0.3)},
      transparent)`,
    transform: 'translateX(-100%)',
    transition: 'transform 0.6s',
  },

  '&:hover::before': {
    transform: 'translateX(100%)',
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
      <LiquidMetalOrbs $reduceMotion={false}>
        <div className="metal-orb orb1" />
        <div className="metal-orb orb2" />
        <div className="metal-orb orb3" />
      </LiquidMetalOrbs>

      {/* Back button */}
      <BackButton onClick={() => navigate('/')} aria-label="Go back">
        <ArrowBackIcon />
      </BackButton>

      <Box sx={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 480, px: 2 }}>
        <HolographicCard elevation={0}>
          <CardContent sx={{ p: 5 }}>
            <Stack spacing={2} alignItems="center" sx={{ mb: 4 }}>
              <Box
                sx={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, #667eea, #764ba2)`,
                  boxShadow: `0 20px 40px rgba(118,75,162,0.4)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <LoginIcon sx={{ color: '#ffffff', fontSize: 28 }} />
              </Box>
              <Typography
                variant="h4"
                sx={{
                  fontWeight: 800,
                  fontSize: '2.2rem',
                  lineHeight: 1.1,
                  background: theme.palette.mode === 'dark'
                    ? `linear-gradient(135deg, #ffffff, #c9b8ff)`
                    : `linear-gradient(135deg, #1a1a2e, #764ba2)`,
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
              <Stack spacing={3} alignItems="center">
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
              </Stack>
            ) : !msVerified ? (
              // Fallback entrance: reached /login without a verified email (deep
              // link / back). Verify the company Microsoft account in place first.
              <Stack spacing={3}>
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
              </Stack>
            ) : (
              <form onSubmit={handleSubmit}>
                <Stack spacing={3}>
                  <StyledTextField
                    fullWidth
                    label="Email"
                    type="email"
                    value={email}
                    InputProps={{
                      readOnly: true,
                      endAdornment: (
                        <InputAdornment position="end">
                          <CheckCircleRoundedIcon
                            fontSize="small"
                            sx={{ color: '#10b981' }}
                          />
                        </InputAdornment>
                      ),
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
                alignItems="center"
                justifyContent="center"
                sx={{ opacity: 0.8 }}
              >
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

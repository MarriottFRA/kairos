import React, { Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
  useMediaQuery,
  Link,
  Divider,
} from "@mui/material";
import { alpha, styled, useTheme, keyframes } from "@mui/material/styles";
import LoginIcon from "@mui/icons-material/Login";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import PersonAddAltRoundedIcon from "@mui/icons-material/PersonAddAltRounded";
import HelpOutlineRoundedIcon from "@mui/icons-material/HelpOutlineRounded";
import marriottLogo from "../images/marriott_logo.png";
import { brokerErrorCode, describeBrokerError } from "../services/auth";

// 3D imports
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

// ────────────────────────────────────────────────────────────
// 0) ROUTING + CONSTANTS
// ────────────────────────────────────────────────────────────

const REDIRECT_AFTER_LOGIN = "/signed-in-landing/home";
const SUPPORT_EMAIL = "EMEAReportingSupport@marriott.com";

// window.ipcApi / window.authApi are typed globally (src/renderer.ts,
// src/services/auth.ts) — no local augmentation needed here.

// ────────────────────────────────────────────────────────────
/** 2) PREMIUM ANIMATIONS */
// ────────────────────────────────────────────────────────────

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

const prismShift = keyframes`
  0%, 100% { 
    filter: hue-rotate(0deg) saturate(100%);
    transform: translateZ(0) rotateY(0deg);
  }
  33% { 
    filter: hue-rotate(60deg) saturate(110%);
    transform: translateZ(20px) rotateY(120deg);
  }
  66% { 
    filter: hue-rotate(-60deg) saturate(120%);
    transform: translateZ(-20px) rotateY(240deg);
  }
`;

const hologramPulse = keyframes`
  0%, 100% { opacity: 0.3; transform: scale(1) translateY(0); }
  50% { opacity: 0.6; transform: scale(1.02) translateY(-2px); }
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

const magneticFloat = keyframes`
  0%, 100% { transform: translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg); }
  25% { transform: translate3d(10px, -15px, 20px) rotateX(5deg) rotateY(10deg); }
  50% { transform: translate3d(-10px, -20px, 30px) rotateX(-5deg) rotateY(-10deg); }
  75% { transform: translate3d(5px, -10px, 15px) rotateX(3deg) rotateY(5deg); }
`;

// ────────────────────────────────────────────────────────────
/** 3) STYLED COMPONENTS */
// ────────────────────────────────────────────────────────────

const PageRoot = styled("div")(({ theme }) => ({
  minHeight: "100vh",
  position: "relative",
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  perspective: "2000px",
  transformStyle: "preserve-3d",
  
  // Deep space gradient with metallic undertones
  background: theme.palette.mode === "dark"
    ? `radial-gradient(ellipse at top left, #1a1b3a 0%, #090a1f 25%, #000511 50%, #090a1f 75%, #1a1b3a 100%)`
    : `radial-gradient(ellipse at top left, #f0f4ff 0%, #e8ecff 25%, #dce2ff 50%, #e8ecff 75%, #f0f4ff 100%)`,
  
  "&::before": {
    // Prismatic overlay
    content: '""',
    position: "absolute",
    inset: 0,
    background: `conic-gradient(from 180deg at 50% 50%,
      ${alpha("#ff00ff", 0.03)},
      ${alpha("#00ffff", 0.03)},
      ${alpha("#ffff00", 0.03)},
      ${alpha("#ff00ff", 0.03)})`,
    backgroundSize: "400% 400%",
    animation: `${chromaticWave} 20s ease-in-out infinite`,
    mixBlendMode: theme.palette.mode === "dark" ? "screen" : "multiply",
    pointerEvents: "none",
  },
  
  "&::after": {
    // Noise texture for depth
    content: '""',
    position: "absolute",
    inset: 0,
    opacity: theme.palette.mode === "dark" ? 0.03 : 0.02,
    backgroundImage: `url("data:image/svg+xml,%3Csvg width='100' height='100' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' /%3E%3C/filter%3E%3Crect width='100' height='100' filter='url(%23noise)' /%3E%3C/svg%3E")`,
    pointerEvents: "none",
  },
}));

const LiquidMetalOrbs = styled("div")<{ $reduceMotion: boolean }>(({ theme, $reduceMotion }) => ({
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  
  ".metal-orb": {
    position: "absolute",
    background: theme.palette.mode === "dark"
      ? `radial-gradient(circle at 30% 30%, 
          ${alpha("#ffffff", 0.8)}, 
          ${alpha("#8b5cf6", 0.4)},
          ${alpha("#06b6d4", 0.3)},
          ${alpha("#000000", 0.2)})`
      : `radial-gradient(circle at 30% 30%, 
          ${alpha("#ffffff", 0.9)}, 
          ${alpha("#8b5cf6", 0.3)},
          ${alpha("#06b6d4", 0.2)},
          ${alpha("#000000", 0.1)})`,
    filter: "blur(40px) contrast(1.5)",
    animation: $reduceMotion ? "none" : `${liquidMorph} 18s ease-in-out infinite`,
    willChange: "transform, border-radius",
  },
  
  ".orb1": {
    width: 500,
    height: 500,
    top: "-15%",
    left: "-10%",
    animationDelay: "0s",
  },
  ".orb2": {
    width: 400,
    height: 400,
    bottom: "-10%",
    right: "-8%",
    animationDelay: "-6s",
    animationDuration: "20s",
  },
  ".orb3": {
    width: 350,
    height: 350,
    top: "35%",
    right: "10%",
    animationDelay: "-12s",
    animationDuration: "16s",
  },
}));

const HolographicCard = styled(Card)(({ theme }) => ({
  width: "100%",
  maxWidth: 480,
  borderRadius: 32,
  position: "relative",
  overflow: "visible",
  backdropFilter: "blur(40px) saturate(200%)",
  background: theme.palette.mode === "dark"
    ? `linear-gradient(135deg, 
        ${alpha("#ffffff", 0.08)} 0%, 
        ${alpha("#ffffff", 0.03)} 40%, 
        ${alpha("#8b5cf6", 0.05)} 100%)`
    : `linear-gradient(135deg, 
        ${alpha("#ffffff", 0.95)} 0%, 
        ${alpha("#ffffff", 0.85)} 40%, 
        ${alpha("#8b5cf6", 0.08)} 100%)`,
  
  border: `1px solid ${alpha("#ffffff", theme.palette.mode === "dark" ? 0.15 : 0.25)}`,
  
  boxShadow: theme.palette.mode === "dark"
    ? `0 50px 100px -20px rgba(139, 92, 246, 0.25),
       0 30px 60px -30px rgba(6, 182, 212, 0.3),
       inset 0 1px 0 rgba(255, 255, 255, 0.1),
       inset 0 -1px 0 rgba(0, 0, 0, 0.2)`
    : `0 50px 100px -20px rgba(139, 92, 246, 0.15),
       0 30px 60px -30px rgba(6, 182, 212, 0.2),
       inset 0 1px 0 rgba(255, 255, 255, 0.9)`,
  
  transformStyle: "preserve-3d",
  transition: "all 0.6s cubic-bezier(0.23, 1, 0.32, 1)",
  
  "&:hover": {
    transform: "translateY(-4px) rotateX(2deg)",
    boxShadow: theme.palette.mode === "dark"
      ? `0 60px 120px -20px rgba(139, 92, 246, 0.35),
         0 40px 80px -30px rgba(6, 182, 212, 0.4),
         inset 0 1px 0 rgba(255, 255, 255, 0.15)`
      : `0 60px 120px -20px rgba(139, 92, 246, 0.25),
         0 40px 80px -30px rgba(6, 182, 212, 0.3)`,
  },
  
  // Holographic shimmer
  "&::before": {
    content: '""',
    position: "absolute",
    inset: -2,
    borderRadius: 32,
    padding: 2,
    background: `linear-gradient(45deg,
      ${alpha("#ff00ff", 0.3)},
      ${alpha("#00ffff", 0.3)},
      ${alpha("#ffff00", 0.3)},
      ${alpha("#ff00ff", 0.3)})`,
    backgroundSize: "300% 300%",
    animation: `${chromaticWave} 8s ease-in-out infinite`,
    WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    WebkitMaskComposite: "xor",
    maskComposite: "exclude",
    opacity: theme.palette.mode === "dark" ? 0.6 : 0.3,
    pointerEvents: "none",
  },
  
  // Floating particles effect
  "&::after": {
    content: '""',
    position: "absolute",
    inset: -50,
    background: `radial-gradient(circle at 50% 50%, 
      ${alpha("#8b5cf6", 0.1)} 0%, 
      transparent 70%)`,
    animation: `${hologramPulse} 4s ease-in-out infinite`,
    pointerEvents: "none",
    zIndex: -1,
  },
}));

const PremiumButton = styled(Button)(({ theme }) => ({
  borderRadius: 18,
  textTransform: "none",
  fontWeight: 700,
  fontSize: "1rem",
  letterSpacing: 0.3,
  padding: "16px 32px",
  position: "relative",
  overflow: "hidden",
  background: `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`,
  boxShadow: `0 20px 40px -10px rgba(103, 126, 234, 0.35)`,
  transform: "translateZ(0)",
  transition: "all 0.3s cubic-bezier(0.23, 1, 0.32, 1)",
  
  "&:hover": {
    transform: "translateY(-2px) scale(1.02)",
    boxShadow: `0 25px 50px -10px rgba(103, 126, 234, 0.45)`,
    background: `linear-gradient(135deg, #764ba2 0%, #667eea 100%)`,
  },
  
  "&:active": {
    transform: "translateY(0) scale(0.98)",
  },
  
  "&:focus-visible": {
    outline: `3px solid ${alpha(theme.palette.primary.main, 0.5)}`,
    outlineOffset: 3,
  },
  
  // Magnetic shimmer
  "&::before": {
    content: '""',
    position: "absolute",
    top: -2,
    left: -2,
    right: -2,
    bottom: -2,
    background: `linear-gradient(45deg,
      transparent,
      ${alpha("#ffffff", 0.3)},
      transparent)`,
    transform: "translateX(-100%)",
    transition: "transform 0.6s",
  },
  
  "&:hover::before": {
    transform: "translateX(100%)",
  },
  
  // Glow effect
  "&::after": {
    content: '""',
    position: "absolute",
    inset: -20,
    background: "inherit",
    filter: "blur(20px)",
    opacity: 0.4,
    zIndex: -1,
    transition: "opacity 0.3s",
  },
  
  "&:hover::after": {
    opacity: 0.6,
  },
}));

const SecondaryButton = styled(Button)(({ theme }) => ({
  borderRadius: 18,
  textTransform: "none",
  fontWeight: 600,
  fontSize: "0.95rem",
  letterSpacing: 0.3,
  padding: "14px 28px",
  position: "relative",
  background: alpha(theme.palette.primary.main, 0.08),
  border: `1px solid ${alpha(theme.palette.primary.main, 0.2)}`,
  backdropFilter: "blur(10px)",
  transition: "all 0.3s cubic-bezier(0.23, 1, 0.32, 1)",
  
  "&:hover": {
    background: alpha(theme.palette.primary.main, 0.12),
    borderColor: alpha(theme.palette.primary.main, 0.3),
    transform: "translateY(-1px)",
  },
}));

// ────────────────────────────────────────────────────────────
/** 4) 3D SCENE COMPONENTS */
// ────────────────────────────────────────────────────────────

function ParticleField() {
  const count = 1000;
  const meshRef = useRef<THREE.Points>(null!);
  
  const [positions, sizes] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const siz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 10;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 10;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 10;
      siz[i] = Math.random() * 0.02 + 0.005;
    }
    return [pos, siz];
  }, []);
  
  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    meshRef.current.rotation.x = t * 0.02;
    meshRef.current.rotation.y = t * 0.03;
    
    // Depth-based motion
    const positions = meshRef.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      positions[i3 + 1] += Math.sin(t + i) * 0.001;
    }
    meshRef.current.geometry.attributes.position.needsUpdate = true;
  });
  
  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-size" count={count} array={sizes} itemSize={1} />
      </bufferGeometry>
      <pointsMaterial
        size={0.015}
        sizeAttenuation
        transparent
        opacity={0.6}
        blending={THREE.AdditiveBlending}
        vertexColors={false}
        color="#8b5cf6"
      />
    </points>
  );
}

class Scene3DBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("[landing] 3D scene disabled:", err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Scene3D({ reduceMotion }: { reduceMotion: boolean }) {
  if (reduceMotion) return null;

  return (
    <Box sx={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0 }}>
      <Scene3DBoundary>
        <Canvas
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          camera={{ position: [0, 0, 5], fov: 50 }}
        >
          <Suspense fallback={null}>
            <ParticleField />
          </Suspense>
        </Canvas>
      </Scene3DBoundary>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────
/** 5) HELPER FUNCTIONS */
// ────────────────────────────────────────────────────────────

function getDisplayName(user: any): string {
  if (!user) return "User";
  const claims = user.claims ?? user.idTokenClaims ?? user.userinfo ?? null;
  const fromClaims = claims?.preferred_username || claims?.name || claims?.email;
  const loose = user.preferred_username || user.name || user.email || user.sub;
  return String(fromClaims || loose || "User");
}

// ────────────────────────────────────────────────────────────
/** 6) useIpcAuth Hook */
// ────────────────────────────────────────────────────────────

type AuthState = {
  initialized: boolean;
  loading: boolean;
  isAuthenticated: boolean;
  user: any | null;
  error: string | null;
};

function useIpcAuth() {
  const [state, setState] = useState<AuthState>({
    initialized: false,
    loading: false,
    isAuthenticated: false,
    user: null,
    error: null,
  });

  useEffect(() => {
    let mounted = true;

    // Read the real session status from main (this also drives cold-start
    // resume). A live Level-3 session lets the component redirect straight to
    // the dashboard; otherwise the landing page is shown.
    const check = async () => {
      try {
        if (!window.authApi) {
          if (mounted) {
            setState((s) => ({
              ...s,
              initialized: true,
              error: s.error ?? "Auth bridge unavailable. Please ensure preload exposes window.authApi.",
            }));
          }
          return;
        }
        const status = await window.authApi.getStatus();
        if (!mounted) return;
        const authed = status.securityLevel >= 2;
        setState((s) => ({
          ...s,
          isAuthenticated: authed,
          user: authed ? { securityLevel: status.securityLevel } : null,
          initialized: true,
        }));
      } catch {
        if (mounted) {
          setState((s) => ({
            ...s,
            initialized: true,
            error: "Failed to check authentication status. Please try again.",
          }));
        }
      }
    };

    void check();

    return () => {
      mounted = false;
    };
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const cancelLogin = useCallback(() => {
    setState((s) => ({ ...s, loading: false, error: null }));
  }, []);

  return { ...state, clearError, cancelLogin };
}

// ────────────────────────────────────────────────────────────
/** 7) UI COMPONENTS */
// ────────────────────────────────────────────────────────────

function LoadingOverlay({ message, onCancel }: { message: string; onCancel?: () => void }) {
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        backdropFilter: "blur(8px)",
        background: alpha("#000000", 0.3),
        zIndex: 9999,
      }}
    >
      <Stack alignItems="center" spacing={3}>
        <Box sx={{ position: "relative" }}>
          <CircularProgress
            size={56}
            thickness={2}
            sx={{
              color: "#8b5cf6",
              "& .MuiCircularProgress-circle": {
                strokeLinecap: "round",
              },
            }}
          />
          <Box
            sx={{
              position: "absolute",
              inset: -8,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(139,92,246,0.2), transparent)",
              animation: `${hologramPulse} 2s ease-in-out infinite`,
            }}
          />
        </Box>
        <Typography
          variant="body1"
          sx={{
            color: "#ffffff",
            fontWeight: 500,
            letterSpacing: 0.5,
            textShadow: "0 2px 10px rgba(0,0,0,0.3)",
          }}
        >
          {message}
        </Typography>
        {onCancel && (
          <Button
            variant="outlined"
            size="small"
            onClick={onCancel}
            sx={{
              mt: 1,
              color: "#ffffff",
              borderColor: alpha("#ffffff", 0.3),
              backgroundColor: alpha("#000000", 0.2),
              backdropFilter: "blur(10px)",
              borderRadius: 2,
              textTransform: "none",
              fontSize: "0.85rem",
              fontWeight: 500,
              px: 2,
              py: 1,
              "&:hover": {
                borderColor: alpha("#ffffff", 0.5),
                backgroundColor: alpha("#ffffff", 0.1),
              },
            }}
          >
            Cancel
          </Button>
        )}
      </Stack>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────
/** 8) MAIN COMPONENT */
// ────────────────────────────────────────────────────────────

export default function Landing() {
  const navigate = useNavigate();
  const theme = useTheme();

  const { initialized, loading, isAuthenticated, user, error, clearError, cancelLogin } = useIpcAuth();

  // Microsoft/Entra entrance state. Clicking "Sign in / Register with Microsoft"
  // verifies the company identity via the SWA broker, then routes to the password
  // screen with the verified email locked. The broker token never leaves main.
  const [msVerifying, setMsVerifying] = useState(false);
  const [msError, setMsError] = useState<string | null>(null);

  const runMicrosoftEntrance = useCallback(
    async (target: "/login" | "/register") => {
      if (!window.authApi) {
        setMsError("Auth bridge unavailable. Please restart the app.");
        return;
      }
      setMsError(null);
      setMsVerifying(true);
      try {
        const { email } = await window.authApi.beginMicrosoftSignIn();
        navigate(target, { state: { msEmail: email } });
      } catch (err) {
        const code = brokerErrorCode(err);
        // A cancelled sign-in is a normal user action — no scary error banner.
        if (code !== "cancelled") {
          setMsError(
            code
              ? describeBrokerError(code)
              : err instanceof Error
              ? err.message
              : "Marriott SSO sign-in failed."
          );
        }
      } finally {
        setMsVerifying(false);
      }
    },
    [navigate]
  );

  // Auto-forward once authenticated
  useEffect(() => {
    if (isAuthenticated && user) {
      const t = setTimeout(() => navigate(REDIRECT_AFTER_LOGIN, { replace: true }), 100);
      return () => clearTimeout(t);
    }
  }, [isAuthenticated, user, navigate]);

  return (
    <PageRoot>
      {/* 3D Scene with chrome spheres and particles */}
      <Scene3D reduceMotion={false} />

      {/* Liquid metal morphing background */}
      <LiquidMetalOrbs $reduceMotion={false}>
        <div className="metal-orb orb1" />
        <div className="metal-orb orb2" />
        <div className="metal-orb orb3" />
      </LiquidMetalOrbs>

      {/* Main content */}
      <Box sx={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 480, px: 2 }}>
        <HolographicCard elevation={0}>
          <CardContent sx={{ p: 5 }}>
            {/* Logo and branding */}
            <Stack spacing={2.5} alignItems="center" sx={{ mb: 5 }}>
              <Box
                component="img"
                src={marriottLogo}
                alt="Marriott Logo"
                sx={{
                  width: 72,
                  height: 72,
                  objectFit: "contain",
                  filter: 'drop-shadow(0 4px 12px rgba(0, 102, 178, 0.15))',
                  transition: 'all 0.3s ease',
                  '&:hover': {
                    transform: 'scale(1.05)',
                    filter: 'drop-shadow(0 6px 16px rgba(0, 102, 178, 0.25))',
                  }
                }}
              />
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 500,
                  fontSize: '0.8rem',
                  color: theme.palette.text.secondary,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  opacity: 0.6,
                }}
              >
                PS Loader 2.0
              </Typography>
            </Stack>

            {/* Welcome text */}
            <Box sx={{ textAlign: "center", mb: 4 }}>
              <Typography
                variant="h4"
                sx={{
                  fontWeight: 800,
                  fontSize: "2.2rem",
                  lineHeight: 1.1,
                  mb: 1.5,
                  background: theme.palette.mode === "dark"
                    ? `linear-gradient(135deg, #ffffff, #c9b8ff)`
                    : `linear-gradient(135deg, #1a1a2e, #764ba2)`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {isAuthenticated && user ? "Welcome back" : "Welcome"}
              </Typography>
              <Typography
                variant="body1"
                sx={{
                  color: theme.palette.text.secondary,
                  opacity: 0.9,
                  fontSize: "1.05rem",
                  fontWeight: 500,
                }}
              >
                {isAuthenticated && user
                  ? getDisplayName(user)
                  : "Sign in to access your workspace"}
              </Typography>
            </Box>

            {/* Error alert */}
            {!!error && (
              <Alert
                severity="error"
                sx={{
                  mb: 3,
                  borderRadius: 4,
                  background: alpha("#ef4444", 0.08),
                  border: `1px solid ${alpha("#ef4444", 0.2)}`,
                  backdropFilter: "blur(10px)",
                  "& .MuiAlert-icon": {
                    color: "#ef4444",
                  },
                }}
                onClose={clearError}
                aria-live="assertive"
              >
                {error}
              </Alert>
            )}

            {/* Microsoft sign-in error */}
            {!!msError && (
              <Alert
                severity="error"
                sx={{
                  mb: 3,
                  borderRadius: 4,
                  background: alpha("#ef4444", 0.08),
                  border: `1px solid ${alpha("#ef4444", 0.2)}`,
                  backdropFilter: "blur(10px)",
                  "& .MuiAlert-icon": { color: "#ef4444" },
                }}
                onClose={() => setMsError(null)}
                aria-live="assertive"
              >
                {msError}
              </Alert>
            )}

            {/* Auth buttons */}
            {!isAuthenticated ? (
              <>
                <PremiumButton
                  fullWidth
                  size="large"
                  startIcon={<LoginIcon />}
                  onClick={() => runMicrosoftEntrance("/login")}
                  disabled={loading || msVerifying}
                  aria-label="Sign in with Marriott SSO"
                  sx={{ mb: 2, color: 'white' }}
                >
                  Sign in with Marriott SSO
                </PremiumButton>

                <SecondaryButton
                  fullWidth
                  size="large"
                  startIcon={<PersonAddAltRoundedIcon />}
                  onClick={() => runMicrosoftEntrance("/register")}
                  disabled={loading || msVerifying}
                  sx={{ mb: 3 }}
                >
                  Register with Marriott SSO
                </SecondaryButton>
              </>
            ) : (
              <PremiumButton
                fullWidth
                size="large"
                onClick={() => navigate(REDIRECT_AFTER_LOGIN)}
                sx={{ mb: 3 }}
              >
                Enter Application
              </PremiumButton>
            )}

            <Divider sx={{ my: 3, opacity: 0.2 }} />

            {/* Footer links */}
            <Stack spacing={2}>
              {/* Security badge */}
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
                    textAlign: "center",
                  }}
                >
                  Marriott SSO • Device-linked authentication
                </Typography>
              </Stack>

              {/* Support link */}
              <Stack
                direction="row"
                spacing={0.5}
                alignItems="center"
                justifyContent="center"
              >
                <HelpOutlineRoundedIcon
                  fontSize="small"
                  sx={{ color: theme.palette.text.secondary, opacity: 0.7 }}
                />
                <Typography
                  variant="caption"
                  sx={{ color: theme.palette.text.secondary }}
                >
                  Having issues?{" "}
                  <Link
                    href={`mailto:${SUPPORT_EMAIL}`}
                    sx={{
                      color: theme.palette.primary.main,
                      fontWeight: 600,
                      textDecoration: "none",
                      "&:hover": {
                        textDecoration: "underline",
                      },
                    }}
                  >
                    Contact support
                  </Link>
                </Typography>
              </Stack>

              {/* Powered by */}
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

        {/* Version badge */}
        <Box
          sx={{
            position: "absolute",
            bottom: -50,
            left: "50%",
            transform: "translateX(-50%)",
            px: 2,
            py: 0.5,
            borderRadius: 2,
            background: alpha(theme.palette.background.paper, 0.1),
            backdropFilter: "blur(10px)",
            border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: 0.5,
              opacity: 0.5,
            }}
          >
            v{__APP_VERSION__}
          </Typography>
        </Box>
      </Box>

      {/* Loading overlay */}
      {!initialized ? (
        <LoadingOverlay message="Initializing secure connection..." />
      ) : loading ? (
        <LoadingOverlay message="Authenticating..." onCancel={cancelLogin} />
      ) : msVerifying ? (
        <LoadingOverlay message="Verifying with Marriott SSO…" />
      ) : null}
    </PageRoot>
  );
}
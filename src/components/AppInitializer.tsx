import React, { useEffect, useState } from "react";
import { CircularProgress, Box, Typography } from "@mui/material";
import { useSettingsStore } from "../store/settings";
import UpdateChecker from "./UpdateChecker";
import backgroundSyncService from "../services/backgroundSync";
import authService from "../services/auth";

interface AppInitializerProps {
  children: React.ReactNode;
}

/**
 * AppInitializer Component
 * 1. Checks for updates first (blocking - user must wait for download/install)
 * 2. Kicks off the cold-start session resume in the BACKGROUND (non-blocking —
 *    no splash), then loads settings
 * 3. Renders the main app; the login page surfaces any resumable session via
 *    its "Continue session" affordance
 */
const AppInitializer: React.FC<AppInitializerProps> = ({ children }) => {
  const [updateCheckComplete, setUpdateCheckComplete] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSettingsFromDb = useSettingsStore((s) => s.loadSettingsFromDb);
  const storeInitialized = useSettingsStore((s) => s.initialized);

  // Step 1: Check for updates (blocking)
  const handleUpdateComplete = () => {
    setUpdateCheckComplete(true);
  };

  // Step 2: Initialize app after update check
  useEffect(() => {
    if (!updateCheckComplete) return;

    const initializeApp = async () => {
      try {
        // Start the cold-start resume in the background. bootstrap() returns as
        // soon as the fast local checks are done — the real /auth/refresh runs
        // without blocking, and the login page reacts to its result. No splash.
        await authService.bootstrap();

        // Load settings from database
        await loadSettingsFromDb();

        // Start background sync service
        backgroundSyncService.start();

        // One-shot staging housekeeping: drop rows already mirrored in
        // financial_data. Fire-and-forget — never block app boot.
        if (window.ipcApi) {
          window.ipcApi
            .sendIpcRequest("db:auto-clean-staging", {})
            .catch((err: unknown) => {
              console.warn("[AutoClean] startup trigger failed:", err);
            });
        }

        setIsInitialized(true);
      } catch (err) {
        console.error("Failed to initialize app:", err);
        setError(err instanceof Error ? err.message : "Failed to initialize app");
        // Still mark as initialized to allow app to run with defaults
        setIsInitialized(true);
      }
    };

    // Only initialize if not already done
    if (!storeInitialized && !isInitialized) {
      initializeApp();
    } else if (storeInitialized) {
      setIsInitialized(true);
      // Still start background sync if already initialized
      backgroundSyncService.start();
    }

    // Cleanup: stop background sync on unmount
    return () => {
      backgroundSyncService.stop();
    };
  }, [updateCheckComplete, loadSettingsFromDb, storeInitialized, isInitialized]);

  // Show update checker first (blocks app until update complete)
  if (!updateCheckComplete) {
    return <UpdateChecker onUpdateComplete={handleUpdateComplete} />;
  }

  // Brief, neutral loader while settings load (no session "splash" — the resume
  // runs in the background and surfaces on the login page).
  if (!isInitialized) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: 2,
          bgcolor: "background.default",
        }}
      >
        <CircularProgress size={40} />
        <Typography variant="body2" color="text.secondary">
          Loading…
        </Typography>
      </Box>
    );
  }

  // Show error if initialization failed (optional - you might want to still render the app)
  if (error) {
    // console.warn("App initialized with error:", error);
    // We still render children to allow the app to work with defaults
  }

  return <>{children}</>;
};

export default AppInitializer;

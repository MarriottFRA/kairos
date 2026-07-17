import { useState, useEffect, useCallback } from "react";
import { Button, Snackbar, Alert, alpha, Tooltip } from "@mui/material";
import SyncIcon from "@mui/icons-material/Sync";
import financialDataService from "../services/financialDataService";
import { useSettingsStore } from "../store/settings";

// Cooldown period in seconds
const COOLDOWN_SECONDS = 30;

interface CheckForUpdatesButtonProps {
  onDataUpdated?: () => void;
}

export default function CheckForUpdatesButton({ onDataUpdated }: CheckForUpdatesButtonProps) {
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [notification, setNotification] = useState<{
    open: boolean;
    message: string;
    severity: 'info' | 'success' | 'warning';
  } | null>(null);

  // Check cooldown status on mount and when OU changes
  const checkCooldown = useCallback(async () => {
    if (!selectedHotelOu || typeof window === 'undefined' || !window.ipcApi) return;

    try {
      const response = await window.ipcApi.sendIpcRequest('db:get-financial-data-last-check-timestamp', {
        ou: selectedHotelOu
      });

      if (response.success && response.data) {
        const lastCheck = new Date(response.data as string);
        const now = new Date();
        const secondsSinceLastCheck = Math.floor((now.getTime() - lastCheck.getTime()) / 1000);
        const remaining = Math.max(0, COOLDOWN_SECONDS - secondsSinceLastCheck);
        setCooldownRemaining(remaining);
      } else {
        setCooldownRemaining(0);
      }
    } catch {
      setCooldownRemaining(0);
    }
  }, [selectedHotelOu]);

  useEffect(() => {
    checkCooldown();
  }, [checkCooldown]);

  // Countdown timer
  useEffect(() => {
    if (cooldownRemaining <= 0) return;

    const timer = setInterval(() => {
      setCooldownRemaining(prev => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldownRemaining]);

  const handleCheckForUpdates = async () => {
    if (!selectedHotelOu || checkingForUpdates || cooldownRemaining > 0) return;

    setCheckingForUpdates(true);
    try {
      const result = await financialDataService.importFinancialDataIncremental(selectedHotelOu);

      // Record the check timestamp
      const now = new Date();
      const checkDate = now.toISOString().split('T')[0];
      const checkTimestamp = now.toISOString();
      const checkResult = result.updatedPeriods.length > 0 ? 'updated' : 'up_to_date';

      await window.ipcApi.sendIpcRequest('db:set-financial-data-sync-check', {
        ou: selectedHotelOu,
        checkDate,
        checkTimestamp,
        checkResult
      });

      // Start cooldown
      setCooldownRemaining(COOLDOWN_SECONDS);

      const updated = result.updatedPeriods.length;
      const orphaned = result.orphanedPeriods?.length ?? 0;

      if (updated > 0 || orphaned > 0) {
        const parts: string[] = [];
        if (updated > 0) parts.push(`Updated ${updated} period(s)`);
        if (orphaned > 0) parts.push(`removed ${orphaned} stale period(s) no longer on server`);
        setNotification({
          open: true,
          message: parts.join(', '),
          severity: 'success'
        });
        onDataUpdated?.();
      } else {
        setNotification({
          open: true,
          message: 'All data is up to date',
          severity: 'info'
        });
      }
    } catch (error) {
      setNotification({
        open: true,
        message: 'Failed to check for updates',
        severity: 'warning'
      });
    } finally {
      setCheckingForUpdates(false);
    }
  };

  const isDisabled = checkingForUpdates || !selectedHotelOu || cooldownRemaining > 0;

  const getButtonText = () => {
    if (checkingForUpdates) return 'Checking...';
    if (cooldownRemaining > 0) return `Wait ${cooldownRemaining}s`;
    return 'Check for Updates';
  };

  const button = (
    <Button
      variant="text"
      size="small"
      startIcon={<SyncIcon sx={{ fontSize: 16 }} />}
      onClick={handleCheckForUpdates}
      disabled={isDisabled}
      sx={{
        color: cooldownRemaining > 0 ? 'text.disabled' : 'text.secondary',
        textTransform: 'none',
        fontSize: '0.75rem',
        fontWeight: 400,
        py: 0.25,
        px: 1,
        minHeight: 'auto',
        minWidth: 130,
        '&:hover': {
          backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.08),
        },
      }}
    >
      {getButtonText()}
    </Button>
  );

  return (
    <>
      {cooldownRemaining > 0 ? (
        <Tooltip title="Please wait before checking again" arrow>
          <span>{button}</span>
        </Tooltip>
      ) : (
        button
      )}

      <Snackbar
        open={notification?.open ?? false}
        autoHideDuration={4000}
        onClose={() => setNotification(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          onClose={() => setNotification(null)}
          severity={notification?.severity ?? 'info'}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {notification?.message}
        </Alert>
      </Snackbar>
    </>
  );
}

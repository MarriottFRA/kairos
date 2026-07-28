import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  FormControl,
  FormLabel,
  RadioGroup,
  FormControlLabel,
  Radio,
  Divider,
  Select,
  MenuItem,
  InputLabel,
  Alert,
  CircularProgress,
  Button,
  Stack,
  Slider,
  Switch,
  TextField,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { useSettingsStore } from "../../store/settings";
import authService, { Hotel } from "../../services/auth";
import {
  getMappingTablesStatus,
  rebuildMappingTables,
} from "../../services/mappingTablesService";
import type {
  MappingSyncResult,
  MappingTablesStatus,
} from "../../shared/mappingTables/types";
import LegacyImportCard from "../../components/settings/LegacyImportCard";
import StorageCleanupCard from "../../components/settings/StorageCleanupCard";

export default function Settings() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const uiScaleMode = useSettingsStore((s) => s.uiScaleMode);
  const uiScale = useSettingsStore((s) => s.uiScale);
  const setUiScale = useSettingsStore((s) => s.setUiScale);
  const resetUiScaleToAuto = useSettingsStore((s) => s.resetUiScaleToAuto);
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const setSelectedHotelOu = useSettingsStore((s) => s.setSelectedHotelOu);
  const planningScenarioId = useSettingsStore((s) => s.planningScenarioId);

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [loadingHotels, setLoadingHotels] = useState(false);
  const [hotelsError, setHotelsError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Mapping reference tables (cached account/department maps + combos).
  const [mappingStatus, setMappingStatus] = useState<MappingTablesStatus | null>(
    null
  );
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [mappingMessage, setMappingMessage] = useState<{
    severity: "success" | "info" | "warning" | "error";
    text: string;
  } | null>(null);

  // DEV ONLY: the revealed secure-DB key, fed to the db:browse export so
  // kairos_secure.db can be opened in DB Browser. Gated on import.meta.env.DEV so
  // this whole block — state, handler, and the card below — is dead-code-
  // eliminated from production.
  const [devKeyHex, setDevKeyHex] = useState<string | null>(null);
  const [devKeyError, setDevKeyError] = useState<string | null>(null);

  const handleRevealDevKey = async () => {
    setDevKeyError(null);
    try {
      const envelope: any = await window.ipcApi.sendIpcRequest(
        "app:dev-secure-db-key"
      );
      const { keyHex } = (envelope?.data ?? envelope) as { keyHex: string };
      setDevKeyHex(keyHex);
    } catch (err: any) {
      // Thrown when locked ("sign in first") or in a packaged build.
      setDevKeyError(err?.message || "Could not reveal the secure DB key");
    }
  };

  const loadHotels = async () => {
    try {
      setLoadingHotels(true);
      setHotelsError(null);
      const hotelList = await authService.getHotels();
      setHotels(hotelList);
    } catch (err: any) {
      console.error("Failed to load hotels:", err);
      setHotelsError(err.message || "Failed to load hotels");
    } finally {
      setLoadingHotels(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadHotels();
  }, []);

  const loadMappingStatus = async () => {
    try {
      setMappingStatus(await getMappingTablesStatus());
    } catch (err) {
      console.error("Failed to load mapping tables status:", err);
    }
  };

  useEffect(() => {
    loadMappingStatus();
  }, []);

  const handleRefreshHotels = async () => {
    setIsRefreshing(true);
    await loadHotels();
  };

  const describeOutcome = (result: MappingSyncResult): {
    severity: "success" | "info" | "warning" | "error";
    text: string;
  } => {
    switch (result.outcome) {
      case "synced":
        return { severity: "success", text: "Mapping tables rebuilt from the server." };
      case "up-to-date":
        return { severity: "info", text: "Mapping tables were already up to date." };
      case "unavailable":
        return {
          severity: "warning",
          text: "No mapping tables are published on the server yet.",
        };
      default:
        return {
          severity: "error",
          text: result.message || "Failed to rebuild mapping tables.",
        };
    }
  };

  const handleRebuildMappingTables = async () => {
    setIsRebuilding(true);
    setMappingMessage(null);
    try {
      const result = await rebuildMappingTables();
      setMappingStatus(result.status);
      setMappingMessage(describeOutcome(result));
    } catch (err: any) {
      console.error("Failed to rebuild mapping tables:", err);
      setMappingMessage({
        severity: "error",
        text: err?.message || "Failed to rebuild mapping tables.",
      });
    } finally {
      setIsRebuilding(false);
    }
  };

  // Rebuild database (danger zone): drop & recreate every feature table in both
  // stores from the current schema baseline. Wipes all planning data; keeps the
  // session and app settings. Gated behind an explicit confirmation dialog.
  const [rebuildDbOpen, setRebuildDbOpen] = useState(false);
  const [isRebuildingDb, setIsRebuildingDb] = useState(false);
  const [rebuildDbError, setRebuildDbError] = useState<string | null>(null);

  const handleRebuildDatabase = async () => {
    setIsRebuildingDb(true);
    setRebuildDbError(null);
    try {
      await window.ipcApi.sendIpcRequest("app:rebuild-database");
      // The in-memory renderer state (scenarios, positions, …) is now stale —
      // reload to re-read the freshly rebuilt, empty stores.
      window.location.reload();
    } catch (err: any) {
      console.error("Failed to rebuild database:", err);
      setRebuildDbError(err?.message || "Failed to rebuild the database.");
      setIsRebuildingDb(false);
    }
  };

  const handleThemeChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const mode = event.target.value as "light" | "dark";
    await setThemeMode(mode);
  };

  const handleHotelChange = async (event: any) => {
    const ou = event.target.value;
    await setSelectedHotelOu(ou);
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto" }}>
      <Typography variant="h4" sx={{ mb: 3, fontWeight: 600 }}>
        Settings
      </Typography>
      <Card variant="outlined" sx={{ borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
            Appearance
          </Typography>
          <Divider sx={{ mb: 3 }} />

          <FormControl component="fieldset">
            <FormLabel component="legend" sx={{ mb: 2 }}>
              Theme
            </FormLabel>
            <RadioGroup value={themeMode} onChange={handleThemeChange}>
              <FormControlLabel
                value="light"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body1">Light</Typography>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Clean and bright interface
                    </Typography>
                  </Box>
                }
                sx={{ mb: 1 }}
              />
              <FormControlLabel
                value="dark"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body1">Dark</Typography>
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      Easy on the eyes in low light
                    </Typography>
                  </Box>
                }
              />
            </RadioGroup>
          </FormControl>

          <Divider sx={{ my: 3 }} />

          <FormControl component="fieldset" sx={{ width: "100%" }}>
            <FormLabel component="legend" sx={{ mb: 1 }}>
              Display Scale
            </FormLabel>
            <Stack
              direction="row"
              sx={{
                alignItems: "center",
                justifyContent: "space-between",
                mb: 1
              }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={uiScaleMode === "auto"}
                    onChange={(e) =>
                      e.target.checked ? resetUiScaleToAuto() : setUiScale(uiScale || 1)
                    }
                  />
                }
                label="Auto (fit to window size)"
              />
              <Button
                size="small"
                onClick={() => resetUiScaleToAuto()}
                disabled={uiScaleMode === "auto"}
                sx={{ textTransform: "none" }}
              >
                Reset to Auto
              </Button>
            </Stack>
            <Box sx={{ px: 1 }}>
              <Slider
                value={Math.round((uiScale || 1) * 100)}
                min={50}
                max={100}
                step={5}
                marks={[
                  { value: 50, label: "50%" },
                  { value: 75, label: "75%" },
                  { value: 100, label: "100%" },
                ]}
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => `${v}%`}
                disabled={uiScaleMode === "auto"}
                onChange={(_, v) => setUiScale((v as number) / 100)}
              />
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: "center",
                  justifyContent: "space-between"
                }}>
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  {uiScaleMode === "auto"
                    ? "Automatically sized to the app window — larger windows show the UI at full size, smaller windows scale it down."
                    : `Manual scale: ${Math.round((uiScale || 1) * 100)}%`}
                </Typography>
                <Button
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={() => window.location.reload()}
                  sx={{ textTransform: "none", flexShrink: 0 }}
                >
                  Reload to apply
                </Button>
              </Stack>
            </Box>
          </FormControl>
        </CardContent>
      </Card>
      <Card variant="outlined" sx={{ mt: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Stack
            direction="row"
            sx={{
              justifyContent: "space-between",
              alignItems: "center",
              mb: 2
            }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Hotel Settings
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RefreshIcon />}
              onClick={handleRefreshHotels}
              disabled={isRefreshing}
              sx={{
                borderRadius: 1,
                textTransform: "none",
                minWidth: "auto",
                px: 2,
              }}
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </Stack>
          <Divider sx={{ mb: 3 }} />

          {hotelsError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {hotelsError}
            </Alert>
          )}

          <FormControl fullWidth>
            <InputLabel id="hotel-select-label">Select Hotel OU</InputLabel>
            <Select
              labelId="hotel-select-label"
              id="hotel-select"
              value={selectedHotelOu || ""}
              label="Select Hotel OU"
              onChange={handleHotelChange}
              disabled={loadingHotels}
            >
              <MenuItem value="">
                <em>None</em>
              </MenuItem>
              {hotels.map((hotel) => (
                <MenuItem key={hotel.ou} value={hotel.ou}>
                  <Box>
                    <Typography variant="body1">
                      {hotel.hotel_name} ({hotel.ou})
                    </Typography>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>
                      {hotel.room_count} rooms
                      {hotel.city && hotel.country && ` • ${hotel.city}, ${hotel.country}`}
                      {hotel.currency && ` • ${hotel.currency}`}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
            {loadingHotels && (
              <Box sx={{ display: "flex", justifyContent: "center", mt: 2 }}>
                <CircularProgress size={20} />
              </Box>
            )}
          </FormControl>

          {selectedHotelOu && hotels.find((h) => h.ou === selectedHotelOu) && (
            <>
              <Divider sx={{ my: 3 }} />
              <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>
                Hotel Details
              </Typography>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    fullWidth
                    label="Currency"
                    value={hotels.find((h) => h.ou === selectedHotelOu)?.currency || ""}
                    slotProps={{ input: { readOnly: true } }}
                    variant="outlined"
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    fullWidth
                    label="Country"
                    value={hotels.find((h) => h.ou === selectedHotelOu)?.country || ""}
                    slotProps={{ input: { readOnly: true } }}
                    variant="outlined"
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    fullWidth
                    label="City"
                    value={hotels.find((h) => h.ou === selectedHotelOu)?.city || ""}
                    slotProps={{ input: { readOnly: true } }}
                    variant="outlined"
                  />
                </Grid>
              </Grid>
            </>
          )}
        </CardContent>
      </Card>
      <Card variant="outlined" sx={{ mt: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Stack
            direction="row"
            sx={{
              justifyContent: "space-between",
              alignItems: "center",
              mb: 2,
            }}
          >
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Mapping Tables
            </Typography>
            <Button
              variant="outlined"
              size="small"
              color="warning"
              startIcon={
                isRebuilding ? <CircularProgress size={16} /> : <RefreshIcon />
              }
              onClick={handleRebuildMappingTables}
              disabled={isRebuilding}
              sx={{
                borderRadius: 1,
                textTransform: "none",
                minWidth: "auto",
                px: 2,
              }}
            >
              {isRebuilding ? "Rebuilding..." : "Clear & Rebuild"}
            </Button>
          </Stack>
          <Divider sx={{ mb: 2 }} />

          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            Cached account and department maps plus their valid combinations.
            These sync automatically when the server publishes a new version;
            use Clear &amp; Rebuild to force a fresh download.
          </Typography>

          {mappingMessage && (
            <Alert severity={mappingMessage.severity} sx={{ mb: 2 }}>
              {mappingMessage.text}
            </Alert>
          )}

          <Grid container spacing={2}>
            <Grid size={{ xs: 6, sm: 3 }}>
              <TextField
                fullWidth
                label="Account maps"
                value={mappingStatus?.counts.accountMaps ?? 0}
                slotProps={{ input: { readOnly: true } }}
                variant="outlined"
                size="small"
              />
            </Grid>
            <Grid size={{ xs: 6, sm: 3 }}>
              <TextField
                fullWidth
                label="Department maps"
                value={mappingStatus?.counts.departmentMaps ?? 0}
                slotProps={{ input: { readOnly: true } }}
                variant="outlined"
                size="small"
              />
            </Grid>
            <Grid size={{ xs: 6, sm: 3 }}>
              <TextField
                fullWidth
                label="Combos"
                value={mappingStatus?.counts.combos ?? 0}
                slotProps={{ input: { readOnly: true } }}
                variant="outlined"
                size="small"
              />
            </Grid>
            <Grid size={{ xs: 6, sm: 3 }}>
              <TextField
                fullWidth
                label="Version"
                value={mappingStatus?.version ?? "—"}
                slotProps={{ input: { readOnly: true } }}
                variant="outlined"
                size="small"
              />
            </Grid>
          </Grid>

          {mappingStatus?.lastSyncedAt && (
            <Typography variant="caption" sx={{ color: "text.secondary", mt: 2, display: "block" }}>
              Last synced {new Date(mappingStatus.lastSyncedAt).toLocaleString()}
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* One-shot migration off the Excel tool. Self-contained: everything it
          needs lives under components/settings + main/legacyImport. */}
      <LegacyImportCard
        ou={selectedHotelOu ?? ""}
        scenarioId={planningScenarioId}
      />

      {/* Purge soft-deleted rows from both stores (all hotels). Self-contained:
          everything it needs lives in components/settings + main/maintenance. */}
      <StorageCleanupCard />

      <Card
        variant="outlined"
        sx={{
          mt: 2,
          borderRadius: 2,
          borderColor: "error.main",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        }}
      >
        <CardContent>
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: "center", mb: 2 }}
          >
            <WarningAmberIcon color="error" />
            <Typography variant="h6" sx={{ fontWeight: 600, color: "error.main" }}>
              Danger Zone
            </Typography>
          </Stack>
          <Divider sx={{ mb: 2 }} />

          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
            Rebuild database
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            Drops and recreates the local databases from the current schema. Use
            this only if the app reports a database error that a restart does not
            fix. This <strong>permanently deletes all planning data</strong> —
            every scenario, position, cost component, calendar, budget import,
            KPI driver, block, hotel cluster and any manual input. Your sign-in,
            device, and app settings are kept. This cannot be undone.
          </Typography>

          <Button
            variant="outlined"
            color="error"
            startIcon={<WarningAmberIcon />}
            onClick={() => {
              setRebuildDbError(null);
              setRebuildDbOpen(true);
            }}
            sx={{ textTransform: "none" }}
          >
            Rebuild database…
          </Button>

          {rebuildDbError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {rebuildDbError}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={rebuildDbOpen}
        onClose={() => {
          if (!isRebuildingDb) setRebuildDbOpen(false);
        }}
        maxWidth="xs"
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <WarningAmberIcon color="error" />
          Rebuild database?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes <strong>all planning data</strong> in this
            install — scenarios, positions, cost components, calendars, budget
            imports, KPI drivers, blocks, hotel clusters and manual input. Your
            sign-in and app settings are kept. This cannot be undone.
          </DialogContentText>
          <DialogContentText sx={{ mt: 2 }}>
            The app will reload once the rebuild finishes.
          </DialogContentText>
          {rebuildDbError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {rebuildDbError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setRebuildDbOpen(false)}
            disabled={isRebuildingDb}
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleRebuildDatabase}
            disabled={isRebuildingDb}
            startIcon={
              isRebuildingDb ? <CircularProgress size={16} color="inherit" /> : undefined
            }
            sx={{ textTransform: "none" }}
          >
            {isRebuildingDb ? "Rebuilding…" : "Delete everything & rebuild"}
          </Button>
        </DialogActions>
      </Dialog>

      {import.meta.env.DEV && (
        <Card
          variant="outlined"
          sx={{ mt: 2, borderRadius: 2, borderStyle: "dashed", opacity: 0.9 }}
        >
          <CardContent>
            <Typography
              variant="overline"
              sx={{ color: "text.secondary", fontWeight: 700 }}
            >
              Developer · dev build only
            </Typography>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
              Secure database key
            </Typography>
            <Divider sx={{ mb: 2 }} />

            <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
              Reveals the derived key for <code>kairos_secure.db</code>, assembled
              from this session's local + server halves. Feed it to{" "}
              <code>db:browse</code>, which writes a throwaway SQLCipher copy you
              can open in DB Browser for SQLite (the live store's ChaCha20 scheme
              cannot be opened there directly). One-way and deleted on exit — no
              plaintext ever hits disk. You must be signed in; this control does
              not exist in packaged builds.
            </Typography>

            <Button
              variant="outlined"
              color="warning"
              onClick={handleRevealDevKey}
              sx={{ textTransform: "none" }}
            >
              {devKeyHex ? "Re-reveal key" : "Reveal secure DB key"}
            </Button>

            {devKeyError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {devKeyError}
              </Alert>
            )}

            {devKeyHex && (
              <Box sx={{ mt: 2 }}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", justifyContent: "space-between", mb: 0.5 }}
                >
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    Run this from the repo root:
                  </Typography>
                  <Button
                    size="small"
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        `npm run db:browse -- --key ${devKeyHex}`
                      )
                    }
                    sx={{ textTransform: "none" }}
                  >
                    Copy command
                  </Button>
                </Stack>
                <Box
                  component="pre"
                  sx={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: "0.8125rem",
                    bgcolor: "action.hover",
                    borderRadius: 1,
                    p: 1.5,
                    m: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    userSelect: "all",
                  }}
                >
                  {`npm run db:browse -- --key ${devKeyHex}`}
                </Box>
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      <Box sx={{ mt: 4, textAlign: "center", pb: 2 }}>
        <Typography variant="caption" sx={{
          color: "text.secondary"
        }}>
          Kairos Version {__APP_VERSION__}
        </Typography>
      </Box>
    </Box>
  );
}

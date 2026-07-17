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
  Tooltip,
  IconButton,
  TextField,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import CachedIcon from "@mui/icons-material/Cached";
import SyncIcon from "@mui/icons-material/Sync";
import DownloadIcon from "@mui/icons-material/Download";
import { useSettingsStore } from "../../store/settings";
import authService, { Hotel } from "../../services/auth";
import importConfigService from "../../services/importConfigService";
import mappingConfigService from "../../services/mappingConfigService";
import mappingTablesService from "../../services/mappingTablesService";
import financialDataService from "../../services/financialDataService";

// IPC API types
interface IpcApi {
  sendIpcRequest: (channel: string, ...args: any[]) => Promise<any>;
}

declare global {
  interface Window {
    ipcApi?: IpcApi;
  }
}

export default function Settings() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const uiScaleMode = useSettingsStore((s) => s.uiScaleMode);
  const uiScale = useSettingsStore((s) => s.uiScale);
  const setUiScale = useSettingsStore((s) => s.setUiScale);
  const resetUiScaleToAuto = useSettingsStore((s) => s.resetUiScaleToAuto);
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const setSelectedHotelOu = useSettingsStore((s) => s.setSelectedHotelOu);

  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [loadingHotels, setLoadingHotels] = useState(false);
  const [hotelsError, setHotelsError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [usingCache, setUsingCache] = useState(false);
  const [syncingMappings, setSyncingMappings] = useState(false);
  const [mappingSyncMessage, setMappingSyncMessage] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // Mapping Tables state
  const [mappingTablesVersion, setMappingTablesVersion] = useState<{ version: string; combo_version: string } | null>(null);
  const [checkingVersion, setCheckingVersion] = useState(false);
  const [syncingMappingTables, setSyncingMappingTables] = useState(false);
  const [mappingTablesSyncMessage, setMappingTablesSyncMessage] = useState<{ type: 'success' | 'error' | 'info', message: string } | null>(null);

  // Financial Data Import state
  const [importingFinancialData, setImportingFinancialData] = useState(false);
  const [financialDataImportMessage, setFinancialDataImportMessage] = useState<{ type: 'success' | 'error' | 'info', message: string } | null>(null);
  const [financialDataCount, setFinancialDataCount] = useState<number | null>(null);
  const [lastImportDate, setLastImportDate] = useState<string | null>(null);
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false);

  // Template download state
  const [templateMessage, setTemplateMessage] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  const loadHotels = async (forceRefresh = false) => {
    try {
      setLoadingHotels(true);
      setHotelsError(null);

      let hotelList: Hotel[] = [];

      if (!forceRefresh && window.ipcApi) {
        // Try to get from cache first
        try {
          const cachedHotelsResponse = await window.ipcApi.sendIpcRequest("db:get-cached-hotels");
          if (cachedHotelsResponse?.data) {
            const cachedHotels = JSON.parse(cachedHotelsResponse.data);
            if (cachedHotels && cachedHotels.length > 0) {
              hotelList = cachedHotels;
              setUsingCache(true);
              // console.log("Using cached hotels in settings");
            }
          }
        } catch (cacheError) {
          // console.warn("Failed to get cached hotels:", cacheError);
        }
      }

      // If no cache or force refresh, fetch from API
      if (hotelList.length === 0 || forceRefresh) {
        if (forceRefresh) {
          // Clear cache first if refreshing
          hotelList = await authService.refreshHotelsCache();
        } else {
          hotelList = await authService.getHotels();
        }
        setUsingCache(false);
      }

      setHotels(hotelList);
    } catch (err: any) {
      console.error('Failed to load hotels:', err);
      setHotelsError(err.message || 'Failed to load hotels');
    } finally {
      setLoadingHotels(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadHotels();
    loadMappingTablesVersion();
    loadFinancialDataInfo();
  }, []);

  useEffect(() => {
    // Reload financial data info when selected hotel changes
    if (selectedHotelOu) {
      loadFinancialDataInfo();
    }
  }, [selectedHotelOu]);

  const loadMappingTablesVersion = async () => {
    try {
      const storedVersion = await mappingTablesService.getStoredVersion();
      setMappingTablesVersion(storedVersion);
    } catch (error) {
      // console.warn('Failed to load mapping tables version:', error);
    }
  };

  const loadFinancialDataInfo = async () => {
    if (!selectedHotelOu) {
      setFinancialDataCount(null);
      setLastImportDate(null);
      return;
    }

    try {
      const count = await financialDataService.getStoredDataCount(selectedHotelOu);
      const lastImport = await financialDataService.getLastImportTimestamp(selectedHotelOu);
      setFinancialDataCount(count);
      setLastImportDate(lastImport);
    } catch (error) {
      // console.warn('Failed to load financial data info:', error);
    }
  };

  const handleRefreshHotels = async () => {
    setIsRefreshing(true);
    await loadHotels(true);
  };

  const handleThemeChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const mode = event.target.value as "light" | "dark";
    await setThemeMode(mode);
    // Settings are now saved automatically within setThemeMode
  };

  const handleHotelChange = async (event: any) => {
    const ou = event.target.value;
    await setSelectedHotelOu(ou);
    // Settings are now saved automatically within setSelectedHotelOu
  };

  const handleSyncMappingConfigs = async () => {
    setSyncingMappings(true);
    setMappingSyncMessage(null);

    try {
      // Get the selected hotel OU or use the first one
      let ou = selectedHotelOu;

      if (!ou && hotels.length > 0) {
        ou = hotels[0].ou;
      }

      if (!ou) {
        throw new Error('No hotel selected. Please select a hotel first.');
      }

      // Sync all mapping configs for this OU
      await importConfigService.syncMappingConfigsForOU(ou);

      // Get the count of synced configs
      const configs = await mappingConfigService.getAllStoredMappingConfigs();

      setMappingSyncMessage({
        type: 'success',
        message: `Successfully synced ${configs.length} mapping configuration(s) for ${ou}`
      });
    } catch (err: any) {
      console.error('Failed to sync mapping configs:', err);
      setMappingSyncMessage({
        type: 'error',
        message: err.message || 'Failed to sync mapping configurations'
      });
    } finally {
      setSyncingMappings(false);
      // Clear message after 5 seconds
      setTimeout(() => setMappingSyncMessage(null), 5000);
    }
  };

  const handleCheckMappingTablesVersion = async () => {
    setCheckingVersion(true);
    setMappingTablesSyncMessage(null);

    try {
      const { needsSync, needsComboSync } = await mappingTablesService.checkIfSyncNeeded();

      if (needsSync || needsComboSync) {
        setMappingTablesSyncMessage({
          type: 'info',
          message: 'A new version is available. Click "Sync Mapping Tables" to update.'
        });
      } else {
        setMappingTablesSyncMessage({
          type: 'success',
          message: 'Your mapping tables are up-to-date!'
        });
        // Clear success message after 3 seconds
        setTimeout(() => setMappingTablesSyncMessage(null), 3000);
      }
    } catch (err: any) {
      console.error('Failed to check mapping tables version:', err);
      setMappingTablesSyncMessage({
        type: 'error',
        message: err.message || 'Failed to check version'
      });
    } finally {
      setCheckingVersion(false);
    }
  };

  const handleSyncMappingTables = async () => {
    setSyncingMappingTables(true);
    setMappingTablesSyncMessage(null);

    try {
      const synced = await mappingTablesService.syncMappingTables(true);

      if (synced) {
        // Reload version
        await loadMappingTablesVersion();

        setMappingTablesSyncMessage({
          type: 'success',
          message: 'Mapping tables synced successfully!'
        });
      } else {
        setMappingTablesSyncMessage({
          type: 'success',
          message: 'Mapping tables are already up-to-date.'
        });
      }

      // Clear message after 5 seconds
      setTimeout(() => setMappingTablesSyncMessage(null), 5000);
    } catch (err: any) {
      console.error('Failed to sync mapping tables:', err);
      setMappingTablesSyncMessage({
        type: 'error',
        message: err.message || 'Failed to sync mapping tables'
      });
    } finally {
      setSyncingMappingTables(false);
    }
  };

  const handleImportFinancialData = async () => {
    if (!selectedHotelOu) {
      setFinancialDataImportMessage({
        type: 'error',
        message: 'Please select a hotel first'
      });
      return;
    }

    setImportingFinancialData(true);
    setFinancialDataImportMessage(null);

    try {
      // Try incremental sync first (only fetches changed periods)
      const result = await financialDataService.importFinancialDataIncremental(selectedHotelOu);

      setFinancialDataImportMessage({
        type: 'success',
        message: result.message
      });

      // Reload financial data info
      await loadFinancialDataInfo();

      // Clear message after 5 seconds
      setTimeout(() => setFinancialDataImportMessage(null), 5000);
    } catch (err: any) {
      console.error('Incremental sync failed, falling back to full import:', err);

      // Fallback to full import if incremental sync fails
      try {
        const result = await financialDataService.importFinancialData(selectedHotelOu);

        setFinancialDataImportMessage({
          type: 'success',
          message: result.message
        });

        await loadFinancialDataInfo();
        setTimeout(() => setFinancialDataImportMessage(null), 5000);
      } catch (fallbackErr: any) {
        console.error('Failed to import financial data:', fallbackErr);
        setFinancialDataImportMessage({
          type: 'error',
          message: fallbackErr.message || 'Failed to import financial data'
        });
      }
    } finally {
      setImportingFinancialData(false);
    }
  };

  // Nuclear recovery path: discards all locally synced financial_data for
  // the selected OU and re-fetches everything from the server. Routine
  // updates are handled automatically by importFinancialDataIncremental
  // (orphan-period delete + byte-equality refetch). This button exists as
  // a confidence/escape hatch for the rare case where sync state drifts in
  // a way the incremental reconciliation can't detect (e.g. backend
  // updates a row without bumping last_updated). Staging is NOT touched.
  const handleRebuildFromServer = async () => {
    if (!selectedHotelOu) {
      setFinancialDataImportMessage({
        type: 'error',
        message: 'Please select a hotel first'
      });
      return;
    }

    setRebuildConfirmOpen(false);
    setImportingFinancialData(true);
    setFinancialDataImportMessage(null);

    try {
      const result = await financialDataService.importFinancialDataFull(selectedHotelOu);

      setFinancialDataImportMessage({
        type: 'success',
        message: `Rebuilt from server: ${result.message}`
      });

      await loadFinancialDataInfo();
      setTimeout(() => setFinancialDataImportMessage(null), 5000);
    } catch (err: any) {
      console.error('Failed to rebuild financial data from server:', err);
      setFinancialDataImportMessage({
        type: 'error',
        message: err.message || 'Failed to rebuild financial data from server'
      });
    } finally {
      setImportingFinancialData(false);
    }
  };

  const handleDownloadTemplate = async (templateId: string) => {
    setTemplateMessage(null);
    try {
      if (!window.ipcApi) {
        setTemplateMessage({ type: 'error', message: 'IPC not available' });
        return;
      }

      const response = await window.ipcApi.sendIpcRequest('template:download-csv', { templateId });

      if (response.success && response.data?.filePath) {
        setTemplateMessage({
          type: 'success',
          message: `Template saved to: ${response.data.filePath}`
        });
        setTimeout(() => setTemplateMessage(null), 5000);
      } else if (response.error === 'Save cancelled by user') {
        // Don't show error for user cancel
      } else {
        setTemplateMessage({
          type: 'error',
          message: response.error || 'Failed to save template'
        });
      }
    } catch (err: any) {
      setTemplateMessage({
        type: 'error',
        message: err.message || 'An error occurred'
      });
    }
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
            <RadioGroup
              value={themeMode}
              onChange={handleThemeChange}
            >
              <FormControlLabel
                value="light"
                control={<Radio />}
                label={
                  <Box>
                    <Typography variant="body1">Light</Typography>
                    <Typography variant="body2" color="text.secondary">
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
                    <Typography variant="body2" color="text.secondary">
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
              alignItems="center"
              justifyContent="space-between"
              sx={{ mb: 1 }}
            >
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
                alignItems="center"
                justifyContent="space-between"
                spacing={1}
              >
                <Typography variant="caption" color="text.secondary">
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
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Hotel Settings
              </Typography>
              {usingCache && (
                <Tooltip title="Using cached data">
                  <CachedIcon fontSize="small" color="action" />
                </Tooltip>
              )}
            </Stack>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RefreshIcon />}
              onClick={handleRefreshHotels}
              disabled={isRefreshing}
              sx={{
                borderRadius: 1,
                textTransform: 'none',
                minWidth: 'auto',
                px: 2,
              }}
            >
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
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
              value={selectedHotelOu || ''}
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
                    <Typography variant="caption" color="text.secondary">
                      {hotel.room_count} rooms
                      {hotel.city && hotel.country && ` • ${hotel.city}, ${hotel.country}`}
                      {hotel.currency && ` • ${hotel.currency}`}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
            {loadingHotels && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <CircularProgress size={20} />
              </Box>
            )}
          </FormControl>

          {selectedHotelOu && hotels.find(h => h.ou === selectedHotelOu) && (
            <>
              <Divider sx={{ my: 3 }} />
              <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 600 }}>
                Hotel Details
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Currency"
                    value={hotels.find(h => h.ou === selectedHotelOu)?.currency || ''}
                    InputProps={{
                      readOnly: true,
                    }}
                    variant="outlined"
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Country"
                    value={hotels.find(h => h.ou === selectedHotelOu)?.country || ''}
                    InputProps={{
                      readOnly: true,
                    }}
                    variant="outlined"
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="City"
                    value={hotels.find(h => h.ou === selectedHotelOu)?.city || ''}
                    InputProps={{
                      readOnly: true,
                    }}
                    variant="outlined"
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Local ID 1"
                    value={hotels.find(h => h.ou === selectedHotelOu)?.local_id_1 || ''}
                    InputProps={{
                      readOnly: true,
                    }}
                    variant="outlined"
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Local ID 2"
                    value={hotels.find(h => h.ou === selectedHotelOu)?.local_id_2 || ''}
                    InputProps={{
                      readOnly: true,
                    }}
                    variant="outlined"
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Local ID 3"
                    value={hotels.find(h => h.ou === selectedHotelOu)?.local_id_3 || ''}
                    InputProps={{
                      readOnly: true,
                    }}
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
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
            Data Synchronization
          </Typography>
          <Divider sx={{ mb: 3 }} />

          {mappingSyncMessage && (
            <Alert severity={mappingSyncMessage.type} sx={{ mb: 2 }}>
              {mappingSyncMessage.message}
            </Alert>
          )}

          <Box sx={{ mb: 4 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              Mapping Configurations
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Sync all mapping configurations from the server for the selected hotel. This includes all mapping rules used for data imports.
            </Typography>
            <Button
              variant="outlined"
              startIcon={syncingMappings ? <CircularProgress size={20} /> : <SyncIcon />}
              onClick={handleSyncMappingConfigs}
              disabled={syncingMappings || !selectedHotelOu}
              sx={{
                borderRadius: 1,
                textTransform: 'none',
              }}
            >
              {syncingMappings ? 'Syncing...' : 'Sync Mapping Configs'}
            </Button>
            {!selectedHotelOu && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Please select a hotel first
              </Typography>
            )}
          </Box>

          <Divider sx={{ my: 3 }} />

          {mappingTablesSyncMessage && (
            <Alert severity={mappingTablesSyncMessage.type} sx={{ mb: 2 }}>
              {mappingTablesSyncMessage.message}
            </Alert>
          )}

          <Box>
            <Typography variant="body1" sx={{ mb: 1 }}>
              Mapping Tables (Account/Department Hierarchies)
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Reference data for account and department hierarchies from the server (ID=1 config). This data is synced automatically on startup.
            </Typography>

            {mappingTablesVersion && (
              <Box sx={{ mb: 2, p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
                <Grid container spacing={2}>
                  <Grid item xs={12} sm={6}>
                    <Typography variant="caption" color="text.secondary">
                      Account/Department Version
                    </Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {mappingTablesVersion.version}
                    </Typography>
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <Typography variant="caption" color="text.secondary">
                      Combos Version
                    </Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {mappingTablesVersion.combo_version}
                    </Typography>
                  </Grid>
                </Grid>
              </Box>
            )}

            <Stack direction="row" spacing={2}>
              <Button
                variant="outlined"
                startIcon={checkingVersion ? <CircularProgress size={20} /> : <RefreshIcon />}
                onClick={handleCheckMappingTablesVersion}
                disabled={checkingVersion || syncingMappingTables}
                sx={{
                  borderRadius: 1,
                  textTransform: 'none',
                }}
              >
                {checkingVersion ? 'Checking...' : 'Check for Updates'}
              </Button>
              <Button
                variant="contained"
                startIcon={syncingMappingTables ? <CircularProgress size={20} /> : <SyncIcon />}
                onClick={handleSyncMappingTables}
                disabled={syncingMappingTables || checkingVersion}
                sx={{
                  borderRadius: 1,
                  textTransform: 'none',
                }}
              >
                {syncingMappingTables ? 'Syncing...' : 'Sync Mapping Tables'}
              </Button>
            </Stack>
          </Box>
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ mt: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
            Financial Data Import
          </Typography>
          <Divider sx={{ mb: 3 }} />

          {financialDataImportMessage && (
            <Alert severity={financialDataImportMessage.type} sx={{ mb: 2 }}>
              {financialDataImportMessage.message}
            </Alert>
          )}

          <Box>
            <Typography variant="body1" sx={{ mb: 1 }}>
              Import Actuals, Budget & Forecast Data
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Import historical actuals, budget, and forecast data from the server for the selected hotel. This data will be stored locally for faster report generation.
            </Typography>

            {selectedHotelOu && financialDataCount !== null && (
              <Box sx={{ mb: 2, p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
                <Grid container spacing={2}>
                  <Grid item xs={12} sm={6}>
                    <Typography variant="caption" color="text.secondary">
                      Records Stored for {selectedHotelOu}
                    </Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {financialDataCount.toLocaleString()}
                    </Typography>
                  </Grid>
                  {lastImportDate && (
                    <Grid item xs={12} sm={6}>
                      <Typography variant="caption" color="text.secondary">
                        Last Import
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {new Date(lastImportDate).toLocaleString()}
                      </Typography>
                    </Grid>
                  )}
                </Grid>
              </Box>
            )}

            <Stack direction="row" spacing={2}>
              <Button
                variant="contained"
                startIcon={importingFinancialData ? <CircularProgress size={20} /> : <DownloadIcon />}
                onClick={handleImportFinancialData}
                disabled={importingFinancialData || !selectedHotelOu}
                sx={{
                  borderRadius: 1,
                  textTransform: 'none',
                }}
              >
                {importingFinancialData ? 'Importing...' : 'Import Financial Data'}
              </Button>
            </Stack>
            {!selectedHotelOu && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Please select a hotel first
              </Typography>
            )}

            <Box sx={{ mt: 4, pt: 3, borderTop: '1px dashed', borderColor: 'divider' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
                Recovery
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                Use only if data appears out of sync. Routine updates are handled automatically.
                This action discards all locally synced data for the selected hotel and re-downloads
                from the server. Your staging data and imported files are not affected.
              </Typography>
              <Button
                variant="outlined"
                color="warning"
                onClick={() => setRebuildConfirmOpen(true)}
                disabled={importingFinancialData || !selectedHotelOu}
                sx={{
                  borderRadius: 1,
                  textTransform: 'none',
                }}
              >
                Rebuild from Server
              </Button>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Dialog
        open={rebuildConfirmOpen}
        onClose={() => setRebuildConfirmOpen(false)}
        aria-labelledby="rebuild-confirm-title"
      >
        <DialogTitle id="rebuild-confirm-title">Rebuild financial data from server?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will discard all locally synced financial data for the selected hotel and
            re-download everything from the server. Your staging data and imported files
            will not be affected.
          </DialogContentText>
          <DialogContentText sx={{ mt: 2, fontWeight: 500 }}>
            Continue?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRebuildConfirmOpen(false)} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            onClick={handleRebuildFromServer}
            color="warning"
            variant="contained"
            sx={{ textTransform: 'none' }}
          >
            Rebuild from Server
          </Button>
        </DialogActions>
      </Dialog>

      <Card variant="outlined" sx={{ mt: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
            Import Templates
          </Typography>
          <Divider sx={{ mb: 3 }} />

          {templateMessage && (
            <Alert severity={templateMessage.type} sx={{ mb: 2 }} onClose={() => setTemplateMessage(null)}>
              {templateMessage.message}
            </Alert>
          )}

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Download blank CSV templates for manual data entry. Open the file, populate your data, and import it through the Data Import page.
            </Typography>

            <Stack direction="row" spacing={2}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<DownloadIcon />}
                onClick={() => handleDownloadTemplate('line_items')}
                sx={{
                  borderRadius: 1,
                  textTransform: 'none',
                }}
              >
                Line Items Template
              </Button>
              <Button
                variant="outlined"
                size="small"
                startIcon={<DownloadIcon />}
                onClick={() => handleDownloadTemplate('worksheet_line_items')}
                sx={{
                  borderRadius: 1,
                  textTransform: 'none',
                }}
              >
                Worksheet Template
              </Button>
            </Stack>
          </Box>
        </CardContent>
      </Card>

      <Box sx={{ mt: 4, textAlign: 'center', pb: 2 }}>
        <Typography variant="caption" color="text.secondary">
          PS Loader Version {__APP_VERSION__}
        </Typography>
      </Box>
    </Box>
  );
}
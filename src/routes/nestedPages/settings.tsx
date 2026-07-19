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
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useSettingsStore } from "../../store/settings";
import authService, { Hotel } from "../../services/auth";

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

  const handleRefreshHotels = async () => {
    setIsRefreshing(true);
    await loadHotels();
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

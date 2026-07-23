// Import specific React and ReactDOM functions
import React, { useState, useEffect, useCallback, useRef  } from "react";
import { styled, useTheme, Theme, CSSObject } from "@mui/material/styles";
// Import specific components from react-router-dom
import { Routes, Route, Outlet, Link, useNavigate, useMatches } from "react-router-dom";
import Button from "@mui/material/Button";
import MuiAppBar, { AppBarProps as MuiAppBarProps } from "@mui/material/AppBar";
import MuiDrawer from "@mui/material/Drawer";
import CssBaseline from "@mui/material/CssBaseline";
import List from "@mui/material/List";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import MenuIcon from "@mui/icons-material/Menu";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import CheckIcon from "@mui/icons-material/Check";
import RefreshIcon from "@mui/icons-material/Refresh";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Toolbar from "@mui/material/Toolbar";
import Box from "@mui/material/Box";
import HomeIcon from "@mui/icons-material/Home";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import InsightsIcon from "@mui/icons-material/Insights";
import EditNoteIcon from "@mui/icons-material/EditNote";
import BadgeIcon from "@mui/icons-material/Badge";
import AssessmentIcon from "@mui/icons-material/Assessment";
import ApartmentIcon from "@mui/icons-material/Apartment";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import LogoutIcon from "@mui/icons-material/Logout";
import Avatar from "@mui/material/Avatar";
import SettingsIcon from "@mui/icons-material/Settings";
import PersonIcon from "@mui/icons-material/Person";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlined";
import Tooltip from "@mui/material/Tooltip";
import { alpha } from "@mui/material/styles";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import ThemeToggle from "./customComponents/themeToggle";
import { useSettingsStore } from "../store/settings";
import PlanningContextPicker from "../components/positions/PlanningContextPicker";
import { contextChipSx } from "../components/ContextChip";
import authService, { Hotel } from "../services/auth";
import { syncMappingTables } from "../services/mappingTablesService";

// window.ipcApi / window.authApi are typed globally (src/renderer.ts,
// src/services/auth.ts) — no local augmentation needed here.

// Custom styled components for modern menu
const StyledMenu = styled(Menu)(({ theme }) => ({
  '& .MuiPaper-root': {
    borderRadius: 12,
    marginTop: theme.spacing(1),
    minWidth: 280,
    boxShadow: '0px 5px 25px rgba(0,0,0,0.15)',
    '& .MuiMenu-list': {
      padding: '8px',
    },
  },
}));

const StyledMenuItem = styled(MenuItem)(({ theme }) => ({
  borderRadius: 8,
  padding: '10px 12px',
  margin: '2px 0',
  '&:hover': {
    backgroundColor: alpha(theme.palette.primary.main, 0.08),
  },
  '& .MuiListItemIcon-root': {
    minWidth: 36,
  },
}));

const UserInfoSection = styled(Box)(({ theme }) => ({
  padding: theme.spacing(2),
  borderBottom: `1px solid ${theme.palette.divider}`,
  display: 'flex',
  alignItems: 'center',
  gap: theme.spacing(2),
}));

export default function SignedInLanding() {
  const drawerWidth = 240;

  const openedMixin = (theme: Theme): CSSObject => ({
    width: drawerWidth,
    transition: theme.transitions.create("width", {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
    overflowX: "hidden",
  });

  const closedMixin = (theme: Theme): CSSObject => ({
    transition: theme.transitions.create("width", {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen,
    }),
    overflowX: "hidden",
    width: `calc(${theme.spacing(7)} + 1px)`,
    [theme.breakpoints.up("sm")]: {
      width: `calc(${theme.spacing(8)} + 1px)`,
    },
  });

  const DrawerHeader = styled("div")(({ theme }) => ({
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: theme.spacing(0, 1),
    // necessary for content to be below app bar
    minHeight: 48,
    height: 48,
  }));

  interface AppBarProps extends MuiAppBarProps {
    open?: boolean;
  }

  const AppBar = styled(MuiAppBar, {
    shouldForwardProp: (prop) => prop !== "open",
  })<AppBarProps>(({ theme }) => ({
    zIndex: theme.zIndex.drawer + 1,
    transition: theme.transitions.create(["width", "margin"], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen,
    }),
    backgroundColor: theme.palette.background.paper,
    color: theme.palette.text.primary,
    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
    variants: [
      {
        props: ({ open }) => open,
        style: {
          marginLeft: drawerWidth,
          width: `calc(100% - ${drawerWidth}px)`,
          transition: theme.transitions.create(["width", "margin"], {
            easing: theme.transitions.easing.sharp,
            duration: theme.transitions.duration.enteringScreen,
          }),
        },
      },
    ],
  }));

  const Drawer = styled(MuiDrawer, { shouldForwardProp: (prop) => prop !== "open" })(({ theme }) => ({
    width: drawerWidth,
    flexShrink: 0,
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    variants: [
      {
        props: ({ open }) => open,
        style: {
          ...openedMixin(theme),
          "& .MuiDrawer-paper": openedMixin(theme),
        },
      },
      {
        props: ({ open }) => !open,
        style: {
          ...closedMixin(theme),
          "& .MuiDrawer-paper": closedMixin(theme),
        },
      },
    ],
  }));

  const theme = useTheme();
  const [open, setOpen] = React.useState(true);
  const [user, setUser] = useState<any>(null);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [currentHotelName, setCurrentHotelName] = useState<string>('');
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const setSelectedHotelOu = useSettingsStore((s) => s.setSelectedHotelOu);
  const navigate = useNavigate();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const accountMenuOpen = Boolean(anchorEl);

  const [hotelAnchorEl, setHotelAnchorEl] = useState<null | HTMLElement>(null);
  const hotelMenuOpen = Boolean(hotelAnchorEl);

  // Determine page title from route handle metadata
  const matches = useMatches();
  const pageTitle = React.useMemo(() => {
    const withTitles = [...matches].reverse().find((m: any) => m.handle && (m.handle as any).title);
    return (withTitles?.handle as any)?.title ?? "Kairos";
  }, [matches]);


  const handleDrawerOpen = () => {
    setOpen(true);
  };

  const handleDrawerClose = () => {
    setOpen(false);
  };

  const listItemButtonStyle = [{ minHeight: 48, px: 2.5 }, open ? { justifyContent: "initial" } : { justifyContent: "center" }];
  const listItemIconStyle = [{ minWidth: 0, justifyContent: "center" }, open ? { mr: 3 } : { mr: "auto" }];
  const listItemTextStyle = [open ? { opacity: 1 } : { opacity: 0 }];


const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
  setAnchorEl(event.currentTarget);
};

const handleMenuClose = () => {
  setAnchorEl(null);
};

// Hotel menu handlers
const handleHotelMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
  setHotelAnchorEl(event.currentTarget);
};

const handleHotelMenuClose = () => {
  setHotelAnchorEl(null);
};

const handleHotelSelect = async (hotel: Hotel) => {
  await setSelectedHotelOu(hotel.ou);
  // Settings are now saved automatically within setSelectedHotelOu
  setCurrentHotelName(hotel.hotel_name);
  handleHotelMenuClose();
};

// Menu item handlers
const handleProfile = () => {
  navigate("/signed-in-landing/profile");
  handleMenuClose();
};

const handleSettings = () => {
  navigate("/signed-in-landing/settings");
  handleMenuClose();
};

const handleHelp = () => {
  navigate("/signed-in-landing/help");
  handleMenuClose();
};

// Sign out function
const handleSignOut = useCallback(async () => {
  try {
    // Revokes the session server-side and wipes local tokens in main.
    await authService.logout();
    navigate("/", { replace: true });
  } catch (error) {
    console.error("Sign out failed:", error);
  }
  handleMenuClose();
}, [navigate]);

  // Get current user data
  useEffect(() => {
    const fetchCurrentUser = async () => {
      try {
        // Get user info from API (same as profile page)
        const userInfo = await authService.getCurrentUser();
        setUser(userInfo);
      } catch (error) {
        console.error("Failed to get user data:", error);
      }
    };

    fetchCurrentUser();
  }, []);

  // Version-gated sync of the cached mapping reference tables, once per signed-in
  // session. These change extremely infrequently, so this is a cheap /version
  // probe that only pulls the bulk payloads when the server version has moved.
  // Fire-and-forget: a failure here never blocks the shell (the settings screen
  // has a manual rebuild button as a fallback).
  useEffect(() => {
    syncMappingTables().catch((error) => {
      console.warn("Mapping tables sync skipped:", error);
    });
  }, []);

  // Load hotels (live read) and resolve the current hotel name
  useEffect(() => {
    const loadHotels = async () => {
      try {
        const hotelList = await authService.getHotels();
        setHotels(hotelList);

        if (selectedHotelOu) {
          const currentHotel = hotelList.find(h => h.ou === selectedHotelOu);
          if (currentHotel) {
            setCurrentHotelName(currentHotel.hotel_name);
          } else if (hotelList.length > 0) {
            // Saved hotel not found — fall back to the first available one
            const firstHotel = hotelList[0];
            await setSelectedHotelOu(firstHotel.ou);
            setCurrentHotelName(firstHotel.hotel_name);
          }
        } else if (hotelList.length > 0) {
          // No hotel selected yet — auto-select the first one
          const firstHotel = hotelList[0];
          await setSelectedHotelOu(firstHotel.ou);
          setCurrentHotelName(firstHotel.hotel_name);
        }
      } catch (error) {
        console.error("Failed to load hotels:", error);
      }
    };

    loadHotels();
  }, [selectedHotelOu]);

  const userEmail = user?.email || '';
  // Extract username from email (part before @) for friendly display
  const friendlyName = userEmail ? userEmail.split('@')[0] : 'User';
  // Use first 2 letters of email username for initials
  const userInitials = friendlyName ? friendlyName.substring(0, 2).toUpperCase() : 'U';

  return (
    <Box sx={{ display: "flex" }}>
      <CssBaseline />
      <AppBar position="fixed" open={open}>
        <Toolbar variant="dense">
          <IconButton
            aria-label="open drawer"
            onClick={handleDrawerOpen}
            edge="start"
            sx={[
              {
                marginRight: 5,
                color: 'inherit',
              },
              open && { display: "none" },
            ]}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1, fontWeight: 600 }}>
            {pageTitle}
          </Typography>
          
          {/* Modern User menu section */}
          <Stack direction="row" spacing={1} sx={{
            alignItems: "center"
          }}>
            {/* Scope selectors, outermost first: hotel > year > scenario. All
                three are the same outlined chip + dropdown menu, so the row
                reads as one control family rather than three widgets. */}
            {/* Hotel selector button */}
            {currentHotelName && (
              <Tooltip title="Switch hotel">
                <Chip
                  icon={<ApartmentIcon />}
                  label={currentHotelName}
                  size="small"
                  variant="outlined"
                  clickable
                  onClick={handleHotelMenuOpen}
                  deleteIcon={<ArrowDropDownIcon />}
                  onDelete={handleHotelMenuOpen}
                  // Shared with the year/scenario chips so the three stay
                  // pixel-identical as the styling evolves.
                  sx={contextChipSx}
                />
              </Tooltip>
            )}

            {/* Budget year + scenario. Persisted settings, so the selection
                holds as you step across screens — the Positions grid and the
                report packs all read the same pair. */}
            <PlanningContextPicker />

            {/* Theme toggle (global) */}
            <ThemeToggle />

            {/* User Avatar and Menu */}
            <IconButton
              onClick={handleMenuOpen}
              size="small"
              sx={{
                ml: 1,
                p: 0.5,
                '&:hover': {
                  backgroundColor: alpha(theme.palette.primary.main, 0.08),
                },
              }}
              aria-controls={accountMenuOpen ? 'account-menu' : undefined}
              aria-haspopup="true"
              aria-expanded={accountMenuOpen ? 'true' : undefined}
            >
              <Avatar
                sx={{
                  width: 36,
                  height: 36,
                  bgcolor: theme.palette.primary.main,
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  '&:hover': {
                    transform: 'scale(1.05)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  },
                }}
              >
                {userInitials}
              </Avatar>
            </IconButton>

            <StyledMenu
              id="account-menu"
              anchorEl={anchorEl}
              open={accountMenuOpen}
              onClose={handleMenuClose}
              anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'right',
              }}
              transformOrigin={{
                vertical: 'top',
                horizontal: 'right',
              }}
              slotProps={{
                paper: {
                  sx: {
                    // Force position to right side of screen
                    position: 'fixed !important',
                    right: '16px !important',
                    left: 'auto !important',
                    top: '56px !important', // Adjust based on your AppBar height
                    maxWidth: 320,
                    minWidth: 280,
                    overflow: 'visible',
                    filter: 'drop-shadow(0px 2px 8px rgba(0,0,0,0.15))',
                    '&:before': {
                      content: '""',
                      display: 'block',
                      position: 'absolute',
                      top: 0,
                      right: 28, // Adjust to align with avatar
                      width: 10,
                      height: 10,
                      bgcolor: 'background.paper',
                      transform: 'translateY(-50%) rotate(45deg)',
                      zIndex: 0,
                    },
                  },
                },
              }}
            >
    {/* User Info Section */}
    <UserInfoSection>
      <Avatar 
        sx={{ 
          width: 48, 
          height: 48, 
          bgcolor: theme.palette.primary.main,
          fontWeight: 600,
        }}
      >
        {userInitials}
      </Avatar>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
          {friendlyName}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: 'text.secondary',
            fontSize: '0.875rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {userEmail || 'Active User'}
        </Typography>
      </Box>
    </UserInfoSection>

    {/* Menu Items */}
    <Box sx={{ p: 1 }}>
      <StyledMenuItem onClick={handleProfile}>
        <ListItemIcon>
          <PersonIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>My Profile</ListItemText>
      </StyledMenuItem>

      <StyledMenuItem onClick={handleSettings}>
        <ListItemIcon>
          <SettingsIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Settings</ListItemText>
      </StyledMenuItem>

      <StyledMenuItem onClick={handleHelp}>
        <ListItemIcon>
          <HelpOutlineIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Help & Support</ListItemText>
      </StyledMenuItem>

      <Divider sx={{ my: 1 }} />

      <StyledMenuItem 
        onClick={handleSignOut}
        sx={{
          color: 'error.main',
          '&:hover': {
            backgroundColor: alpha(theme.palette.error.main, 0.08),
          }
        }}
      >
        <ListItemIcon>
          <LogoutIcon fontSize="small" color="error" />
        </ListItemIcon>
        <ListItemText>Sign Out</ListItemText>
              </StyledMenuItem>
            </Box>
            </StyledMenu>

            {/* Hotel Selection Menu */}
            <StyledMenu
              id="hotel-menu"
              anchorEl={hotelAnchorEl}
              open={hotelMenuOpen}
              onClose={handleHotelMenuClose}
              anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'right',
              }}
              transformOrigin={{
                vertical: 'top',
                horizontal: 'right',
              }}
              slotProps={{
                paper: {
                  sx: {
                    // Force position to right side of screen (same as user menu)
                    position: 'fixed !important',
                    right: '16px !important',
                    left: 'auto !important',
                    top: '56px !important', // Adjust based on your AppBar height
                    maxWidth: 320,
                    minWidth: 280,
                    maxHeight: 400,
                    overflow: 'auto',
                    filter: 'drop-shadow(0px 2px 8px rgba(0,0,0,0.15))',
                    '&:before': {
                      content: '""',
                      display: 'block',
                      position: 'absolute',
                      top: 0,
                      right: 100, // Adjust to align with hotel chip (different from user menu)
                      width: 10,
                      height: 10,
                      bgcolor: 'background.paper',
                      transform: 'translateY(-50%) rotate(45deg)',
                      zIndex: 0,
                    },
                  },
                },
              }}
            >
              {/* Hotel Menu Header */}
              <Box sx={{ p: 2, pb: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                  Select Hotel
                </Typography>
                <Tooltip title="Refresh hotels">
                  <IconButton
                    size="small"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        // Refresh cache and reload hotels
                        const refreshedHotels = await authService.refreshHotelsCache();
                        setHotels(refreshedHotels);
                      } catch (error) {
                        console.error('Failed to refresh hotels:', error);
                      }
                    }}
                    sx={{
                      color: 'text.secondary',
                      '&:hover': {
                        backgroundColor: alpha(theme.palette.primary.main, 0.08)
                      }
                    }}
                  >
                    <RefreshIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
              <Divider />

              {/* Hotel List */}
              <Box sx={{ p: 1 }}>
                {hotels.map((hotel) => (
                  <StyledMenuItem
                    key={hotel.ou}
                    onClick={() => handleHotelSelect(hotel)}
                    selected={hotel.ou === selectedHotelOu}
                  >
                    <ListItemIcon>
                      <ApartmentIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText
                      primary={hotel.hotel_name}
                      secondary={hotel.ou}
                      slotProps={{
                        secondary: {
                          sx: { fontSize: '0.75rem', color: 'text.secondary' },
                        },
                      }}
                    />
                    {hotel.ou === selectedHotelOu && (
                      <CheckIcon fontSize="small" color="primary" sx={{ ml: 1 }} />
                    )}
                  </StyledMenuItem>
                ))}
              </Box>
            </StyledMenu>
          </Stack>
        </Toolbar>
      </AppBar>
      <Drawer variant="permanent" open={open}>
        <DrawerHeader>
          <IconButton size="small" onClick={handleDrawerClose}>
            {theme.direction === "rtl" ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </IconButton>
        </DrawerHeader>
        <Divider />
        <List>
          {/* Main Navigation */}
          <ListItem key="home" disablePadding sx={{ display: "block" }}>
            <ListItemButton sx={listItemButtonStyle} onClick={() => navigate("/signed-in-landing/home")}>
              <ListItemIcon sx={listItemIconStyle}>
                <HomeIcon />
              </ListItemIcon>
              <ListItemText primary="Home" sx={listItemTextStyle} />
            </ListItemButton>
          </ListItem>
          <ListItem key="budget-pull" disablePadding sx={{ display: "block" }}>
            <ListItemButton sx={listItemButtonStyle} onClick={() => navigate("/signed-in-landing/budget-pull")}>
              <ListItemIcon sx={listItemIconStyle}>
                <FileDownloadIcon />
              </ListItemIcon>
              <ListItemText primary="Budget Pull" sx={listItemTextStyle} />
            </ListItemButton>
          </ListItem>
          <ListItem key="kpi-drivers" disablePadding sx={{ display: "block" }}>
            <ListItemButton sx={listItemButtonStyle} onClick={() => navigate("/signed-in-landing/kpi-drivers")}>
              <ListItemIcon sx={listItemIconStyle}>
                <InsightsIcon />
              </ListItemIcon>
              <ListItemText primary="KPI Drivers" sx={listItemTextStyle} />
            </ListItemButton>
          </ListItem>
          <ListItem key="manual-input" disablePadding sx={{ display: "block" }}>
            <ListItemButton sx={listItemButtonStyle} onClick={() => navigate("/signed-in-landing/manual-input")}>
              <ListItemIcon sx={listItemIconStyle}>
                <EditNoteIcon />
              </ListItemIcon>
              <ListItemText primary="Manual Input" sx={listItemTextStyle} />
            </ListItemButton>
          </ListItem>
          <ListItem key="positions" disablePadding sx={{ display: "block" }}>
            <ListItemButton sx={listItemButtonStyle} onClick={() => navigate("/signed-in-landing/positions")}>
              <ListItemIcon sx={listItemIconStyle}>
                <BadgeIcon />
              </ListItemIcon>
              <ListItemText primary="Positions" sx={listItemTextStyle} />
            </ListItemButton>
          </ListItem>
          <ListItem key="results" disablePadding sx={{ display: "block" }}>
            <ListItemButton sx={listItemButtonStyle} onClick={() => navigate("/signed-in-landing/results")}>
              <ListItemIcon sx={listItemIconStyle}>
                <AssessmentIcon />
              </ListItemIcon>
              <ListItemText primary="Results" sx={listItemTextStyle} />
            </ListItemButton>
          </ListItem>
        </List>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: 2 }}>
        <DrawerHeader />
        <Outlet />
      </Box>
    </Box>
  );
}

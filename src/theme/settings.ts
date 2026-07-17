import { createTheme } from "@mui/material/styles";

export type ThemeMode = "light" | "dark";

export const createAppTheme = (mode: ThemeMode = "light") => {
  const isLight = mode === "light";
  
  return createTheme({
    palette: {
      mode,
      primary: { 
        main: isLight ? "#1976d2" : "#90caf9" 
      },
      secondary: { 
        main: isLight ? "#9c27b0" : "#ce93d8" 
      },
      background: {
        default: isLight ? "#FAFAFA" : "#121212", 
        paper: isLight ? "#ffffff" : "#1e1e1e",
      },
      text: {
        primary: isLight ? "#111111" : "#ffffff",
        secondary: isLight ? "#666666" : "#aaaaaa",
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: isLight ? "#FAFAFA" : "#121212", 
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: isLight ? "#ffffff" : "#1e1e1e",
            borderRight: `1px solid ${isLight ? "#e0e0e0" : "#333333"}`,
          },
        },
      },
    },
  });
};


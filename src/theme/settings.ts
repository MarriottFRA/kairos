import { createTheme } from "@mui/material/styles";

export type ThemeMode = "light" | "dark";

export const createAppTheme = (mode: ThemeMode = "light") => {
  const isLight = mode === "light";
  
  // Kairos "budget/ledger" palette — teal accent + steel-blue secondary on a
  // near-white / deep-navy canvas. Values mirror the welcome screen's themeVars()
  // so the login scene and the rest of the app share one color language.
  const line = isLight ? "rgba(15,22,32,.09)" : "rgba(238,242,247,.09)";

  return createTheme({
    palette: {
      mode,
      primary: {
        main: isLight ? "#0d7d6b" : "#34e0ab",
        contrastText: isLight ? "#ffffff" : "#04140d",
      },
      secondary: {
        main: isLight ? "#2b6fd4" : "#5bb0ff",
      },
      background: {
        default: isLight ? "#f4f6f8" : "#0a0d13",
        paper: isLight ? "#ffffff" : "#0f141d",
      },
      text: {
        primary: isLight ? "#0f1620" : "#eef2f7",
        secondary: isLight ? "rgba(15,22,32,.6)" : "rgba(238,242,247,.6)",
      },
      divider: line,
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: isLight ? "#f4f6f8" : "#0a0d13",
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
            backgroundColor: isLight ? "#ffffff" : "#0f141d",
            borderRight: `1px solid ${line}`,
          },
        },
      },
    },
  });
};


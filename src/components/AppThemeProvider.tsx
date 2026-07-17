import React from "react";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { useSettingsStore } from "../store/settings";
import { createAppTheme } from "../theme/settings";

type Props = { children: React.ReactNode };

const AppThemeProvider: React.FC<Props> = ({ children }) => {
  const themeMode = useSettingsStore((s) => s.themeMode);

  // Settings are now loaded by AppInitializer before this component renders

  const theme = React.useMemo(() => createAppTheme(themeMode), [themeMode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
};

export default AppThemeProvider;


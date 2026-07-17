import React from "react";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import { useSettingsStore } from "../../store/settings";

const ThemeToggle: React.FC = () => {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);

  const handleClick = async () => {
    await toggleTheme();
    // Settings are now saved automatically within toggleTheme
  };

  return (
    <Tooltip title={themeMode === "light" ? "Switch to dark mode" : "Switch to light mode"}>
      <IconButton onClick={handleClick} size="small" sx={{ color: "text.secondary" }}>
        {themeMode === "light" ? <DarkModeIcon /> : <LightModeIcon />}
      </IconButton>
    </Tooltip>
  );
};

export default ThemeToggle;


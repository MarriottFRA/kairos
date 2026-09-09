/**
 * ReportRail — the list of reports, as a rail that collapses to icons.
 *
 * Mirrors the app's navigation drawer: open, each entry shows its name and
 * a one-line description; collapsed, the icon alone with the same text in
 * a tooltip. It defaults to OPEN and remembers the choice per install — a
 * user who finds the collapse button will find the expand one, but a rail
 * that first loads collapsed is a rail nobody finds (decided 2026-09-09).
 */

import { useCallback, useState } from "react";
import {
  Box,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
} from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Chip from "@mui/material/Chip";

export const RAIL_OPEN_WIDTH = 240;
export const RAIL_CLOSED_WIDTH = 52;

const STORAGE_KEY = "kairos.reports.railOpen";

/** Matches the drawer's "Soon" chip: an annotation on the row, not a control. */
const COMING_SOON_CHIP = {
  height: 18,
  fontSize: "0.625rem",
  fontWeight: 600,
  letterSpacing: "0.04em",
  color: "text.secondary",
  flexShrink: 0,
  ml: 1,
  "& .MuiChip-label": { px: 0.75 },
};

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

/** Open by default; the stored choice wins once one has been made. */
export function useRailOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState<boolean>(readStored);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "open" : "closed");
    } catch {
      // A private window or blocked storage: the choice lasts the session.
    }
  }, []);
  return [open, setOpen];
}

export interface RailEntry {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  /**
   * A report we have designed but not built. It renders greyed and refuses
   * selection rather than routing to an empty pane — a dead-end screen reads
   * as a bug, a greyed row reads as a roadmap (the drawer does the same).
   */
  comingSoon?: boolean;
}

export interface ReportRailProps {
  entries: RailEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ReportRail({ entries, selectedId, onSelect, open, onOpenChange }: ReportRailProps) {
  return (
    <Box
      sx={{
        width: open ? RAIL_OPEN_WIDTH : RAIL_CLOSED_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: 1,
        borderColor: "divider",
        // Full height of the page: its top padding lines the collapse button
        // up with the pane's first row, and it carries the gap to the pane.
        pt: 1,
        pl: 1,
        mr: 1.5,
        transition: (theme) =>
          theme.transitions.create("width", { duration: theme.transitions.duration.shorter }),
        overflow: "hidden",
      }}
    >
      <Box sx={{ display: "flex", justifyContent: open ? "flex-end" : "center", pr: open ? 1 : 0 }}>
        <Tooltip title={open ? "Collapse the report list" : "Expand the report list"} placement="right">
          <IconButton size="small" onClick={() => onOpenChange(!open)} aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronLeftIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>
      <List dense disablePadding sx={{ overflowY: "auto", overflowX: "hidden", flex: 1, pr: open ? 1 : 0 }}>
        {entries.map((entry) => {
          const button = (
            <ListItemButton
              key={entry.id}
              selected={!entry.comingSoon && entry.id === selectedId}
              disabled={entry.comingSoon}
              onClick={entry.comingSoon ? undefined : () => onSelect(entry.id)}
              sx={{
                borderRadius: 1,
                minHeight: 44,
                px: open ? 1.5 : 1.25,
                justifyContent: open ? "initial" : "center",
              }}
            >
              <ListItemIcon sx={{ minWidth: 0, mr: open ? 1.5 : 0, justifyContent: "center" }}>
                {entry.icon}
              </ListItemIcon>
              {open && (
                <ListItemText
                  primary={entry.name}
                  secondary={entry.description}
                  slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                />
              )}
              {open && entry.comingSoon && (
                <Chip label="Soon" size="small" variant="outlined" sx={COMING_SOON_CHIP} />
              )}
            </ListItemButton>
          );
          const tip = (
            <>
              <strong>{entry.name}</strong>
              {entry.comingSoon && " — coming soon"}
              <br />
              {entry.description}
            </>
          );
          // A disabled button swallows its own hover events, so a tooltip on
          // one has to hang off a wrapper that is still live. Open, only the
          // greyed rows need a tooltip; collapsed, every row does.
          const needsTip = entry.comingSoon || !open;
          return (
            <Box key={entry.id}>
              {needsTip ? (
                <Tooltip placement="right" title={tip}>
                  {entry.comingSoon ? <span>{button}</span> : button}
                </Tooltip>
              ) : (
                button
              )}
            </Box>
          );
        })}
      </List>
    </Box>
  );
}

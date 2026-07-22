/**
 * ContextChip — one control shape for every app-bar scope selector.
 *
 * The bar carries three selections that together scope the whole app (hotel,
 * budget year, planning scenario). They are peers, so they must look and behave
 * like peers: same pill, same icon slot, same dropdown affordance, same menu.
 * Anything that renders its own TextField or IconButton up here breaks the row.
 *
 * Owns the trigger only — the caller supplies the menu items, so each selector
 * keeps its own list, footer actions and loading rules.
 */

import { ReactNode, useState } from "react";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { Chip, Menu, SxProps, Theme, Tooltip, alpha } from "@mui/material";

/**
 * The shared pill styling, exported so a selector that needs its own menu
 * (the hotel switcher's rich list) still renders an identical trigger.
 *
 * A `size="small"` Chip is 24px tall, which leaves a 16px icon touching the
 * border on both axes. The extra height plus the explicit label/icon gutters
 * are what let the icon breathe inside the pill.
 */
export const contextChipSx: SxProps<Theme> = (theme) => ({
  height: 32,
  borderRadius: 16,
  borderColor: theme.palette.divider,
  color: theme.palette.text.secondary,
  fontWeight: 500,
  "& .MuiChip-label": { px: 1, fontSize: "0.875rem" },
  "& .MuiChip-icon": { ml: 1, mr: 0, fontSize: 19 },
  "& .MuiChip-deleteIcon": {
    mr: 0.5,
    color: theme.palette.text.secondary,
    "&:hover": { color: theme.palette.primary.main },
  },
  "&:hover": {
    backgroundColor: alpha(theme.palette.primary.main, 0.08),
    borderColor: theme.palette.primary.main,
  },
});

export interface ContextChipProps {
  icon: ReactNode;
  label: string;
  tooltip: string;
  disabled?: boolean;
  /** Rendered inside the menu; `close` dismisses it after a selection. */
  children: (close: () => void) => ReactNode;
}

export default function ContextChip({
  icon,
  label,
  tooltip,
  disabled = false,
  children,
}: ContextChipProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);
  const close = () => setAnchorEl(null);

  return (
    <>
      <Tooltip title={tooltip}>
        <Chip
          icon={icon as never}
          label={label}
          size="small"
          variant="outlined"
          clickable={!disabled}
          disabled={disabled}
          onClick={(event) => setAnchorEl(event.currentTarget)}
          // deleteIcon is the only slot that puts an affordance on the trailing
          // edge of a Chip; it opens the menu rather than deleting anything.
          deleteIcon={<ArrowDropDownIcon />}
          onDelete={disabled ? undefined : (event) => setAnchorEl(event.currentTarget)}
          sx={contextChipSx}
        />
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 220, mt: 0.5 } } }}
      >
        {children(close)}
      </Menu>
    </>
  );
}

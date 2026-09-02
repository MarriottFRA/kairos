/**
 * The app bar's "what's new" bell.
 * -----------------------------------------------------------
 * Sits beside the theme toggle and carries a dot while the latest note is
 * unread. Opening the note marks it read — the dot goes, the bell does not: it
 * keeps opening the same note as often as anyone wants to re-read it.
 *
 * "Read" is one number in `user_settings` (the plaintext store), so it survives
 * a secure-store rebuild, and a new note is a new id rather than any kind of
 * reset. Deliberately never opens itself: an update note that seizes the screen
 * on launch is a worse thing than an update note nobody reads.
 */

import { useState } from "react";
import { Badge, IconButton, Tooltip } from "@mui/material";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import { useSettingsStore } from "../../store/settings";
import { LATEST_UPDATE_ID } from "../../shared/updates/releases";
import WhatsNewDialog from "./WhatsNewDialog";

export default function WhatsNewBell() {
  const seenId = useSettingsStore((s) => s.updatesSeenId);
  const setUpdatesSeenId = useSettingsStore((s) => s.setUpdatesSeenId);
  const [open, setOpen] = useState(false);

  // Settings load asynchronously; an unread install reads 0 either way, so the
  // coercion only guards a missing/corrupt value showing a permanent dot.
  const unread = LATEST_UPDATE_ID > (Number(seenId) || 0);

  const handleOpen = () => {
    setOpen(true);
    if (unread) void setUpdatesSeenId(LATEST_UPDATE_ID);
  };

  return (
    <>
      <Tooltip title={unread ? "What's new" : "What's new in this version"}>
        <IconButton
          onClick={handleOpen}
          size="small"
          aria-label={unread ? "What's new (unread)" : "What's new"}
          sx={{ color: "text.secondary" }}
        >
          <Badge
            color="error"
            variant="dot"
            invisible={!unread}
            overlap="circular"
            anchorOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <NotificationsNoneIcon />
          </Badge>
        </IconButton>
      </Tooltip>

      <WhatsNewDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

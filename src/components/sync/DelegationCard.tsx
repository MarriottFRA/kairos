/**
 * One delegation, one card.
 *
 * The facts about a single delegation used to live in three different regions of
 * the Delegation page: which departments somebody held and whether they had
 * given them back (the Departments table), whether they were working right now
 * (a separate "Working on this now" list), and what the grant permitted, plus
 * the buttons to change it (the delegation row). Answering "what is Bob's
 * situation, and what should I do about it?" meant reading all three and joining
 * them by eye on an email address.
 *
 * This card is that join, done once: who, what they hold, what state each of
 * those departments is in, and the one thing worth pressing. The state sentence
 * comes from `delegationCardState`, which is pure and separately tested.
 *
 * ## Why the actions are behind a menu
 *
 * Withdrawing and taking the pen away are both consequential and both rare —
 * the common case is reading the card and doing nothing. Putting them inline
 * gave every row two buttons of equal weight and no primary action, so the one
 * thing an owner actually comes here to do (collect finished work) looked
 * exactly like the one thing they must not do by accident. Now there is at most
 * one contained button per card, and it only appears when there is something to
 * collect.
 *
 * ## The timestamp is not a publish time
 *
 * "Last seen working" is `ActivityEntry.seenAt`, a presence ping written while
 * the delegate's app is open. It is not when they last published — there is no
 * such field on the wire — and it must not be labelled as one, because an owner
 * who reads it that way will conclude that work has arrived when it has not.
 * The count that does matter is `dirtyEntities`: work that exists and cannot be
 * downloaded yet, which is exactly what a withdrawal would strand.
 */

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import UndoOutlinedIcon from "@mui/icons-material/UndoOutlined";

import { ActivityEntry, Delegation } from "../../shared/kairosSync/protocol";
import { delegationCardState } from "../../shared/kairosSync/delegationCardState";
import { formatWhen } from "../../shared/kairosSync/formatWhen";
import { TONE_COLOUR } from "./tone";

export interface DelegationCardProps {
  delegation: Delegation;
  /**
   * Presence for this delegate, joined on `delegateUserId`.
   *
   * Null when they have not pinged recently, which is the ordinary state — it
   * means "not in the app", never "not working".
   */
  presence: ActivityEntry | null;
  /** Whether the viewer may act on this delegation at all. */
  isOwner: boolean;
  busy: boolean;
  onMakeViewOnly: (delegation: Delegation) => void;
  onLetThemEdit: (delegation: Delegation) => void;
  onWithdraw: (delegation: Delegation) => void;
  /** Reopen one department the delegate handed back. */
  onReopen: (delegationId: string, departmentCode: string) => void;
  /** Reopen every handed-back department in this grant. */
  onReopenAll: (delegation: Delegation) => void;
  /** Collect their published work. Opens the download review. */
  onDownload: (delegation: Delegation) => void;
}

export default function DelegationCard({
  delegation,
  presence,
  isOwner,
  busy,
  onMakeViewOnly,
  onLetThemEdit,
  onWithdraw,
  onReopen,
  onReopenAll,
  onDownload,
}: DelegationCardProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = (): void => setMenuAnchor(null);
  const run = (action: () => void) => () => {
    closeMenu();
    action();
  };

  const state = delegationCardState(delegation, presence);

  const stateByCode = new Map(
    delegation.departments.map((department) => [department.code, department])
  );
  /**
   * Every department this grant mentions, in either sense.
   *
   * `requestedDepartments` is what the owner asked for and is kept as intent;
   * `departments` is what the delegate actually holds and in what state. A code
   * in the first and not the second is the "recorded but not in effect" case,
   * which used to surface as an unexplained "Partial" chip.
   */
  const codes = Array.from(
    new Set([
      ...delegation.departments.map((department) => department.code),
      ...delegation.requestedDepartments,
    ])
  );

  /**
   * Did the headline already say how much unpublished work there is?
   *
   * When a handback or a dead grant takes the headline, the count would
   * otherwise vanish — and that is the case where it matters most, because it
   * is the work a withdrawal would strand.
   */
  const headlineCarriesPresence = !state.collectable && delegation.effective;
  const unpublished = presence?.dirtyEntities ?? 0;

  const permissions = [
    delegation.canEdit && delegation.canAddRows ? "can add rows" : null,
    delegation.canEdit && delegation.canDeleteRows ? "can delete rows" : null,
    delegation.canReadPii ? "can see employee details" : null,
  ].filter((entry): entry is string => entry !== null);

  const footer = [
    delegation.grantedAt ? `Granted ${formatWhen(delegation.grantedAt)}` : null,
    ...permissions,
    // Deliberately not "last published". See the module docblock.
    presence ? `Last seen working ${formatWhen(presence.seenAt)}` : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <Card variant="outlined" sx={{ borderRadius: 2, mb: 2 }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              mt: 1,
              flexShrink: 0,
              bgcolor: TONE_COLOUR[state.tone],
            }}
          />

          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {delegation.delegateEmail}
              </Typography>
              {!delegation.canEdit && (
                // Kept as a chip even though the headline may also say it: when
                // a handback or a presence ping takes the sentence, this is the
                // fact that would otherwise disappear.
                <Tooltip title="They can read these departments. You keep full control of them and can carry on editing.">
                  <Chip size="small" variant="outlined" label="View only" />
                </Tooltip>
              )}
              {unpublished > 0 && !headlineCarriesPresence && (
                <Tooltip title="Changes they have made and not yet published. You cannot download these until they publish — withdrawing now would strand them.">
                  <Chip size="small" color="warning" label={`${unpublished} unpublished`} />
                </Tooltip>
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {state.headline}
            </Typography>
          </Box>

          {isOwner && (
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
              {state.collectable && (
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<DownloadOutlinedIcon />}
                  disabled={busy}
                  onClick={() => onDownload(delegation)}
                >
                  Download their work
                </Button>
              )}
              <Tooltip title="Change or end this delegation">
                <IconButton size="small" onClick={(event) => setMenuAnchor(event.currentTarget)}>
                  <MoreVertIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          )}
        </Stack>

        {/* What they hold, and what state each one is in — the fact that used to
            live in a table two sections away from the delegation it belongs to. */}
        {codes.length > 0 && (
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: "wrap", mt: 2, ml: 3 }}
          >
            {codes.map((code) => {
              const department = stateByCode.get(code);

              if (department?.state === "HANDED_BACK") {
                const note = department.handedBackNote
                  ? ` — “${department.handedBackNote}”`
                  : "";
                const when = department.handedBackAt
                  ? formatWhen(department.handedBackAt)
                  : "at some point";
                return (
                  <Tooltip
                    key={code}
                    title={`Handed back ${when}${note}${
                      isOwner ? ". Press the arrow to give it back to them." : ""
                    }`}
                  >
                    <Chip
                      size="small"
                      color="info"
                      label={code}
                      disabled={busy}
                      onDelete={isOwner ? () => onReopen(delegation.id, code) : undefined}
                      deleteIcon={isOwner ? <UndoOutlinedIcon /> : undefined}
                    />
                  </Tooltip>
                );
              }

              if (!delegation.effectiveDepartments.includes(code)) {
                return (
                  <Tooltip
                    key={code}
                    title="Recorded, but not in effect — they do not have access to this department. It starts working if their access is widened."
                  >
                    <Chip
                      size="small"
                      variant="outlined"
                      label={code}
                      sx={{ color: "text.disabled", borderStyle: "dashed" }}
                    />
                  </Tooltip>
                );
              }

              return <Chip key={code} size="small" variant="outlined" label={code} />;
            })}
          </Stack>
        )}

        {footer.length > 0 && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 1.5, ml: 3 }}
          >
            {footer.join(" · ")}
          </Typography>
        )}

        <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu}>
          {delegation.canEdit ? (
            <MenuItem disabled={busy} onClick={run(() => onMakeViewOnly(delegation))}>
              <ListItemText
                primary="Make view only"
                secondary="Freezes anything they have not published"
              />
            </MenuItem>
          ) : (
            <MenuItem disabled={busy} onClick={run(() => onLetThemEdit(delegation))}>
              <ListItemText primary="Let them edit" secondary="Gives the pen back" />
            </MenuItem>
          )}

          {state.collectable && (
            <MenuItem disabled={busy} onClick={run(() => onReopenAll(delegation))}>
              <ListItemText
                primary="Reopen handed-back departments"
                secondary="If they are not finished after all"
              />
            </MenuItem>
          )}

          <Divider />

          <MenuItem disabled={busy} onClick={run(() => onWithdraw(delegation))}>
            <ListItemText
              primary={<Typography color="error.main">Withdraw delegation</Typography>}
              secondary="They lose access immediately"
            />
          </MenuItem>
        </Menu>
      </CardContent>
    </Card>
  );
}

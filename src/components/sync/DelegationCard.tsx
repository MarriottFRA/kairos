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
 * ## Why the actions are inline
 *
 * They were behind an overflow menu, on the theory that withdrawing is
 * consequential enough to hide. It is — but a menu is not what makes it safe:
 * withdrawal opens a dialog that will not proceed without a typed reason, so a
 * stray click costs a glance, not a delegation. What the menu did cost was every
 * ordinary action — reopen, view-only, give the pen back — one extra click and
 * one guess about where it lives. So the buttons are on the card, ranked:
 * contained for the thing you came to do, plain text for the rest, and Withdraw
 * last and in error colour so it never reads as a peer of the others.
 *
 * ## Departments are rows, not chips
 *
 * A chip's delete slot rendered with an Undo icon reads as "remove this
 * department" — the opposite of reopening it. Each department now gets a line
 * saying what state it is in and a button that says what it does.
 *
 * There is deliberately no per-department Download. `/changes` takes a watermark
 * and a cursor and nothing else: every download is whole-plan. A button offering
 * one department's data would be describing something the protocol cannot do.
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

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import UndoOutlinedIcon from "@mui/icons-material/UndoOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";

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

  const handedBackCount = delegation.departments.filter(
    (department) => department.state === "HANDED_BACK"
  ).length;

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
        </Stack>

        {/* What they hold, and what state each one is in — the fact that used to
            live in a table two sections away from the delegation it belongs to.
            One line each, so the department that needs something doing to it can
            carry the button that does it. */}
        {codes.length > 0 && (
          <Stack sx={{ mt: 1.5, ml: 3 }}>
            {codes.map((code) => (
              <DepartmentLine
                key={code}
                code={code}
                department={stateByCode.get(code) ?? null}
                inEffect={delegation.effectiveDepartments.includes(code)}
                isOwner={isOwner}
                busy={busy}
                onReopen={() => onReopen(delegation.id, code)}
              />
            ))}
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

        {/* Ranked, not equal: one contained button for the thing an owner comes
            here to do, plain text for the rest, and Withdraw last and in error
            colour. It opens a dialog that will not proceed without a typed
            reason, which is what actually makes it safe to show. */}
        {isOwner && (
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ mt: 2, ml: 3, flexWrap: "wrap", alignItems: "center" }}
          >
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

            {handedBackCount > 1 && (
              <Tooltip title="Give every department they handed back to them again">
                <Button
                  size="small"
                  startIcon={<UndoOutlinedIcon />}
                  disabled={busy}
                  onClick={() => onReopenAll(delegation)}
                >
                  Reopen all {handedBackCount}
                </Button>
              </Tooltip>
            )}

            {delegation.canEdit ? (
              <Tooltip title="They keep seeing these departments and stop being able to change them. Freezes anything they have not published.">
                <Button
                  size="small"
                  startIcon={<VisibilityOutlinedIcon />}
                  disabled={busy}
                  onClick={() => onMakeViewOnly(delegation)}
                >
                  Make view only
                </Button>
              </Tooltip>
            ) : (
              <Tooltip title="Gives the pen back. Anything they held unpublished can publish again.">
                <Button
                  size="small"
                  startIcon={<EditOutlinedIcon />}
                  disabled={busy}
                  onClick={() => onLetThemEdit(delegation)}
                >
                  Let them edit
                </Button>
              </Tooltip>
            )}

            <Box sx={{ flexGrow: 1 }} />

            <Tooltip title="Ends this delegation. They lose access immediately and you get the departments back.">
              <Button size="small" color="error" disabled={busy} onClick={() => onWithdraw(delegation)}>
                Withdraw
              </Button>
            </Tooltip>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One department of one grant: what state it is in, and the button for it.
 *
 * Below the default export and unexported, per the house convention for a
 * presentational fragment private to its parent.
 */
function DepartmentLine({
  code,
  department,
  inEffect,
  isOwner,
  busy,
  onReopen,
}: {
  code: string;
  department: Delegation["departments"][number] | null;
  inEffect: boolean;
  isOwner: boolean;
  busy: boolean;
  onReopen: () => void;
}) {
  const handedBack = department?.state === "HANDED_BACK";

  const note = handedBack && department.handedBackNote
    ? ` — “${department.handedBackNote}”`
    : "";
  const status = handedBack
    ? `Handed back ${
        department.handedBackAt ? formatWhen(department.handedBackAt) : "at some point"
      }${note}`
    : !inEffect
      ? // Recorded as intent, refused in practice. It starts working by itself
        // if their department access is widened, which is why it is shown at all
        // rather than filtered out.
        "Recorded, but not in effect — they do not have access to this one"
      : "Theirs to edit";

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: "center", minHeight: 32, flexWrap: "wrap" }}
    >
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, minWidth: 72, color: inEffect ? undefined : "text.disabled" }}
      >
        {code}
      </Typography>
      <Typography
        variant="body2"
        color={handedBack ? "info.main" : "text.secondary"}
        sx={{ flexGrow: 1, minWidth: 0 }}
      >
        {status}
      </Typography>
      {handedBack && isOwner && (
        <Button
          size="small"
          startIcon={<UndoOutlinedIcon />}
          disabled={busy}
          onClick={onReopen}
        >
          Reopen
        </Button>
      )}
    </Stack>
  );
}

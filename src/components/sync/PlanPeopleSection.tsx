/**
 * Who is working on this plan with you — as a list of people, not a message box.
 * ---------------------------------------------------------------------------
 * This replaces `PlanDelegationStrip`, which answered the same question with a
 * shape-shifting `Alert`: blue with a title and two buttons when somebody handed
 * work back, a bare grey caption when they had not, and nothing at all when
 * `/department-ownership` had never run — which, for an owner who had never
 * opened the Delegation page, was most of the time.
 *
 * The trouble with the Alert was not that it was wrong. It was that a delegation
 * is a standing fact about the plan and an Alert is an interruption, so the same
 * information arrived with a different weight, a different colour and a different
 * set of buttons depending on the day. People cannot learn a surface that moves.
 *
 * So: one region, always in the same place, one row per person, and the facts as
 * objects rather than prose — a status dot, an address, department chips, one
 * sentence. The only filled control in the section is the download that collects
 * finished work, which is the one thing an owner comes to this card to do.
 *
 * ## The row is the link
 *
 * Every row navigates to the Delegation page, anchored on that delegation. That
 * is where withdrawing, view-only and reopening live, and they stay there: the
 * withdraw flow alone has a 409 `unsynced-work` branch that must not exist in
 * two places. This card is a status surface; that page is the management one.
 *
 * ## "Download their work" is whole-plan, and says so downstream
 *
 * There is no per-delegate feed — `/changes` takes a watermark and a cursor and
 * nothing else. The button runs the ordinary pull and the review dialog leads
 * with their departments (`highlightDepartments`) while still showing, and
 * saying, that the rest of the plan is arriving too.
 */

import { MouseEvent, ReactNode } from "react";
import ButtonBase from "@mui/material/ButtonBase";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import { ActivityEntry, Delegation } from "../../shared/kairosSync/protocol";
import { delegationCardState } from "../../shared/kairosSync/delegationCardState";
import { PlanDelegationSummary } from "../../shared/kairosSync/delegationSummary";
import { Relation, canDelegate } from "../../shared/kairosSync/relations";
import { TONE_COLOUR } from "./tone";

/** Beyond this the section stops being a glance and becomes a page. */
const ROW_LIMIT = 4;

export interface PlanPeopleSectionProps {
  /**
   * The full grants, when they have been fetched.
   *
   * `null` means not loaded yet — which is NOT the same as "nobody holds
   * anything", and is the distinction the old strip kept getting wrong. The
   * cheap `summary` decides whether anything is expected at all.
   */
  delegations: Delegation[] | null;
  /** Presence, joined on `delegateUserId`. Never on email — see `delegationSummary`. */
  presenceByUserId: Record<string, ActivityEntry>;
  /** From `/department-ownership`. `stale` means it has never run. */
  summary: PlanDelegationSummary | null;
  relation: Relation | null;
  /** Departments this user may see, for a view-only delegate's own row. */
  departments: string[] | null;
  /**
   * Does the server hold anything this computer has not downloaded?
   *
   * What decides whether a handback is still collectable. Without it the
   * download button outlived the download — see `delegationCardState`.
   */
  serverAhead: boolean;
  busy: boolean;
  onDownloadFor: (delegation: Delegation) => void;
  onOpenDelegation: (delegationId?: string) => void;
}

export default function PlanPeopleSection({
  delegations,
  presenceByUserId,
  summary,
  relation,
  departments,
  serverAhead,
  busy,
  onDownloadFor,
  onOpenDelegation,
}: PlanPeopleSectionProps) {
  const isOwner = canDelegate(relation);

  if (!isOwner) {
    return (
      <DelegateRow
        summary={summary}
        relation={relation}
        departments={departments}
        busy={busy}
        onOpenDelegation={onOpenDelegation}
      />
    );
  }

  // `stale` is UNKNOWN, not empty. Rendering the "nobody holds anything" empty
  // state from it would be the reassuring reading and the wrong one.
  //
  // Counted by DELEGATION, not by department. This section draws one row per
  // person, so a department count is the wrong unit for both the emptiness test
  // and the skeletons — and an ownership handover is the case that makes the
  // difference obvious, leaving one delegate holding every department at once.
  //
  // `readOnly` is included: they hold no department away from the owner, but
  // they are somebody with access, and this section's whole question is who
  // else is on the plan.
  const stale = summary?.stale ?? true;
  const expected =
    summary !== null && !stale
      ? new Set(
          [...summary.delegatedOut, ...summary.readOnly, ...summary.handedBack].map(
            (entry) => entry.delegationId
          )
        ).size
      : 0;

  if (stale) return <Frame><Skeleton height={28} /></Frame>;

  if (expected === 0) {
    // A real gap in the old strip, which rendered nothing here: an owner who has
    // never delegated had no way to discover that they could.
    return (
      <Frame>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
            Nobody else is working on this plan.
          </Typography>
          <Button size="small" onClick={() => onOpenDelegation()} disabled={busy}>
            Share a department
          </Button>
        </Stack>
      </Frame>
    );
  }

  // Ownership says somebody holds something, but the grants themselves have not
  // arrived. One skeleton per expected person, so the section does not resize
  // under the reader's eye when they land.
  if (delegations === null) {
    return (
      <Frame count={expected}>
        {Array.from({ length: Math.min(expected, ROW_LIMIT) }, (_, index) => (
          <Skeleton key={index} height={40} />
        ))}
      </Frame>
    );
  }

  // Something to collect first — that is the row the owner came for.
  const ordered = [...delegations].sort((a, b) => {
    const collectable = (delegation: Delegation): number =>
      Number(
        delegationCardState(
          delegation,
          presenceByUserId[delegation.delegateUserId] ?? null,
          { serverAhead }
        ).collectable
      );
    const lead = collectable(b) - collectable(a);
    return lead !== 0 ? lead : a.delegateEmail.localeCompare(b.delegateEmail);
  });
  const shown = ordered.slice(0, ROW_LIMIT);
  const rest = ordered.length - shown.length;

  return (
    <Frame count={ordered.length} onManage={() => onOpenDelegation()} busy={busy}>
      <Stack divider={<Divider flexItem />}>
        {shown.map((delegation) => (
          <PersonRow
            key={delegation.id}
            delegation={delegation}
            presence={presenceByUserId[delegation.delegateUserId] ?? null}
            serverAhead={serverAhead}
            busy={busy}
            onDownload={() => onDownloadFor(delegation)}
            onOpen={() => onOpenDelegation(delegation.id)}
          />
        ))}
      </Stack>
      {rest > 0 && (
        <Button size="small" sx={{ mt: 0.5 }} onClick={() => onOpenDelegation()}>
          {`and ${rest} more`}
        </Button>
      )}
    </Frame>
  );
}

/**
 * The section's chrome: a hairline rule, a label, and the way out to the page.
 *
 * Deliberately not a `Card` inside a `Card` and not an `Alert`. It is a band of
 * the plan card, and it has to read as one whatever is inside it.
 */
function Frame({
  count,
  onManage,
  busy,
  children,
}: {
  count?: number;
  onManage?: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Box sx={{ mt: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", mb: 0.5 }}
      >
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 600, lineHeight: 1.6 }}
        >
          {count === undefined
            ? "Shared with"
            : count === 1
              ? "Shared with 1 person"
              : `Shared with ${count} people`}
        </Typography>
        <Divider sx={{ flexGrow: 1 }} />
        {onManage && (
          <Button
            size="small"
            endIcon={<ChevronRightIcon />}
            onClick={onManage}
            disabled={busy}
            sx={{ color: "text.secondary" }}
          >
            Manage
          </Button>
        )}
      </Stack>
      {children}
    </Box>
  );
}

/**
 * One delegate, one line and a half.
 *
 * The whole row is the link to their card on the Delegation page. The download
 * sits on top of it and stops the click from propagating, which is the ordinary
 * list-row-with-an-action idiom — and it is the only contained control in the
 * section, so a handback carries more weight here than the amber Alert it
 * replaced, with none of the box.
 */
function PersonRow({
  delegation,
  presence,
  serverAhead,
  busy,
  onDownload,
  onOpen,
}: {
  delegation: Delegation;
  presence: ActivityEntry | null;
  serverAhead: boolean;
  busy: boolean;
  onDownload: () => void;
  onOpen: () => void;
}) {
  const state = delegationCardState(delegation, presence, { serverAhead });
  const stateByCode = new Map(
    delegation.departments.map((department) => [department.code, department])
  );
  // Requested but not held is the "recorded, not in effect" case — kept visible
  // rather than silently dropped, same as the Delegation page's card.
  const codes = Array.from(
    new Set([
      ...delegation.departments.map((department) => department.code),
      ...delegation.requestedDepartments,
    ])
  );

  return (
    <ButtonBase
      // A div, not the default <button>: the row carries a Button of its own for
      // the download, and a button inside a button is invalid markup that React
      // warns about and screen readers cannot describe. ButtonBase still applies
      // role="button", tabIndex and the keyboard handlers.
      component="div"
      onClick={onOpen}
      sx={{
        display: "block",
        width: "100%",
        textAlign: "left",
        borderRadius: 1,
        px: 1,
        py: 1,
        mx: -1,
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            mt: 0.9,
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
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {delegation.delegateEmail}
            </Typography>
            {codes.map((code) => {
              const department = stateByCode.get(code);
              if (department?.state === "HANDED_BACK") {
                // Filled only while it is still an invitation. Once the work is
                // downloaded the department is simply the owner's again, and a
                // coloured chip that never settles reads as unfinished business.
                return (
                  <Chip
                    key={code}
                    size="small"
                    color={state.collectable ? "info" : "default"}
                    variant={state.collectable ? "filled" : "outlined"}
                    label={code}
                  />
                );
              }
              if (!delegation.effectiveDepartments.includes(code)) {
                return (
                  <Chip
                    key={code}
                    size="small"
                    variant="outlined"
                    label={code}
                    sx={{ color: "text.disabled", borderStyle: "dashed" }}
                  />
                );
              }
              return <Chip key={code} size="small" variant="outlined" label={code} />;
            })}
            {!delegation.canEdit && (
              <Chip size="small" variant="outlined" label="View only" />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {state.headline}
          </Typography>
        </Box>

        {state.collectable && (
          <Tooltip title="Brings the whole plan down, with their departments listed first.">
            <Box
              component="span"
              sx={{ flexShrink: 0 }}
              onClick={(event: MouseEvent) => event.stopPropagation()}
            >
              <Button
                size="small"
                variant="contained"
                startIcon={<DownloadOutlinedIcon />}
                disabled={busy}
                onClick={onDownload}
              >
                Get their work
              </Button>
            </Box>
          </Tooltip>
        )}
      </Stack>
    </ButtonBase>
  );
}

/**
 * The other side of the same fact: what YOU hold, and how to give it back.
 *
 * A view-only delegate has nothing in `summary.mine` — nothing is writable — so
 * they used to fall through the old strip entirely and lose the "Who has what"
 * route along with it. They get a row of their own, built from the plan's read
 * scope instead.
 */
function DelegateRow({
  summary,
  relation,
  departments,
  busy,
  onOpenDelegation,
}: {
  summary: PlanDelegationSummary | null;
  relation: Relation | null;
  departments: string[] | null;
  busy: boolean;
  onOpenDelegation: (delegationId?: string) => void;
}) {
  if (relation !== "DELEGATE") return null;
  if (!summary || summary.stale) return null;

  const held = summary.mine;
  const handedBack = summary.myHandedBack;
  const viewOnly = held.length === 0 && handedBack.length === 0;

  // Read scope is the only thing a view-only share has to describe itself with.
  const readable = departments ?? [];
  if (viewOnly && readable.length === 0) return null;

  return (
    <Frame>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", flexGrow: 1, minWidth: 0 }}
        >
          <Typography variant="body2" color="text.secondary">
            {viewOnly ? "You can read" : held.length > 0 ? "You hold" : "You have handed back"}
          </Typography>
          {(viewOnly ? readable : held.length > 0 ? held : handedBack).map((code) => (
            <Chip key={code} size="small" variant="outlined" label={code} />
          ))}
          {held.length > 0 && handedBack.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              {`handed back: ${handedBack.join(", ")}`}
            </Typography>
          )}
        </Stack>
        <Button size="small" onClick={() => onOpenDelegation()} disabled={busy}>
          {viewOnly ? "Who has what" : held.length > 0 ? "Hand work back" : "Delegation"}
        </Button>
      </Stack>
    </Frame>
  );
}

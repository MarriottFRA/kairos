/**
 * One plan on the Sync page: what state it is in, and the one thing to do.
 * -----------------------------------------------------------
 * This card used to show five counters — server version, your version,
 * unpublished changes, last published, last pulled — and three buttons of equal
 * weight. Every fact on it was true and none of it answered the question a hotel
 * finance manager actually arrives with, which is "is my work safe, and what do
 * I press?".
 *
 * So the counters moved behind a disclosure and the card leads with a state and
 * a primary action, computed by `planState`. The counters are still there for
 * the people who read them; they are just no longer the headline.
 *
 * ## Review, then apply — in both directions
 *
 * Publish and Pull are both preview-first. That matters more here than in most
 * confirmations: a pull can overwrite an afternoon of a delegate's unpublished
 * work, and a publish can carry a deletion nobody meant. Neither is undone by
 * pressing the button again.
 *
 * ## One decision per band
 *
 * The footer used to carry five buttons of near-equal weight — Delegation, Hand
 * over, Download, Publish, Details — and above them two more, plus an Alert.
 * Every one was individually justified and together they were a wall, which is
 * a bad thing to put in front of a finance director who wants to know whether
 * it is safe to press anything.
 *
 * So the footer is now two verbs and an overflow. Delegation left it entirely
 * (the people section IS the route now), and handing over, checking for
 * differences and repairing the sync state went behind "More" — all three are
 * real and none is a thing anybody does weekly.
 *
 * ## Two overflow menus, on purpose
 *
 * The plain "More" in the footer holds the rare-but-ordinary. The warning-
 * coloured one in the header holds support tools, is drawn only when the
 * Settings switch is on AND the server has confirmed the account is an
 * administrator, and its actions are recorded. They are different colours in
 * different places because "Delete plan" should not be one pixel away from
 * "Publish" — which is also why deleting the server's copy stays inside Details
 * rather than joining the footer menu.
 */

import { ReactNode, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CloudOffOutlinedIcon from "@mui/icons-material/CloudOffOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { PlanSyncStatus } from "../../shared/kairosSync/ipc";
import { PlanDelegationSummary } from "../../shared/kairosSync/delegationSummary";
import { ActivityEntry, Delegation, Lease } from "../../shared/kairosSync/protocol";
import PlanPeopleSection from "./PlanPeopleSection";
import { TONE_COLOUR } from "./tone";
import { changesWaiting, planState } from "../../shared/kairosSync/planState";
import { syncAssurance } from "../../shared/kairosSync/syncAssurance";
import {
  canDeletePlan,
  canRead,
  RELATION_EXPLAINER,
  RELATION_LABEL,
} from "../../shared/kairosSync/relations";

/**
 * A read-only delegation, explained where the relation cannot explain it.
 *
 * `canEdit: false` leaves the relation a plain `DELEGATE` on the wire and strips
 * the write capabilities underneath, so `RELATION_EXPLAINER.DELEGATE` — which
 * promises editing and publishing — would be actively wrong for these. The chip
 * and the popover both switch to this instead.
 */
const VIEW_ONLY_EXPLAINER = {
  can: "Read the whole plan, download updates as the owner publishes them, and see the departments you were given.",
  cannot: "Change anything, publish, or hand a department back.",
  next:
    "The owner is still working on this plan. If you need to edit a department, " +
    "ask them — they can switch this on without re-sharing the plan.",
};

export interface PlanAdminActions {
  onTakeLease: () => void;
  onExtendLease: () => void;
  onReleaseLease: () => void;
  onTransfer: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onExport: () => void;
  onWhy: () => void;
}

export interface PlanSyncCardProps {
  plan: PlanSyncStatus;
  busy: boolean;
  lease?: Lease | null;
  /** Render the support-tools menu. Wanted AND permitted — see `useAdminTools`. */
  adminTools?: boolean;
  admin?: PlanAdminActions;
  onRegister: () => void;
  onPreviewPublish: () => void;
  onPreviewPull: () => void;
  /** Both sides moved — ask which copy wins rather than picking one. */
  onResolveDivergence: () => void;
  /** Optionally anchored on one grant, when the click came from a person's row. */
  onOpenDelegation: (delegationId?: string) => void;
  /**
   * The grants on this plan, for the people section. `null` = not fetched yet,
   * which is NOT the same as nobody holding anything.
   */
  delegations?: Delegation[] | null;
  /** Presence, keyed by `delegateUserId`. */
  presenceByUserId?: Record<string, ActivityEntry>;
  /** Collect one delegate's finished work — an ordinary whole-plan pull. */
  onDownloadForDelegation?: (delegation: Delegation) => void;
  /**
   * `POST /manifest/diff` — reports what disagrees, changes nothing.
   *
   * In the overflow rather than the card body: it answers a question almost
   * nobody has, and the two people who do have it are usually on the phone to
   * support when they ask it.
   */
  onReconcile?: () => void;
  /** `GET /manifest` — adopts the server's hashes into the shadow. */
  onRebuildShadow?: () => void;
  /**
   * A fresher `/department-ownership` answer than the status call carried.
   *
   * The status call derives `plan.delegation` from whatever was last cached,
   * which is nothing at all for an owner who has never opened the Delegation
   * page — most of them. `useDelegationOverview` fills that in for the plans
   * that can have a delegation; this is where the result arrives.
   */
  delegationOverride?: PlanDelegationSummary | null;
  /** Owner-callable, no administrator involved. */
  onTransfer?: () => void;
  /**
   * Delete the SERVER's copy. Owner-callable — `plan:delete` belongs to OWNER
   * and ADMIN_LEASE, so it is not a support action and does not belong only in
   * the support menu. It lives behind Details rather than in the button row:
   * the same reasoning that keeps it out of one pixel from Publish.
   */
  onDeleteFromServer?: () => void;
  /**
   * Remove this computer's copy of a plan that is no longer shared.
   *
   * Only ever offered on a frozen copy — one the server has stopped sharing and
   * the status sweep spared because it holds unpublished work. Everything clean
   * is purged without asking, because there is nothing to ask about.
   */
  onDiscardLocalCopy?: () => void;
  children?: ReactNode;
}

export default function PlanSyncCard({
  plan,
  busy,
  lease,
  adminTools,
  admin,
  onRegister,
  onPreviewPublish,
  onPreviewPull,
  onResolveDivergence,
  onOpenDelegation,
  delegations = null,
  presenceByUserId = {},
  onDownloadForDelegation,
  onReconcile,
  onRebuildShadow,
  delegationOverride,
  onTransfer,
  onDeleteFromServer,
  onDiscardLocalCopy,
  children,
}: PlanSyncCardProps) {
  const state = planState(plan, lease);
  const partial = plan.scopeKind === "PARTIAL";
  const isOwner = plan.relation === "OWNER" || plan.relation === "OWNER_DEGRADED";
  // `plan:delete` is OWNER and ADMIN_LEASE only — NOT OWNER_DEGRADED, whose
  // access has lapsed, and not GLOBAL_ADMIN without a lease. Offering it wider
  // than that just produces a 403 the user cannot act on.
  const canDelete =
    plan.published && onDeleteFromServer !== undefined && canDeletePlan(plan.relation);
  /**
   * A delegation granted with `canEdit: false`.
   *
   * `writeScope` comes from `/department-ownership`, which is the same predicate
   * a save uses, so this cannot disagree with what happens on save. `UNKNOWN`
   * means that call has not run yet and is deliberately NOT treated as read-only
   * — accusing a working delegate of having lost their access is worse than a
   * button that occasionally has to explain itself.
   */
  const viewOnly = plan.relation === "DELEGATE" && plan.writeScope === "NONE";
  /**
   * The plan is here and the server will not talk about it.
   *
   * Only reachable with unpublished work in it — anything clean is purged by the
   * status call before the page is built. So the card keeps its Details (the
   * counters are the reassurance) and loses both of its buttons: Download is a
   * 403 and Publish is a 403.
   */
  const frozen = plan.relation !== null && !canRead(plan.relation);

  const [showDetails, setShowDetails] = useState(false);
  const [relationAnchor, setRelationAnchor] = useState<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);

  const summary = delegationOverride ?? plan.delegation;
  /**
   * The two sentences that answer the questions people hesitate over — does a
   * download wipe my work, does a publish wipe theirs. Both can be null, and the
   * whole caption disappears when they are; a permanent reassurance stops being
   * read within a week.
   */
  const assurance = syncAssurance(plan, summary);
  const closeMore = (): void => setMoreAnchor(null);
  const runMore = (action?: () => void) => () => {
    closeMore();
    action?.();
  };
  const hasMore =
    (isOwner && onTransfer !== undefined) ||
    (plan.published && (onReconcile !== undefined || onRebuildShadow !== undefined));

  const explainer = viewOnly
    ? VIEW_ONLY_EXPLAINER
    : plan.relation
      ? RELATION_EXPLAINER[plan.relation]
      : undefined;
  const closeMenu = (): void => setMenuAnchor(null);
  const runAdmin = (action: () => void) => () => {
    closeMenu();
    action();
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 2, mb: 2 }}>
      <CardContent>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {plan.label}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {plan.year} · {plan.ou}
            </Typography>
          </Box>

          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {!plan.published && (
              <Chip
                size="small"
                icon={<CloudOffOutlinedIcon />}
                label="Not published"
                variant="outlined"
              />
            )}
            {plan.relation && (
              // Clickable for everything except plain ownership: a relation that
              // constrains you should be able to tell you how.
              <Chip
                size="small"
                label={
                  // "Delegated to you" promises a pen this grant does not carry.
                  viewOnly ? "Shared with you · view only" : RELATION_LABEL[plan.relation] ?? plan.relation
                }
                color={plan.relation === "OWNER" ? "primary" : "default"}
                variant="outlined"
                onClick={
                  explainer && plan.relation !== "OWNER"
                    ? (event) => setRelationAnchor(event.currentTarget)
                    : undefined
                }
              />
            )}
            {partial && !viewOnly && (
              // Not decoration. A partial scope silently under-reports every
              // total on the Results page and makes a BST push destructive, so
              // the user has to be able to see it from here.
              <Tooltip title="You hold some of this plan's departments. Allocations, totals and BST push are disabled — they would be wrong, not just incomplete.">
                <Chip
                  size="small"
                  color="warning"
                  label={`Partial scope · ${plan.departments?.length ?? 0} departments`}
                />
              </Tooltip>
            )}
            {/* The `N handed back` chip used to live here. It was the anonymous
                version of a fact the people section below now states by name,
                with the person it belongs to and a button that acts on it. Two
                places saying the same thing at different resolutions is how a
                card gets crowded. */}
            {adminTools && admin && (
              <Tooltip title="Support tools">
                <IconButton
                  size="small"
                  color="warning"
                  onClick={(event) => setMenuAnchor(event.currentTarget)}
                >
                  <MoreVertIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        </Stack>

        {/* The headline: what state this plan is in, and what it means. */}
        <Stack direction="row" spacing={1.5} sx={{ mt: 2, alignItems: "flex-start" }}>
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              mt: 0.75,
              flexShrink: 0,
              bgcolor: TONE_COLOUR[state.tone],
            }}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {state.headline}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {state.detail}
            </Typography>
          </Box>
        </Stack>

        {/* Below the one-sentence state, above the lease banner. The "somebody
            has finished with Rooms" signal, now as a list of people rather than
            an Alert — see PlanPeopleSection for why that swap matters. */}
        {/* Nothing can be shared before it is on the server, so an unpublished
            plan gets no people section at all — least of all the "Share a
            department" empty state, which would send somebody to a page that can
            only refuse them. */}
        {!frozen && plan.published && (
          <PlanPeopleSection
            delegations={delegations}
            presenceByUserId={presenceByUserId}
            summary={summary}
            relation={plan.relation}
            departments={plan.departments}
            // Whether a handback still has anything behind it. The grant cannot
            // answer that — it stays HANDED_BACK until the owner reopens it —
            // and the plan's own watermark can.
            serverAhead={changesWaiting(plan) > 0}
            busy={busy}
            onDownloadFor={onDownloadForDelegation ?? (() => undefined)}
            onOpenDelegation={onOpenDelegation}
          />
        )}

        {children}

        <Divider sx={{ my: 2 }} />

        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
        >
          <Button
            size="small"
            endIcon={
              <ExpandMoreIcon
                sx={{
                  transform: showDetails ? "rotate(180deg)" : undefined,
                  transition: "transform 150ms",
                }}
              />
            }
            onClick={() => setShowDetails((open) => !open)}
            sx={{ color: "text.secondary" }}
          >
            Details
          </Button>

          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            {busy && <CircularProgress size={20} />}
            {!plan.published ? (
              // A plan of this name is already up there and is not this one, so
              // publishing would put a second one beside it. The way out is the
              // "Download and replace" on that plan's card further down the
              // page, or renaming this one — both said in the state's detail.
              <Tooltip
                title={
                  plan.twinPlanId
                    ? "A plan with this name is already on the server. Download it below, or rename this plan to publish it separately."
                    : ""
                }
              >
                <span>
                  <Button
                    variant="contained"
                    onClick={onRegister}
                    disabled={busy || plan.twinPlanId !== null}
                  >
                    Publish to server
                  </Button>
                </span>
              </Tooltip>
            ) : frozen ? (
              // Nothing here works any more. Both buttons are 403s, and drawing
              // a disabled pair invites somebody to keep pressing them; the
              // headline already says what happened and what would change it.
              // Discarding lives in Details, quietly — see below.
              null
            ) : (
              <>
                {/* Both sides moved. Neither Download nor Publish is the
                    answer on its own, and offering them side by side invites
                    somebody to press one and lose the other's work. */}
                {state.kind === "DIVERGED" && (
                  <Button variant="contained" onClick={onResolveDivergence} disabled={busy}>
                    Review both versions
                  </Button>
                )}
                {/* The Delegation button used to live here, for owners and
                    delegates alike. It has gone: the people section above is the
                    route now, and it is a better one — it says who and what
                    before you get there instead of after. The one case that
                    needed watching is a view-only delegate, who holds nothing
                    writable and so used to fall through the strip entirely;
                    `PlanPeopleSection` gives them a row of their own built from
                    read scope, carrying the same "Who has what" label. */}
                <Button
                  startIcon={<CloudDownloadOutlinedIcon />}
                  onClick={onPreviewPull}
                  disabled={busy}
                  // Enabled even when level, because a manifest can disagree
                  // with a version — reconciliation is what catches that.
                  color={state.action === "pull" ? "primary" : "inherit"}
                  variant={state.action === "pull" ? "contained" : "text"}
                >
                  {/* "Download" reads as "download OVER" to somebody holding
                      unpublished work — who is exactly the person who most needs
                      to press it, an owner collecting a delegate's finished
                      department. On a plan already here this is a per-row merge,
                      and the count of what it would actually replace (usually
                      zero) is one click away in the review. Not split into two
                      buttons: the card cannot know which it is until the preview
                      has fetched the delta, so promising either would be a
                      promise it is not in a position to make. */}
                  {plan.pendingChanges > 0 ? "Get changes" : "Download"}
                </Button>
                {/* Withheld rather than disabled for a view-only share. This is
                    the grant working as the owner intended, not a fault, and a
                    greyed-out Publish reads as something broken. */}
                {!viewOnly && (
                  <Button
                    startIcon={<CloudUploadOutlinedIcon />}
                    onClick={onPreviewPublish}
                    disabled={busy}
                    color={state.action === "publish" ? "primary" : "inherit"}
                    variant={state.action === "publish" ? "contained" : "outlined"}
                  >
                    Publish
                  </Button>
                )}
                {hasMore && (
                  <Tooltip title="More">
                    <IconButton
                      size="small"
                      onClick={(event) => setMoreAnchor(event.currentTarget)}
                    >
                      <MoreHorizIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </>
            )}
          </Stack>
        </Stack>

        {/* One quiet line, right under the buttons it is about. The full answer
            lives in the review dialog — this is only what somebody needs before
            they are willing to open it. Unmounts entirely when there is nothing
            live to say, because a permanent reassurance is not read. */}
        {!frozen && plan.published && (assurance.download || assurance.publish) && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 1, textAlign: { xs: "left", sm: "right" } }}
          >
            {[assurance.download, assurance.publish].filter(Boolean).join(" ")}
          </Typography>
        )}

        <Collapse in={showDetails} unmountOnExit>
          <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap", mt: 2 }}>
            <Detail label="Server version" value={plan.published ? plan.serverVersion : "—"} />
            <Detail label="You have" value={plan.published ? plan.watermark : "—"} />
            <Detail
              label="Unpublished changes"
              value={plan.pendingChanges > 0 ? plan.pendingChanges : "None"}
              emphasise={plan.pendingChanges > 0}
            />
            <Detail label="Last published" value={formatWhen(plan.lastPublishedAt)} />
            <Detail label="Last pulled" value={formatWhen(plan.lastPulledAt)} />
          </Stack>

          {canDelete && (
            // Last thing in the disclosure, quiet, and a long way from Publish.
            // The sentence beside it is the point: people hesitate over this
            // because they think it deletes their work, and it does not.
            <>
              <Divider sx={{ mt: 2, mb: 1.5 }} />
              <Stack
                direction="row"
                spacing={2}
                useFlexGap
                sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
              >
                <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 460 }}>
                  Removes the server&rsquo;s copy only. The plan stays on this
                  computer and keeps working; colleagues lose the ability to
                  download it or publish to it.
                </Typography>
                <Button size="small" color="error" onClick={onDeleteFromServer} disabled={busy}>
                  Delete from the server
                </Button>
              </Stack>
            </>
          )}

          {frozen && onDiscardLocalCopy && (
            // An escape hatch, not a prompt. This copy survives only because it
            // has unpublished work in it, and that work is the reason not to
            // remove it — the owner may delegate again, in which case it
            // publishes normally. So the button is here, in a disclosure, with
            // the case for keeping it stated first.
            <>
              <Divider sx={{ mt: 2, mb: 1.5 }} />
              <Stack
                direction="row"
                spacing={2}
                useFlexGap
                sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
              >
                <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 460 }}>
                  Kept because of the unpublished changes above. If the owner
                  shares the plan with you again, they publish as normal.
                  Discarding removes the plan and those changes from this
                  computer for good.
                </Typography>
                <Button
                  size="small"
                  color="error"
                  onClick={onDiscardLocalCopy}
                  disabled={busy}
                >
                  Discard this copy
                </Button>
              </Stack>
            </>
          )}
        </Collapse>
      </CardContent>

      <Popover
        open={relationAnchor !== null}
        anchorEl={relationAnchor}
        onClose={() => setRelationAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        {explainer && (
          <Box sx={{ p: 2, maxWidth: 400 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
              {viewOnly
                ? "Shared with you · view only"
                : plan.relation
                  ? RELATION_LABEL[plan.relation]
                  : ""}
            </Typography>
            <Typography variant="body2" sx={{ mb: 1 }}>
              <strong>You can</strong> {explainer.can}
            </Typography>
            <Typography variant="body2" sx={{ mb: 1 }}>
              <strong>You cannot</strong> {explainer.cannot}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {explainer.next}
            </Typography>
            {adminTools && admin && (
              <Button
                size="small"
                sx={{ mt: 1 }}
                onClick={() => {
                  setRelationAnchor(null);
                  admin.onWhy();
                }}
              >
                Why does the server say this?
              </Button>
            )}
          </Box>
        )}
      </Popover>

      {/* Rare, ordinary, and none of it destructive. Deleting the server's copy
          is NOT here: it stays in Details with the sentence that stops people
          fearing it deletes their work, and a long way from Publish. */}
      <Menu anchorEl={moreAnchor} open={moreAnchor !== null} onClose={closeMore}>
        {isOwner && onTransfer && (
          <MenuItem onClick={runMore(onTransfer)} disabled={busy}>
            <ListItemText
              primary="Hand over to a colleague"
              secondary="Makes them the owner. You keep the plan on this computer."
            />
          </MenuItem>
        )}
        {plan.published && onReconcile && (
          <MenuItem onClick={runMore(onReconcile)} disabled={busy}>
            <ListItemText
              primary="Check for differences"
              secondary="Compares row by row. Changes nothing."
            />
          </MenuItem>
        )}
        {plan.published && onRebuildShadow && (
          <MenuItem onClick={runMore(onRebuildShadow)} disabled={busy}>
            <ListItemText
              primary="Repair sync state"
              secondary="After rebuilding the database or running an import."
            />
          </MenuItem>
        )}
      </Menu>

      <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={closeMenu}>
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="overline" color="warning.main" sx={{ fontWeight: 700 }}>
            Support tools
          </Typography>
        </Box>
        <Divider />
        {admin && [
          lease ? (
            <MenuItem key="extend" onClick={runAdmin(admin.onExtendLease)}>
              <ListItemText primary="Extend the lease" />
            </MenuItem>
          ) : (
            <MenuItem key="take" onClick={runAdmin(admin.onTakeLease)}>
              <ListItemText
                primary="Take a support lease"
                secondary="Required before changing anybody else's plan"
              />
            </MenuItem>
          ),
          lease ? (
            <MenuItem key="release" onClick={runAdmin(admin.onReleaseLease)}>
              <ListItemText
                primary="Release the lease"
                secondary="Everyone re-downloads the plan"
              />
            </MenuItem>
          ) : null,
          <Divider key="d1" />,
          <MenuItem key="why" onClick={runAdmin(admin.onWhy)}>
            <ListItemText primary="Why this access?" secondary="Trace the owner's permissions" />
          </MenuItem>,
          <MenuItem key="export" onClick={runAdmin(admin.onExport)}>
            <ListItemText primary="Export a repro bundle" secondary="Recorded, 20 per day" />
          </MenuItem>,
          <Divider key="d2" />,
          <MenuItem key="transfer" onClick={runAdmin(admin.onTransfer)}>
            <ListItemText primary="Transfer ownership" />
          </MenuItem>,
          <MenuItem key="archive" onClick={runAdmin(admin.onArchive)}>
            <ListItemText primary="Archive this plan" />
          </MenuItem>,
          <MenuItem key="delete" onClick={runAdmin(admin.onDelete)}>
            <ListItemText
              primary={<Typography color="error.main">Delete this plan</Typography>}
              secondary="Recoverable by support"
            />
          </MenuItem>,
        ]}
      </Menu>
    </Card>
  );
}

function Detail({
  label,
  value,
  emphasise,
}: {
  label: string;
  value: string | number;
  emphasise?: boolean;
}) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ fontWeight: emphasise ? 700 : 500, color: emphasise ? "warning.main" : undefined }}
      >
        {value}
      </Typography>
    </Box>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "Never";
  return new Date(parsed).toLocaleString();
}

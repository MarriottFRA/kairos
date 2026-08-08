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
 * ## Support tools
 *
 * The administrator controls are rendered only when the Settings switch is on
 * AND the server has confirmed the account is an administrator. They sit in an
 * overflow menu rather than the button row, with warning colouring, because
 * "Delete plan" should not be one pixel away from "Publish".
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
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { PlanSyncStatus } from "../../shared/kairosSync/ipc";
import { Lease } from "../../shared/kairosSync/protocol";
import { PlanState, planState } from "../../shared/kairosSync/planState";

/** Human wording for each relation. The user should never see the enum. */
const RELATION_LABEL: Record<string, string> = {
  OWNER: "You own this plan",
  OWNER_DEGRADED: "You own this plan, but your access has lapsed",
  DELEGATE: "Delegated to you",
  ADMIN_LEASE: "You hold a support lease",
  GLOBAL_ADMIN: "Administrator — read only",
  OU_MEMBER: "Read only",
};

/**
 * What each relation means for this user, in the second person.
 *
 * The chip on its own is a dead end — "Administrator — read only" states a fact
 * and leaves the reader to guess its consequences and whether it is a mistake.
 * These are the consequences.
 */
const RELATION_EXPLAINER: Record<string, { can: string; cannot: string; next: string }> = {
  OWNER: {
    can: "Edit every department, publish, delegate, transfer the plan and push it to the budget workbook.",
    cannot: "Edit a department while it is delegated to somebody else.",
    next: "To take one back, withdraw the delegation on the Delegation page.",
  },
  OWNER_DEGRADED: {
    can: "Edit your departments and publish them.",
    cannot:
      "Change the plan's columns, blocks, schemes, allocations or KPI drivers — that needs full access to the hotel.",
    next: "Your administrator can restore it by granting you all departments and write access to this hotel.",
  },
  DELEGATE: {
    can: "Edit and publish the departments you were given, and download the whole plan.",
    cannot:
      "Edit other departments, change the plan's structure, delegate onwards, or push to the budget workbook.",
    next: "When you have finished a department, hand it back on the Delegation page.",
  },
  ADMIN_LEASE: {
    can: "Everything the owner can, for as long as the lease lasts.",
    cannot: "Hold it indefinitely — it expires, and the hotel is locked out meanwhile.",
    next: "Release it as soon as you are done, with a note of what you changed.",
  },
  GLOBAL_ADMIN: {
    can: "See this plan, including its numbers, and download it.",
    cannot: "Change anything, publish, or push to the budget workbook.",
    next:
      "If you expected to own this plan, the server does not agree — check who it is " +
      "registered to. To change something on somebody else's plan, take a support lease.",
  },
  OU_MEMBER: {
    can: "See this plan and download it.",
    cannot: "Change anything or publish.",
    next: "Ask the plan's owner to delegate the departments you need.",
  },
};

const TONE_COLOUR: Record<PlanState["tone"], string> = {
  neutral: "text.disabled",
  good: "success.main",
  attention: "warning.main",
  blocked: "error.main",
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
  onOpenDelegation: () => void;
  /** Owner-callable, no administrator involved. */
  onTransfer?: () => void;
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
  onTransfer,
  children,
}: PlanSyncCardProps) {
  const state = planState(plan, lease);
  const partial = plan.scopeKind === "PARTIAL";
  const isOwner = plan.relation === "OWNER" || plan.relation === "OWNER_DEGRADED";

  const [showDetails, setShowDetails] = useState(false);
  const [relationAnchor, setRelationAnchor] = useState<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const explainer = plan.relation ? RELATION_EXPLAINER[plan.relation] : undefined;
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
                label={RELATION_LABEL[plan.relation] ?? plan.relation}
                color={plan.relation === "OWNER" ? "primary" : "default"}
                variant="outlined"
                onClick={
                  explainer && plan.relation !== "OWNER"
                    ? (event) => setRelationAnchor(event.currentTarget)
                    : undefined
                }
              />
            )}
            {partial && (
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
            {plan.handbacksPending > 0 && (
              <Chip size="small" color="info" label={`${plan.handbacksPending} handed back`} />
            )}
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
              <Button variant="contained" onClick={onRegister} disabled={busy}>
                Publish to server
              </Button>
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
                {isOwner && (
                  <Button onClick={onOpenDelegation} disabled={busy}>
                    Delegation
                  </Button>
                )}
                {isOwner && onTransfer && (
                  <Button onClick={onTransfer} disabled={busy}>
                    Hand over
                  </Button>
                )}
                <Button
                  startIcon={<CloudDownloadOutlinedIcon />}
                  onClick={onPreviewPull}
                  disabled={busy}
                  // Enabled even when level, because a manifest can disagree
                  // with a version — reconciliation is what catches that.
                  color={state.action === "pull" ? "primary" : "inherit"}
                  variant={state.action === "pull" ? "contained" : "text"}
                >
                  Download
                </Button>
                <Button
                  startIcon={<CloudUploadOutlinedIcon />}
                  onClick={onPreviewPublish}
                  disabled={busy}
                  color={state.action === "publish" ? "primary" : "inherit"}
                  variant={state.action === "publish" ? "contained" : "outlined"}
                >
                  Publish
                </Button>
              </>
            )}
          </Stack>
        </Stack>

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
              {plan.relation ? RELATION_LABEL[plan.relation] : ""}
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

/**
 * A plan the server holds and this computer does not.
 * -----------------------------------------------------------
 * The Sync page used to be built from the local `scenarios` table alone, with
 * `/sync/heads` consulted only to decorate rows that already existed. Anything
 * the server listed and this machine had never seen was dropped, which made two
 * ordinary situations look like nothing at all:
 *
 * - **A new computer.** Your own plan is on the server and invisible here.
 * - **A delegation.** The owner grants you three departments; you open Sync and
 *   are told to create a scenario on the Positions page — and creating one and
 *   publishing it is a `POST /plans`, which a delegate is not eligible to make.
 *
 * So these get their own section and one button. Deliberately not a
 * `PlanSyncCard`: every counter on that card is a comparison against a local
 * copy, and there is not one yet.
 *
 * ## The name clash
 *
 * If a plan of the same name and year already exists on this machine, it is a
 * DIFFERENT plan — the scenario id is the plan id, so a hand-rebuilt copy can
 * never be the same one. Downloading takes over the name: the server's copy
 * becomes the plan, the local one is soft-deleted. That is said here in full
 * before anything is pressed, because it is the one irreversible-looking part of
 * an otherwise safe action.
 *
 * ## The locked tile
 *
 * Access to a hotel is no longer access to every plan in it. A plan whose owner
 * has not delegated to you arrives here as an `OU_VISITOR` entry — discoverable,
 * with its version, row count and scope all withheld — and this card renders it
 * as a lock rather than an error.
 *
 * It stays visible on purpose. A plan that simply vanished would read as data
 * loss to somebody who knows it exists, and you cannot ask for access to
 * something you cannot see. So the tile carries the two facts that make the next
 * step obvious — what it is called, and who to ask — and offers that ask
 * directly. What it does NOT carry is any number: `serverRows` and the version
 * are null for these, and rendering "0 rows" would be a confident lie about a
 * plan with three thousand.
 *
 * The chip is grey, not amber. This is the correct, ordinary state of a
 * colleague's plan; colouring it as a fault teaches people to raise tickets
 * about the system working.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import MailOutlinedIcon from "@mui/icons-material/MailOutlined";
import { PlanSyncStatus } from "../../shared/kairosSync/ipc";
import { canDeletePlan, RELATION_LABEL } from "../../shared/kairosSync/relations";

export interface CloudPlanCardProps {
  plan: PlanSyncStatus;
  busy: boolean;
  /** The label of the local plan this would replace, if there is one. */
  twinLabel?: string | null;
  onDownload: () => void;
  /**
   * Delete the server's copy. Owner-callable, and the answer to a plan on the
   * server that nobody wants — including the name clash, where deleting is what
   * frees the name so the local plan of that name can finally be published.
   */
  onDeleteFromServer?: () => void;
  /**
   * Ask the owner for a delegation.
   *
   * The only move available on a locked tile, and the reason `ownerEmail` is on
   * the wire at all. Handled by the page rather than here because opening a mail
   * draft is a shell action.
   */
  onRequestAccess?: (plan: PlanSyncStatus) => void;
  /** Put the owner's address on the clipboard, for estates that block mailto. */
  onCopyOwnerEmail?: (email: string) => void;
}

export default function CloudPlanCard({
  plan,
  busy,
  twinLabel,
  onDownload,
  onDeleteFromServer,
  onRequestAccess,
  onCopyOwnerEmail,
}: CloudPlanCardProps) {
  const departments = plan.departments?.length ?? 0;
  // `plan:delete` is OWNER and ADMIN_LEASE only. A delegate looking at a plan
  // that has been shared with them must never be offered this — and neither
  // must somebody who cannot even open it.
  const canDelete = onDeleteFromServer !== undefined && canDeletePlan(plan.relation);

  if (!plan.readable) {
    return (
      <LockedPlanCard
        plan={plan}
        onRequestAccess={onRequestAccess}
        onCopyOwnerEmail={onCopyOwnerEmail}
      />
    );
  }

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
              {plan.ownerEmail ? ` · owned by ${plan.ownerEmail}` : ""}
              {plan.serverRows > 0 ? ` · ${plan.serverRows.toLocaleString()} rows` : ""}
            </Typography>
          </Box>

          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {plan.relation && (
              <Chip
                size="small"
                variant="outlined"
                color={plan.relation === "OWNER" ? "primary" : "default"}
                label={RELATION_LABEL[plan.relation] ?? plan.relation}
              />
            )}
            {plan.scopeKind === "PARTIAL" && (
              <Chip
                size="small"
                color="warning"
                label={`${departments} ${departments === 1 ? "department" : "departments"}`}
              />
            )}
          </Stack>
        </Stack>

        {plan.twinPlanId && (
          // Never quietly: the local plan disappears from every other page the
          // moment this download applies.
          <Alert severity="warning" sx={{ mt: 2 }}>
            You already have <strong>{twinLabel ?? plan.label}</strong> on this
            computer, and it is a different plan. Downloading makes this one the
            plan of that name — the local copy stops being listed and its
            unpublished work goes with it.
          </Alert>
        )}

        {/* Delete is on the OPPOSITE end of the row from Download, not beside
            it. There is no Details disclosure to hide it behind here, so the
            separation has to come from the layout: a plain text button in error
            colour at the far left, and the filled primary at the far right. The
            two most consequential actions on this card send the plan in
            opposite directions, and they should not be adjacent. */}
        <Stack
          direction="row"
          spacing={1}
          sx={{ mt: 2, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
        >
          <Box>
            {canDelete && (
              <Button size="small" color="error" disabled={busy} onClick={onDeleteFromServer}>
                Delete from the server
              </Button>
            )}
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            {busy && <CircularProgress size={20} />}
            <Button
              variant="contained"
              startIcon={<CloudDownloadOutlinedIcon />}
              disabled={busy}
              onClick={onDownload}
            >
              {plan.twinPlanId ? "Download and replace" : "Download to this computer"}
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * A plan you can see and cannot open.
 *
 * Everything quantitative is deliberately absent — see the note at the top of
 * this file. What is left is the label, the owner, and the one thing that
 * changes the situation.
 */
function LockedPlanCard({
  plan,
  onRequestAccess,
  onCopyOwnerEmail,
}: {
  plan: PlanSyncStatus;
  onRequestAccess?: (plan: PlanSyncStatus) => void;
  onCopyOwnerEmail?: (email: string) => void;
}) {
  const owner = plan.ownerEmail;

  return (
    <Card variant="outlined" sx={{ borderRadius: 2, mb: 2 }}>
      <CardContent>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}
        >
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start", minWidth: 0 }}>
            <LockOutlinedIcon fontSize="small" sx={{ mt: 0.5, color: "text.disabled" }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                {plan.label}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {plan.year} · {plan.ou}
                {owner ? ` · owned by ${owner}` : ""}
              </Typography>
            </Box>
          </Stack>

          {/* Grey, not amber. Nothing has gone wrong here. */}
          <Chip
            size="small"
            variant="outlined"
            label={RELATION_LABEL[plan.relation ?? ""] ?? "Not shared with you"}
          />
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mt: 2, maxWidth: 620 }}>
          {owner ? <strong>{owner}</strong> : "Its owner"} has not given you access
          to this plan. You can see that it exists; you cannot open it or see any
          of its numbers. Ask them to delegate the departments you need — they can
          share it read-only and carry on working on it themselves.
        </Typography>

        {onRequestAccess && owner && (
          <Stack
            direction="row"
            spacing={1}
            sx={{ mt: 2, justifyContent: "flex-end", flexWrap: "wrap" }}
          >
            {/* Two routes to the same address, because estates differ on
                whether an app may open a mail client. One of them always
                works, and a tile that cannot say who to ask is a dead end. */}
            {onCopyOwnerEmail && (
              <Button
                size="small"
                startIcon={<ContentCopyOutlinedIcon fontSize="small" />}
                onClick={() => onCopyOwnerEmail(owner)}
              >
                Copy email
              </Button>
            )}
            <Button
              size="small"
              variant="outlined"
              startIcon={<MailOutlinedIcon fontSize="small" />}
              onClick={() => onRequestAccess(plan)}
            >
              Ask for access
            </Button>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

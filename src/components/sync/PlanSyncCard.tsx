/**
 * One plan's row on the Sync page: state, and the two buttons.
 * -----------------------------------------------------------
 * Publish and Pull are both review-then-apply. The preview is a separate,
 * read-only round trip that writes nothing, and the confirm step is where the
 * user sees what is about to change. That matters more here than in most
 * confirm dialogs: a pull can overwrite an afternoon of a delegate's
 * unpublished work, and a publish can carry a deletion nobody meant.
 */

import { ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CloudOffOutlinedIcon from "@mui/icons-material/CloudOffOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import { PlanSyncStatus } from "../../shared/kairosSync/ipc";

/** Human wording for each relation. The user should never see the enum. */
const RELATION_LABEL: Record<string, string> = {
  OWNER: "You own this plan",
  OWNER_DEGRADED: "You own this plan, but your access has lapsed",
  DELEGATE: "Delegated to you",
  ADMIN_LEASE: "You hold a support lease",
  GLOBAL_ADMIN: "Administrator — read only",
  OU_MEMBER: "Read only",
};

export interface PlanSyncCardProps {
  plan: PlanSyncStatus;
  busy: boolean;
  onRegister: () => void;
  onPreviewPublish: () => void;
  onPreviewPull: () => void;
  onOpenDelegation: () => void;
  children?: ReactNode;
}

export default function PlanSyncCard({
  plan,
  busy,
  onRegister,
  onPreviewPublish,
  onPreviewPull,
  onOpenDelegation,
  children,
}: PlanSyncCardProps) {
  const behind = plan.published && plan.serverVersion > plan.watermark;
  const partial = plan.scopeKind === "PARTIAL";
  const isOwner = plan.relation === "OWNER" || plan.relation === "OWNER_DEGRADED";

  return (
    <Card variant="outlined" sx={{ borderRadius: 2, mb: 2 }}>
      <CardContent>
        <Stack
          direction="row"
          spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
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
              <Chip
                size="small"
                label={RELATION_LABEL[plan.relation] ?? plan.relation}
                color={plan.relation === "OWNER" ? "primary" : "default"}
                variant="outlined"
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
              <Chip
                size="small"
                color="info"
                label={`${plan.handbacksPending} handed back`}
              />
            )}
          </Stack>
        </Stack>

        {children}

        <Divider sx={{ my: 2 }} />

        <Stack
          direction="row"
          spacing={2}
          useFlexGap sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
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

          <Stack direction="row" spacing={1}>
            {busy && <CircularProgress size={20} />}
            {!plan.published ? (
              <Button variant="contained" onClick={onRegister} disabled={busy}>
                Publish to server
              </Button>
            ) : (
              <>
                {isOwner && (
                  <Button onClick={onOpenDelegation} disabled={busy}>
                    Delegation
                  </Button>
                )}
                <Button
                  startIcon={<CloudDownloadOutlinedIcon />}
                  onClick={onPreviewPull}
                  disabled={busy}
                  // Enabled even when level, because a manifest can disagree
                  // with a version — reconciliation is what catches that.
                  color={behind ? "primary" : "inherit"}
                  variant={behind ? "contained" : "text"}
                >
                  {behind ? `Pull ${plan.serverVersion - plan.watermark} changes` : "Pull"}
                </Button>
                <Button
                  startIcon={<CloudUploadOutlinedIcon />}
                  onClick={onPreviewPublish}
                  disabled={busy}
                  variant="outlined"
                >
                  Publish
                </Button>
              </>
            )}
          </Stack>
        </Stack>
      </CardContent>
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

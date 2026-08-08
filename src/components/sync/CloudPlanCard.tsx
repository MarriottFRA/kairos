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
import { PlanSyncStatus } from "../../shared/kairosSync/ipc";

/** Human wording for each relation, in the second person. */
const RELATION_LABEL: Record<string, string> = {
  OWNER: "You own this plan",
  OWNER_DEGRADED: "You own this plan, but your access has lapsed",
  DELEGATE: "Delegated to you",
  ADMIN_LEASE: "You hold a support lease",
  GLOBAL_ADMIN: "Administrator — read only",
  OU_MEMBER: "Read only",
};

export interface CloudPlanCardProps {
  plan: PlanSyncStatus;
  busy: boolean;
  /** The label of the local plan this would replace, if there is one. */
  twinLabel?: string | null;
  onDownload: () => void;
}

export default function CloudPlanCard({
  plan,
  busy,
  twinLabel,
  onDownload,
}: CloudPlanCardProps) {
  const departments = plan.departments?.length ?? 0;

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

        <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: "center", justifyContent: "flex-end" }}>
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
      </CardContent>
    </Card>
  );
}

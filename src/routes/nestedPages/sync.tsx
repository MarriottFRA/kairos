/**
 * Sync page — publish a plan, download changes, and see who holds what.
 * -----------------------------------------------------------
 * The hub for everything server-side. Kairos works entirely without it: a hotel
 * that never opens this page has no rows on the server and loses nothing.
 *
 * ## Cadence
 *
 * `GET /sync/heads` is the ONLY thing on a timer — on mount, on window focus,
 * and every five minutes idle. It is one conditional request covering plans,
 * structure, BST, clusters and mapping tables, and in the steady state it
 * answers 304 in a couple of hundred bytes. Everything else on this page is a
 * user action, or is triggered by what the probe reported.
 *
 * `/changes` and `/plans` are never polled.
 *
 * ## Review, then apply
 *
 * Both directions preview first. A pull can overwrite unpublished local work and
 * a publish can carry a deletion nobody meant; neither is undone by pressing the
 * button again.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CloudSyncOutlinedIcon from "@mui/icons-material/CloudSyncOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useSelectedHotel } from "../../store/settings";
import {
  previewPublish as previewPublishCall,
  previewPull as previewPullCall,
  probe as probeCall,
  publish as publishCall,
  pull as pullCall,
  previewStructure as previewStructureCall,
  pullStructure as pullStructureCall,
  pushStructure as pushStructureCall,
  reconcile as reconcileCall,
  registerPlan as registerPlanCall,
  rebuildShadow as rebuildShadowCall,
  syncStatus,
} from "../../services/kairosSyncService";
import {
  PlanSyncStatus,
  PublishResponse,
  SyncStatusResponse,
  syncFailed,
} from "../../shared/kairosSync/ipc";
import PlanSyncCard from "../../components/sync/PlanSyncCard";
import PublishResultAlert from "../../components/sync/PublishResultAlert";
import ReviewDialog from "../../components/sync/ReviewDialog";

/** Idle probe interval. Matches the cadence table in the API guide (§3.5). */
const PROBE_INTERVAL_MS = 5 * 60 * 1000;

type Toast = { severity: "success" | "error" | "info" | "warning"; message: string } | null;

interface PullReview {
  planId: string;
  byType: Record<string, number>;
  deletedByType: Record<string, number>;
  total: number;
  deleted: number;
  skippedTypes: string[];
  reset: boolean;
}

interface PublishReview {
  planId: string;
  byType: Record<string, number>;
  total: number;
  chunks: number;
  withheld: number;
  unclassified: number;
}

export default function Sync() {
  const ou = useSelectedHotel();
  const navigate = useNavigate();

  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const [pullReview, setPullReview] = useState<PullReview | null>(null);
  const [publishReview, setPublishReview] = useState<PublishReview | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResponse | null>(null);
  const [structureChanges, setStructureChanges] = useState<number | null>(null);

  // Guards the probe timer against a component that has unmounted mid-flight.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!ou) return;
    setLoading(true);
    const result = await syncStatus(ou);
    if (!alive.current) return;
    if (syncFailed(result)) {
      // Offline or signed out is not an error state for a page whose whole
      // premise is that the app works without it.
      setError(result.error.code === "local" ? null : result.error.message);
      setStatus(null);
    } else {
      setStatus(result.data);
      setError(null);
    }
    setLoading(false);
  }, [ou]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * The probe: on mount, on focus, and every five minutes.
   *
   * Deliberately the ONLY timer in the feature. It refreshes the page only when
   * the server says something moved, so an idle app costs one 304 per interval
   * rather than a re-render and five requests.
   */
  useEffect(() => {
    if (!ou) return;

    const tick = async (): Promise<void> => {
      const result = await probeCall(ou);
      if (!alive.current || syncFailed(result)) return;
      if (!result.data.notModified) void refresh();
    };

    const timer = window.setInterval(() => {
      void tick();
    }, PROBE_INTERVAL_MS);
    const onFocus = (): void => {
      void tick();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [ou, refresh]);

  const run = useCallback(
    async <T,>(planId: string, work: () => Promise<T>): Promise<T | null> => {
      setBusyPlan(planId);
      try {
        return await work();
      } finally {
        if (alive.current) setBusyPlan(null);
      }
    },
    []
  );

  const handleRegister = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const created = await registerPlanCall(ou, plan.planId);
        if (syncFailed(created)) {
          setToast({ severity: "error", message: created.error.message });
          return;
        }
        // Registering only creates the plan row; the data still has to go up.
        const published = await publishCall(ou, plan.planId);
        if (syncFailed(published)) {
          setToast({ severity: "error", message: published.error.message });
          return;
        }
        setPublishResult(published.data);
        await refresh();
      });
    },
    [ou, refresh, run]
  );

  const handlePreviewPull = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await previewPullCall(ou, plan.planId);
        if (syncFailed(result)) {
          setToast({ severity: "error", message: result.error.message });
          return;
        }
        setPullReview({
          planId: plan.planId,
          byType: result.data.byType,
          deletedByType: result.data.deletedByType,
          total: result.data.total,
          deleted: result.data.deleted,
          skippedTypes: result.data.skippedTypes,
          reset: result.data.reset,
        });
      });
    },
    [ou, run]
  );

  const handleConfirmPull = useCallback(async () => {
    if (!ou || !pullReview) return;
    await run(pullReview.planId, async () => {
      const result = await pullCall(ou, pullReview.planId);
      if (syncFailed(result)) {
        setToast({ severity: "error", message: result.error.message });
        return;
      }
      setPullReview(null);
      setToast({
        severity: "success",
        message: `Downloaded ${result.data.total} rows.`,
      });
      await refresh();
    });
  }, [ou, pullReview, refresh, run]);

  const handlePreviewPublish = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await previewPublishCall(ou, plan.planId);
        if (syncFailed(result)) {
          setToast({ severity: "error", message: result.error.message });
          return;
        }
        setPublishReview({
          planId: plan.planId,
          byType: result.data.byType,
          total: result.data.total,
          chunks: result.data.chunks,
          withheld: result.data.withheld.length,
          unclassified: result.data.unclassified.length,
        });
      });
    },
    [ou, run]
  );

  const handleConfirmPublish = useCallback(async () => {
    if (!ou || !publishReview) return;
    await run(publishReview.planId, async () => {
      const result = await publishCall(ou, publishReview.planId);
      if (syncFailed(result)) {
        // A 423 is a state, not a failure: an administrator is holding the plan.
        setToast({
          severity: result.error.code === "kairos_plan_locked_by_support" ? "info" : "error",
          message: result.error.message,
        });
        return;
      }
      setPublishReview(null);
      setPublishResult(result.data);
      await refresh();
    });
  }, [ou, publishReview, refresh, run]);

  const handleReconcile = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await reconcileCall(ou, plan.planId);
        if (syncFailed(result)) {
          setToast({ severity: "error", message: result.error.message });
          return;
        }
        const { matched, needed, toPull, toPurge, suggestFullPull } = result.data;
        setToast({
          severity: needed + toPull + toPurge === 0 ? "success" : "warning",
          message:
            needed + toPull + toPurge === 0
              ? `Everything agrees — ${matched} rows checked.`
              : `${needed} to republish, ${toPull} to download, ${toPurge} deletions to record.` +
                (suggestFullPull ? " A full download would be quicker." : ""),
        });
        await refresh();
      });
    },
    [ou, refresh, run]
  );

  const handleRebuildShadow = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await rebuildShadowCall(ou, plan.planId);
        setToast(
          syncFailed(result)
            ? { severity: "error", message: result.error.message }
            : {
                severity: "success",
                message: `Re-read ${result.data.rows} rows from the server.`,
              }
        );
        await refresh();
      });
    },
    [ou, refresh, run]
  );

  const handleStructurePreview = useCallback(async () => {
    if (!ou) return;
    const result = await previewStructureCall(ou);
    if (syncFailed(result)) {
      setToast({ severity: "error", message: result.error.message });
      return;
    }
    setStructureChanges(result.data.changes.length);
    if (result.data.changes.length === 0) {
      setToast({ severity: "success", message: "Your setup matches the server." });
    }
  }, [ou]);

  const handleStructurePull = useCallback(async () => {
    if (!ou) return;
    const result = await pullStructureCall(ou);
    setToast(
      syncFailed(result)
        ? { severity: "error", message: result.error.message }
        : {
            severity: "success",
            message: `Applied ${result.data.changes.length} setup changes.`,
          }
    );
    setStructureChanges(null);
    await refresh();
  }, [ou, refresh]);

  const handleStructurePush = useCallback(async () => {
    if (!ou) return;
    const result = await pushStructureCall(ou, status?.structureVersion ?? null);
    setToast(
      syncFailed(result)
        ? {
            severity: "error",
            message:
              result.error.code === "kairos_structure_precondition"
                ? "Somebody else changed this hotel's setup while this page was open. Download it, then publish again."
                : result.error.message,
          }
        : { severity: "success", message: "Hotel setup published." }
    );
    await refresh();
  }, [ou, status, refresh]);

  if (!ou) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">Select a hotel to sync.</Alert>
      </Box>
    );
  }

  const anyOwner = status?.plans.some(
    (plan) => plan.relation === "OWNER" || plan.relation === "ADMIN_LEASE"
  );

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <CloudSyncOutlinedIcon color="primary" />
        <Typography variant="h4" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Sync
        </Typography>
        {status?.upToDate && <Chip size="small" label="Up to date" color="success" />}
        <Tooltip title="Check the server now">
          <span>
            <Button startIcon={<RefreshIcon />} onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
          </span>
        </Tooltip>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Kairos works without any of this. Publishing a plan lets colleagues you
        delegate to work on their own departments and send the results back.
      </Typography>

      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {status?.piiEnabled === false && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Employee details stay on this machine</AlertTitle>
          This property does not allow names, employee numbers or hiring dates to
          be stored on the server. Everything else publishes normally, and
          colleagues will see positions without names.
        </Alert>
      )}

      {publishResult && (
        <Box sx={{ mb: 2 }}>
          <PublishResultAlert result={publishResult} />
          <Button size="small" sx={{ mt: 1 }} onClick={() => setPublishResult(null)}>
            Dismiss
          </Button>
        </Box>
      )}

      {status?.plans.length === 0 && (
        <Alert severity="info">
          There are no planning scenarios for this hotel yet. Create one on the
          Positions page first.
        </Alert>
      )}

      {status?.plans.map((plan) => (
        <PlanSyncCard
          key={plan.planId}
          plan={plan}
          busy={busyPlan === plan.planId}
          onRegister={() => void handleRegister(plan)}
          onPreviewPublish={() => void handlePreviewPublish(plan)}
          onPreviewPull={() => void handlePreviewPull(plan)}
          onOpenDelegation={() => navigate(`/signed-in-landing/delegation?plan=${plan.planId}`)}
        >
          {plan.revoked && (
            // The one deliberate break in denial opacity, and the reason it
            // exists: this person demonstrably had access minutes ago. Never
            // wipe their work — offer to publish it once access is restored.
            <Alert severity="warning" sx={{ mt: 2 }}>
              <AlertTitle>Your access to this plan was withdrawn</AlertTitle>
              {String(plan.revoked.revokedByEmail ?? "The plan owner")} withdrew
              your delegation
              {plan.revoked.reasonPublic ? `: ${plan.revoked.reasonPublic}` : "."} Your
              work is still here and is not lost, but it cannot be published
              unless they delegate to you again.
            </Alert>
          )}

          {plan.published && (
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button size="small" onClick={() => void handleReconcile(plan)}>
                Check for differences
              </Button>
              <Tooltip title="Re-read what the server holds. Use this after rebuilding the local database or running an import.">
                <Button size="small" onClick={() => void handleRebuildShadow(plan)}>
                  Repair sync state
                </Button>
              </Tooltip>
            </Stack>
          )}
        </PlanSyncCard>
      ))}

      {status && (
        <Card variant="outlined" sx={{ borderRadius: 2, mt: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
              Hotel setup
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Columns, blocks, social security schemes, allocations, KPI drivers,
              the calendar and the defaults for new positions. One shared copy per
              hotel, used by every scenario.
            </Typography>

            {structureChanges !== null && structureChanges > 0 && (
              <Alert severity="info" sx={{ mb: 2 }}>
                {structureChanges} {structureChanges === 1 ? "change" : "changes"} to
                apply. Nothing you have added locally will be removed.
              </Alert>
            )}

            <Divider sx={{ mb: 2 }} />
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              <Button onClick={() => void handleStructurePreview()}>
                Check for changes
              </Button>
              <Button onClick={() => void handleStructurePull()}>
                Download setup
              </Button>
              {anyOwner && (
                <Button variant="outlined" onClick={() => void handleStructurePush()}>
                  Publish setup
                </Button>
              )}
            </Stack>
          </CardContent>
        </Card>
      )}

      <ReviewDialog
        open={pullReview !== null}
        title="Download changes"
        direction="pull"
        busy={busyPlan !== null}
        byType={pullReview?.byType ?? {}}
        deletedByType={pullReview?.deletedByType ?? {}}
        total={pullReview?.total ?? 0}
        deleted={pullReview?.deleted ?? 0}
        skippedTypes={pullReview?.skippedTypes ?? []}
        reset={pullReview?.reset ?? false}
        onConfirm={() => void handleConfirmPull()}
        onClose={() => setPullReview(null)}
      />

      <ReviewDialog
        open={publishReview !== null}
        title="Publish changes"
        direction="publish"
        busy={busyPlan !== null}
        byType={publishReview?.byType ?? {}}
        total={publishReview?.total ?? 0}
        chunks={publishReview?.chunks}
        withheld={publishReview?.withheld ?? 0}
        unclassified={publishReview?.unclassified ?? 0}
        onConfirm={() => void handleConfirmPublish()}
        onClose={() => setPublishReview(null)}
      />

      <Snackbar
        open={toast !== null}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)}>
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>

      {loading && !status && (
        <Stack sx={{ alignItems: "center", mt: 4 }}>
          <CircularProgress />
        </Stack>
      )}
    </Box>
  );
}

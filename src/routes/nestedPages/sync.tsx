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
 * Every direction previews first — publish, pull, and the hotel setup document.
 * A pull can overwrite unpublished local work and a publish can carry a deletion
 * nobody meant; neither is undone by pressing the button again.
 *
 * ## Attention first
 *
 * A hotel with eight scenarios used to get eight identical full-height cards.
 * Plans that need nothing are collapsed to a line and sorted below the ones that
 * do, so the page answers "what needs me?" before it answers "what exists?".
 *
 * ## Support tools
 *
 * Administrator controls appear only when the Settings switch is on and the
 * server has confirmed the account. They are per-plan and live in an overflow
 * menu — acting on a plan you are not looking at is how the wrong hotel gets
 * locked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CloudSyncOutlinedIcon from "@mui/icons-material/CloudSyncOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useSelectedHotel } from "../../store/settings";
import authService from "../../services/auth";
import {
  acquireLease as acquireLeaseCall,
  adminBundle as adminBundleCall,
  delegationCandidates as candidatesCall,
  deletePlan as deletePlanCall,
  extendLease as extendLeaseCall,
  lease as leaseCall,
  patchPlan as patchPlanCall,
  previewPublish as previewPublishCall,
  previewPull as previewPullCall,
  probe as probeCall,
  publish as publishCall,
  publishOverServer as publishOverServerCall,
  pull as pullCall,
  previewStructure as previewStructureCall,
  pullStructure as pullStructureCall,
  pushStructure as pushStructureCall,
  reconcile as reconcileCall,
  registerPlan as registerPlanCall,
  rebuildShadow as rebuildShadowCall,
  releaseLease as releaseLeaseCall,
  syncStatus,
  transferPlan as transferPlanCall,
} from "../../services/kairosSyncService";
import {
  PlanSyncStatus,
  PublishResponse,
  SyncStatusResponse,
  syncFailed,
} from "../../shared/kairosSync/ipc";
import {
  DelegationCandidate,
  Lease,
  LeaseCreate,
} from "../../shared/kairosSync/protocol";
import { planState } from "../../shared/kairosSync/planState";
import { useAdminTools } from "../../hooks/useAdminTools";
import PlanSyncCard, { PlanAdminActions } from "../../components/sync/PlanSyncCard";
import CloudPlanCard from "../../components/sync/CloudPlanCard";
import PublishResultAlert from "../../components/sync/PublishResultAlert";
import ReviewDialog from "../../components/sync/ReviewDialog";
import LeaseBanner from "../../components/sync/LeaseBanner";
import ClaimPlanDialog from "../../components/sync/ClaimPlanDialog";
import {
  AcquireLeaseDialog,
  ReleaseLeaseDialog,
} from "../../components/sync/LeaseDialog";
import ScopeTraceDialog from "../../components/sync/ScopeTraceDialog";
import TransferOwnershipDialog from "../../components/sync/TransferOwnershipDialog";

/** Idle probe interval. Matches the cadence table in the API guide (§3.5). */
const PROBE_INTERVAL_MS = 5 * 60 * 1000;

/** Plain-English names for the hotel-setup document's sections. */
const STRUCTURE_LABELS: Record<string, string> = {
  fieldCatalog: "Columns",
  blockConfigs: "Blocks",
  componentDefs: "Block components",
  ssSchemes: "Social security schemes",
  allocations: "Allocations",
  kpiDrivers: "KPI drivers",
  calendars: "Calendar",
  positionDefaults: "Defaults for new positions",
};

type Toast = { severity: "success" | "error" | "info" | "warning"; message: string } | null;

interface PullReview {
  planId: string;
  byType: Record<string, number>;
  deletedByType: Record<string, number>;
  total: number;
  deleted: number;
  skippedTypes: string[];
  reset: boolean;
  /** The local plan of the same name this download takes over from. */
  replaceLocalPlanId: string | null;
  /** True for a plan this computer does not hold yet — a first download. */
  firstDownload: boolean;
}

interface PublishReview {
  planId: string;
  byType: Record<string, number>;
  total: number;
  chunks: number;
  withheld: number;
  unclassified: number;
}

interface StructureReview {
  byType: Record<string, number>;
  removedByType: Record<string, number>;
  total: number;
  removed: number;
}

/** Which per-plan dialog is open, and for which plan. */
type PlanDialog =
  | { kind: "acquireLease"; plan: PlanSyncStatus }
  | { kind: "releaseLease"; plan: PlanSyncStatus }
  | { kind: "transfer"; plan: PlanSyncStatus }
  | { kind: "export"; plan: PlanSyncStatus }
  | { kind: "delete"; plan: PlanSyncStatus }
  | { kind: "scope"; plan: PlanSyncStatus }
  | { kind: "claim"; plan: PlanSyncStatus }
  | null;

export default function Sync() {
  const ou = useSelectedHotel();
  const navigate = useNavigate();
  const adminTools = useAdminTools();

  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [leases, setLeases] = useState<Record<string, Lease | null>>({});
  const [loading, setLoading] = useState(false);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const [pullReview, setPullReview] = useState<PullReview | null>(null);
  const [publishReview, setPublishReview] = useState<PublishReview | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResponse | null>(null);
  const [structureReview, setStructureReview] = useState<StructureReview | null>(null);
  /** Set by a first download; consumed by the effect under `handleStructurePreview`. */
  const [checkSetupAfterDownload, setCheckSetupAfterDownload] = useState(false);

  const [dialog, setDialog] = useState<PlanDialog>(null);
  const [candidates, setCandidates] = useState<DelegationCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [transferIneligible, setTransferIneligible] =
    useState<Record<string, unknown> | null>(null);
  const [exportReason, setExportReason] = useState("");
  /**
   * The signed-in user's own id, for the scope debugger.
   *
   * The question that button asks is "why does the server give ME this
   * relation", and `/admin/users/{id}/scope` is keyed by user. This client has
   * no `/me` on the sync surface, so it comes from the auth service — which is
   * also the only place the renderer learns anything about who is signed in.
   */
  const [myUserId, setMyUserId] = useState<number | null>(null);

  useEffect(() => {
    if (!adminTools.visible || myUserId !== null) return;
    void authService
      .getCurrentUser()
      .then((user) => setMyUserId(user.id))
      .catch(() => setMyUserId(null));
  }, [adminTools.visible, myUserId]);

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
   * Leases, for the published plans only.
   *
   * Read by the hotel and not only by support: an owner whose publish came back
   * 423 needs the holder and the reference, or the failure is inexplicable and
   * the obvious response is to keep pressing the button. One call per published
   * plan, on a page that already has the plan list — not on any timer.
   */
  useEffect(() => {
    if (!ou || !status) return;
    const published = status.plans.filter((plan) => plan.published);
    if (published.length === 0) return;

    let cancelled = false;
    void Promise.all(
      published.map(async (plan) => {
        const result = await leaseCall(ou, plan.planId);
        return [plan.planId, syncFailed(result) ? null : result.data?.lease ?? null] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      setLeases(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [ou, status]);

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

  const fail = useCallback((message: string) => {
    setToast({ severity: "error", message });
  }, []);

  // ------------------------------------------------------------- pull

  const handlePreviewPull = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await previewPullCall(ou, plan.planId);
        if (syncFailed(result)) {
          fail(result.error.message);
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
          replaceLocalPlanId: plan.onThisComputer ? null : plan.twinPlanId,
          firstDownload: !plan.onThisComputer,
        });
      });
    },
    [ou, run, fail]
  );

  const handleConfirmPull = useCallback(async () => {
    if (!ou || !pullReview) return;
    await run(pullReview.planId, async () => {
      const result = await pullCall(ou, pullReview.planId, pullReview.replaceLocalPlanId);
      if (syncFailed(result)) {
        fail(result.error.message);
        return;
      }
      setPullReview(null);
      setToast({
        severity: "success",
        message: result.data.replacedLocalPlan
          ? `Downloaded ${result.data.total} rows. This is now the plan of that name on ` +
            "this computer; the copy it replaced is no longer listed."
          : pullReview.firstDownload
            ? `Downloaded ${result.data.total} rows. The plan is now on this computer — ` +
              "open it from the Positions page."
            : `Downloaded ${result.data.total} rows.`,
      });
      // A plan downloaded onto a machine that has never held one renders through
      // whatever columns, blocks and schemes that machine happens to have. The
      // hotel setup is the other half of the download, so it is offered straight
      // away — as a review, like every other direction, never applied blind.
      if (pullReview.firstDownload) setCheckSetupAfterDownload(true);
      await refresh();
    });
  }, [ou, pullReview, refresh, run, fail]);

  // ---------------------------------------------------------- publish

  const handlePreviewPublish = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await previewPublishCall(ou, plan.planId);
        if (syncFailed(result)) {
          fail(result.error.message);
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
    [ou, run, fail]
  );

  /**
   * Register the plan, then review the first publish like any other.
   *
   * It used to register and publish in one unattended step. That hid the two
   * things a first publish most needs to say — how many rows are actually going,
   * and how many are being withheld because of the caller's scope — behind a
   * six-second toast. A first publish is the largest and least reversible one a
   * plan ever has; it gets the same confirmation as the rest.
   *
   * `refresh()` runs whatever happened, including on failure: registering may
   * well have succeeded and only the publish failed, and the card must not keep
   * offering to register a plan the server already has.
   */
  const handleRegister = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const created = await registerPlanCall(ou, plan.planId);
        await refresh();
        if (syncFailed(created)) {
          fail(created.error.message);
          return;
        }
        // Registering only creates the plan row; the data still has to go up.
        await handlePreviewPublish(plan);
      });
    },
    [ou, refresh, run, fail, handlePreviewPublish]
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

  /**
   * "Keep mine" from the claim dialog.
   *
   * Publishes over the server's copy by adopting its hashes first, which is the
   * protocol's own two-step overwrite. Offered only as one of two named choices
   * — never as a fallback when an ordinary publish conflicts, because that would
   * turn an accident into a policy.
   */
  const handleKeepMine = useCallback(async () => {
    if (!ou || dialog?.kind !== "claim") return;
    const plan = dialog.plan;
    await run(plan.planId, async () => {
      const result = await publishOverServerCall(ou, plan.planId);
      if (syncFailed(result)) {
        fail(result.error.message);
        return;
      }
      setDialog(null);
      setPublishResult(result.data);
      await refresh();
    });
  }, [ou, dialog, refresh, run, fail]);

  // -------------------------------------------------------- recovery

  const handleReconcile = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await reconcileCall(ou, plan.planId);
        if (syncFailed(result)) {
          fail(result.error.message);
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
    [ou, refresh, run, fail]
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

  // ------------------------------------------------------- structure

  /**
   * Preview the hotel setup before applying it.
   *
   * This used to apply straight away, unlike a plan pull, even though it can
   * replace the columns and blocks every scenario at the property renders
   * through. The diff already came back from the preview call; it just was not
   * being shown.
   */
  const handleStructurePreview = useCallback(async () => {
    if (!ou) return;
    const result = await previewStructureCall(ou);
    if (syncFailed(result)) {
      fail(result.error.message);
      return;
    }
    const changes = result.data.changes;
    if (changes.length === 0) {
      setToast({ severity: "success", message: "Your setup matches the server." });
      return;
    }
    const byType: Record<string, number> = {};
    const removedByType: Record<string, number> = {};
    for (const change of changes) {
      const bucket = change.kind === "removed" ? removedByType : byType;
      bucket[change.section] = (bucket[change.section] ?? 0) + 1;
    }
    setStructureReview({
      byType,
      removedByType,
      total: changes.length,
      removed: changes.filter((change) => change.kind === "removed").length,
    });
  }, [ou, fail]);

  // Deliberately an effect rather than a call inside `handleConfirmPull`: the
  // preview is declared below that handler, so naming it there would read it
  // before it exists.
  useEffect(() => {
    if (!checkSetupAfterDownload) return;
    setCheckSetupAfterDownload(false);
    void handleStructurePreview();
  }, [checkSetupAfterDownload, handleStructurePreview]);

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
    setStructureReview(null);
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

  // -------------------------------------------------- transfer & admin

  const searchCandidates = useCallback(
    async (query: string, planId: string) => {
      if (!ou) return;
      setCandidatesLoading(true);
      const result = await candidatesCall(ou, planId, query || undefined);
      if (!syncFailed(result)) setCandidates(result.data.candidates);
      setCandidatesLoading(false);
    },
    [ou]
  );

  useEffect(() => {
    if (dialog?.kind === "transfer") void searchCandidates("", dialog.plan.planId);
  }, [dialog, searchCandidates]);

  const handleTransfer = useCallback(
    async (newOwnerUserId: number, reason: string) => {
      if (!ou || dialog?.kind !== "transfer") return;
      const plan = dialog.plan;
      await run(plan.planId, async () => {
        const result = await transferPlanCall(ou, plan.planId, newOwnerUserId, reason);
        if (syncFailed(result)) {
          // The eligibility refusal carries the list of conditions the successor
          // fails. Keep the dialog open and render it, rather than reducing it
          // to a toast that says "no".
          if (result.error.code === "kairos_owner_not_eligible") {
            setTransferIneligible(result.error.context ?? {});
            return;
          }
          fail(result.error.message);
          return;
        }
        setDialog(null);
        setTransferIneligible(null);
        setToast({ severity: "success", message: "Ownership transferred." });
        await refresh();
      });
    },
    [ou, dialog, refresh, run, fail]
  );

  const handleAcquireLease = useCallback(
    async (request: LeaseCreate) => {
      if (!ou || dialog?.kind !== "acquireLease") return;
      const plan = dialog.plan;
      await run(plan.planId, async () => {
        const result = await acquireLeaseCall(ou, plan.planId, request);
        if (syncFailed(result)) {
          fail(result.error.message);
          return;
        }
        setDialog(null);
        setLeases((current) => ({ ...current, [plan.planId]: result.data.lease }));
        setToast({
          severity: request.mode === "EXCLUSIVE" ? "warning" : "info",
          message:
            request.mode === "EXCLUSIVE"
              ? "Lease taken. The hotel cannot edit this plan until you release it."
              : "Read-only lease taken. Nobody else is affected.",
        });
        await refresh();
      });
    },
    [ou, dialog, refresh, run, fail]
  );

  const handleExtendLease = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await extendLeaseCall(ou, plan.planId, 60);
        if (syncFailed(result)) {
          fail(result.error.message);
          return;
        }
        setLeases((current) => ({ ...current, [plan.planId]: result.data.lease }));
        setToast({ severity: "success", message: "Extended by 60 minutes." });
      });
    },
    [ou, run, fail]
  );

  const handleReleaseLease = useCallback(
    async (summary: string) => {
      if (!ou || dialog?.kind !== "releaseLease") return;
      const plan = dialog.plan;
      await run(plan.planId, async () => {
        const result = await releaseLeaseCall(ou, plan.planId, summary);
        if (syncFailed(result)) {
          fail(result.error.message);
          return;
        }
        setDialog(null);
        setLeases((current) => ({ ...current, [plan.planId]: null }));
        const moved = result.data.version - result.data.versionAtAcquire;
        setToast({
          severity: "success",
          message:
            moved > 0
              ? `Released. The plan moved ${result.data.versionAtAcquire} → ${result.data.version}; everyone will re-download it.`
              : "Released. Nothing changed while you held it, so nobody has to re-download.",
        });
        await refresh();
      });
    },
    [ou, dialog, refresh, run, fail]
  );

  const handleArchive = useCallback(
    async (plan: PlanSyncStatus) => {
      if (!ou) return;
      await run(plan.planId, async () => {
        const result = await patchPlanCall(ou, plan.planId, { state: "ARCHIVED" });
        setToast(
          syncFailed(result)
            ? { severity: "error", message: result.error.message }
            : { severity: "success", message: "Plan archived." }
        );
        await refresh();
      });
    },
    [ou, refresh, run]
  );

  const handleDelete = useCallback(async () => {
    if (!ou || dialog?.kind !== "delete") return;
    const plan = dialog.plan;
    await run(plan.planId, async () => {
      const result = await deletePlanCall(ou, plan.planId);
      setDialog(null);
      setToast(
        syncFailed(result)
          ? { severity: "error", message: result.error.message }
          : {
              severity: "success",
              message: "Deleted from the server. The rows survive there and support can restore it.",
            }
      );
      await refresh();
    });
  }, [ou, dialog, refresh, run]);

  const handleExport = useCallback(async () => {
    if (dialog?.kind !== "export") return;
    const plan = dialog.plan;
    await run(plan.planId, async () => {
      const result = await adminBundleCall({
        planId: plan.planId,
        pii: "pseudonymize",
        reason: exportReason.trim(),
      });
      setDialog(null);
      setExportReason("");
      setToast(
        syncFailed(result)
          ? { severity: "error", message: result.error.message }
          : { severity: "success", message: `Saved to ${result.data.savedTo}` }
      );
    });
  }, [dialog, exportReason, run]);

  // ----------------------------------------------------------- render

  /**
   * Attention first, then by year.
   *
   * A plan that needs nothing is still listed — people look for the one they
   * expect — but it does not get the same weight as one with unpublished work
   * or a support lease on it.
   */
  /**
   * Plans the server holds that this computer does not.
   *
   * Kept out of the main list on purpose: none of the states below apply to
   * them, and the only action is to download. A new machine and a fresh
   * delegation both land here.
   */
  const cloudPlans = useMemo(
    () => (status?.plans ?? []).filter((plan) => !plan.onThisComputer),
    [status]
  );

  const localPlans = useMemo(
    () => (status?.plans ?? []).filter((plan) => plan.onThisComputer),
    [status]
  );

  /** planId → label, so a clash can be named on both cards. */
  const labelById = useMemo(
    () => new Map((status?.plans ?? []).map((plan) => [plan.planId, plan.label])),
    [status]
  );

  const orderedPlans = useMemo(() => {
    const plans = localPlans;
    return [...plans].sort((left, right) => {
      const leftState = planState(left, leases[left.planId]);
      const rightState = planState(right, leases[right.planId]);
      if (leftState.needsAttention !== rightState.needsAttention) {
        return leftState.needsAttention ? -1 : 1;
      }
      if (left.year !== right.year) return right.year - left.year;
      return left.label.localeCompare(right.label);
    });
  }, [localPlans, leases]);

  if (!ou) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">Select a hotel to sync.</Alert>
      </Box>
    );
  }

  // Only a plan this computer holds can have its setup published from here.
  const anyOwner = localPlans.some(
    (plan) => plan.relation === "OWNER" || plan.relation === "ADMIN_LEASE"
  );
  // Cloud-only plans count: a page that says "Up to date" above a plan waiting
  // to be downloaded is contradicting itself.
  const attentionCount =
    orderedPlans.filter((plan) => planState(plan, leases[plan.planId]).needsAttention)
      .length + cloudPlans.length;

  const adminActionsFor = (plan: PlanSyncStatus): PlanAdminActions => ({
    onTakeLease: () => setDialog({ kind: "acquireLease", plan }),
    onExtendLease: (): void => void handleExtendLease(plan),
    onReleaseLease: () => setDialog({ kind: "releaseLease", plan }),
    onTransfer: () => setDialog({ kind: "transfer", plan }),
    onArchive: (): void => void handleArchive(plan),
    onDelete: () => setDialog({ kind: "delete", plan }),
    onExport: () => setDialog({ kind: "export", plan }),
    onWhy: () => setDialog({ kind: "scope", plan }),
  });

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <CloudSyncOutlinedIcon color="primary" />
        <Typography variant="h4" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Sync
        </Typography>
        {status && attentionCount === 0 && status.upToDate && (
          <Chip size="small" label="Up to date" color="success" />
        )}
        {attentionCount > 0 && (
          <Chip
            size="small"
            color="warning"
            label={`${attentionCount} ${attentionCount === 1 ? "plan needs" : "plans need"} attention`}
          />
        )}
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

      {adminTools.visible && (
        <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
          Support tools are on. Every plan below has an administrator menu, and
          the actions in it are recorded against your account.
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

      {status && localPlans.length === 0 && cloudPlans.length === 0 && (
        <Alert severity="info">
          There are no planning scenarios for this hotel yet, and the server has
          none for you either. Create one on the Positions page.
        </Alert>
      )}

      {orderedPlans.map((plan) => (
        <PlanSyncCard
          key={plan.planId}
          plan={plan}
          busy={busyPlan === plan.planId}
          lease={leases[plan.planId]}
          adminTools={adminTools.visible}
          admin={adminActionsFor(plan)}
          onRegister={() => void handleRegister(plan)}
          onPreviewPublish={() => void handlePreviewPublish(plan)}
          onPreviewPull={() => void handlePreviewPull(plan)}
          onResolveDivergence={() => setDialog({ kind: "claim", plan })}
          onOpenDelegation={() => navigate(`/signed-in-landing/delegation?plan=${plan.planId}`)}
          onTransfer={() => setDialog({ kind: "transfer", plan })}
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

          {leases[plan.planId] && (
            <LeaseBanner
              lease={leases[plan.planId] as Lease}
              mine={plan.relation === "ADMIN_LEASE"}
              busy={busyPlan === plan.planId}
              onExtend={() => void handleExtendLease(plan)}
              onRelease={() => setDialog({ kind: "releaseLease", plan })}
            />
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

      {cloudPlans.length > 0 && (
        // Deliberately below the local plans and above the hotel setup: it is
        // the answer to "where is my plan?" on a machine that has never held it,
        // and for a delegate it is the only thing on this page that applies.
        <Box sx={{ mt: 4 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            In the cloud, not on this computer
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Plans the server holds for you at this hotel — ones you own from
            another machine, and ones colleagues have delegated to you. Downloading
            brings the whole plan here; nothing changes until you do.
          </Typography>
          {cloudPlans.map((plan) => (
            <CloudPlanCard
              key={plan.planId}
              plan={plan}
              busy={busyPlan === plan.planId}
              twinLabel={plan.twinPlanId ? labelById.get(plan.twinPlanId) : null}
              onDownload={() => void handlePreviewPull(plan)}
            />
          ))}
        </Box>
      )}

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

            <Divider sx={{ mb: 2 }} />
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              <Button onClick={() => void handleStructurePreview()}>Check for changes</Button>
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
        title={pullReview?.firstDownload ? "Download this plan" : "Download changes"}
        direction="pull"
        busy={busyPlan !== null}
        byType={pullReview?.byType ?? {}}
        deletedByType={pullReview?.deletedByType ?? {}}
        total={pullReview?.total ?? 0}
        deleted={pullReview?.deleted ?? 0}
        skippedTypes={pullReview?.skippedTypes ?? []}
        reset={pullReview?.reset ?? false}
        replacesLabel={
          pullReview?.replaceLocalPlanId
            ? labelById.get(pullReview.replaceLocalPlanId) ?? "your local plan"
            : null
        }
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

      <ReviewDialog
        open={structureReview !== null}
        title="Download hotel setup"
        direction="pull"
        busy={false}
        labels={STRUCTURE_LABELS}
        byType={structureReview?.byType ?? {}}
        deletedByType={structureReview?.removedByType ?? {}}
        total={structureReview?.total ?? 0}
        deleted={structureReview?.removed ?? 0}
        onConfirm={() => void handleStructurePull()}
        onClose={() => setStructureReview(null)}
      />

      <ClaimPlanDialog
        open={dialog?.kind === "claim"}
        busy={busyPlan !== null}
        planLabel={dialog?.plan.label ?? ""}
        localChanges={dialog?.plan.pendingChanges ?? 0}
        serverChanges={
          dialog ? Math.max(0, dialog.plan.serverVersion - dialog.plan.watermark) : 0
        }
        onTakeServer={() => {
          const plan = dialog?.kind === "claim" ? dialog.plan : null;
          setDialog(null);
          if (plan) void handlePreviewPull(plan);
        }}
        onKeepMine={() => void handleKeepMine()}
        onClose={() => setDialog(null)}
      />

      <AcquireLeaseDialog
        open={dialog?.kind === "acquireLease"}
        busy={busyPlan !== null}
        planLabel={dialog?.plan.label ?? ""}
        onSubmit={(request) => void handleAcquireLease(request)}
        onClose={() => setDialog(null)}
      />

      <ReleaseLeaseDialog
        open={dialog?.kind === "releaseLease"}
        busy={busyPlan !== null}
        planLabel={dialog?.plan.label ?? ""}
        onSubmit={(summary) => void handleReleaseLease(summary)}
        onClose={() => setDialog(null)}
      />

      <TransferOwnershipDialog
        open={dialog?.kind === "transfer"}
        busy={busyPlan !== null}
        planLabel={dialog?.plan.label ?? ""}
        candidates={candidates}
        candidatesLoading={candidatesLoading}
        ineligible={transferIneligible}
        onSearch={(query) =>
          dialog?.kind === "transfer" && void searchCandidates(query, dialog.plan.planId)
        }
        onSubmit={(userId, reason) => void handleTransfer(userId, reason)}
        onClose={() => {
          setDialog(null);
          setTransferIneligible(null);
        }}
      />

      <ScopeTraceDialog
        open={dialog?.kind === "scope"}
        userId={myUserId}
        planId={dialog?.plan.planId ?? null}
        onClose={() => setDialog(null)}
      />

      <Dialog
        open={dialog?.kind === "export"}
        onClose={() => setDialog(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Export a repro bundle</DialogTitle>
        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            Saves the whole of <strong>{dialog?.plan.label}</strong> to your
            Downloads folder as a compressed file. Employee details are
            pseudonymised.
          </DialogContentText>
          <Alert severity="info" sx={{ mb: 2 }}>
            Recorded against your account with the reason below, visible to every
            administrator, and limited to twenty exports a day across the estate.
          </Alert>
          <TextField
            fullWidth
            required
            label="Reason"
            value={exportReason}
            onChange={(event) => setExportReason(event.target.value)}
            helperText="A ticket reference or a sentence. This is the answer when the export is queried later."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            disabled={exportReason.trim().length < 3 || busyPlan !== null}
            onClick={() => void handleExport()}
          >
            Export
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={dialog?.kind === "delete"} onClose={() => setDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Delete this plan from the server?</DialogTitle>
        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            <strong>{dialog?.plan.label}</strong> will stop being listed and
            nobody will be able to pull it. The copy on each person&rsquo;s own
            machine is untouched.
          </DialogContentText>
          <Alert severity="warning">
            The rows are kept server-side, so support can restore this — but
            anybody working on it will lose the ability to publish until it is.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            disabled={busyPlan !== null}
            onClick={() => void handleDelete()}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

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

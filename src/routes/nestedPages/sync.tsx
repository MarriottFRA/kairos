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
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
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
  discardLocalPlan,
  extendLease as extendLeaseCall,
  lease as leaseCall,
  patchPlan as patchPlanCall,
  previewPublish as previewPublishCall,
  previewPull as previewPullCall,
  probe as probeCall,
  publish as publishCall,
  publishOverServer as publishOverServerCall,
  pull as pullCall,
  pendingByDepartment as pendingByDepartmentCall,
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
  SYNC_ERROR_CODES,
  SyncStatusResponse,
  syncFailed,
} from "../../shared/kairosSync/ipc";
import {
  Delegation,
  DelegationCandidate,
  Lease,
  LeaseCreate,
} from "../../shared/kairosSync/protocol";
import { planState } from "../../shared/kairosSync/planState";
import { useAdminTools } from "../../hooks/useAdminTools";
import { useDelegationOverview } from "../../hooks/useDelegationOverview";
import { usePlanDelegations } from "../../hooks/usePlanDelegations";
import { delegationSummary } from "../../shared/kairosSync/delegationSummary";
import { transferOutcome } from "../../shared/kairosSync/retainedAccess";
import PlanSyncCard, { PlanAdminActions } from "../../components/sync/PlanSyncCard";
import CloudPlanCard from "../../components/sync/CloudPlanCard";
import DeletePlanDialog, {
  LocalCopyAfterDelete,
} from "../../components/sync/DeletePlanDialog";
import DiscardLocalPlanDialog from "../../components/sync/DiscardLocalPlanDialog";
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
import HotelSetupCard, {
  STRUCTURE_LABELS,
  countBySection,
} from "../../components/sync/HotelSetupCard";
import HotelSetupCompareDialog from "../../components/sync/HotelSetupCompareDialog";
import { StructureChange } from "../../shared/kairosSync/structureDoc";

/** Idle probe interval. Matches the cadence table in the API guide (§3.5). */
const PROBE_INTERVAL_MS = 5 * 60 * 1000;

type Toast = { severity: "success" | "error" | "info" | "warning"; message: string } | null;

interface PullReview {
  planId: string;
  byType: Record<string, number>;
  deletedByType: Record<string, number>;
  /** Incoming rows by department — where the download lands. */
  byDepartment: Record<string, number>;
  /** Departments this machine has unpublished work in, for the contrast. */
  pendingDepartments: string[];
  total: number;
  deleted: number;
  skippedTypes: string[];
  reset: boolean;
  /** Incoming rows that land on local work never published. See `ReviewDialog`. */
  collides: number;
  collidingDepartments: string[];
  /** What this machine has waiting, so "nothing collides" can be said usefully. */
  pendingChanges: number;
  /** The local plan of the same name this download takes over from. */
  replaceLocalPlanId: string | null;
  /** True for a plan this computer does not hold yet — a first download. */
  firstDownload: boolean;
  /**
   * Departments to lead the review with, when the download was started from one
   * person's row in the plan card.
   *
   * Presentation only. `/changes` takes a watermark and a cursor and nothing
   * else, so there is no per-delegate feed to ask for — the pull is whole-plan
   * either way, and the dialog says so. This only decides what is listed first.
   */
  forDepartments: string[];
}

interface PublishReview {
  planId: string;
  byType: Record<string, number>;
  total: number;
  chunks: number;
  withheld: number;
  unclassified: number;
}

/**
 * What this computer is left holding once the server's copy is deleted.
 *
 * The three cases are genuinely different promises, so the dialog is told which
 * one applies rather than hedging across all three. `twin` is the interesting
 * one: a plan of the same name here that is NOT this plan, which is exactly the
 * situation where deleting is the constructive move — it frees the name.
 */
function localCopyAfterDelete(plan: PlanSyncStatus): LocalCopyAfterDelete {
  if (plan.onThisComputer) return "keeps";
  return plan.twinPlanId ? "twin" : "none";
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
  /** Purge a local copy the server no longer shares. Local, hard, no undo. */
  | { kind: "discard"; plan: PlanSyncStatus }
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
  /**
   * The hotel-setup diff, in both directions, from the last check.
   *
   * Held rather than shown-and-discarded because the card draws from it
   * continuously — the divergence badge, the "publishing affects everybody"
   * warning, and the copy-for-the-owner summary all read the same answer.
   * `null` means nothing has been checked yet.
   *
   * `serverVersion` rides along because it is the `If-Match` the next publish
   * must send. Taking it from `status` instead is how a publish that follows a
   * download 412s: the pull moved the hotel's version and the page's sync status
   * still holds the one from before it.
   */
  const [setupDiff, setSetupDiff] = useState<{
    incoming: StructureChange[];
    outgoing: StructureChange[];
    published: boolean;
    serverVersion: number | null;
  } | null>(null);
  /** Open when the user asked to see the divergence row by row. */
  const [setupCompare, setSetupCompare] = useState(false);
  /** Confirming a hotel-wide publish. Holds the outgoing diff at the moment of asking. */
  const [setupPublish, setSetupPublish] = useState<StructureChange[] | null>(null);
  /** Set by a first download; consumed by the effect under `handleStructurePreview`. */
  const [checkSetupAfterDownload, setCheckSetupAfterDownload] = useState(false);

  /**
   * Plans the last status call purged from this computer.
   *
   * Persisted in state rather than fired as a toast, because a toast that
   * vanishes after six seconds is the wrong medium for "a plan you had is gone
   * and here is why". Dismissed by hand, like the publish result above it.
   */
  const [removed, setRemoved] = useState<SyncStatusResponse["removed"]>([]);

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
      // Plans the status call removed because the server no longer shares them.
      // Said out loud: a plan that simply stopped being listed reads as data
      // loss to somebody who was working in it yesterday.
      if (result.data.removed.length > 0) setRemoved(result.data.removed);
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
    async (plan: PlanSyncStatus, forDepartments: string[] = []): Promise<void> => {
      if (!ou) return;
      await run(plan.planId, async () => {
        // Both at once: the second is a local read and only worth making when
        // there IS unpublished work for the verdict to contrast the download
        // with. `Promise.all` rather than sequential — neither depends on the
        // other and the dialog waits for both.
        const [result, pending] = await Promise.all([
          previewPullCall(ou, plan.planId),
          plan.pendingChanges > 0
            ? pendingByDepartmentCall(ou, plan.planId)
            : Promise.resolve(null),
        ]);
        if (syncFailed(result)) {
          fail(result.error.message);
          return;
        }
        setPullReview({
          planId: plan.planId,
          byType: result.data.byType,
          deletedByType: result.data.deletedByType,
          byDepartment: result.data.byDepartment,
          total: result.data.total,
          deleted: result.data.deleted,
          skippedTypes: result.data.skippedTypes,
          reset: result.data.reset,
          collides: result.data.collides,
          collidingDepartments: result.data.collidingDepartments,
          pendingChanges: plan.pendingChanges,
          pendingDepartments:
            pending && !syncFailed(pending)
              ? Object.keys(pending.data.byDepartment)
              : [],
          replaceLocalPlanId: plan.onThisComputer ? null : plan.twinPlanId,
          // The handler decides this, not the card: it is the one that knows
          // whether a live `scenarios` row exists, and it uses the same answer
          // to choose between a delta and a full pull.
          firstDownload: result.data.firstDownload,
          forDepartments,
        });
      });
    },
    [ou, run, fail]
  );

  /**
   * Collect one person's finished work, from their row in the plan card.
   *
   * The same whole-plan pull as the Download button — there is no per-delegate
   * feed and pretending otherwise would make the review lie about what is
   * arriving. Their departments are sorted to the front of the dialog and
   * coloured; the rest is still listed, and still said.
   */
  const handleDownloadForDelegation = useCallback(
    (plan: PlanSyncStatus, delegation: Delegation): void => {
      void handlePreviewPull(plan, delegation.effectiveDepartments);
    },
    [handlePreviewPull]
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
      // Employee details arrive on their own stream and are not in `total`, so
      // saying "42 rows" when six of them were people's names and numbers would
      // under-report the download every time.
      const people = result.data.pii;
      const withPeople = (message: string): string =>
        people && people.applied > 0
          ? `${message} ${people.applied} employee ${
              people.applied === 1 ? "detail" : "details"
            } came with them.`
          : message;
      setToast({
        severity: "success",
        message: withPeople(
          result.data.replacedLocalPlan
            ? `Downloaded ${result.data.total} rows. This is now the plan of that name on ` +
              "this computer; the copy it replaced is no longer listed."
            : pullReview.firstDownload
              ? `Downloaded ${result.data.total} rows. The plan is now on this computer — ` +
                "open it from the Positions page."
              : `Downloaded ${result.data.total} rows.`
        ),
      });
      // Not blanks. A record whose key has been erased is unrecoverable, and
      // rendering it as an empty name field looks like a hotel that never
      // entered anybody.
      if (people && people.unreadable > 0) {
        setToast({
          severity: "warning",
          message:
            `${people.unreadable} employee ${
              people.unreadable === 1 ? "record" : "records"
            } could not be read — the personal details for this plan have been ` +
            "erased on the server. The positions themselves are unaffected.",
        });
      }
      // Only meaningful on a first download, and only when the server had no
      // plan record of its own to send. Said out loud because it is the answer
      // to "why is this plan empty?" — the rows exist, nobody published them.
      if (result.data.createdLocalPlan && result.data.total === 0) {
        setToast({
          severity: "info",
          message:
            "The plan is now on this computer, but the server had no rows in it " +
            "to send. Anything you enter here can be published normally.",
        });
      }
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
   * Refresh the hotel-setup diff without putting a dialog in anybody's way.
   *
   * Deliberately silent: it runs on load, and a conditional GET that comes back
   * 304 must not announce itself. The card renders whatever this leaves behind.
   */
  const refreshSetupDiff = useCallback(async () => {
    if (!ou) return null;
    const result = await previewStructureCall(ou);
    if (syncFailed(result)) return null;
    const diff = {
      incoming: result.data.changes,
      outgoing: result.data.outgoing,
      published: result.data.published,
      serverVersion: result.data.serverVersion,
    };
    setSetupDiff(diff);
    return diff;
  }, [ou]);

  // On load, and on every hotel change. One ETag'd request; a 304 costs nothing
  // and the answer is what the card needs before anybody presses anything.
  useEffect(() => {
    void refreshSetupDiff();
  }, [refreshSetupDiff]);

  /**
   * Check, and show the answer.
   *
   * Nothing to see gets a toast; anything to see opens the compare dialog, which
   * is where both directions and all three actions live. It used to open a
   * generic review dialog showing the same section counts the card already
   * showed, with a Download button behind them — so the only way to find out
   * WHAT had changed was to apply it and look at the grid.
   */
  const handleStructurePreview = useCallback(async () => {
    if (!ou) return;
    const result = await previewStructureCall(ou);
    if (syncFailed(result)) {
      fail(result.error.message);
      return;
    }
    setSetupDiff({
      incoming: result.data.changes,
      outgoing: result.data.outgoing,
      published: result.data.published,
      serverVersion: result.data.serverVersion,
    });
    if (result.data.changes.length === 0 && result.data.outgoing.length === 0) {
      setToast({
        severity: result.data.published ? "success" : "info",
        message: result.data.published
          ? "Your setup matches the server."
          : "This hotel's setup has never been published.",
      });
      return;
    }
    setSetupCompare(true);
  }, [ou, fail]);

  // Deliberately an effect rather than a call inside `handleConfirmPull`: the
  // preview is declared below that handler, so naming it there would read it
  // before it exists.
  useEffect(() => {
    if (!checkSetupAfterDownload) return;
    setCheckSetupAfterDownload(false);
    void handleStructurePreview();
  }, [checkSetupAfterDownload, handleStructurePreview]);

  /**
   * Apply the hotel's setup here.
   *
   * The count comes from the diff the user was just shown, not from the pull's
   * own response: that response is a SECOND fetch, and by the time it answers
   * the rows have been applied, so it reports how much the document changed
   * during this call rather than how much arrived. It read "Applied 0 setup
   * changes" for a download that did the work.
   */
  const handleStructurePull = useCallback(async () => {
    if (!ou) return;
    const expected = setupDiff?.incoming.length ?? 0;
    const result = await pullStructureCall(ou);
    if (syncFailed(result)) {
      fail(result.error.message);
      return;
    }
    setSetupCompare(false);
    setToast({
      severity: "success",
      message:
        expected === 1
          ? "Applied 1 setup change."
          : `Applied ${expected} setup changes.`,
    });
    await refreshSetupDiff();
    await refresh();
  }, [ou, setupDiff, refresh, refreshSetupDiff, fail]);

  /**
   * Ask before publishing something that lands in everybody's plans.
   *
   * The diff is re-fetched at the moment of asking rather than reused from the
   * card: this is the one screen where a stale answer would understate what is
   * about to be sent, and a colleague may well have published since the page
   * loaded. If the check fails the confirmation still opens, with an empty list
   * and the hotel-wide warning — which is the honest state, and refusing to let
   * an owner publish because a diff call failed would be worse.
   */
  const handleStructurePublishIntent = useCallback(async () => {
    const diff = await refreshSetupDiff();
    setSetupPublish(diff?.outgoing ?? []);
  }, [refreshSetupDiff]);

  /**
   * Publish, matching on the version the diff on screen was computed against.
   *
   * NOT `status.structureVersion`: that comes from the last `/sync/heads`, which
   * moves on a five-minute timer and is never touched by a structure pull. After
   * a download it names a version the hotel has already moved past, so `If-Match`
   * fails and the publish 412s every time.
   *
   * Deliberately not re-fetched at the moment of pressing, either. The 412 is
   * the guard against publishing over a change nobody has looked at, and quietly
   * adopting the newest version first would disarm it — the diff in front of the
   * user is exactly what they are agreeing to send.
   */
  const handleStructurePush = useCallback(async () => {
    if (!ou) return;
    const version = setupDiff?.serverVersion ?? status?.structureVersion ?? null;
    const result = await pushStructureCall(ou, version);
    setSetupPublish(null);
    if (syncFailed(result)) {
      setToast({
        severity: "error",
        message:
          result.error.code === "kairos_structure_precondition"
            ? "Somebody else changed this hotel's setup while this page was open. Download it, then publish again."
            : result.error.message,
      });
      await refreshSetupDiff();
      return;
    }
    setSetupCompare(false);
    setToast({ severity: "success", message: "Hotel setup published." });
    await refreshSetupDiff();
    await refresh();
  }, [ou, status, setupDiff, refresh, refreshSetupDiff]);

  /**
   * Download the hotel's setup, then publish the result.
   *
   * The answer to the state the card could describe but neither button could
   * resolve: the hotel's copy and this one have each moved on, so downloading
   * loses nothing (the merge is additive) but leaves this machine's own work
   * unpublished, and publishing first would send a document that predates the
   * colleague's change. Doing both, in that order, ends with one setup holding
   * everything.
   *
   * Sequenced here rather than added to the protocol — `GET` then `PUT` is all
   * it is, and the server's own merge is additive in both directions.
   */
  const handleStructureSyncBoth = useCallback(async () => {
    if (!ou) return;
    const pulled = await pullStructureCall(ou);
    if (syncFailed(pulled)) {
      fail(pulled.error.message);
      await refreshSetupDiff();
      return;
    }
    // The version to match on is the one the pull just landed on, not the one
    // this page loaded with.
    const result = await pushStructureCall(ou, pulled.data.serverVersion);
    setSetupCompare(false);
    setToast(
      syncFailed(result)
        ? {
            severity: "error",
            message:
              result.error.code === "kairos_structure_precondition"
                ? "The hotel's setup changed again while this was running. Check for changes and try once more."
                : // The download DID apply — say so, or this reads as a total
                  // failure and the obvious next move is to press it again.
                  `Downloaded, but publishing failed: ${result.error.message}`,
          }
        : {
            severity: "success",
            message:
              "Downloaded this hotel's setup and published yours. Both copies now match.",
          }
    );
    await refreshSetupDiff();
    await refresh();
  }, [ou, refresh, refreshSetupDiff, fail]);

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
          if (result.error.code === SYNC_ERROR_CODES.OWNER_NOT_ELIGIBLE) {
            setTransferIneligible(result.error.context ?? {});
            return;
          }
          fail(result.error.message);
          return;
        }
        setDialog(null);
        setTransferIneligible(null);
        // The plan has moved either way, so this is never a failure — but what
        // it leaves the person who pressed the button is not something they can
        // see for themselves. Retention is best effort: they normally keep a
        // read-only view of the whole plan, and a departed owner keeps nothing.
        setToast(transferOutcome(result.data));
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
    const freesName = !plan.onThisComputer && plan.twinPlanId !== null;
    await run(plan.planId, async () => {
      const result = await deletePlanCall(ou, plan.planId);
      setDialog(null);
      setToast(
        syncFailed(result)
          ? { severity: "error", message: result.error.message }
          : {
              severity: "success",
              // The name clash is the reason most owners come to this button, so
              // the toast says the thing they are waiting to hear rather than
              // making them go and check whether Publish has woken up.
              message: freesName
                ? "Deleted from the server. The name is free — your own plan of that " +
                  "name can now be published. Support can still restore the copy that went."
                : "Deleted from the server. The rows survive there and support can restore it.",
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

  /**
   * Ask a plan's owner for a delegation.
   *
   * Not an endpoint — there is no "request access" on the server, and inventing
   * a workflow for it would mean somewhere for the request to sit unanswered.
   * The owner's address is on the wire precisely so this can be a mail draft,
   * which lands in a place they already read.
   *
   * The subject and body name the plan and the property because "can I have
   * access?" arrives at somebody who owns four of them.
   */
  const handleRequestAccess = useCallback((plan: PlanSyncStatus) => {
    if (!plan.ownerEmail) return;
    const subject = `Kairos: access to ${plan.label} (${plan.year})`;
    const body =
      `Hello,\n\n` +
      `Could you share the ${plan.label} plan for ${plan.year} at ${plan.ou} with me ` +
      `in Kairos? I can see it listed but cannot open it.\n\n` +
      `If you are still working on it, you can share it read-only from the ` +
      `Delegation page — that lets me look without changing anything, and you keep ` +
      `full control.\n\nThank you.`;
    window.open(
      `mailto:${encodeURIComponent(plan.ownerEmail)}` +
        `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    );
  }, []);

  const handleCopyOwnerEmail = useCallback((email: string) => {
    void navigator.clipboard
      .writeText(email)
      .then(() => setToast({ severity: "success", message: `${email} copied.` }))
      .catch(() =>
        setToast({ severity: "error", message: "Could not reach the clipboard." })
      );
  }, []);

  /**
   * Throw away a frozen local copy.
   *
   * Reuses the delete dialog's `"none"` mode — the one that demands the plan's
   * name be typed — because this is the same act in every way that matters: the
   * rows go and nothing on the server can bring them back, since the server will
   * not talk to this user about the plan at all.
   */
  const handleDiscardLocalCopy = useCallback(async () => {
    if (!ou || dialog?.kind !== "discard") return;
    const plan = dialog.plan;
    await run(plan.planId, async () => {
      const result = await discardLocalPlan(ou, plan.planId);
      setDialog(null);
      setToast(
        syncFailed(result)
          ? { severity: "error", message: result.error.message }
          : {
              severity: "success",
              message: `${plan.label} was removed from this computer.`,
            }
      );
      await refresh();
    });
  }, [ou, dialog, refresh, run]);

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
   *
   * So do colleagues' plans that are not shared with this user, which have no
   * action at all — they render as locked tiles. Same section, because the
   * question both answer is "what else is at this hotel?", and separating them
   * would put a heading over a list whose whole content is "nothing to do".
   */
  const cloudPlans = useMemo(
    () => (status?.plans ?? []).filter((plan) => !plan.onThisComputer),
    [status]
  );

  /** The subset with something to press. Drives the attention count only. */
  const downloadablePlans = useMemo(
    () => cloudPlans.filter((plan) => plan.readable),
    [cloudPlans]
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

  // Two stages. The cheap one answers "does anybody hold anything here" for
  // every plan you could delegate; the expensive one fetches the grants and
  // presence only where the answer was yes. See both hooks.
  const delegationOverview = useDelegationOverview(ou, localPlans);
  const planDelegations = usePlanDelegations(ou, localPlans, delegationOverview);

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
  /**
   * Somebody who could publish the hotel's setup, when this user cannot.
   *
   * Best-effort and deliberately so: there is no "who owns this hotel's setup"
   * call, because the setup has no owner — it is published by anybody who owns
   * any plan here. The owner of a plan this user can see is the closest true
   * answer, and naming one real person beats "ask an administrator".
   */
  const setupPublisherEmail = anyOwner
    ? null
    : orderedPlans.find((plan) => plan.ownerEmail)?.ownerEmail ?? null;
  // Cloud-only plans count: a page that says "Up to date" above a plan waiting
  // to be downloaded is contradicting itself. Locked ones do NOT — a colleague's
  // plan you were never meant to open is not outstanding work, and counting it
  // would leave this badge permanently lit at any hotel with two budget owners.
  const attentionCount =
    orderedPlans.filter((plan) => planState(plan, leases[plan.planId]).needsAttention)
      .length + downloadablePlans.length;

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

      {removed.length > 0 && (
        // Not a toast. "A plan you had is gone" needs to survive long enough to
        // be read twice and to be shown to somebody else, and it needs to say
        // who to talk to — a six-second snackbar does none of that.
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setRemoved([])}>
          <AlertTitle>
            {removed.length === 1
              ? "A plan was removed from this computer"
              : `${removed.length} plans were removed from this computer`}
          </AlertTitle>
          <Typography variant="body2">
            Seeing a hotel no longer means being able to open every plan in it.
            These belong to colleagues who have not shared them with you, so the
            copies here were removed:
          </Typography>
          <Stack component="ul" sx={{ mt: 1, mb: 0, pl: 3 }} spacing={0.25}>
            {removed.map((plan) => (
              <Typography key={plan.planId} component="li" variant="body2">
                <strong>{plan.label}</strong>
                {plan.ownerEmail ? ` — ask ${plan.ownerEmail} to share it` : ""}
              </Typography>
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            Nothing of your own was touched. Anything you had changed and not
            published is kept, and those plans are still listed below.
          </Typography>
        </Alert>
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
          delegationOverride={
            delegationOverview[plan.planId]
              ? delegationSummary(delegationOverview[plan.planId])
              : undefined
          }
          delegations={planDelegations[plan.planId]?.delegations ?? null}
          presenceByUserId={planDelegations[plan.planId]?.presenceByUserId ?? {}}
          onDownloadForDelegation={(delegation) =>
            handleDownloadForDelegation(plan, delegation)
          }
          onReconcile={() => void handleReconcile(plan)}
          onRebuildShadow={() => void handleRebuildShadow(plan)}
          onOpenDelegation={(delegationId) =>
            // The hint saves the Delegation page a round trip and, more to the
            // point, lets it name the plan before anything renders. Matched on
            // `planId` there, so a replayed history entry cannot mislabel it.
            // `delegation` anchors the scroll on one person's card, so a click
            // on a row lands on that row rather than at the top of a list.
            navigate(
              `/signed-in-landing/delegation?plan=${plan.planId}` +
                (delegationId ? `&delegation=${delegationId}` : ""),
              {
              state: {
                plan: {
                  planId: plan.planId,
                  label: plan.label,
                  year: plan.year,
                  ou: plan.ou,
                  ownerEmail: plan.ownerEmail,
                },
              },
              }
            )
          }
          onTransfer={() => setDialog({ kind: "transfer", plan })}
          onDeleteFromServer={() => setDialog({ kind: "delete", plan })}
          onDiscardLocalCopy={() => setDialog({ kind: "discard", plan })}
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

          {/* "Check for differences" and "Repair sync state" used to sit here,
              as a third button row inside the card. They are now in the card's
              own "More" menu: both are diagnostics, neither is something anybody
              does on purpose in a normal week, and giving them the same weight
              as Publish was most of what made this card read as a wall. */}
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
            Plans the server holds at this hotel — ones you own from another
            machine, and ones colleagues have shared with you. Downloading brings
            the whole plan here; nothing changes until you do.
            {cloudPlans.some((plan) => !plan.readable) &&
              " Plans marked with a lock belong to a colleague and have not been shared with you."}
          </Typography>
          {cloudPlans.map((plan) => (
            <CloudPlanCard
              key={plan.planId}
              plan={plan}
              busy={busyPlan === plan.planId}
              twinLabel={plan.twinPlanId ? labelById.get(plan.twinPlanId) : null}
              onDownload={() => void handlePreviewPull(plan)}
              onDeleteFromServer={() => setDialog({ kind: "delete", plan })}
              onRequestAccess={handleRequestAccess}
              onCopyOwnerEmail={handleCopyOwnerEmail}
            />
          ))}
        </Box>
      )}

      {status && (
        <HotelSetupCard
          incoming={setupDiff?.incoming ?? null}
          outgoing={setupDiff?.outgoing ?? null}
          checked={setupDiff !== null}
          published={setupDiff?.published ?? false}
          busy={loading}
          canPublish={anyOwner}
          publisherEmail={setupPublisherEmail}
          onCheck={() => void handleStructurePreview()}
          onCompare={() => setSetupCompare(true)}
          onPublish={() => void handleStructurePublishIntent()}
        />
      )}

      <HotelSetupCompareDialog
        open={setupCompare}
        incoming={setupDiff?.incoming ?? []}
        outgoing={setupDiff?.outgoing ?? []}
        busy={loading}
        canPublish={anyOwner}
        onDownload={() => void handleStructurePull()}
        // Straight to the hotel-wide confirmation, not to the push: publishing
        // the setup lands in everybody's plans, and that warning is the one
        // thing on this page that must not be skippable.
        onPublish={() => void handleStructurePublishIntent()}
        onSyncBoth={() => void handleStructureSyncBoth()}
        onClose={() => setSetupCompare(false)}
      />

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
        // A first download is worth doing even with nothing to bring down: it
        // is what makes the plan exist here.
        collides={pullReview?.collides ?? 0}
        collidingDepartments={pullReview?.collidingDepartments ?? []}
        pendingChanges={pullReview?.pendingChanges ?? 0}
        byDepartment={pullReview?.byDepartment ?? {}}
        pendingDepartments={pullReview?.pendingDepartments ?? []}
        // Set only when the download was started from somebody's row. Leads with
        // their departments; the dialog still shows, and says, that the rest of
        // the plan is arriving too.
        highlightDepartments={pullReview?.forDepartments ?? []}
        allowEmpty={pullReview?.firstDownload ?? false}
        replacesLabel={
          pullReview?.replaceLocalPlanId
            ? labelById.get(pullReview.replaceLocalPlanId) ?? "your local plan"
            : null
        }
        // Only offered when something would actually be overwritten — see the
        // verdict in ReviewDialog. Closes this dialog and opens the publish
        // review for the same plan, which is what the user meant by pressing it.
        onPublishFirst={
          pullReview && pullReview.collides > 0
            ? () => {
                const plan = localPlans.find(
                  (candidate) => candidate.planId === pullReview.planId
                );
                setPullReview(null);
                if (plan) void handlePreviewPublish(plan);
              }
            : undefined
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

      {/* Publishing the setup is the one action on this page whose blast radius
          is the whole hotel rather than one plan, and the button said nothing
          about that. It also sends the WHOLE local document — not a delta since
          the last publish — which is the part nobody expects. */}
      <Dialog
        open={setupPublish !== null}
        onClose={() => setSetupPublish(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Publish this hotel&apos;s setup</DialogTitle>
        <DialogContent dividers>
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>This changes every plan at this hotel</AlertTitle>
            Columns, blocks and schemes are one shared copy per hotel. Publishing
            them applies to your colleagues&apos; plans as well as your own, the
            next time they download.
          </Alert>

          {setupPublish && setupPublish.length > 0 ? (
            <>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                What is different from the hotel&apos;s copy
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mb: 2 }}>
                {countBySection(setupPublish).map(([section, count]) => (
                  <Chip
                    key={section}
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={`${STRUCTURE_LABELS[section] ?? section}: ${count}`}
                  />
                ))}
              </Stack>
              <Box sx={{ maxHeight: 220, overflowY: "auto" }}>
                {setupPublish.slice(0, 60).map((change) => (
                  <Typography
                    key={`${change.section}:${change.key}`}
                    variant="body2"
                    color="text.secondary"
                  >
                    {change.kind === "removed"
                      ? "Removes"
                      : change.kind === "added"
                        ? "Adds"
                        : "Changes"}{" "}
                    {STRUCTURE_LABELS[change.section] ?? change.section} —{" "}
                    <strong>{change.label}</strong>
                  </Typography>
                ))}
                {setupPublish.length > 60 && (
                  <Typography variant="caption" color="text.secondary">
                    …and {setupPublish.length - 60} more.
                  </Typography>
                )}
              </Box>
            </>
          ) : (
            <Typography color="text.secondary">
              Nothing here differs from the hotel&apos;s copy. Publishing sends
              your whole local setup anyway, which is harmless when the two
              already agree.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSetupPublish(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => void handleStructurePush()}
          >
            Publish for the whole hotel
          </Button>
        </DialogActions>
      </Dialog>

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

      <DeletePlanDialog
        open={dialog?.kind === "delete"}
        busy={busyPlan !== null}
        planLabel={dialog?.plan.label ?? ""}
        localCopy={dialog ? localCopyAfterDelete(dialog.plan) : "none"}
        twinLabel={
          dialog?.plan.twinPlanId ? labelById.get(dialog.plan.twinPlanId) ?? null : null
        }
        onConfirm={() => void handleDelete()}
        onClose={() => setDialog(null)}
      />

      <DiscardLocalPlanDialog
        open={dialog?.kind === "discard"}
        busy={busyPlan !== null}
        planLabel={dialog?.plan.label ?? ""}
        pendingChanges={dialog?.plan.pendingChanges ?? 0}
        ownerEmail={dialog?.plan.ownerEmail ?? null}
        onConfirm={() => void handleDiscardLocalCopy()}
        onClose={() => setDialog(null)}
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

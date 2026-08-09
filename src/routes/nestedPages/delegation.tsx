/**
 * Delegation page — who is editing which departments of this plan.
 * -----------------------------------------------------------
 * The brief's "very simple list of departments with delegated user, if not
 * delegated then the owner is the owner". That list is `/department-ownership`,
 * whose `writable` field IS the server's write predicate — so what this page
 * shows and what the positions grid allows are the same answer, never two.
 *
 * ## The three flows worth knowing about
 *
 * **Partial overlap.** A delegate holding fewer departments than the owner is
 * granting gets the intersection. The owner is shown exactly which departments
 * will not take effect, and only then may confirm. Handled in
 * `GrantDelegationDialog`.
 *
 * **Force-withdrawal.** Withdrawing from somebody with unpublished work returns
 * a 409 naming what is about to be stranded. Forcing is legitimate — it is the
 * escape hatch when a colleague is on leave — but the owner is told plainly that
 * the work is not lost and that re-granting is how it gets published. That
 * warning depends on the delegate having reported presence, which is why the
 * positions page sends it.
 *
 * **Handback.** A delegate saying "I'm finished with Rooms" keeps their read
 * access and leaves the grant intact, so reopening is one click and the audit
 * lineage survives.
 *
 * A delegated department is deliberately NOT writable by the owner. Their route
 * back is to withdraw. That is per the brief and it is not a bug.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import Divider from "@mui/material/Divider";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AssignmentReturnOutlinedIcon from "@mui/icons-material/AssignmentReturnOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import { useSelectedHotel } from "../../store/settings";
import {
  activity as activityCall,
  amendDelegation as amendCall,
  delegatableDepartments as delegatableCall,
  delegationCandidates as candidatesCall,
  departmentOwnership as ownershipCall,
  grantDelegation as grantCall,
  handBack as handBackCall,
  handBackAll as handBackAllCall,
  listDelegations as listCall,
  pendingByDepartment as pendingByDepartmentCall,
  previewPull as previewPullCall,
  publish as publishCall,
  pull as pullCall,
  reopenDepartment as reopenCall,
  revokeDelegation as revokeCall,
} from "../../services/kairosSyncService";
import {
  PublishResponse,
  SYNC_ERROR_CODES,
  syncFailed,
} from "../../shared/kairosSync/ipc";
import {
  ActivityEntry,
  DelegatableDepartment,
  Delegation,
  DelegationCandidate,
  DelegationCreate,
  DepartmentOwnership,
  DepartmentOwnershipRow,
  HandbackUnsyncedContext,
  PartialOverlapContext,
  UnsyncedWorkContext,
} from "../../shared/kairosSync/protocol";
import { LOCK_REASON } from "../../shared/kairosSync/lockReason";
import { formatWhen } from "../../shared/kairosSync/formatWhen";
import { useAdminTools } from "../../hooks/useAdminTools";
import { usePlanIdentity } from "../../hooks/usePlanIdentity";
import DelegationCard from "../../components/sync/DelegationCard";
import GrantDelegationDialog from "../../components/sync/GrantDelegationDialog";
import HandbackDialog from "../../components/sync/HandbackDialog";
import ReviewDialog from "../../components/sync/ReviewDialog";

type Toast = { severity: "success" | "error" | "info" | "warning"; message: string } | null;

/**
 * A download started from one delegate's card.
 *
 * The pull itself is whole-plan — `/changes` takes a watermark and a cursor and
 * nothing else, so there is no per-delegate feed to ask for. `forDepartments`
 * is therefore presentation only: it tells the review dialog whose departments
 * to lead with, and the dialog says plainly that the rest is arriving too.
 */
type PullReview = {
  byType: Record<string, number>;
  deletedByType: Record<string, number>;
  byDepartment: Record<string, number>;
  total: number;
  deleted: number;
  skippedTypes: string[];
  reset: boolean;
  collides: number;
  collidingDepartments: string[];
  pendingChanges: number;
  pendingDepartments: string[];
  forDepartments: string[];
  delegateEmail: string;
};

export default function DelegationPage() {
  const ou = useSelectedHotel();
  const [params] = useSearchParams();
  const planId = params.get("plan");
  /**
   * One delegation to scroll to and pick out, when the Sync page sent us here
   * from a person's row.
   *
   * Cleared once it has been honoured: the outline is a "here is the one you
   * clicked" cue, not a selection, and leaving it on turns into a permanent
   * highlight nobody can dismiss.
   */
  const [anchoredId, setAnchoredId] = useState<string | null>(
    params.get("delegation")
  );
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const adminTools = useAdminTools();
  const identity = usePlanIdentity(ou, planId);

  const [ownership, setOwnership] = useState<DepartmentOwnership | null>(null);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [departments, setDepartments] = useState<DelegatableDepartment[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [candidates, setCandidates] = useState<DelegationCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const [grantOpen, setGrantOpen] = useState(false);
  const [overlap, setOverlap] = useState<PartialOverlapContext | null>(null);
  const [revoking, setRevoking] = useState<Delegation | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [unsynced, setUnsynced] = useState<UnsyncedWorkContext | null>(null);
  /**
   * The handback being confirmed.
   *
   * `department: null` is the bulk form. `stranded` is where the unpublished
   * work is — from a local read for a single department (the server does not
   * check that one) or from the 409's context for the bulk one.
   */
  const [handback, setHandback] = useState<{
    department: string | null;
    departments: string[];
    stranded: Record<string, number>;
    pendingTotal: number;
  } | null>(null);
  /** A publish that ran as part of a handback and did not come back clean. */
  const [handbackPublish, setHandbackPublish] = useState<PublishResponse | null>(null);
  /** The optional line for the owner. Only the per-department route takes one. */
  const [handbackNote, setHandbackNote] = useState("");
  /**
   * The delegation being switched from editable to view-only.
   *
   * Only the narrowing direction stops to ask. Taking the pen away bumps the
   * delegation's `generation` server-side and freezes whatever the delegate has
   * not published; giving it back takes nothing from anybody, so it goes
   * straight through.
   */
  const [makingViewOnly, setMakingViewOnly] = useState<Delegation | null>(null);
  /**
   * The departments you hold yourself, revealed.
   *
   * Collapsed by default because on most plans it is most of them, and "you hold
   * it and may edit it" is not what anybody opens this page to find out.
   */
  const [showRoutine, setShowRoutine] = useState(false);
  const [pullReview, setPullReview] = useState<PullReview | null>(null);

  const refresh = useCallback(async () => {
    if (!ou || !planId) return;
    setLoading(true);
    const [ownershipResult, listResult, departmentsResult, activityResult] =
      await Promise.all([
        ownershipCall(ou, planId),
        listCall(ou, planId),
        delegatableCall(ou, planId),
        // Fully plumbed since delegation shipped and never rendered anywhere.
        // This is the same data the force-revoke 409 carries — shown BEFORE the
        // owner presses Withdraw rather than as a refusal afterwards, which is
        // the entire reason `usePresenceReporter` runs every sixty seconds.
        activityCall(ou, planId),
      ]);
    if (!syncFailed(ownershipResult)) setOwnership(ownershipResult.data);
    if (!syncFailed(listResult)) setDelegations(listResult.data.delegations);
    if (!syncFailed(departmentsResult)) setDepartments(departmentsResult.data.departments);
    // Presence is advisory. Failing to fetch it is not worth a word on screen.
    setActivity(syncFailed(activityResult) ? [] : activityResult.data.present);
    setLoading(false);
  }, [ou, planId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Land on the card the Sync page's row pointed at, once it exists.
   *
   * Runs after the grants arrive rather than on mount — the list is empty until
   * then, so there is nothing to scroll to. The cue clears itself after a few
   * seconds: it answers "which one did I click", and past that it is just a
   * highlight with no way to turn it off.
   */
  useEffect(() => {
    if (!anchoredId || delegations.length === 0) return;
    anchorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(() => setAnchoredId(null), 4000);
    return () => clearTimeout(timer);
  }, [anchoredId, delegations]);

  const isOwner =
    ownership?.me.relation === "OWNER" || ownership?.me.relation === "ADMIN_LEASE";

  /**
   * Departments I hold as a delegate and could hand back.
   *
   * Derived from `writable`, never from the holder list: `DelegatedHolder` has a
   * userId and an email and neither answers "is that me", and matching on email
   * fails silently when a login address differs from the granted one.
   */
  const myHoldings = useMemo(() => {
    if (isOwner) return [];
    return (ownership?.departments ?? []).filter((row) => row.writable);
  }, [ownership, isOwner]);

  const myHoldingCodes = useMemo(
    () => myHoldings.map((row) => row.code),
    [myHoldings]
  );

  /**
   * Presence keyed by user, so each card can speak for its own delegate.
   *
   * `/department-ownership` reports who holds a department and in what state and
   * nothing about when it moved; the times live on `Delegation.departments[]`,
   * which only an owner can fetch. Both now land on the same card, joined here
   * on `delegateUserId` rather than on an email — a login address need not match
   * the granted one, and matching on it fails silently when it does not.
   */
  const presenceByUser = useMemo(
    () => new Map(activity.map((entry) => [entry.userId, entry])),
    [activity]
  );

  /**
   * Presence for somebody who is not a delegate — the owner on a second machine,
   * or an administrator under a lease.
   *
   * Folding the old "Working on this now" list into the cards would otherwise
   * drop these silently, and "who else is in here" is the one thing that list
   * was for.
   */
  const unmatchedActivity = useMemo(
    () =>
      activity.filter(
        (entry) => !delegations.some((delegation) => delegation.delegateUserId === entry.userId)
      ),
    [activity, delegations]
  );

  /**
   * Departments worth a row, and departments that are merely fine.
   *
   * A row earns its place if somebody else is in it, or if you cannot edit it.
   * Everything else is "you hold it and may edit it" — true of most departments
   * on most plans, and it was pushing the three rows that carry information off
   * the first screen. The same rule reads correctly for a delegate, whose own
   * holdings are the writable ones and whose locked rows say why.
   */
  const [interestingRows, routineRows] = useMemo(() => {
    const rows = ownership?.departments ?? [];
    return [
      rows.filter((row) => row.assignedTo.length > 0 || !row.writable),
      rows.filter((row) => row.assignedTo.length === 0 && row.writable),
    ];
  }, [ownership]);

  /** Every department handed back and not yet reopened, flattened for the card. */
  const handedBackRows = useMemo(() => {
    const rows: Array<{
      code: string;
      email: string;
      delegationId: string;
      handedBackAt: string | null;
      handedBackNote: string | null;
    }> = [];
    for (const delegation of delegations) {
      for (const department of delegation.departments) {
        if (department.state !== "HANDED_BACK") continue;
        rows.push({
          code: department.code,
          email: delegation.delegateEmail,
          delegationId: delegation.id,
          handedBackAt: department.handedBackAt,
          handedBackNote: department.handedBackNote,
        });
      }
    }
    return rows;
  }, [delegations]);

  const searchCandidates = useCallback(
    async (query: string) => {
      if (!ou || !planId) return;
      setCandidatesLoading(true);
      const result = await candidatesCall(ou, planId, query || undefined);
      if (!syncFailed(result)) setCandidates(result.data.candidates);
      setCandidatesLoading(false);
    },
    [ou, planId]
  );

  useEffect(() => {
    if (grantOpen) void searchCandidates("");
  }, [grantOpen, searchCandidates]);

  const handleGrant = useCallback(
    async (body: DelegationCreate) => {
      if (!ou || !planId) return;
      setBusy(true);
      const result = await grantCall(ou, planId, body);
      setBusy(false);

      if (syncFailed(result)) {
        setToast({ severity: "error", message: result.error.message });
        return;
      }
      if (result.data.outcome === "partial-overlap") {
        // Not a failure — a question. Keep the dialog open with the warning so
        // the owner can see exactly what will and will not take effect.
        setOverlap(result.data.context);
        return;
      }
      setOverlap(null);
      setGrantOpen(false);
      setToast({ severity: "success", message: "Delegated." });
      await refresh();
    },
    [ou, planId, refresh]
  );

  const handleRevoke = useCallback(
    async (force: boolean) => {
      if (!ou || !planId || !revoking) return;
      setBusy(true);
      const result = await revokeCall(ou, planId, revoking.id, revokeReason, force);
      setBusy(false);

      if (syncFailed(result)) {
        setToast({ severity: "error", message: result.error.message });
        return;
      }
      if (result.data.outcome === "unsynced-work") {
        setUnsynced(result.data.context);
        return;
      }
      setRevoking(null);
      setUnsynced(null);
      setRevokeReason("");
      setToast({
        severity: result.data.unsyncedAtRevoke ? "warning" : "success",
        message:
          result.data.warning ??
          "Delegation withdrawn. You can edit those departments again.",
      });
      await refresh();
    },
    [ou, planId, revoking, revokeReason, refresh]
  );

  /**
   * Ask before handing one department back, when there is something to ask about.
   *
   * The server deliberately does NOT check this route for unpublished work —
   * finishing one department of five with four still open is routine — so the
   * client has to, from a local read. Fast, and offline-safe: somebody deciding
   * whether to publish before handing back may well be on a train.
   */
  const openHandback = useCallback(
    async (code: string | null) => {
      if (!ou || !planId) return;
      const moving = code ? [code] : myHoldingCodes;
      const pending = await pendingByDepartmentCall(ou, planId);
      const byDepartment = syncFailed(pending) ? {} : pending.data.byDepartment;
      const stranded = Object.fromEntries(
        moving
          .map((department) => [department, byDepartment[department] ?? 0])
          .filter(([, count]) => (count as number) > 0)
      ) as Record<string, number>;
      setHandbackPublish(null);
      setHandback({
        department: code,
        departments: moving,
        stranded,
        pendingTotal: syncFailed(pending) ? 0 : pending.data.total,
      });
    },
    [ou, planId, myHoldingCodes]
  );

  /** Do the handback itself, once the conversation above has been had. */
  const runHandback = useCallback(
    async (target: { department: string | null }, force: boolean) => {
      if (!ou || !planId) return true;
      if (target.department !== null) {
        const result = await handBackCall(
          ou,
          planId,
          target.department,
          handbackNote.trim() || undefined
        );
        if (syncFailed(result)) {
          setToast({ severity: "error", message: result.error.message });
          return false;
        }
        setToast({
          severity: "success",
          message: `${target.department} handed back. You can still see it, but not edit it.`,
        });
        return true;
      }

      const result = await handBackAllCall(ou, planId, force);
      if (syncFailed(result)) {
        if (result.error.code === SYNC_ERROR_CODES.HANDBACK_WITH_UNSYNCED_WORK) {
          // The server's count wins for the headline — it sees what this client
          // last REPORTED as dirty, which is the number the owner would be
          // warned about too.
          const context = (result.error.context ?? {}) as unknown as HandbackUnsyncedContext;
          setHandback({
            department: null,
            departments: context.departments ?? myHoldingCodes,
            stranded: Object.fromEntries(
              (context.departments ?? myHoldingCodes).map((code) => [
                code,
                Math.max(1, Math.round((context.dirtyEntities ?? 1) / Math.max(1, (context.departments ?? myHoldingCodes).length))),
              ])
            ),
            pendingTotal: context.dirtyEntities ?? 0,
          });
          return false;
        }
        setToast({ severity: "error", message: result.error.message });
        return false;
      }
      setToast({
        severity: "success",
        message: `${result.data.departments.length} departments handed back. You can still see them.`,
      });
      return true;
    },
    [ou, planId, myHoldingCodes]
  );

  const handleHandBackAnyway = useCallback(async () => {
    if (!handback) return;
    setBusy(true);
    const done = await runHandback(handback, true);
    setBusy(false);
    if (done) {
      setHandback(null);
      setHandbackNote("");
    }
    await refresh();
  }, [handback, runHandback, refresh]);

  /**
   * Publish, then hand back, as one act.
   *
   * The order is the whole point. A handback is not a revocation and takes
   * nothing away, but it does remove the department from the write scope — so a
   * publish afterwards silently withholds exactly the rows the delegate meant to
   * send, and the first anybody hears about it is the owner wondering where
   * Rooms went. Publishing first is the only ordering that works, which is why
   * this is one button rather than advice to press two in sequence.
   *
   * A publish that comes back with conflicts or actionable rejections stops
   * here: the handback is not attempted, the result is rendered in full, and the
   * dialog stays open. Handing back on top of a partial publish would strand the
   * remainder with no way to retry.
   */
  const handlePublishThenHandBack = useCallback(async () => {
    if (!ou || !planId || !handback) return;
    setBusy(true);
    setHandbackPublish(null);

    const published = await publishCall(ou, planId);
    if (syncFailed(published)) {
      setBusy(false);
      setToast({ severity: "error", message: published.error.message });
      return;
    }
    if (published.data.conflicts.length > 0 || published.data.rejected.length > 0) {
      setBusy(false);
      setHandbackPublish(published.data);
      return;
    }

    const done = await runHandback(handback, false);
    setBusy(false);
    if (done) {
      setHandback(null);
      setHandbackNote("");
    }
    await refresh();
  }, [ou, planId, handback, runHandback, refresh]);

  /**
   * Flip a live delegation between editable and view-only.
   *
   * `PATCH` rather than withdraw-and-regrant, which matters: a re-grant bumps
   * `generation` and stamps an override window, so it is a materially different
   * act from amending the flag. The plumbing for this existed end to end and had
   * no UI at all — reasonable while `canEdit` was hard-coded true, and not now
   * that a read-only share is the only way to let a colleague look.
   */
  const handleSetCanEdit = useCallback(
    async (delegation: Delegation, canEdit: boolean) => {
      if (!ou || !planId) return;
      setBusy(true);
      const result = await amendCall(ou, planId, delegation.id, { canEdit });
      setBusy(false);
      setMakingViewOnly(null);

      if (syncFailed(result)) {
        setToast({ severity: "error", message: result.error.message });
        return;
      }
      setToast({
        severity: "success",
        message: canEdit
          ? `${delegation.delegateEmail} can edit again.`
          : `${delegation.delegateEmail} can still see the plan but not change it.`,
      });
      await refresh();
    },
    [ou, planId, refresh]
  );

  /**
   * Give everything back at once.
   *
   * Sequential rather than parallel: each is a separate authorization change and
   * a half-applied burst of parallel calls is harder to reason about than a
   * half-applied sequence. One toast at the end, because five is noise.
   */
  const handleReopenAll = useCallback(async () => {
    if (!ou || !planId || handedBackRows.length === 0) return;
    setBusy(true);
    let reopened = 0;
    for (const entry of handedBackRows) {
      const result = await reopenCall(ou, planId, entry.delegationId, entry.code);
      if (!syncFailed(result)) reopened += 1;
    }
    setBusy(false);
    setToast(
      reopened === handedBackRows.length
        ? { severity: "success", message: `${reopened} departments reopened.` }
        : {
            severity: "warning",
            message: `${reopened} of ${handedBackRows.length} departments reopened.`,
          }
    );
    await refresh();
  }, [ou, planId, handedBackRows, refresh]);

  /** The same, for one delegation — the card's "not finished after all" route. */
  const handleReopenFor = useCallback(
    async (delegation: Delegation) => {
      if (!ou || !planId) return;
      const codes = delegation.departments
        .filter((department) => department.state === "HANDED_BACK")
        .map((department) => department.code);
      if (codes.length === 0) return;

      setBusy(true);
      let reopened = 0;
      for (const code of codes) {
        const result = await reopenCall(ou, planId, delegation.id, code);
        if (!syncFailed(result)) reopened += 1;
      }
      setBusy(false);
      setToast(
        reopened === codes.length
          ? {
              severity: "success",
              message: `${delegation.delegateEmail} has ${
                reopened === 1 ? "that department" : `those ${reopened} departments`
              } back.`,
            }
          : {
              severity: "warning",
              message: `${reopened} of ${codes.length} departments reopened.`,
            }
      );
      await refresh();
    },
    [ou, planId, refresh]
  );

  /**
   * Collect a delegate's published work, without leaving the page.
   *
   * The download is whole-plan and cannot be otherwise — the server has no
   * per-delegate feed — so this leads the review with their departments and the
   * dialog says so. Simpler than the Sync page's version of the same flow: a
   * plan reached from here is always already on this computer, so there is no
   * first-download or replace-a-local-plan branch to take.
   */
  const handlePreviewPull = useCallback(
    async (delegation: Delegation) => {
      if (!ou || !planId) return;
      setBusy(true);
      const [preview, pending] = await Promise.all([
        previewPullCall(ou, planId),
        pendingByDepartmentCall(ou, planId),
      ]);
      setBusy(false);

      if (syncFailed(preview)) {
        setToast({ severity: "error", message: preview.error.message });
        return;
      }
      const pendingByDepartment = syncFailed(pending) ? {} : pending.data.byDepartment;
      setPullReview({
        byType: preview.data.byType,
        deletedByType: preview.data.deletedByType,
        byDepartment: preview.data.byDepartment,
        total: preview.data.total,
        deleted: preview.data.deleted,
        skippedTypes: preview.data.skippedTypes,
        reset: preview.data.reset,
        collides: preview.data.collides,
        collidingDepartments: preview.data.collidingDepartments,
        pendingChanges: syncFailed(pending) ? 0 : pending.data.total,
        pendingDepartments: Object.keys(pendingByDepartment),
        forDepartments: delegation.effectiveDepartments,
        delegateEmail: delegation.delegateEmail,
      });
    },
    [ou, planId]
  );

  const handleConfirmPull = useCallback(async () => {
    if (!ou || !planId) return;
    setBusy(true);
    const result = await pullCall(ou, planId);
    setBusy(false);

    if (syncFailed(result)) {
      setToast({ severity: "error", message: result.error.message });
      return;
    }
    setPullReview(null);
    setToast({
      severity: "success",
      message: `Downloaded ${result.data.total} ${
        result.data.total === 1 ? "row" : "rows"
      }. Their work is on this computer.`,
    });
    await refresh();
  }, [ou, planId, refresh]);

  const handleReopen = useCallback(
    async (delegationId: string, code: string) => {
      if (!ou || !planId) return;
      setBusy(true);
      const result = await reopenCall(ou, planId, delegationId, code);
      setBusy(false);
      setToast(
        syncFailed(result)
          ? { severity: "error", message: result.error.message }
          : { severity: "success", message: `${code} reopened.` }
      );
      await refresh();
    },
    [ou, planId, refresh]
  );

  /**
   * A delegate who was given departments to read and none to write.
   *
   * `canEdit: false`, in other words. Without this the page shows them a
   * Departments table full of "No", no Hand back button on any row, and no
   * explanation of why they are on the page at all.
   */
  const viewOnly =
    !isOwner &&
    ownership !== null &&
    ownership.me.relation === "DELEGATE" &&
    myHoldings.length === 0 &&
    ownership.departments.length > 0;

  if (!ou || !planId) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          Open this page from the Sync tab so it knows which plan you mean.
        </Alert>
      </Box>
    );
  }

  /**
   * The plan is real, and it is somewhere else.
   *
   * Worth its own page rather than an empty table: everything below would be
   * blank and read as "you have no departments here", which is true of this
   * hotel and false of the question being asked.
   */
  if (identity.atAnotherHotel) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          <AlertTitle>This plan is at another hotel</AlertTitle>
          <strong>
            {identity.label ?? "That plan"}
            {identity.year ? ` (${identity.year})` : ""}
          </strong>{" "}
          belongs to{" "}
          <strong>
            {identity.atAnotherHotel.hotelName ?? identity.atAnotherHotel.ou}
          </strong>
          , and Kairos is showing{" "}
          <strong>{identity.hotelName ?? ou}</strong>. Switch hotel at the top of
          the window and this page will open it.
        </Alert>
      </Box>
    );
  }

  if (identity.unknown) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="warning">
          <AlertTitle>That plan is not one of yours</AlertTitle>
          Nothing at this hotel, and nothing shared with you anywhere, has that
          id. Open the Delegation page from the Sync tab so it knows which plan
          you mean.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      {/* Which plan, before anything else on the page. Handing departments back
          on a plan you mis-clicked is expensive, and this used to render a
          hardcoded "Delegation" over an opaque id. */}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start", mb: 1 }}>
        <GroupsOutlinedIcon color="primary" sx={{ mt: 1 }} />
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography variant="overline" color="text.secondary">
            Delegation
          </Typography>
          {identity.label === null && identity.loading ? (
            // A skeleton rather than a placeholder name: flashing the wrong plan
            // for a moment is worse than showing nothing for one.
            <Skeleton variant="text" width={280} sx={{ fontSize: "2.125rem" }} />
          ) : (
            <Typography variant="h4" sx={{ fontWeight: 600 }}>
              {identity.label ?? "This plan"}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {[
              identity.year,
              identity.hotelName ?? identity.ou ?? ou,
              identity.ownerEmail ? `owned by ${identity.ownerEmail}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Typography>
        </Box>
        {isOwner && (
          <Button variant="contained" onClick={() => setGrantOpen(true)} disabled={busy}>
            Delegate departments
          </Button>
        )}
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Departments you delegate become editable by that person and read-only for
        you until you withdraw. Sharing a department <strong>view only</strong> is
        different: they can read it, and you carry on editing as normal.
      </Typography>

      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {ownership && !ownership.structureEditableByMe && isOwner && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Your access has changed</AlertTitle>
          You still own this plan, but you no longer meet the requirements to edit
          its columns, blocks and schemes. You can still edit your own departments.
        </Alert>
      )}

      {viewOnly && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <AlertTitle>This plan was shared with you to look at</AlertTitle>
          You can read{" "}
          {ownership?.departments.map((row) => row.code).join(", ")} and download
          updates as the owner publishes them. Editing and publishing are theirs
          to do. If you need to change something, ask them — they can switch that
          on without re-sharing the plan.
        </Alert>
      )}

      {/* There is no separate "Your departments" card. It listed the delegate's
          holdings as chips whose delete slot carried a padlock — a control that
          reads as "lock this department" and in fact handed it back. The
          Departments table below already lists every department this user can
          see, so the handback lives there, on the row it belongs to, spelled
          out in words. */}

      {/* The owner's cue. A handback means somebody has finished and their work
          is on the server waiting — which is a thing to go and DO, not a state
          to notice, so it says so and points at the button. */}
      {isOwner && handedBackRows.length > 0 && (
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            <Button
              color="inherit"
              size="small"
              disabled={busy}
              onClick={() => void handleReopenAll()}
            >
              Reopen all
            </Button>
          }
        >
          <AlertTitle>
            {handedBackRows.length === 1
              ? "A department has been handed back to you"
              : `${handedBackRows.length} departments have been handed back to you`}
          </AlertTitle>
          {handedBackRows.map((entry) => (
            <Typography key={`${entry.delegationId}:${entry.code}`} variant="body2">
              <strong>{entry.code}</strong> — {entry.email}
              {entry.handedBackAt ? `, ${formatWhen(entry.handedBackAt)}` : ""}
              {entry.handedBackNote ? ` — “${entry.handedBackNote}”` : ""}
            </Typography>
          ))}
          <Typography variant="body2" sx={{ mt: 1 }}>
            Their work is on the server. Use <strong>Download their work</strong> on
            their card below to bring it onto this computer, or reopen a department
            if they are not finished after all.
          </Typography>
        </Alert>
      )}

      <Card variant="outlined" sx={{ borderRadius: 2, mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
            Departments
          </Typography>
          {/* Said once, here, rather than on a card of its own: this table is
              now where a delegate gives work back from. */}
          {myHoldings.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Hand a department back when you are finished with it. You keep
              being able to see it, and the owner can give it back to you in one
              click.
            </Typography>
          )}

          {/* Only the rows that carry information. When and why a department
              moved now lives on the delegation it belongs to, so this table
              answers the two questions it is uniquely good at — who is editing
              this, and may I — and stops repeating the cards. */}
          {interestingRows.length > 0 && (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Department</TableCell>
                  <TableCell>Edited by</TableCell>
                  <TableCell>You can edit</TableCell>
                  {myHoldings.length > 0 && <TableCell />}
                </TableRow>
              </TableHead>
              <TableBody>
                {interestingRows.map((row) => (
                  <DepartmentRow
                    key={row.code}
                    row={row}
                    busy={busy}
                    onHandBack={
                      myHoldings.length > 0
                        ? () => void openHandback(row.code)
                        : undefined
                    }
                  />
                ))}
              </TableBody>
            </Table>
          )}

          {interestingRows.length === 0 && routineRows.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              Nothing is delegated. You hold{" "}
              {routineRows.length === 1
                ? "the only department"
                : `all ${routineRows.length} departments`}
              .
            </Typography>
          )}

          {routineRows.length > 0 && (
            <>
              <Button
                size="small"
                sx={{ mt: interestingRows.length > 0 ? 1.5 : 1, color: "text.secondary" }}
                endIcon={
                  <ExpandMoreIcon
                    sx={{
                      transform: showRoutine ? "rotate(180deg)" : undefined,
                      transition: "transform 150ms",
                    }}
                  />
                }
                onClick={() => setShowRoutine((open) => !open)}
              >
                {showRoutine ? "Hide" : "Show"} {routineRows.length}{" "}
                {routineRows.length === 1 ? "department" : "departments"} you hold
              </Button>
              <Collapse in={showRoutine} unmountOnExit>
                <Table size="small" sx={{ mt: 1 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Department</TableCell>
                      <TableCell>Edited by</TableCell>
                      <TableCell>You can edit</TableCell>
                      {myHoldings.length > 0 && <TableCell />}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {routineRows.map((row) => (
                      <DepartmentRow
                        key={row.code}
                        row={row}
                        busy={busy}
                        onHandBack={
                          myHoldings.length > 0
                            ? () => void openHandback(row.code)
                            : undefined
                        }
                      />
                    ))}
                  </TableBody>
                </Table>
              </Collapse>
            </>
          )}

          {(ownership?.departments ?? []).length === 0 && !loading && (
            <Typography variant="body2" color="text.secondary">
              No departments to show. Add positions with a department code first.
            </Typography>
          )}

          {/* Under the table, not above it: the bulk verb only makes sense once
              you have seen the rows it applies to. Same dialog as a single
              handback, in its "everything" form — which is the one the server
              refuses outright when there is unpublished work. */}
          {myHoldings.length > 1 && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <Button
                size="small"
                disabled={busy}
                startIcon={<AssignmentReturnOutlinedIcon />}
                onClick={() => void openHandback(null)}
              >
                Hand all {myHoldings.length} back
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {delegations.length > 0 && (
        <>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1.5 }}>
            Delegations
          </Typography>

          {delegations.map((delegation) => (
            <Box
              key={delegation.id}
              ref={(node: HTMLDivElement | null) => {
                if (delegation.id === anchoredId) anchorRef.current = node;
              }}
              sx={
                delegation.id === anchoredId
                  ? {
                      borderRadius: 2,
                      outline: "2px solid",
                      outlineColor: "primary.main",
                      outlineOffset: 2,
                    }
                  : undefined
              }
            >
            <DelegationCard
              delegation={delegation}
              // Advisory, never a lock — an offline-capable desktop client
              // cannot hold a pessimistic lock honestly — but it is the
              // difference between withdrawing a delegation and stranding
              // somebody's afternoon.
              presence={presenceByUser.get(delegation.delegateUserId) ?? null}
              isOwner={isOwner}
              busy={busy}
              // Widening goes straight through; narrowing asks. See
              // `handleSetCanEdit`.
              onMakeViewOnly={setMakingViewOnly}
              onLetThemEdit={(target) => void handleSetCanEdit(target, true)}
              onWithdraw={(target) => {
                setRevoking(target);
                setUnsynced(null);
                setRevokeReason("");
              }}
              onReopen={(delegationId, code) => void handleReopen(delegationId, code)}
              onReopenAll={(target) => void handleReopenFor(target)}
              onDownload={(target) => void handlePreviewPull(target)}
            />
            </Box>
          ))}

          {/* Somebody in the plan who is not a delegate — the owner on another
              machine, or an administrator under a lease. There is no card to
              fold them into and dropping them silently would lose the one
              question the old presence list answered. */}
          {unmatchedActivity.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Also in this plan right now:{" "}
              {unmatchedActivity
                .map((entry) => `${entry.email} (seen ${formatWhen(entry.seenAt)})`)
                .join(", ")}
            </Typography>
          )}
        </>
      )}

      {/* Nothing shared yet. The button in the header is easy to miss on a page
          that is otherwise a wall of departments, so the state that has nothing
          to show carries the invitation instead. */}
      {isOwner && delegations.length === 0 && !loading && (
        <Paper
          variant="outlined"
          sx={{
            maxWidth: 560,
            width: "100%",
            p: 4,
            mt: 1,
            mx: "auto",
            textAlign: "center",
            borderRadius: 3,
          }}
        >
          <GroupsOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 1 }} />
          <Typography variant="h6" gutterBottom>
            Nobody is helping with this plan yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Give a colleague one or more departments and they can budget them on
            their own machine. You keep everything else, you can see what they have
            done, and you can take a department back at any time.
          </Typography>
          <Button variant="contained" disabled={busy} onClick={() => setGrantOpen(true)}>
            Delegate departments
          </Button>
        </Paper>
      )}

      <GrantDelegationDialog
        open={grantOpen}
        busy={busy}
        departments={departments}
        candidates={candidates}
        candidatesLoading={candidatesLoading}
        // Estate administrators are hidden from hotels: their route to write
        // access is a support lease, not a department somebody granted them.
        showAdministrators={adminTools.visible}
        overlap={overlap}
        onSearch={(query) => void searchCandidates(query)}
        onSubmit={(body) => void handleGrant(body)}
        onClose={() => {
          setGrantOpen(false);
          setOverlap(null);
        }}
      />

      <Dialog
        open={revoking !== null}
        onClose={busy ? undefined : () => setRevoking(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Withdraw delegation</DialogTitle>
        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            {revoking?.delegateEmail} will lose the ability to edit{" "}
            {revoking?.effectiveDepartments.join(", ")}. You will be able to edit
            those departments again.
          </DialogContentText>

          {unsynced && (
            // The whole point of presence reporting. Say plainly that the work
            // survives, because "it is not lost" is the question the owner is
            // actually asking.
            <Alert severity="warning" sx={{ mb: 2 }}>
              <AlertTitle>They have unpublished work</AlertTitle>
              <Typography variant="body2">
                {unsynced.delegateEmail} has {unsynced.dirtyEntities} unpublished
                changes in {unsynced.departments.join(", ")}
                {unsynced.lastSeenAt
                  ? `, last seen ${new Date(unsynced.lastSeenAt).toLocaleString()}`
                  : ""}
                .
              </Typography>
              <Typography variant="body2" sx={{ mt: 1 }}>
                Their work is <strong>not lost</strong> — it stays on their
                machine. But they will not be able to publish it unless you
                delegate to them again, and if you do, their copy will replace
                anything you change in the meantime.
              </Typography>
            </Alert>
          )}

          <TextField
            fullWidth
            required
            label="Reason"
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            helperText="Recorded on the audit trail and shown to them."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRevoking(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy || revokeReason.trim().length < 3}
            onClick={() => void handleRevoke(unsynced !== null)}
          >
            {unsynced ? "Withdraw anyway" : "Withdraw"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={makingViewOnly !== null}
        onClose={busy ? undefined : () => setMakingViewOnly(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Make this view only</DialogTitle>
        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            {makingViewOnly?.delegateEmail} will still see{" "}
            {makingViewOnly?.effectiveDepartments.join(", ") || "these departments"},
            and will stop being able to change or publish them. You get them back
            to edit yourself.
          </DialogContentText>
          {/* Narrowing bumps the delegation's generation server-side, which
              freezes rows the delegate has not published. Same promise as a
              withdrawal, and the same reason for making it explicitly. */}
          <Alert severity="info">
            Anything they have not published stays on their machine and is{" "}
            <strong>not lost</strong>. If you let them edit again, it publishes as
            normal.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMakingViewOnly(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={busy}
            onClick={() =>
              makingViewOnly ? void handleSetCanEdit(makingViewOnly, false) : undefined
            }
          >
            Make view only
          </Button>
        </DialogActions>
      </Dialog>

      <HandbackDialog
        open={handback !== null}
        busy={busy}
        department={handback?.department ?? null}
        departments={handback?.departments ?? []}
        stranded={handback?.stranded ?? {}}
        pendingTotal={handback?.pendingTotal ?? 0}
        publishResult={handbackPublish}
        note={handbackNote}
        onNoteChange={setHandbackNote}
        onPublishThenHandBack={() => void handlePublishThenHandBack()}
        onHandBackAnyway={() => void handleHandBackAnyway()}
        onClose={() => {
          setHandback(null);
          setHandbackPublish(null);
          setHandbackNote("");
        }}
      />

      <ReviewDialog
        open={pullReview !== null}
        title={
          pullReview ? `Download ${pullReview.delegateEmail}'s work` : "Download changes"
        }
        direction="pull"
        busy={busy}
        byType={pullReview?.byType ?? {}}
        deletedByType={pullReview?.deletedByType ?? {}}
        byDepartment={pullReview?.byDepartment}
        total={pullReview?.total ?? 0}
        deleted={pullReview?.deleted ?? 0}
        skippedTypes={pullReview?.skippedTypes ?? []}
        reset={pullReview?.reset ?? false}
        collides={pullReview?.collides ?? 0}
        collidingDepartments={pullReview?.collidingDepartments ?? []}
        pendingChanges={pullReview?.pendingChanges ?? 0}
        pendingDepartments={pullReview?.pendingDepartments ?? []}
        // Lead with theirs; the dialog still shows — and says — that the rest of
        // the plan comes too.
        highlightDepartments={pullReview?.forDepartments ?? []}
        onConfirm={() => void handleConfirmPull()}
        onClose={() => setPullReview(null)}
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
    </Box>
  );
}

/**
 * One department, and whether you may edit it.
 *
 * Below the default export and unexported, per the house convention for a
 * presentational fragment used twice in the same file — here, once for the rows
 * that carry information and once inside the disclosure for the rows that do
 * not. When and why a department moved is deliberately absent: that belongs to
 * the delegation it came from, and it is on that card.
 *
 * `onHandBack` is passed only when the viewer holds departments as a delegate,
 * and the button appears only on the rows they can actually write. It replaced a
 * chip whose delete slot rendered a padlock — a control that read as "lock this"
 * and in fact gave the department away.
 */
function DepartmentRow({
  row,
  busy,
  onHandBack,
}: {
  row: DepartmentOwnershipRow;
  busy?: boolean;
  onHandBack?: () => void;
}) {
  const holders = row.assignedTo.filter((holder) => holder.state === "ACTIVE");
  const handedBack = row.assignedTo.filter((holder) => holder.state === "HANDED_BACK");

  return (
    <TableRow>
      <TableCell>{row.code}</TableCell>
      <TableCell>
        {holders.length > 0 ? (
          holders.map((holder) => holder.email).join(", ")
        ) : (
          // Nobody delegated → the owner holds it. That is the whole rule,
          // stated in the one place a user will look for it.
          <Typography variant="body2" color="text.secondary">
            The plan owner
          </Typography>
        )}
        {handedBack.length > 0 && (
          <Chip
            size="small"
            color="info"
            sx={{ ml: holders.length > 0 ? 1 : 0 }}
            label={`handed back by ${handedBack.map((holder) => holder.email).join(", ")}`}
          />
        )}
      </TableCell>
      <TableCell>
        {row.writable ? (
          <Chip size="small" color="success" label="Yes" />
        ) : (
          <Tooltip title={LOCK_REASON[row.reason ?? ""] ?? ""}>
            <Chip size="small" label="No" />
          </Tooltip>
        )}
      </TableCell>
      {onHandBack !== undefined && (
        <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
          {row.writable && (
            <Tooltip title="Tell the owner you are finished with this one. You keep being able to see it, and they can give it back to you in one click.">
              <Button
                size="small"
                disabled={busy}
                startIcon={<AssignmentReturnOutlinedIcon />}
                onClick={onHandBack}
              >
                Hand back
              </Button>
            </Tooltip>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

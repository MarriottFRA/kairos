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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
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
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useSelectedHotel } from "../../store/settings";
import {
  delegatableDepartments as delegatableCall,
  delegationCandidates as candidatesCall,
  departmentOwnership as ownershipCall,
  grantDelegation as grantCall,
  handBack as handBackCall,
  handBackAll as handBackAllCall,
  listDelegations as listCall,
  reopenDepartment as reopenCall,
  revokeDelegation as revokeCall,
} from "../../services/kairosSyncService";
import { syncFailed } from "../../shared/kairosSync/ipc";
import {
  DelegatableDepartment,
  Delegation,
  DelegationCandidate,
  DelegationCreate,
  DepartmentOwnership,
  HandbackUnsyncedContext,
  PartialOverlapContext,
  UnsyncedWorkContext,
} from "../../shared/kairosSync/protocol";
import { LOCK_REASON } from "../../shared/kairosSync/lockReason";
import { useAdminTools } from "../../hooks/useAdminTools";
import GrantDelegationDialog from "../../components/sync/GrantDelegationDialog";

type Toast = { severity: "success" | "error" | "info" | "warning"; message: string } | null;

const INEFFECTIVE_REASON: Record<string, string> = {
  OU_ACCESS_REVOKED: "Their access to this hotel was removed",
  DEPARTMENT_ACCESS_SHRUNK: "Their department access has narrowed",
  EXPIRED: "This delegation has expired",
  NO_OVERLAP: "They have none of these departments",
};

export default function DelegationPage() {
  const ou = useSelectedHotel();
  const [params] = useSearchParams();
  const planId = params.get("plan");
  const adminTools = useAdminTools();

  const [ownership, setOwnership] = useState<DepartmentOwnership | null>(null);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [departments, setDepartments] = useState<DelegatableDepartment[]>([]);
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
  /** Set when a bulk handback was refused because this delegate has dirty rows. */
  const [handbackUnsynced, setHandbackUnsynced] =
    useState<HandbackUnsyncedContext | null>(null);

  const refresh = useCallback(async () => {
    if (!ou || !planId) return;
    setLoading(true);
    const [ownershipResult, listResult, departmentsResult] = await Promise.all([
      ownershipCall(ou, planId),
      listCall(ou, planId),
      delegatableCall(ou, planId),
    ]);
    if (!syncFailed(ownershipResult)) setOwnership(ownershipResult.data);
    if (!syncFailed(listResult)) setDelegations(listResult.data.delegations);
    if (!syncFailed(departmentsResult)) setDepartments(departmentsResult.data.departments);
    setLoading(false);
  }, [ou, planId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const handleHandBack = useCallback(
    async (code: string) => {
      if (!ou || !planId) return;
      setBusy(true);
      const result = await handBackCall(ou, planId, code);
      setBusy(false);
      setToast(
        syncFailed(result)
          ? { severity: "error", message: result.error.message }
          : {
              severity: "success",
              message: `${code} handed back. You can still see it, but not edit it.`,
            }
      );
      await refresh();
    },
    [ou, planId, refresh]
  );

  /**
   * Hand every department back in one go.
   *
   * Unlike the per-department form this checks for unpublished work first, and
   * that difference is deliberate: finishing one of five departments with four
   * still open is routine, but finishing ALL of them is the moment any
   * unpublished work becomes unpublishable — the owner would have to reopen a
   * department for it to go anywhere. So the delegate is told before, not after,
   * and forcing is a second, explicit press.
   *
   * The delegation itself survives either way. This is not a revocation: read
   * access stays and the owner can reopen without re-granting.
   */
  const handleHandBackAll = useCallback(
    async (force: boolean) => {
      if (!ou || !planId) return;
      setBusy(true);
      const result = await handBackAllCall(ou, planId, force);
      setBusy(false);

      if (syncFailed(result)) {
        if (result.error.code === "kairos_handback_with_unsynced_work") {
          setHandbackUnsynced(
            (result.error.context ?? {}) as unknown as HandbackUnsyncedContext
          );
          return;
        }
        setToast({ severity: "error", message: result.error.message });
        return;
      }

      setHandbackUnsynced(null);
      setToast({
        severity: "success",
        message: `${result.data.departments.length} departments handed back. You can still see them.`,
      });
      await refresh();
    },
    [ou, planId, refresh]
  );

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

  const isOwner =
    ownership?.me.relation === "OWNER" || ownership?.me.relation === "ADMIN_LEASE";

  /** Departments I hold as a delegate and could hand back. */
  const myHoldings = useMemo(() => {
    if (isOwner) return [];
    return (ownership?.departments ?? []).filter((row) => row.writable);
  }, [ownership, isOwner]);

  if (!ou || !planId) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          Open this page from the Sync tab so it knows which plan you mean.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <GroupsOutlinedIcon color="primary" />
        <Typography variant="h4" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Delegation
        </Typography>
        {isOwner && (
          <Button variant="contained" onClick={() => setGrantOpen(true)} disabled={busy}>
            Delegate departments
          </Button>
        )}
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Departments you delegate become editable by that person and read-only for
        you until you withdraw.
      </Typography>

      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {ownership && !ownership.structureEditableByMe && isOwner && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Your access has changed</AlertTitle>
          You still own this plan, but you no longer meet the requirements to edit
          its columns, blocks and schemes. You can still edit your own departments.
        </Alert>
      )}

      {myHoldings.length > 0 && (
        <Card variant="outlined" sx={{ borderRadius: 2, mb: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
              Your departments
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Hand a department back when you are finished with it. You keep being
              able to see it, and the owner can give it back to you in one click.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              {myHoldings.map((row) => (
                <Chip
                  key={row.code}
                  label={row.code}
                  onDelete={() => void handleHandBack(row.code)}
                  deleteIcon={<LockOutlinedIcon />}
                  disabled={busy}
                />
              ))}
            </Stack>

            {myHoldings.length > 1 && (
              <Button
                size="small"
                sx={{ mt: 2 }}
                disabled={busy}
                onClick={() => void handleHandBackAll(false)}
              >
                Hand everything back
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card variant="outlined" sx={{ borderRadius: 2, mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            Departments
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Department</TableCell>
                <TableCell>Edited by</TableCell>
                <TableCell>You can edit</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {(ownership?.departments ?? []).map((row) => {
                const holders = row.assignedTo.filter((h) => h.state === "ACTIVE");
                const handedBack = row.assignedTo.filter((h) => h.state === "HANDED_BACK");
                return (
                  <TableRow key={row.code}>
                    <TableCell>{row.code}</TableCell>
                    <TableCell>
                      {holders.length > 0 ? (
                        holders.map((holder) => holder.email).join(", ")
                      ) : (
                        // Nobody delegated → the owner holds it. That is the whole
                        // rule, stated in the one place a user will look for it.
                        <Typography variant="body2" color="text.secondary">
                          The plan owner
                        </Typography>
                      )}
                      {handedBack.length > 0 && (
                        <Chip
                          size="small"
                          sx={{ ml: 1 }}
                          label={`handed back by ${handedBack
                            .map((holder) => holder.email)
                            .join(", ")}`}
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
                    <TableCell align="right">
                      {isOwner &&
                        handedBack.map((holder) => (
                          <Button
                            key={holder.delegationId}
                            size="small"
                            disabled={busy}
                            onClick={() =>
                              void handleReopen(holder.delegationId, row.code)
                            }
                          >
                            Reopen
                          </Button>
                        ))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {(ownership?.departments ?? []).length === 0 && !loading && (
            <Typography variant="body2" color="text.secondary">
              No departments to show. Add positions with a department code first.
            </Typography>
          )}
        </CardContent>
      </Card>

      {delegations.length > 0 && (
        <Card variant="outlined" sx={{ borderRadius: 2 }}>
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
              Delegations
            </Typography>
            <Stack spacing={2}>
              {delegations.map((delegation) => (
                <Box key={delegation.id}>
                  <Stack
                    direction="row"
                    spacing={2}
                    useFlexGap sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                    <Box>
                      <Typography variant="subtitle2">
                        {delegation.delegateEmail}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {delegation.effectiveDepartments.join(", ") || "no departments"}
                        {delegation.canReadPii ? " · can see employee details" : ""}
                        {delegation.canDeleteRows ? " · can delete rows" : ""}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      {!delegation.effective && (
                        // Without this an owner waits indefinitely for a publish
                        // that can never come, because the delegate's access was
                        // changed somewhere else entirely.
                        <Chip
                          size="small"
                          color="warning"
                          label={
                            INEFFECTIVE_REASON[delegation.reason ?? ""] ?? "Not in effect"
                          }
                        />
                      )}
                      {delegation.requestedDepartments.length >
                        delegation.effectiveDepartments.length && (
                        <Tooltip
                          title={`Also recorded, but not in effect: ${delegation.requestedDepartments
                            .filter(
                              (code) => !delegation.effectiveDepartments.includes(code)
                            )
                            .join(", ")}. These start working if their access is widened.`}
                        >
                          <Chip size="small" label="Partial" />
                        </Tooltip>
                      )}
                      {isOwner && (
                        <Button
                          size="small"
                          color="error"
                          disabled={busy}
                          onClick={() => {
                            setRevoking(delegation);
                            setUnsynced(null);
                            setRevokeReason("");
                          }}
                        >
                          Withdraw
                        </Button>
                      )}
                    </Stack>
                  </Stack>
                </Box>
              ))}
            </Stack>
          </CardContent>
        </Card>
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
        open={handbackUnsynced !== null}
        onClose={busy ? undefined : () => setHandbackUnsynced(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>You have unpublished work</DialogTitle>
        <DialogContent dividers>
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>
              {handbackUnsynced?.dirtyEntities} changes have not been published
            </AlertTitle>
            <Typography variant="body2">
              They are in {handbackUnsynced?.departments.join(", ")}. Handing
              everything back removes your ability to publish them — the owner
              would have to give a department back to you first.
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Your work is <strong>not lost</strong> either way. It stays on this
              machine.
            </Typography>
          </Alert>
          <DialogContentText>
            Publish first if you want the owner to see this work. Hand back anyway
            if you have finished and the changes were not meant to go.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHandbackUnsynced(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            disabled={busy}
            onClick={() => void handleHandBackAll(true)}
          >
            Hand back anyway
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
    </Box>
  );
}

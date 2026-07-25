/**
 * Clusters page.
 * -----------------------------------------------------------
 * Create and manage hotel clusters: named CROSS-hotel groups where each
 * member hotel carries a weight (two hotels sharing a person equally → 0.5
 * each). Positions pick a cluster in the Positions grid; each hotel's copy of
 * a shared person is then flexed by that hotel's weight — hours, costs and
 * statistics scale down, headcount never does.
 *
 * Unlike every other tab this page is NOT scoped to the selected hotel — a
 * cluster spans hotels by definition, so the list renders regardless of the
 * top-bar selection. Cluster definitions live in the plaintext store; the
 * assigned-positions view reads the session-locked secure store and degrades
 * to guidance (not an error) while locked.
 */

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import HubIcon from "@mui/icons-material/Hub";
import {
  ClusterPositionRefDto,
  HotelClusterDto,
  HotelClusterInput,
} from "../../shared/hotelClusters/ipc";
import { SECURE_DB_LOCKED } from "../../shared/positions/ipc";
import {
  clusterMembersView,
  deleteCluster,
  listClusters,
  saveCluster,
} from "../../services/hotelClustersService";
import authService, { type Hotel } from "../../services/auth";
import ClusterCard from "../../components/hotelClusters/ClusterCard";
import ClusterDialog from "../../components/hotelClusters/ClusterDialog";
import DeleteClusterDialog from "../../components/hotelClusters/DeleteClusterDialog";
import type { AssignmentsState } from "../../components/hotelClusters/ClusterAssignmentsList";

type Toast = { severity: "success" | "error" | "info"; message: string } | null;

type DialogState = {
  open: boolean;
  cluster: HotelClusterDto | null;
  duplicate: boolean;
};

export default function HotelClusters() {
  const [clusters, setClusters] = useState<HotelClusterDto[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [hotelsFailed, setHotelsFailed] = useState(false);
  const [assignments, setAssignments] = useState<Map<
    string,
    ClusterPositionRefDto[]
  > | null>(null);
  const [assignmentsState, setAssignmentsState] =
    useState<AssignmentsState>("loading");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({
    open: false,
    cluster: null,
    duplicate: false,
  });
  const [deleteTarget, setDeleteTarget] = useState<HotelClusterDto | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  // The assigned-positions view is a second, independently-failing load — a
  // locked secure store must never blank the cluster list itself.
  const loadAssignments = useCallback(async (list: HotelClusterDto[]) => {
    if (list.length === 0) {
      setAssignments(new Map());
      setAssignmentsState("ready");
      return;
    }
    setAssignmentsState("loading");
    try {
      const views = await Promise.all(
        list.map((cluster) =>
          clusterMembersView(cluster.id).then(
            (view) => [cluster.id, view.positions] as const
          )
        )
      );
      setAssignments(new Map(views));
      setAssignmentsState("ready");
    } catch (error) {
      setAssignments(null);
      setAssignmentsState(
        (error as Error).message === SECURE_DB_LOCKED ? "locked" : "error"
      );
    }
  }, []);

  // Extracted so the hotels-failed warning's Retry can re-run it. The hotels
  // list is best-effort but NOT silently so — without it the picker is empty
  // and names render as raw OUs, which deserves an explanation.
  const loadPage = useCallback(
    (isCancelled: () => boolean = () => false) => {
      setLoading(true);
      Promise.all([
        listClusters(),
        authService.getHotels().then(
          (h) => ({ hotels: h, failed: false }),
          () => ({ hotels: [] as Hotel[], failed: true })
        ),
      ])
        .then(([list, hotelResult]) => {
          if (isCancelled()) return;
          setClusters(list);
          setHotels(hotelResult.hotels);
          setHotelsFailed(hotelResult.failed);
          void loadAssignments(list);
        })
        .catch((error) => {
          if (!isCancelled())
            setToast({ severity: "error", message: (error as Error).message });
        })
        .finally(() => {
          if (!isCancelled()) setLoading(false);
        });
    },
    [loadAssignments]
  );

  useEffect(() => {
    let cancelled = false;
    loadPage(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadPage]);

  const hotelByOu = new Map(hotels.map((hotel) => [hotel.ou, hotel]));
  const hotelName = (ou: string) => hotelByOu.get(ou)?.hotel_name ?? ou;

  const openNew = () => setDialog({ open: true, cluster: null, duplicate: false });
  const openEdit = (cluster: HotelClusterDto) =>
    setDialog({ open: true, cluster, duplicate: false });
  const openDuplicate = (cluster: HotelClusterDto) =>
    setDialog({ open: true, cluster, duplicate: true });
  const closeDialog = () => setDialog((d) => ({ ...d, open: false }));

  const handleSave = useCallback(
    async (input: HotelClusterInput) => {
      setSaving(true);
      try {
        const list = await saveCluster(input);
        setClusters(list);
        setDialog({ open: false, cluster: null, duplicate: false });
        setToast({ severity: "success", message: "Cluster saved." });
        void loadAssignments(list);
      } catch (error) {
        setToast({ severity: "error", message: (error as Error).message });
      } finally {
        setSaving(false);
      }
    },
    [loadAssignments]
  );

  const handleDelete = useCallback(
    async (cluster: HotelClusterDto) => {
      setBusy(true);
      try {
        const list = await deleteCluster(cluster.id);
        setClusters(list);
        setDeleteTarget(null);
        setToast({ severity: "success", message: "Cluster deleted." });
        void loadAssignments(list);
      } catch (error) {
        const message = (error as Error).message;
        setToast({
          severity: "error",
          message:
            message === SECURE_DB_LOCKED
              ? "Position data is locked — sign out and back in before deleting a cluster (its assignments must be cleared)."
              : message,
        });
      } finally {
        setBusy(false);
      }
    },
    [loadAssignments]
  );

  const empty = !loading && clusters.length === 0;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <Button variant="contained" startIcon={<AddIcon />} onClick={openNew}>
          New cluster
        </Button>
        {loading && <CircularProgress size={20} />}
      </Stack>

      {hotelsFailed && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={() => loadPage()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load your hotel list — hotel names may appear as codes
          and clusters can&apos;t be created or edited until it loads.
        </Alert>
      )}

      {assignmentsState === "locked" && clusters.length > 0 && (
        <Alert severity="info">
          Position data is locked — sign out and back in to see who is
          assigned to each cluster.
        </Alert>
      )}

      {empty ? (
        <Paper
          variant="outlined"
          sx={{
            alignSelf: "center",
            maxWidth: 560,
            width: "100%",
            p: 4,
            mt: 4,
            textAlign: "center",
            borderRadius: 3,
          }}
        >
          <HubIcon sx={{ fontSize: 48, color: "text.disabled", mb: 1 }} />
          <Typography variant="h6" gutterBottom>
            Share people across hotels
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            A cluster is a group of hotels that share staff. Give each hotel a
            weight — a person split evenly across two hotels is 0.5 + 0.5 —
            then assign positions to the cluster in the Positions grid. Each
            hotel&apos;s position carries that hotel&apos;s weight: hours,
            costs and statistics flex down by it, while headcount stays whole.
            You can keep several clusters (one for HR, one for Finance, …),
            but most properties need just one.
          </Typography>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openNew}>
            New cluster
          </Button>
        </Paper>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {clusters.map((cluster) => (
            <ClusterCard
              key={cluster.id}
              cluster={cluster}
              expanded={expandedId === cluster.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === cluster.id ? null : cluster.id))
              }
              hotelName={hotelName}
              assignments={assignments?.get(cluster.id) ?? null}
              assignmentsState={assignmentsState}
              busy={busy}
              onEdit={openEdit}
              onDuplicate={openDuplicate}
              onDelete={setDeleteTarget}
            />
          ))}
        </Box>
      )}

      <ClusterDialog
        open={dialog.open}
        cluster={dialog.cluster}
        duplicate={dialog.duplicate}
        hotels={hotels}
        existing={clusters}
        assignedCount={
          dialog.cluster
            ? (assignments?.get(dialog.cluster.id)?.length ?? null)
            : null
        }
        hotelsFailed={hotelsFailed}
        saving={saving}
        onClose={closeDialog}
        onSave={handleSave}
      />

      <DeleteClusterDialog
        cluster={deleteTarget}
        assignments={
          deleteTarget ? (assignments?.get(deleteTarget.id) ?? null) : null
        }
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />

      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
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

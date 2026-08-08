/**
 * Estate administration — triage across every hotel.
 * -----------------------------------------------------------
 * Reached from the Support tools card in Settings, never from the navigation.
 * It is not in the nav for the same reason Delegation is not: it is meaningless
 * to most of the people who would see it, and every request on it 403s for them
 * anyway.
 *
 * The four tabs are the four support questions, and each maps to exactly one
 * endpoint rather than being assembled client-side:
 *
 * - **Hotels** — where is Kairos actually being used, and when did each property
 *   last publish anything.
 * - **Plans** — the estate list with the flags support triages on. `ownerIneligible`
 *   is the one that matters: it means somebody owns a plan they can no longer
 *   fully edit, which surfaces to them as columns disappearing rather than as an
 *   error, so it is worth finding before they report it.
 * - **Exports** — every administrator bundle, with the reason given. Deliberately
 *   readable by any administrator and not only its author: a control nobody but
 *   its subject can inspect is not a control.
 * - **Audit** — the append-only trail.
 *
 * Everything here is read-only. The actions that change something — leases,
 * transfer, archive, delete — live on the Sync page beside the plan they act on,
 * because acting on a plan you are not looking at is how the wrong hotel gets
 * locked.
 */

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AdminPanelSettingsOutlinedIcon from "@mui/icons-material/AdminPanelSettingsOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  adminAudit,
  adminDownloads,
  adminHotels,
  adminPlans,
} from "../../services/kairosSyncService";
import { syncFailed } from "../../shared/kairosSync/ipc";
import {
  AdminHotel,
  AdminPlanRow,
  AuditRow,
  SupportDownload,
} from "../../shared/kairosSync/protocol";
import { useAdminTools } from "../../hooks/useAdminTools";
import ScopeTraceDialog from "../../components/sync/ScopeTraceDialog";

type TabKey = "hotels" | "plans" | "downloads" | "audit";

export default function AdminPage() {
  const admin = useAdminTools();
  const [tab, setTab] = useState<TabKey>("plans");

  const [hotels, setHotels] = useState<AdminHotel[]>([]);
  const [plans, setPlans] = useState<AdminPlanRow[]>([]);
  const [downloads, setDownloads] = useState<SupportDownload[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  const [ouFilter, setOuFilter] = useState("");
  const [ineligibleOnly, setIneligibleOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeFor, setScopeFor] = useState<{ userId: number; planId: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    if (!admin.visible) return;
    setLoading(true);
    setError(null);

    const fail = (message: string): void => setError(message);

    /**
     * A table only ever receives an array. The main process unwraps whatever
     * envelope each admin endpoint answers with, so this is the second line
     * rather than the first — but a shape it could not unwrap has to land in
     * the alert above the table, not as a blank screen from the router's error
     * boundary, which loses the tab, the filters and the reason at once.
     */
    const rows = <T,>(value: unknown, set: (next: T[]) => void): void => {
      if (Array.isArray(value)) set(value as T[]);
      else fail("The server answered with a shape this table cannot read.");
    };

    if (tab === "hotels") {
      const result = await adminHotels();
      if (syncFailed(result)) fail(result.error.message);
      else rows(result.data, setHotels);
    } else if (tab === "plans") {
      const result = await adminPlans({
        ou: ouFilter.trim() || null,
        ownerIneligible: ineligibleOnly ? true : null,
        limit: 200,
      });
      if (syncFailed(result)) fail(result.error.message);
      else rows(result.data?.plans, setPlans);
    } else if (tab === "downloads") {
      const result = await adminDownloads({ limit: 200 });
      if (syncFailed(result)) fail(result.error.message);
      else rows(result.data, setDownloads);
    } else {
      const result = await adminAudit({ limit: 200 });
      if (syncFailed(result)) fail(result.error.message);
      else rows(result.data, setAudit);
    }

    setLoading(false);
  }, [admin.visible, tab, ouFilter, ineligibleOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!admin.visible) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          <AlertTitle>Support tools are off</AlertTitle>
          Turn them on under Settings → Support tools. They are only available to
          accounts with administrator access across the estate.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <AdminPanelSettingsOutlinedIcon color="warning" />
        <Typography variant="h4" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Estate administration
        </Typography>
        <Button startIcon={<RefreshIcon />} onClick={() => void refresh()} disabled={loading}>
          Refresh
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Read-only. Leases, ownership transfer, archiving and deletion live on the
        Sync page beside the plan they act on.
      </Typography>

      <Tabs value={tab} onChange={(_event, next) => setTab(next as TabKey)} sx={{ mb: 2 }}>
        <Tab value="plans" label="Plans" />
        <Tab value="hotels" label="Hotels" />
        <Tab value="downloads" label="Exports" />
        <Tab value="audit" label="Audit" />
      </Tabs>

      {loading && <LinearProgress sx={{ mb: 2 }} />}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Card variant="outlined" sx={{ borderRadius: 2, borderStyle: "dashed" }}>
        <CardContent>
          {tab === "plans" && (
            <>
              <Stack direction="row" spacing={2} sx={{ alignItems: "center", mb: 2 }}>
                <TextField
                  size="small"
                  label="Hotel (OU)"
                  value={ouFilter}
                  onChange={(event) => setOuFilter(event.target.value)}
                  sx={{ maxWidth: 200 }}
                />
                <Tooltip title="Plans whose owner no longer meets the bar to own one. They keep their departments but lose the columns-and-blocks editor, which looks like a bug from their side.">
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={ineligibleOnly}
                        onChange={(event) => setIneligibleOnly(event.target.checked)}
                      />
                    }
                    label="Owner no longer eligible"
                  />
                </Tooltip>
              </Stack>

              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Hotel</TableCell>
                    <TableCell>Plan</TableCell>
                    <TableCell>Owner</TableCell>
                    <TableCell align="right">Version</TableCell>
                    <TableCell align="right">Rows</TableCell>
                    <TableCell>State</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {plans.map((plan) => (
                    <TableRow key={plan.id}>
                      <TableCell>{plan.ou}</TableCell>
                      <TableCell>
                        {plan.label}
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: "block" }}
                        >
                          {plan.year}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {plan.ownerEmail ?? `user ${plan.ownerUserId}`}
                        {plan.ownerIneligible && (
                          <Chip
                            size="small"
                            color="warning"
                            sx={{ ml: 1 }}
                            label="not eligible"
                          />
                        )}
                      </TableCell>
                      <TableCell align="right">{plan.version}</TableCell>
                      <TableCell align="right">{plan.entityCount}</TableCell>
                      <TableCell>
                        {plan.state}
                        {plan.leaseHeldBy && (
                          <Chip
                            size="small"
                            sx={{ ml: 1 }}
                            label={`lease · ${plan.leaseHeldBy}`}
                          />
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          onClick={() =>
                            setScopeFor({ userId: plan.ownerUserId, planId: plan.id })
                          }
                        >
                          Why?
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Empty rows={plans.length} loading={loading} what="plans" />
            </>
          )}

          {tab === "hotels" && (
            <>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Hotel</TableCell>
                    <TableCell>Name</TableCell>
                    <TableCell align="right">Plans</TableCell>
                    <TableCell align="right">Rows</TableCell>
                    <TableCell>Last published</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {hotels.map((hotel) => (
                    <TableRow key={hotel.ou}>
                      <TableCell>{hotel.ou}</TableCell>
                      <TableCell>{hotel.name ?? "—"}</TableCell>
                      <TableCell align="right">{hotel.plans}</TableCell>
                      <TableCell align="right">{hotel.entities}</TableCell>
                      <TableCell>{formatWhen(hotel.lastPublishedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Empty rows={hotels.length} loading={loading} what="hotels" />
            </>
          )}

          {tab === "downloads" && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Every plan export any administrator has taken, with the reason
                they gave. Twenty per day, per administrator, across the estate.
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>When</TableCell>
                    <TableCell>Who</TableCell>
                    <TableCell>Plan</TableCell>
                    <TableCell>Personal data</TableCell>
                    <TableCell>Reason</TableCell>
                    <TableCell align="right">Rows</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {downloads.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{formatWhen(row.at)}</TableCell>
                      <TableCell>{row.adminEmail}</TableCell>
                      <TableCell>{row.planId}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          color={row.piiMode === "raw" ? "warning" : "default"}
                          label={row.piiMode}
                        />
                      </TableCell>
                      <TableCell>
                        {row.reason}
                        {row.ticketRef ? ` · ${row.ticketRef}` : ""}
                      </TableCell>
                      <TableCell align="right">{row.rows}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Empty rows={downloads.length} loading={loading} what="exports" />
            </>
          )}

          {tab === "audit" && (
            <>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>When</TableCell>
                    <TableCell>Who</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Hotel</TableCell>
                    <TableCell>Plan</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {audit.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{formatWhen(row.at)}</TableCell>
                      <TableCell>{row.actorEmail ?? "—"}</TableCell>
                      <TableCell>{row.action}</TableCell>
                      <TableCell>{row.ou ?? "—"}</TableCell>
                      <TableCell>{row.planId ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Empty rows={audit.length} loading={loading} what="audit entries" />
            </>
          )}
        </CardContent>
      </Card>

      <ScopeTraceDialog
        open={scopeFor !== null}
        userId={scopeFor?.userId ?? null}
        planId={scopeFor?.planId ?? null}
        onClose={() => setScopeFor(null)}
      />
    </Box>
  );
}

function Empty({
  rows,
  loading,
  what,
}: {
  rows: number;
  loading: boolean;
  what: string;
}) {
  if (rows > 0 || loading) return null;
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
      No {what} to show.
    </Typography>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "—";
  return new Date(parsed).toLocaleString();
}

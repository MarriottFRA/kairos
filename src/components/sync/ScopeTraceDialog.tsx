/**
 * "Why does this account see what it sees?"
 * -----------------------------------------------------------
 * Renders `GET /admin/users/{id}/scope`, which is the resolver explaining
 * itself: the same function that enforces the decision, run with a trace
 * attached. Nothing here re-derives or interprets the rules — a debugger that
 * reimplemented them would eventually explain, confidently, a decision the
 * system did not make.
 *
 * This is the screen that answers questions like "I created this plan, so why
 * am I read-only on it?" in one step instead of by inference from symptoms. The
 * inputs section is the valuable half: access type, OU grants, departments, the
 * personal-data switch, any live lease, and every delegation INCLUDING the dead
 * ones with the reason they are dead. "Anna has no access" is not something
 * anybody can act on; "Anna's OU grant expired on 3 June" is.
 *
 * Values are printed as they arrive rather than being mapped to friendlier
 * words. The audience is an administrator diagnosing an authorization problem,
 * and for them the server's own vocabulary is the useful one.
 */

import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { adminUserScope } from "../../services/kairosSyncService";
import { syncFailed } from "../../shared/kairosSync/ipc";
import { ScopeTrace } from "../../shared/kairosSync/protocol";

export interface ScopeTraceDialogProps {
  open: boolean;
  userId: number | null;
  planId: string | null;
  capability?: string | null;
  onClose: () => void;
}

export default function ScopeTraceDialog({
  open,
  userId,
  planId,
  capability,
  onClose,
}: ScopeTraceDialogProps) {
  const [trace, setTrace] = useState<ScopeTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || userId === null) return;
    let cancelled = false;
    setLoading(true);
    setTrace(null);
    setError(null);

    void adminUserScope(userId, planId, capability ?? null).then((result) => {
      if (cancelled) return;
      if (syncFailed(result)) setError(result.error.message);
      else setTrace(result.data);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open, userId, planId, capability]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Why this access?</DialogTitle>
      <DialogContent dividers>
        {loading && <LinearProgress sx={{ mb: 2 }} />}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {trace && (
          <Stack spacing={3}>
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {trace.email ?? `User ${trace.userId}`}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {trace.planId ? `Plan ${trace.planId}` : "No plan — access overall"}
                {trace.capability ? ` · ${trace.capability}` : ""}
              </Typography>
            </Box>

            <Section title="What the server knows about them">
              <KeyValues values={trace.inputs} />
            </Section>

            <Section title="How it decided">
              {!Array.isArray(trace.steps) || trace.steps.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No steps returned.
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {trace.steps.map((step, index) => (
                    <Stack
                      key={`${step.step}-${index}`}
                      direction="row"
                      spacing={1.5}
                      sx={{ alignItems: "flex-start" }}
                    >
                      <Chip size="small" label={index + 1} sx={{ minWidth: 32 }} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {step.step}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {step.outcome}
                          {step.detail ? ` — ${step.detail}` : ""}
                        </Typography>
                      </Box>
                    </Stack>
                  ))}
                </Stack>
              )}
            </Section>

            <Section title="Outcome">
              <KeyValues values={trace.outcome} />
            </Section>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      <Divider sx={{ mb: 1.5, mt: 0.5 }} />
      {children}
    </Box>
  );
}

/**
 * Print whatever came back, one row per key.
 *
 * Deliberately not a typed renderer: the point of this screen is to show the
 * resolver's own inputs, and a client that only knew how to display the fields
 * it was written against would silently hide the new one that explains the
 * problem.
 */
function KeyValues({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing returned.
      </Typography>
    );
  }
  return (
    <Stack spacing={0.75}>
      {entries.map(([key, value]) => (
        <Stack key={key} direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 600, minWidth: 200, flexShrink: 0 }}
          >
            {key}
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              fontSize: "0.78rem",
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "text.secondary",
              minWidth: 0,
            }}
          >
            {format(value)}
          </Box>
        </Stack>
      ))}
    </Stack>
  );
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

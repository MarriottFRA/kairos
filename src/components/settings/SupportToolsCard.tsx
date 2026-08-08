/**
 * Support tools — the administrator switch.
 * -----------------------------------------------------------
 * Deliberately quiet and deliberately last. It is visible to everybody, because
 * hiding it behind a gesture only an administrator is told about is a secret,
 * and a secret is a worse control than a request the server refuses.
 *
 * Turning it on makes an admin-only request. A 200 unlocks the surface; a 403
 * leaves the switch off with a sentence explaining that this account cannot use
 * it. Nothing about that path can be defeated from the client: every action the
 * switch reveals is authorised again, server-side, on every request. The switch
 * decides what to draw, not what is allowed.
 *
 * It is off by default even for administrators. Somebody working on their own
 * hotel's budget should not have "Delete plan" and "Take over" sitting next to
 * Publish for a whole afternoon.
 */

import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useNavigate } from "react-router-dom";
import { useAdminTools } from "../../hooks/useAdminTools";

export default function SupportToolsCard() {
  const navigate = useNavigate();
  const admin = useAdminTools();
  const [refused, setRefused] = useState(false);

  const onToggle = async (next: boolean): Promise<void> => {
    setRefused(false);
    const applied = await admin.setEnabled(next);
    if (next && !applied) setRefused(true);
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 2, borderStyle: "dashed" }}>
      <CardContent>
        <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 700 }}>
          Administration
        </Typography>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
          Support tools
        </Typography>
        <Divider sx={{ mb: 2 }} />

        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: "flex-start", justifyContent: "space-between" }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              Adds support controls to the Sync page — taking a lease on a plan,
              transferring ownership, archiving and deleting — and an estate view
              of every hotel, plan and audit entry. Only accounts with
              administrator access can turn this on, and every action still has to
              be allowed by the server when it runs.
            </Typography>

            {refused && (
              <Alert severity="info" sx={{ mt: 2 }}>
                Not available for your account. Support tools need administrator
                access across the estate.
              </Alert>
            )}

            {admin.visible && (
              <Button
                size="small"
                variant="outlined"
                color="warning"
                sx={{ mt: 2, textTransform: "none" }}
                onClick={() => navigate("/signed-in-landing/admin")}
              >
                Open estate administration
              </Button>
            )}
          </Box>

          <Stack direction="row" spacing={1} sx={{ alignItems: "center", pt: 0.5 }}>
            {admin.probing && <CircularProgress size={16} />}
            <Switch
              checked={admin.visible}
              disabled={admin.probing}
              onChange={(event) => void onToggle(event.target.checked)}
              slotProps={{ input: { "aria-label": "Enable support tools" } }}
            />
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

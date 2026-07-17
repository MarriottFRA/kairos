import React, { useEffect, useMemo, useState } from "react";
import { Box, Typography, Avatar, Card, CardContent, Divider, Stack, Button, Chip, CircularProgress, Alert, List, ListItem, ListItemText } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import authService, { UserInfo, OUAccess } from "../../services/auth";

interface IpcApi {
  sendIpcRequest: (channel: string, ...args: any[]) => Promise<any>;
}

declare global {
  interface Window {
    ipcApi?: IpcApi;
  }
}

function decodeJWT(token: string): any {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

function extractUser(user: any) {
  if (!user) return { name: "User", email: "" };
  const decoded = user.id_token ? decodeJWT(user.id_token) : null;
  const claims = decoded ?? user.claims ?? user.idTokenClaims ?? user.userinfo ?? user;
  const fullName = claims?.name || user.name;
  const firstName = claims?.given_name;
  const name = firstName ? String(firstName) : (fullName ? String(String(fullName).split(" ")[0]) : "User");
  const email = claims?.email || user.email || "";
  return { name, email };
}

export default function Profile() {
  const theme = useTheme();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [ouAccess, setOuAccess] = useState<OUAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch user info
        const userInfo = await authService.getCurrentUser();
        setUser(userInfo);

        // Fetch OU access
        const access = await authService.getUserOUAccess();
        setOuAccess(access);
      } catch (err: any) {
        console.error('Failed to load profile data:', err);
        setError(err.message || 'Failed to load profile data');
      } finally {
        setLoading(false);
      }
    };
    fetchUserData();
  }, []);

  const email = user?.email || '';
  const initials = email ? email.substring(0, 2).toUpperCase() : 'U';

  if (loading) {
    return (
      <Box sx={{ maxWidth: 900, mx: "auto", display: "flex", justifyContent: "center", p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ maxWidth: 900, mx: "auto", p: 2 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 900, mx: "auto" }}>
      <Card variant="outlined" sx={{ mb: 2, borderRadius: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <CardContent>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ xs: "flex-start", sm: "center" }}>
            <Avatar sx={{ width: 64, height: 64, bgcolor: theme.palette.primary.main, fontWeight: 700 }}>
              {initials}
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                {email}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>User ID: {user?.id}</Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <Chip size="small" color="success" variant="outlined" label="Active User" />
                <Chip size="small" variant="outlined" label="Member since 2025" />
              </Stack>
            </Box>
            <Stack direction="row" spacing={1}>
              <Button variant="contained" disabled>Edit Profile</Button>
              <Button variant="outlined" disabled sx={{ bgcolor: alpha(theme.palette.text.primary, 0.02) }}>
                Change Password
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ mb: 2, borderRadius: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
            Account Details
          </Typography>
          <Divider sx={{ mb: 2 }} />
          <Stack spacing={1.5}>
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>Email</Typography>
              <Typography variant="body1">{email || "—"}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>User ID</Typography>
              <Typography variant="body1">{user?.id || "—"}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>Status</Typography>
              <Typography variant="body1">Active</Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ borderRadius: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
            OU Access
          </Typography>
          <Divider sx={{ mb: 2 }} />
          {ouAccess.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              No OU access configured
            </Typography>
          ) : (
            <List dense>
              {ouAccess.map((access) => (
                <ListItem key={access.id} sx={{ px: 0 }}>
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="body1">{access.ou}</Typography>
                        <Chip
                          size="small"
                          label={access.access_level}
                          color={access.is_active ? "success" : "default"}
                          variant="outlined"
                        />
                      </Stack>
                    }
                    secondary={
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        Granted: {new Date(access.granted_at).toLocaleDateString()}
                        {access.expires_at && ` • Expires: ${new Date(access.expires_at).toLocaleDateString()}`}
                      </Typography>
                    }
                  />
                </ListItem>
              ))}
            </List>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

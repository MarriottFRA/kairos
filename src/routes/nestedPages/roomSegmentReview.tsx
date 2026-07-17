/**
 * Room Segment Review Page
 * ========================
 *
 * Clean, Apple-inspired design for reviewing room segment data.
 * Uses DataGridPremium for efficient data display with adjustment capabilities.
 * Follows the design patterns from MappingReview and COA pages.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  Card,
  Chip,
  IconButton,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Tooltip,
  Stack,
  CircularProgress,
  Fade,
} from "@mui/material";
import {
  DataGridPremium,
  GridColDef,
  GridToolbarContainer,
  GridToolbarColumnsButton,
  GridToolbarFilterButton,
  GridToolbarExport,
  GridToolbarDensitySelector,
  GridToolbarQuickFilter,
  GridRenderCellParams,
} from "@mui/x-data-grid-premium";
import { styled, alpha, keyframes } from "@mui/material/styles";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RefreshIcon from "@mui/icons-material/Refresh";
import SendIcon from "@mui/icons-material/Send";
import { useSettingsStore, useCurrency } from "../../store/settings";

// ────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────

interface SegmentRow {
  id: string;
  revenueAccount: string;
  statAccount: string | null;
  description: string;
  revenue: number;
  stats: number;
  category: string;
}

interface StatsRow {
  id: string;
  account: string;
  description: string;
  value: number;
}

interface PendingAdjustment {
  id: string;
  account: string;
  description: string;
  amount: number;
  type: "revenue" | "stat";
  originalValue: number;
}

// ────────────────────────────────────────────────────────────
// STATIC DATA - accounts with prefixes as stored in staging
// ────────────────────────────────────────────────────────────

const DEPARTMENT = "D0010";

// Room Stats (stat accounts start with A9 in the staging table)
const ROOM_STATS_CONFIG = [
  { statAccount: "A960101", description: "Total AVAILABLE Rooms" },
  { statAccount: "A960102", description: "Total AVAILABLE Rooms (from 960101)" },
  { statAccount: "A960103", description: "Total SOLD Room Nights" },
  { statAccount: "A960001", description: "Total Room Nights (from 960103)" },
  { statAccount: "A960003", description: "Total Available Rooms (from 960101)" },
  { statAccount: "A961662", description: "Total Complimentary Rooms" },
];

// Revenue Segments - accounts stored with A prefix in staging
const SEGMENTS_CONFIG: Array<{ revenueAccount: string; statAccount: string | null; description: string; category: string }> = [
  { revenueAccount: "A361010", statAccount: "A961010", description: "Premium Retail Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361011", statAccount: "A961011", description: "Regular Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361012", statAccount: "A961012", description: "Standard Retail Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361013", statAccount: "A961013", description: "Spec Corp Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361014", statAccount: "A961014", description: "Stay For Breakfast Sun-Thurs", category: "Sun-Thur" },
  { revenueAccount: "A361015", statAccount: "A961015", description: "Oth Disc Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361016", statAccount: "A961016", description: "Adv Purch Sun-Thu", category: "Sun-Thur" },
  { revenueAccount: "A361017", statAccount: "A961017", description: "Wholesalr Sun-Thu", category: "Sun-Thur" },
  { revenueAccount: "A361018", statAccount: "A961018", description: "Packages Sun-Thu", category: "Sun-Thur" },
  { revenueAccount: "A361019", statAccount: "A961019", description: "Leisure Sun-Thu", category: "Sun-Thur" },
  { revenueAccount: "A361020", statAccount: "A961020", description: "Weekend Sun-Thu", category: "Sun-Thur" },
  { revenueAccount: "A361021", statAccount: "A961021", description: "Aaa Sun-Thurs", category: "Sun-Thur" },
  { revenueAccount: "A361026", statAccount: "A961026", description: "Govt / Military Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361027", statAccount: "A961027", description: "Senior Discount Sun-Thurs", category: "Sun-Thur" },
  { revenueAccount: "A361028", statAccount: "A961028", description: "Travel Industry Sun-Thu", category: "Sun-Thur" },
  { revenueAccount: "A361029", statAccount: "A961029", description: "Associate Leisure Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361030", statAccount: "A961030", description: "Echannel Retail Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361031", statAccount: "A961031", description: "Reward Redem/Upgrades Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361032", statAccount: "A961032", description: "Natl Rooms Rev Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361033", statAccount: "A961033", description: "Volume Rms Rev Sun Thurs", category: "Sun-Thur" },
  { revenueAccount: "A361041", statAccount: null, description: "Bonvoy Occ Premium - WD", category: "Sun-Thur" },
  { revenueAccount: "A361318", statAccount: "A961318", description: "Contract Sun-Thur", category: "Sun-Thur" },
  { revenueAccount: "A361334", statAccount: "A961334", description: "Corp Grp Sun-Thur", category: "Groups" },
  { revenueAccount: "A361335", statAccount: "A961335", description: "Assoc Grp Sun-Thur", category: "Groups" },
  { revenueAccount: "A361336", statAccount: "A961336", description: "Other Grp Sun-Thur", category: "Groups" },
  { revenueAccount: "A361337", statAccount: "A961337", description: "Tour Wholesale Grp Sun Thur", category: "Groups" },
  { revenueAccount: "A361338", statAccount: "A961338", description: "Government Grp Sun Thurs", category: "Groups" },
  { revenueAccount: "A361510", statAccount: "A961510", description: "Premium Retail Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361511", statAccount: "A961511", description: "Regular Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361512", statAccount: "A961512", description: "Standard Retail Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361513", statAccount: "A961513", description: "Spec Corp Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361514", statAccount: "A961514", description: "Stay For Breakfast Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361515", statAccount: "A961515", description: "Oth Disc Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361516", statAccount: "A961516", description: "Adv Purch Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361517", statAccount: "A961517", description: "Wholesaler Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361518", statAccount: "A961518", description: "Packages Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361519", statAccount: "A961519", description: "Leisure Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361520", statAccount: "A961520", description: "Weekend Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361521", statAccount: "A961521", description: "Aaa Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361526", statAccount: "A961526", description: "Govt / Military Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361527", statAccount: "A961527", description: "Senior Discount Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361528", statAccount: "A961528", description: "Travel Industry Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361529", statAccount: "A961529", description: "Associate Leisure Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361530", statAccount: "A961530", description: "Echannel Retail Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361531", statAccount: "A961531", description: "Reward Redem/Upgrades Fri-Sat", category: "Fri-Sat" },
  { revenueAccount: "A361533", statAccount: "A961533", description: "Volume Rms Rev Fri Sat", category: "Fri-Sat" },
  { revenueAccount: "A361541", statAccount: null, description: "Bonvoy Occ Premium - WE", category: "Fri-Sat" },
  { revenueAccount: "A361601", statAccount: "A961601", description: "Assoc CMP Sun-Thu", category: "Complimentary" },
  { revenueAccount: "A361602", statAccount: "A961602", description: "Assoc CMP Fri-Sat", category: "Complimentary" },
  { revenueAccount: "A361603", statAccount: "A961603", description: "Corp CMP Sun-Thu", category: "Complimentary" },
  { revenueAccount: "A361604", statAccount: "A961604", description: "Corp CMP Fri-Sat", category: "Complimentary" },
  { revenueAccount: "A361607", statAccount: "A961607", description: "Other CMP Sun-Thu", category: "Complimentary" },
  { revenueAccount: "A361608", statAccount: "A961608", description: "Other Cmp Fri-Sat", category: "Complimentary" },
  { revenueAccount: "A361734", statAccount: "A961734", description: "Corp Grp Fri-Sat", category: "Groups" },
  { revenueAccount: "A361735", statAccount: "A961735", description: "Assoc Grp Fri-Sat", category: "Groups" },
  { revenueAccount: "A361736", statAccount: "A961736", description: "Other Grp Fri-Sat", category: "Groups" },
  { revenueAccount: "A361737", statAccount: "A961737", description: "Tour Wholesales Grp Fri Sat", category: "Groups" },
  { revenueAccount: "A361738", statAccount: "A961738", description: "Government Grp Fri Sat", category: "Groups" },
  { revenueAccount: "A361818", statAccount: "A961818", description: "Contract Fri-Sat", category: "Fri-Sat" },
];

// ────────────────────────────────────────────────────────────
// ANIMATIONS
// ────────────────────────────────────────────────────────────

const slideIn = keyframes`
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
`;

// ────────────────────────────────────────────────────────────
// STYLED COMPONENTS
// ────────────────────────────────────────────────────────────

const PageContainer = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  height: "calc(100vh - 64px)",
  width: "100%",
  background: theme.palette.background.default,
  padding: theme.spacing(3),
  overflow: "hidden",
  boxSizing: "border-box",
}));

const Header = styled(Card)(({ theme }) => ({
  borderRadius: 16,
  background: theme.palette.mode === "dark"
    ? `linear-gradient(135deg, ${alpha("#ffffff", 0.05)} 0%, ${alpha("#6366f1", 0.08)} 100%)`
    : `linear-gradient(135deg, ${alpha("#ffffff", 0.9)} 0%, ${alpha("#6366f1", 0.05)} 100%)`,
  backdropFilter: "blur(20px)",
  border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
  boxShadow: theme.palette.mode === "dark"
    ? `0 8px 32px ${alpha("#000000", 0.3)}`
    : `0 8px 32px ${alpha("#6366f1", 0.08)}`,
  flexShrink: 0,
  marginBottom: theme.spacing(1.5),
  padding: theme.spacing(1.5),
}));

const StatsChip = styled(Chip)(({ theme }) => ({
  fontWeight: 600,
  fontSize: "0.75rem",
  height: 28,
  borderRadius: 8,
}));

const SectionCard = styled(Card)(({ theme }) => ({
  borderRadius: 12,
  overflow: "hidden",
  background: theme.palette.background.paper,
  border: `1px solid ${alpha(theme.palette.divider, 0.08)}`,
  boxShadow: theme.palette.mode === "dark"
    ? "0 4px 12px rgba(0,0,0,0.3)"
    : "0 2px 8px rgba(0,0,0,0.06)",
  animation: `${slideIn} 0.3s ease-out`,
}));

const SectionTitle = styled(Box)(({ theme }) => ({
  padding: theme.spacing(1.5, 2),
  borderBottom: `1px solid ${alpha(theme.palette.divider, 0.08)}`,
  background: theme.palette.mode === "dark"
    ? alpha("#ffffff", 0.02)
    : alpha("#000000", 0.01),
}));

const StyledDataGrid = styled(DataGridPremium)(({ theme }) => ({
  border: "none",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  "& .MuiDataGrid-columnHeaders": {
    backgroundColor: theme.palette.mode === "dark"
      ? alpha("#ffffff", 0.02)
      : alpha("#000000", 0.01),
    borderBottom: `1px solid ${alpha(theme.palette.divider, 0.08)}`,
    minHeight: "40px !important",
    maxHeight: "40px !important",
  },
  "& .MuiDataGrid-columnHeader": {
    fontWeight: 600,
    fontSize: "0.75rem",
    color: theme.palette.text.secondary,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  "& .MuiDataGrid-columnSeparator": { opacity: 0 },
  "& .MuiDataGrid-row": {
    cursor: "default",
    "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.03) },
  },
  // Validation error highlighting
  "& .MuiDataGrid-row.row-error": {
    backgroundColor: alpha(theme.palette.error.main, 0.08),
    "&:hover": { backgroundColor: alpha(theme.palette.error.main, 0.12) },
  },
  "& .MuiDataGrid-row.row-warning": {
    backgroundColor: alpha(theme.palette.warning.main, 0.08),
    "&:hover": { backgroundColor: alpha(theme.palette.warning.main, 0.12) },
  },
  "& .MuiDataGrid-cell": {
    borderBottom: `1px solid ${alpha(theme.palette.divider, 0.06)}`,
    fontSize: "0.8rem",
    padding: "0 12px",
  },
  "& .MuiDataGrid-footerContainer": {
    borderTop: `1px solid ${alpha(theme.palette.divider, 0.08)}`,
    minHeight: 44,
  },
}));

const AdjustmentCard = styled(Card)(({ theme }) => ({
  borderRadius: 12,
  border: `2px solid ${theme.palette.warning.main}`,
  background: theme.palette.mode === "dark"
    ? alpha(theme.palette.warning.main, 0.08)
    : alpha(theme.palette.warning.main, 0.04),
  marginBottom: theme.spacing(2),
  padding: theme.spacing(2),
}));

// ────────────────────────────────────────────────────────────
// CUSTOM TOOLBAR
// ────────────────────────────────────────────────────────────

function CustomToolbar() {
  return (
    <GridToolbarContainer
      sx={{
        p: 1,
        gap: 0.5,
        borderBottom: "1px solid",
        borderColor: (theme) => alpha(theme.palette.divider, 0.08),
        minHeight: 44,
        backgroundColor: (theme) =>
          theme.palette.mode === "dark" ? alpha("#ffffff", 0.01) : alpha("#000000", 0.005),
        "& .MuiButton-root": {
          fontSize: "0.75rem",
          fontWeight: 500,
          textTransform: "none",
          borderRadius: 1,
          px: 1,
          color: "text.secondary",
        },
      }}
    >
      <GridToolbarColumnsButton />
      <GridToolbarFilterButton />
      <GridToolbarDensitySelector />
      <GridToolbarExport
        csvOptions={{ fileName: `room-segments-${new Date().toISOString().split("T")[0]}`, utf8WithBom: true }}
        printOptions={{ hideFooter: true, hideToolbar: true }}
      />
      <Box sx={{ flex: 1 }} />
      <GridToolbarQuickFilter
        debounceMs={300}
        sx={{
          width: { xs: 160, sm: 200 },
          "& .MuiOutlinedInput-root": {
            borderRadius: 1.5,
            height: 30,
            fontSize: "0.8rem",
            backgroundColor: (theme) => alpha(theme.palette.background.default, 0.5),
          },
        }}
      />
    </GridToolbarContainer>
  );
}

// ────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────

export default function RoomSegmentReview() {
  const selectedHotelOu = useSettingsStore((s) => s.selectedHotelOu);
  const includeDetailBreakdown = useSettingsStore((s) => s.includeDetailBreakdown);
  const userCurrency = useCurrency();

  // State
  const [loading, setLoading] = useState(false);
  const [periodCombo, setPeriodCombo] = useState<string | null>(null);
  const [rows, setRows] = useState<SegmentRow[]>([]);
  const [statsRows, setStatsRows] = useState<StatsRow[]>([]);
  const [pendingAdjustments, setPendingAdjustments] = useState<PendingAdjustment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogData, setDialogData] = useState<{
    account: string;
    description: string;
    currentValue: number;
    type: "revenue" | "stat";
  } | null>(null);
  const [adjustmentValue, setAdjustmentValue] = useState("");

  // Formatters - no currency symbol as requested
  const numberFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const intFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  // ────────────────────────────────────────────────────────────
  // DATA FETCHING
  // ────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!selectedHotelOu) return;

    setLoading(true);
    try {
      // Get latest import session for period
      const sessionResponse = await window.ipcApi?.sendIpcRequest("db:get-latest-import-session", { ou: selectedHotelOu });

      let currentPeriod: string | null = null;
      if (sessionResponse?.success && sessionResponse?.data) {
        const session = sessionResponse.data as { year: number; month: number };
        // Period format is YYYY-MM (e.g., "2024-01")
        currentPeriod = `${session.year}-${String(session.month).padStart(2, "0")}`;
        setPeriodCombo(currentPeriod);
      }

      // Fetch staging data
      const response = await window.ipcApi?.sendIpcRequest("db:get-staging-data", { ou: selectedHotelOu });

      if (response?.success && response?.data) {
        const data = JSON.parse(response.data as string);

        // Build lookup map - key by account
        // Stats are now stored in the amount column (identified by stat account codes)
        const amountByAccount = new Map<string, number>();

        data.forEach((row: any) => {
          // Filter by department
          if (row.department === DEPARTMENT) {
            const account = row.account || "";
            amountByAccount.set(account, (amountByAccount.get(account) || 0) + (row.amount || 0));
          }
        });

        // Update stats rows - stats values are now in the amount column
        const newStatsRows: StatsRow[] = ROOM_STATS_CONFIG.map((stat) => ({
          id: stat.statAccount,
          account: stat.statAccount,
          description: stat.description,
          value: amountByAccount.get(stat.statAccount) || 0,
        }));
        setStatsRows(newStatsRows);

        // Update segment rows - stats come from amount column for stat accounts
        const newRows: SegmentRow[] = SEGMENTS_CONFIG.map((seg) => ({
          id: seg.revenueAccount,
          revenueAccount: seg.revenueAccount,
          statAccount: seg.statAccount,
          description: seg.description,
          revenue: amountByAccount.get(seg.revenueAccount) || 0,
          stats: seg.statAccount ? (amountByAccount.get(seg.statAccount) || 0) : 0,
          category: seg.category,
        }));
        setRows(newRows);
      }
    } catch (error) {
      console.error("Error fetching room segment data:", error);
    } finally {
      setLoading(false);
    }
  }, [selectedHotelOu]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ────────────────────────────────────────────────────────────
  // ADJUSTMENT HANDLERS
  // ────────────────────────────────────────────────────────────

  const openAdjustmentDialog = (account: string, description: string, currentValue: number, type: "revenue" | "stat") => {
    setDialogData({ account, description, currentValue, type });
    setAdjustmentValue("");
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setDialogData(null);
    setAdjustmentValue("");
  };

  const addAdjustment = () => {
    if (!dialogData) return;
    const numValue = parseFloat(adjustmentValue);
    if (isNaN(numValue) || numValue === 0) return;

    const adjustment: PendingAdjustment = {
      id: `adj_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      account: dialogData.account,
      description: dialogData.description,
      amount: numValue,
      type: dialogData.type,
      originalValue: dialogData.currentValue,
    };

    setPendingAdjustments((prev) => [...prev, adjustment]);
    closeDialog();
  };

  const removeAdjustment = (id: string) => {
    setPendingAdjustments((prev) => prev.filter((adj) => adj.id !== id));
  };

  const submitAdjustments = async () => {
    if (pendingAdjustments.length === 0 || !selectedHotelOu || !periodCombo) return;

    setSubmitting(true);
    try {
      // Parse period (format: YYYY-MM)
      const [yearStr, monthStr] = periodCombo.split("-");
      const year = parseInt(yearStr);
      const month = parseInt(monthStr);

      const stagingEntries = pendingAdjustments.map((adj) => {
        // Revenue: increase = negative (credit), Stats: stored as positive in amount
        const finalAmount = adj.type === "revenue" ? -adj.amount : adj.amount;

        return {
          dep_acc_combo_id: `${DEPARTMENT}_${adj.account}`,
          month,
          year,
          period_combo: periodCombo,
          scenario: "ACT",
          amount: finalAmount,
          currency: userCurrency,
          ou: selectedHotelOu,
          department: DEPARTMENT,
          account: adj.account,
          version: "MAIN",
          source_account: `MANUAL_ADJ_${adj.account}`,
          source_department: `MANUAL_ADJ_${DEPARTMENT}`,
          source_description: `Manual adjustment: ${adj.description}`,
          mapping_status: "mapped",
          import_batch_id: `ROOM_SEG_REVIEW_${new Date().toISOString()}`,
        };
      });

      const response = await window.ipcApi?.sendIpcRequest("db:insert-manual-adjustments", { adjustments: stagingEntries });

      if (response?.success) {
        setSubmitSuccess(true);
        setPendingAdjustments([]);
        await fetchData();
        setTimeout(() => setSubmitSuccess(false), 3000);
      }
    } catch (error) {
      console.error("Error submitting adjustments:", error);
    } finally {
      setSubmitting(false);
    }
  };

  // ────────────────────────────────────────────────────────────
  // COLUMNS
  // ────────────────────────────────────────────────────────────

  const segmentColumns: GridColDef<SegmentRow>[] = useMemo(
    () => [
      {
        field: "revenueAccount",
        headerName: "Rev Acct",
        width: 90,
        renderCell: (params: GridRenderCellParams) => (
          <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem" color="text.secondary">
            {params.value?.replace("A", "")}
          </Typography>
        ),
      },
      {
        field: "statAccount",
        headerName: "Stat Acct",
        width: 85,
        renderCell: (params: GridRenderCellParams) => (
          <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem" color="text.secondary">
            {params.value?.replace("A", "") || "-"}
          </Typography>
        ),
      },
      { field: "description", headerName: "Description", flex: 1, minWidth: 180 },
      { field: "category", headerName: "Category", width: 200 },
      {
        field: "revenue",
        headerName: "Revenue",
        width: 240,
        type: "number",
        renderCell: (params: GridRenderCellParams) => (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, width: "100%" }}>
            <Typography
              variant="body2"
              fontFamily="monospace"
              fontSize="0.8rem"
              color={params.value < 0 ? "error.main" : "text.primary"}
              sx={{ flex: 1, textAlign: "right" }}
            >
              {numberFormatter.format(params.value || 0)}
            </Typography>
            <Tooltip title="Add revenue adjustment">
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  openAdjustmentDialog(params.row.revenueAccount, params.row.description, params.value || 0, "revenue");
                }}
                sx={{ p: 0.25, opacity: 0.5, "&:hover": { opacity: 1 } }}
              >
                <AddCircleOutlineIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
        ),
      },
      {
        field: "stats",
        headerName: "Stats",
        width: 200,
        type: "number",
        renderCell: (params: GridRenderCellParams) => (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, width: "100%" }}>
            <Typography variant="body2" fontFamily="monospace" fontSize="0.8rem" sx={{ flex: 1, textAlign: "right" }}>
              {intFormatter.format(params.value || 0)}
            </Typography>
            {params.row.statAccount && (
              <Tooltip title="Add stat adjustment">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    openAdjustmentDialog(params.row.statAccount!, params.row.description, params.value || 0, "stat");
                  }}
                  sx={{ p: 0.25, opacity: 0.5, "&:hover": { opacity: 1 } }}
                >
                  <AddCircleOutlineIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        ),
      },
    ],
    [numberFormatter, intFormatter]
  );

  const statsColumns: GridColDef<StatsRow>[] = useMemo(
    () => [
      {
        field: "account",
        headerName: "Account",
        width: 100,
        renderCell: (params: GridRenderCellParams) => (
          <Typography variant="body2" fontFamily="monospace" fontSize="0.8rem">
            {params.value?.replace("A", "")}
          </Typography>
        ),
      },
      { field: "description", headerName: "Description", flex: 1, minWidth: 200 },
      {
        field: "value",
        headerName: "Value",
        width: 120,
        type: "number",
        renderCell: (params: GridRenderCellParams) => (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, width: "100%" }}>
            <Typography variant="body2" fontFamily="monospace" fontWeight={600} fontSize="0.85rem" sx={{ flex: 1, textAlign: "right" }}>
              {intFormatter.format(params.value || 0)}
            </Typography>
            <Tooltip title="Add adjustment">
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  openAdjustmentDialog(params.row.account, params.row.description, params.value || 0, "stat");
                }}
                sx={{ p: 0.25, opacity: 0.5, "&:hover": { opacity: 1 } }}
              >
                <AddCircleOutlineIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
        ),
      },
    ],
    [intFormatter]
  );

  // ────────────────────────────────────────────────────────────
  // CONSOLIDATED / DETAIL VIEW
  // ────────────────────────────────────────────────────────────

  const displayRows: SegmentRow[] = useMemo(() => {
    if (includeDetailBreakdown) return rows;

    // Aggregate Sun-Thur + Fri-Sat into "Transient"; Groups & Complimentary pass through
    const map = new Map<string, SegmentRow>();
    for (const row of rows) {
      const isTransient = row.category === "Sun-Thur" || row.category === "Fri-Sat";
      const consolidatedCategory = isTransient ? "Transient" : row.category;
      // Strip day-type suffix to get consolidated name
      const consolidatedName = isTransient
        ? row.description
            .replace(/\s+Sun-Thur[s]?$/i, "")
            .replace(/\s+Sun-Thu$/i, "")
            .replace(/\s+Fri-Sat$/i, "")
            .replace(/\s+-\s*W[DE]$/i, "")
        : row.description;
      const key = `${consolidatedCategory}::${consolidatedName}`;

      const existing = map.get(key);
      if (existing) {
        existing.revenue += row.revenue;
        existing.stats += row.stats;
      } else {
        map.set(key, {
          id: key,
          revenueAccount: row.revenueAccount,
          statAccount: row.statAccount,
          description: consolidatedName,
          revenue: row.revenue,
          stats: row.stats,
          category: consolidatedCategory,
        });
      }
    }
    return Array.from(map.values());
  }, [rows, includeDetailBreakdown]);

  // ────────────────────────────────────────────────────────────
  // SUMMARY & VALIDATION CALCULATIONS
  // ────────────────────────────────────────────────────────────

  const { summary, segmentErrors, totalsMismatch } = useMemo(() => {
    const totalRevenue = displayRows.reduce((sum, r) => sum + r.revenue, 0);
    const totalStats = displayRows.reduce((sum, r) => sum + r.stats, 0);

    // Check revenue-to-stats mapping errors (only for rows that have a statAccount)
    const errors = new Set<string>();
    displayRows.forEach((r) => {
      if (r.statAccount) {
        const hasRevenue = r.revenue !== 0;
        const hasStats = r.stats !== 0;
        // Error if one has value but the other doesn't
        if (hasRevenue !== hasStats) {
          errors.add(r.id);
        }
      }
    });

    // Check totals mismatch: sum of segment stats vs Total SOLD Room Nights (A960103)
    const totalSoldRow = statsRows.find((r) => r.account === "A960103");
    const segmentStatsSum = totalStats;
    const mismatch = totalSoldRow ? totalSoldRow.value !== segmentStatsSum : false;

    return {
      summary: { totalRevenue, totalStats, segmentCount: displayRows.length },
      segmentErrors: errors,
      totalsMismatch: mismatch,
    };
  }, [displayRows, statsRows]);

  // ────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      {/* Header */}
      <Header>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={2}>
          <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
            <Chip label={`Dept: ${DEPARTMENT}`} size="small" variant="outlined" />
            {periodCombo && <Chip label={`Period: ${periodCombo}`} size="small" variant="outlined" />}
            {selectedHotelOu && <Chip label={`OU: ${selectedHotelOu}`} size="small" variant="outlined" />}
          </Stack>
          <Stack direction="row" spacing={2} alignItems="center">
            <StatsChip label={`Revenue: ${numberFormatter.format(summary.totalRevenue)}`} color="primary" />
            <StatsChip label={`Room Nights: ${intFormatter.format(summary.totalStats)}`} color="secondary" />
            <Tooltip title="Refresh data">
              <IconButton onClick={fetchData} disabled={loading} size="small">
                {loading ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Header>

      {/* Success Alert */}
      {submitSuccess && (
        <Fade in={submitSuccess}>
          <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mb: 1.5 }} onClose={() => setSubmitSuccess(false)}>
            Adjustments submitted successfully!
          </Alert>
        </Fade>
      )}

      {/* Pending Adjustments */}
      {pendingAdjustments.length > 0 && (
        <AdjustmentCard>
          <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5}>
            <Stack direction="row" alignItems="center" gap={1}>
              <Typography variant="subtitle2" fontWeight={600}>
                Pending Adjustments
              </Typography>
              <Chip label={pendingAdjustments.length} size="small" color="warning" />
            </Stack>
            <Button
              variant="contained"
              color="warning"
              size="small"
              startIcon={<SendIcon />}
              onClick={submitAdjustments}
              disabled={submitting}
              sx={{ textTransform: "none", fontSize: "0.8rem" }}
            >
              {submitting ? "Submitting..." : "Submit All"}
            </Button>
          </Stack>
          <Stack spacing={0.5}>
            {pendingAdjustments.map((adj) => (
              <Stack
                key={adj.id}
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{ py: 0.5, px: 1, borderRadius: 1, bgcolor: "background.paper" }}
              >
                <Stack direction="row" alignItems="center" gap={1}>
                  <Chip label={adj.type === "revenue" ? "Rev" : "Stat"} size="small" color={adj.type === "revenue" ? "primary" : "secondary"} sx={{ height: 20, fontSize: "0.7rem" }} />
                  <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem">
                    {adj.account.replace("A", "")}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" fontSize="0.75rem" noWrap sx={{ maxWidth: 180 }}>
                    {adj.description}
                  </Typography>
                </Stack>
                <Stack direction="row" alignItems="center" gap={1}>
                  <Typography variant="body2" fontWeight={600} fontSize="0.8rem" color={adj.amount >= 0 ? "success.main" : "error.main"}>
                    {adj.amount >= 0 ? "+" : ""}
                    {adj.type === "revenue" ? numberFormatter.format(adj.amount) : intFormatter.format(adj.amount)}
                  </Typography>
                  <IconButton size="small" color="error" onClick={() => removeAdjustment(adj.id)} sx={{ p: 0.25 }}>
                    <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Stack>
              </Stack>
            ))}
          </Stack>
        </AdjustmentCard>
      )}

      {/* Room Stats Section - Compact at top */}
      <SectionCard sx={{ mb: 1.5, flexShrink: 0 }}>
        <SectionTitle>
          <Typography variant="subtitle2" fontWeight={600} color="text.secondary">
            Room Stats
          </Typography>
        </SectionTitle>
        <Box sx={{ height: 250 }}>
          <StyledDataGrid
            rows={statsRows}
            columns={statsColumns}
            loading={loading}
            density="compact"
            disableRowSelectionOnClick
            hideFooter
            disableColumnMenu
            getRowClassName={(params) =>
              totalsMismatch && params.row.account === "A960103" ? "row-warning" : ""
            }
          />
        </Box>
      </SectionCard>

      {/* Revenue Segments Section - Takes remaining space */}
      <SectionCard sx={{ flex: 1, minHeight: 300, display: "flex", flexDirection: "column" }}>
        <SectionTitle>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle2" fontWeight={600} color="text.secondary">
              Revenue Segments ({displayRows.length})
            </Typography>
          </Stack>
        </SectionTitle>
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <StyledDataGrid
            rows={displayRows}
            columns={segmentColumns}
            loading={loading}
            density="compact"
            slots={{ toolbar: CustomToolbar }}
            initialState={{
              pagination: { paginationModel: { pageSize: 50 } },
              sorting: { sortModel: [{ field: "category", sort: "asc" }] },
            }}
            pageSizeOptions={[25, 50, 100]}
            disableRowSelectionOnClick
            getRowClassName={(params) => (segmentErrors.has(params.id as string) ? "row-error" : "")}
          />
        </Box>
      </SectionCard>

      {/* Adjustment Dialog */}
      <Dialog open={dialogOpen} onClose={closeDialog} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          Add {dialogData?.type === "revenue" ? "Revenue" : "Stat"} Adjustment
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="info" sx={{ fontSize: "0.8rem", py: 0.5 }}>
              {dialogData?.type === "revenue"
                ? "Revenue is a credit account. Enter positive to decrease, negative to increase."
                : "Stats are debits. Positive to increase, negative to decrease."}
            </Alert>
            <Box>
              <Typography variant="caption" color="text.secondary">Account</Typography>
              <Typography variant="body2" fontFamily="monospace">{dialogData?.account.replace("A", "")}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">Current Value</Typography>
              <Typography variant="body2" fontWeight={600}>
                {dialogData?.type === "revenue"
                  ? numberFormatter.format(dialogData?.currentValue || 0)
                  : intFormatter.format(dialogData?.currentValue || 0)}
              </Typography>
            </Box>
            <TextField
              label="Adjustment Amount"
              type="number"
              value={adjustmentValue}
              onChange={(e) => setAdjustmentValue(e.target.value)}
              fullWidth
              autoFocus
              size="small"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} size="small">Cancel</Button>
          <Button
            variant="contained"
            onClick={addAdjustment}
            disabled={!adjustmentValue || parseFloat(adjustmentValue) === 0}
            size="small"
          >
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
}

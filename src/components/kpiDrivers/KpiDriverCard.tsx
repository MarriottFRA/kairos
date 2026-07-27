/**
 * KpiDriverCard — one KPI driver rendered as a collapsible accordion: a summary
 * row (label + mode/status chips + actions) always visible, its filter chips and
 * resolved series revealed when expanded. Expansion is controlled by the parent
 * so only one driver is open at a time. Built-ins are read-only (no edit/delete)
 * but can still be recomputed or duplicated into an editable user driver. A stale
 * chip appears when the cache predates the current budget or the definition
 * changed after its last compute.
 */

import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RefreshIcon from "@mui/icons-material/Refresh";
import EditIcon from "@mui/icons-material/Edit";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import { KpiDriverWithSeries } from "../../shared/kpiDrivers/ipc";
import { BucketMeta, bucketName } from "../../shared/budgetImport/ipc";
import KpiSeriesGrid from "./KpiSeriesGrid";

export interface KpiDriverCardProps {
  item: KpiDriverWithSeries;
  /** Whether this card is the currently expanded one. */
  expanded: boolean;
  /** Toggle expansion (parent enforces single-open). */
  onToggle: () => void;
  /** Current import's buckets, so the source chip can name the bucket. */
  buckets?: BucketMeta[];
  busy?: boolean;
  onEdit: (item: KpiDriverWithSeries) => void;
  onDuplicate: (item: KpiDriverWithSeries) => void;
  onDelete: (item: KpiDriverWithSeries) => void;
  onRecalc: (item: KpiDriverWithSeries) => void;
}

export default function KpiDriverCard({
  item,
  expanded,
  onToggle,
  buckets = [],
  busy,
  onEdit,
  onDuplicate,
  onDelete,
  onRecalc,
}: KpiDriverCardProps) {
  const { driver, series } = item;
  const bucketLabel = bucketName(buckets, driver.bucketIndex);

  // Buttons live inside the summary row; stop the click from toggling the panel.
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <Accordion
      variant="outlined"
      expanded={expanded}
      onChange={onToggle}
      disableGutters
      sx={{ "&:before": { display: "none" } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", width: "100%", pr: 1 }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mr: 0.5 }}>
            {driver.label}
          </Typography>
          {driver.isBuiltin && (
            <Chip size="small" label="Built-in" variant="outlined" />
          )}
          <Chip
            size="small"
            color="primary"
            variant="outlined"
            label={
              driver.deptMode === "EXPLICIT"
                ? "Typed department(s)"
                : "Position's department"
            }
          />
          {driver.isStale && (
            <Tooltip title="This driver's values are out of date with the current budget or its definition. Recalculate to refresh.">
              <Chip size="small" color="warning" label="Stale" />
            </Tooltip>
          )}

          <Box sx={{ flexGrow: 1 }} />

          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={act(() => onRecalc(item))}
            disabled={busy}
          >
            Recalculate
          </Button>
          <Button
            size="small"
            startIcon={<ContentCopyIcon />}
            onClick={act(() => onDuplicate(item))}
            disabled={busy}
          >
            Duplicate
          </Button>
          {!driver.isBuiltin && (
            <>
              <Button
                size="small"
                startIcon={<EditIcon />}
                onClick={act(() => onEdit(item))}
                disabled={busy}
              >
                Edit
              </Button>
              <Button
                size="small"
                color="error"
                startIcon={<DeleteOutlineIcon />}
                onClick={act(() => onDelete(item))}
                disabled={busy}
              >
                Delete
              </Button>
            </>
          )}
        </Stack>
      </AccordionSummary>

      <AccordionDetails>
        {driver.description && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 1.5, whiteSpace: "pre-wrap" }}
          >
            {driver.description}
          </Typography>
        )}

        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", mb: 1.5 }}
        >
          {driver.deptMode === "EXPLICIT" &&
            driver.deptPatterns.map((p) => (
              <Chip key={`d-${p}`} size="small" label={`dept ${p}`} />
            ))}
          {driver.accountPrefixes.map((a) => (
            <Chip key={`a-${a}`} size="small" label={`acct ${a}*`} />
          ))}
          <Chip
            size="small"
            variant="outlined"
            label={
              bucketLabel
                ? `bucket ${driver.bucketIndex} — ${bucketLabel}`
                : `bucket ${driver.bucketIndex}`
            }
          />
          {driver.multiplier !== 1 && (
            // The series below is already multiplied, so say so — otherwise the
            // numbers won't reconcile against the accounts listed beside them.
            <Chip
              size="small"
              color="secondary"
              variant="outlined"
              label={`× ${driver.multiplier}`}
            />
          )}
        </Stack>

        {series.length > 0 ? (
          <KpiSeriesGrid series={series} />
        ) : (
          <Typography variant="caption" color="text.secondary">
            No values yet — pull a budget for this hotel, then recalculate.
          </Typography>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

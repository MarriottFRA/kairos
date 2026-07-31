/**
 * ClusterCard — one hotel cluster as a collapsible accordion: the summary row
 * (name + member chips + weight-sum warning + assignment count + actions)
 * always visible, the assigned-positions view revealed when expanded.
 * Expansion is controlled by the parent so only one cluster is open at a time
 * (the KpiDriverCard idiom).
 */

import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import PersonAddAltIcon from "@mui/icons-material/PersonAddAlt";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  ClusterPositionRefDto,
  HotelClusterDto,
} from "../../shared/hotelClusters/ipc";
import { WEIGHT_SUM_TOLERANCE, weightSum } from "./ClusterMembersEditor";
import ClusterAssignmentsList, {
  AssignmentsState,
} from "./ClusterAssignmentsList";

export interface ClusterCardProps {
  cluster: HotelClusterDto;
  expanded: boolean;
  onToggle: () => void;
  /** Resolve a hotel's display name (fall back to the raw OU). */
  hotelName: (ou: string) => string;
  /** Assigned positions (null while loading), plus the failure mode if any. */
  assignments: ClusterPositionRefDto[] | null;
  assignmentsState: AssignmentsState;
  /** Start a cluster position from here: opens the Positions grid at the
   *  cluster's first member hotel with a new row already assigned to it. */
  onAddPosition?: (cluster: HotelClusterDto) => void;
  /** Link a standalone row into an existing cluster-position group. */
  onAdopt?: (position: ClusterPositionRefDto, clusterLinkId: string) => void;
  /** The position id currently being linked, if any. */
  adopting?: string | null;
  busy?: boolean;
  onEdit: (cluster: HotelClusterDto) => void;
  onDuplicate: (cluster: HotelClusterDto) => void;
  onDelete: (cluster: HotelClusterDto) => void;
}

export default function ClusterCard({
  cluster,
  expanded,
  onToggle,
  hotelName,
  assignments,
  assignmentsState,
  onAddPosition,
  onAdopt,
  adopting,
  busy,
  onEdit,
  onDuplicate,
  onDelete,
}: ClusterCardProps) {
  const sum = weightSum(cluster.members);
  const sumOff = Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE;

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
      {/* Rendered as a div, not MUI's default <button>: the summary row holds
          action buttons, and a <button> can't nest inside one. ButtonBase still
          applies role="button" plus Enter/Space handling, so toggling by
          keyboard is unchanged. */}
      <AccordionSummary component="div" expandIcon={<ExpandMoreIcon />}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap", width: "100%", pr: 1 }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mr: 0.5 }}>
            {cluster.name}
          </Typography>
          {cluster.members.map((member) => (
            <Chip
              key={member.ou}
              size="small"
              variant="outlined"
              label={
                <span>
                  {hotelName(member.ou)}{" "}
                  <Box
                    component="span"
                    sx={{ fontFamily: "'IBM Plex Mono', monospace" }}
                  >
                    ×{member.weight.toFixed(2)}
                  </Box>
                </span>
              }
            />
          ))}
          {sumOff && (
            <Tooltip
              title={`Weights don't sum to 1 — assigned people are counted at ${Math.round(
                sum * 100
              )}% of a person across the cluster.`}
            >
              <Chip
                size="small"
                color="warning"
                label={`Σ ${sum.toFixed(2)}`}
                sx={{ fontFamily: "'IBM Plex Mono', monospace" }}
              />
            </Tooltip>
          )}
          {assignments !== null && (
            <Chip
              size="small"
              variant="outlined"
              label={`${assignments.length} position${
                assignments.length === 1 ? "" : "s"
              }`}
            />
          )}

          <Box sx={{ flexGrow: 1 }} />

          {onAddPosition && (
            <Button
              size="small"
              startIcon={<PersonAddAltIcon />}
              onClick={act(() => onAddPosition(cluster))}
              disabled={busy}
            >
              Add position
            </Button>
          )}
          <Button
            size="small"
            startIcon={<ContentCopyIcon />}
            onClick={act(() => onDuplicate(cluster))}
            disabled={busy}
          >
            Duplicate
          </Button>
          <Button
            size="small"
            startIcon={<EditIcon />}
            onClick={act(() => onEdit(cluster))}
            disabled={busy}
          >
            Edit
          </Button>
          <Button
            size="small"
            color="error"
            startIcon={<DeleteOutlineIcon />}
            onClick={act(() => onDelete(cluster))}
            disabled={busy}
          >
            Delete
          </Button>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <ClusterAssignmentsList
          cluster={cluster}
          hotelName={hotelName}
          assignments={assignments}
          state={assignmentsState}
          onAdopt={onAdopt}
          adopting={adopting}
        />
      </AccordionDetails>
    </Accordion>
  );
}

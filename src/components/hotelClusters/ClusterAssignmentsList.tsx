/**
 * ClusterAssignmentsList — who is assigned to a cluster, grouped by member
 * hotel, shown inside the expanded ClusterCard.
 *
 * Identification is deliberately non-personal: Job Title — Department — Count
 * (title names the post, not the person — see the fieldSeed PII notes; this
 * page has no mask toggle so nothing maskable may render here). Positions
 * assigned from a hotel that is NOT a member (stale after a membership edit)
 * gather in a trailing warning group — they resolve to multiplier ×1 until
 * their hotel is added. Reads come from the session-locked secure store, so a
 * locked state renders as guidance, not an error.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  ClusterPositionRefDto,
  HotelClusterDto,
} from "../../shared/hotelClusters/ipc";

export type AssignmentsState = "loading" | "locked" | "error" | "ready";

export interface ClusterAssignmentsListProps {
  cluster: HotelClusterDto;
  hotelName: (ou: string) => string;
  assignments: ClusterPositionRefDto[] | null;
  state: AssignmentsState;
}

function PositionLine({ position }: { position: ClusterPositionRefDto }) {
  const label = [
    position.title?.trim() || "Untitled position",
    position.departmentCode && `Dept ${position.departmentCode}`,
    `Count ${position.headcount}`,
    position.scenarioLabel &&
      `${position.year || ""} ${position.scenarioLabel}`.trim(),
  ]
    .filter(Boolean)
    .join(" — ");
  return (
    <Typography
      variant="body2"
      sx={{ color: position.active ? "text.primary" : "text.disabled" }}
    >
      {label}
      {!position.active && " (inactive)"}
    </Typography>
  );
}

export default function ClusterAssignmentsList({
  cluster,
  hotelName,
  assignments,
  state,
}: ClusterAssignmentsListProps) {
  if (state === "locked") {
    return (
      <Alert severity="info">
        Position data is locked — sign out and back in to see who is assigned
        to this cluster.
      </Alert>
    );
  }
  if (state === "error") {
    return (
      <Alert severity="warning">
        Couldn&apos;t load this cluster&apos;s assigned positions.
      </Alert>
    );
  }
  if (state === "loading" || assignments === null) {
    return (
      <Stack spacing={1}>
        <Skeleton variant="text" width="45%" />
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="text" width="50%" />
      </Stack>
    );
  }

  const memberOus = new Set(cluster.members.map((member) => member.ou));
  const strays = assignments.filter((position) => !memberOus.has(position.ou));
  const total = assignments.length;

  if (total === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No positions assigned yet. Open the Positions grid and pick this
        cluster in the Cluster column.
      </Typography>
    );
  }

  return (
    <Stack spacing={2}>
      {cluster.members.map((member) => {
        const here = assignments.filter(
          (position) => position.ou === member.ou
        );
        return (
          <Box key={member.ou}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="overline" color="text.secondary">
                {hotelName(member.ou)} · {member.ou}
              </Typography>
              <Chip
                size="small"
                variant="outlined"
                label={`×${member.weight.toFixed(2)}`}
                sx={{ fontFamily: "'IBM Plex Mono', monospace" }}
              />
            </Stack>
            {here.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                No positions assigned at this hotel yet.
              </Typography>
            ) : (
              <Stack spacing={0.25} sx={{ pl: 0.5 }}>
                {here.map((position) => (
                  <PositionLine key={position.positionId} position={position} />
                ))}
              </Stack>
            )}
          </Box>
        );
      })}

      {strays.length > 0 && (
        <Box>
          <Tooltip title="These positions keep their assignment but their hotel is not in the cluster, so they get multiplier ×1 until it is added (or they are reassigned).">
            <Typography variant="overline" sx={{ color: "warning.main" }}>
              Not in this cluster&apos;s hotels
            </Typography>
          </Tooltip>
          <Stack spacing={0.25} sx={{ pl: 0.5 }}>
            {strays.map((position) => (
              <Stack
                key={position.positionId}
                direction="row"
                spacing={1}
                sx={{ alignItems: "center" }}
              >
                <Typography variant="caption" color="warning.main">
                  {hotelName(position.ou)}:
                </Typography>
                <PositionLine position={position} />
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

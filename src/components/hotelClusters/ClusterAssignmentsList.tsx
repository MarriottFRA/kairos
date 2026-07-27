/**
 * ClusterAssignmentsList — who is assigned to a cluster, shown inside the
 * expanded ClusterCard.
 *
 * Grouped by PERSON, not by hotel: a cluster position exists once per member
 * hotel but is one person, so it reads as one line naming the hotels that hold
 * it and their weights. That is the whole point of the feature — seeing "HR
 * Director, 3 hotels, 0.4 / 0.3 / 0.3" rather than the same title three times.
 *
 * Rows that carry the assignment but no group are listed separately as
 * "Not linked": either a hotel that was never mirrored, or the pre-feature
 * habit of typing the same person into each hotel by hand. Those get the Link
 * action, which is the only place the app will join two existing rows — it will
 * not guess that on its own (see clusterSync.adoptIntoGroup).
 *
 * Identification stays non-personal: Job Title — Department — Count (title
 * names the post, not the person — see the fieldSeed PII notes; this page has
 * no mask toggle so nothing maskable may render here). Reads come from the
 * session-locked secure store, so a locked state renders as guidance, not an
 * error.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import LinkIcon from "@mui/icons-material/Link";
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
  /** Link a standalone row into an existing group. Omit to hide the action
   *  (e.g. while another adopt is in flight). */
  onAdopt?: (position: ClusterPositionRefDto, clusterLinkId: string) => void;
  /** The position id currently being adopted, if any. */
  adopting?: string | null;
}

/** One person's rows, keyed by the group they share. */
interface PositionGroup {
  linkId: string;
  /** The row that names the group — any member; they are kept in sync. */
  lead: ClusterPositionRefDto;
  rows: ClusterPositionRefDto[];
}

function describe(position: ClusterPositionRefDto): string {
  return [
    position.title?.trim() || "Untitled position",
    position.departmentCode && `Dept ${position.departmentCode}`,
    `Count ${position.headcount}`,
  ]
    .filter(Boolean)
    .join(" — ");
}

function PositionLine({ position }: { position: ClusterPositionRefDto }) {
  const label = [
    describe(position),
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
  onAdopt,
  adopting,
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

  if (assignments.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No positions assigned yet. Open the Positions grid at any member hotel
        and pick this cluster in the Cluster column — the position then appears
        in every hotel below.
      </Typography>
    );
  }

  const memberOus = new Set(cluster.members.map((member) => member.ou));
  const weightOf = new Map(
    cluster.members.map((member) => [member.ou, member.weight])
  );

  const groups = new Map<string, PositionGroup>();
  const unlinked: ClusterPositionRefDto[] = [];
  for (const position of assignments) {
    if (!position.clusterLinkId) {
      unlinked.push(position);
      continue;
    }
    const existing = groups.get(position.clusterLinkId);
    if (existing) {
      existing.rows.push(position);
    } else {
      groups.set(position.clusterLinkId, {
        linkId: position.clusterLinkId,
        lead: position,
        rows: [position],
      });
    }
  }

  const groupList = [...groups.values()];

  return (
    <Stack spacing={2}>
      {groupList.length > 0 && (
        <Box>
          <Typography variant="overline" color="text.secondary">
            Cluster positions
          </Typography>
          <Stack spacing={1.25} sx={{ pl: 0.5 }}>
            {groupList.map((group) => {
              const held = new Set(group.rows.map((row) => row.ou));
              const missing = [...memberOus].filter((ou) => !held.has(ou));
              return (
                <Box key={group.linkId}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: "center", flexWrap: "wrap" }}
                  >
                    <Tooltip title="One person held by several hotels — editing this position in any of them updates all of them.">
                      <LinkIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                    </Tooltip>
                    <PositionLine position={group.lead} />
                  </Stack>
                  <Stack
                    direction="row"
                    spacing={0.5}
                    sx={{ pl: 3, pt: 0.25, flexWrap: "wrap", gap: 0.5 }}
                  >
                    {group.rows.map((row) => (
                      <Chip
                        key={row.positionId}
                        size="small"
                        variant="outlined"
                        label={`${hotelName(row.ou)} ×${(
                          weightOf.get(row.ou) ?? row.effectiveWeight
                        ).toFixed(2)}`}
                      />
                    ))}
                    {missing.map((ou) => (
                      <Tooltip
                        key={ou}
                        title="This member hotel has no copy of this position — it will be created the next time the position is saved."
                      >
                        <Chip
                          size="small"
                          variant="outlined"
                          color="warning"
                          label={`${hotelName(ou)} — missing`}
                        />
                      </Tooltip>
                    ))}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </Box>
      )}

      {unlinked.length > 0 && (
        <Box>
          <Tooltip title="These carry the cluster assignment but are not part of a shared position, so edits do not travel between hotels. Link one into an existing cluster position to join them up.">
            <Typography variant="overline" color="text.secondary">
              Not linked
            </Typography>
          </Tooltip>
          <Stack spacing={0.5} sx={{ pl: 0.5 }}>
            {unlinked.map((position) => {
              // Only offer a group this hotel does not already hold — linking a
              // second row of the same hotel into one group would create the
              // duplicate this action exists to fix.
              const candidates = groupList.filter(
                (group) => !group.rows.some((row) => row.ou === position.ou)
              );
              const match = candidates.find(
                (group) =>
                  (group.lead.title ?? "").trim().toLowerCase() ===
                  (position.title ?? "").trim().toLowerCase()
              );
              const target = match ?? candidates[0];
              return (
                <Stack
                  key={position.positionId}
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", flexWrap: "wrap" }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {hotelName(position.ou)}:
                  </Typography>
                  <PositionLine position={position} />
                  {!memberOus.has(position.ou) && (
                    <Tooltip title="This hotel is not in the cluster, so the position gets multiplier ×1 until it is added (or the position is reassigned).">
                      <Chip size="small" color="warning" label="not a member" />
                    </Tooltip>
                  )}
                  {onAdopt && target && memberOus.has(position.ou) && (
                    <Tooltip
                      title={`Link into “${
                        target.lead.title?.trim() || "the cluster position"
                      }” — this row joins that shared position and takes its values.`}
                    >
                      <span>
                        <Button
                          size="small"
                          startIcon={<LinkIcon />}
                          disabled={adopting === position.positionId}
                          onClick={() => onAdopt(position, target.linkId)}
                        >
                          {adopting === position.positionId
                            ? "Linking…"
                            : "Link into group"}
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                </Stack>
              );
            })}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

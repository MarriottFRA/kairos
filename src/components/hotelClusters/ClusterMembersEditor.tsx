/**
 * ClusterMembersEditor — per-hotel weight rows inside the cluster dialog.
 *
 * One row per selected hotel: name/OU, a 0..1 weight input, and a live "= n%"
 * caption. Until the user touches a weight, every membership change re-splits
 * equally (the last member takes the remainder so the sum is exactly 1); the
 * first manual keystroke reports touched=true to the parent, after which new
 * hotels join at 0 and manual numbers are never clobbered. "Distribute
 * evenly" re-splits AND reports touched=false, so auto-splitting resumes.
 * The sum chip warns — never blocks — when the weights don't sum to 1;
 * per-weight VALIDITY (each weight must be > 0) is a separate gate that does
 * block Save, enforced in ClusterDialog and flagged on the row here.
 */

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import BalanceIcon from "@mui/icons-material/Balance";
import {
  isValidClusterWeight,
  type HotelClusterMember,
} from "../../shared/hotelClusters/ipc";

export const WEIGHT_SUM_TOLERANCE = 0.001;

/** Equal split over n members, rounded to 4 decimals with the last member
 *  absorbing the remainder so the sum is exactly 1. */
export function equalSplit(ous: string[]): HotelClusterMember[] {
  const count = ous.length;
  if (count === 0) return [];
  const share = Math.round((1 / count) * 10000) / 10000;
  return ous.map((ou, index) => ({
    ou,
    weight:
      index === count - 1
        ? Math.round((1 - share * (count - 1)) * 10000) / 10000
        : share,
  }));
}

export function weightSum(members: HotelClusterMember[]): number {
  return members.reduce((sum, member) => sum + (member.weight || 0), 0);
}

export interface ClusterMembersEditorProps {
  members: HotelClusterMember[];
  /** Resolve a hotel's display name (fall back to the raw OU). */
  hotelName: (ou: string) => string;
  onChange: (members: HotelClusterMember[]) => void;
  /** Manual edits report true (parent stops auto re-splitting);
   *  "Distribute evenly" reports false (auto-splitting resumes). */
  onTouched: (touched: boolean) => void;
}

export default function ClusterMembersEditor({
  members,
  hotelName,
  onChange,
  onTouched,
}: ClusterMembersEditorProps) {
  const sum = weightSum(members);
  const sumOk = Math.abs(sum - 1) <= WEIGHT_SUM_TOLERANCE;
  const allValid = members.every((member) => isValidClusterWeight(member.weight));

  const setWeight = (ou: string, raw: string) => {
    onTouched(true);
    // Clamp into [0, 1]; an unparsable entry reads as 0 so the row visibly
    // needs attention rather than silently keeping a stale number.
    const num = Number(raw);
    const weight = Number.isFinite(num) ? Math.min(Math.max(num, 0), 1) : 0;
    onChange(
      members.map((member) =>
        member.ou === ou ? { ...member, weight } : member
      )
    );
  };

  return (
    <Stack spacing={1}>
      {members.map((member) => (
        <Stack
          key={member.ou}
          direction="row"
          spacing={2}
          sx={{ alignItems: "center" }}
        >
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              {hotelName(member.ou)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {member.ou}
            </Typography>
          </Box>
          <TextField
            size="small"
            type="number"
            value={member.weight}
            onChange={(e) => setWeight(member.ou, e.target.value)}
            error={!isValidClusterWeight(member.weight)}
            slotProps={{
              htmlInput: { min: 0, max: 1, step: 0.05 },
              input: {
                sx: { fontFamily: "'IBM Plex Mono', monospace" },
              },
            }}
            sx={{ width: 128, "& .MuiOutlinedInput-root": { height: 36 } }}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ width: 52, textAlign: "right" }}
          >
            = {Math.round((member.weight || 0) * 1000) / 10}%
          </Typography>
        </Stack>
      ))}

      <Stack direction="row" spacing={1} sx={{ alignItems: "center", pt: 0.5 }}>
        <Button
          size="small"
          variant="text"
          startIcon={<BalanceIcon />}
          onClick={() => {
            onTouched(false);
            onChange(equalSplit(members.map((m) => m.ou)));
          }}
        >
          Distribute evenly
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip
          title={
            sumOk
              ? "The weights sum to 1 — one whole person shared across the cluster."
              : `Weights usually sum to 1 (one whole person across the cluster). ` +
                `${sum > 1 ? "Over" : "Under"} 1 ${
                  sum > 1 ? "over" : "under"
                }-counts shared people. ` +
                (allValid
                  ? "Saving is still allowed."
                  : "Fix the highlighted weights (each must be greater than 0) to save.")
          }
        >
          <Chip
            size="small"
            label={`Total ${sum.toFixed(2)}`}
            color={sumOk ? "success" : "warning"}
            variant={sumOk ? "outlined" : "filled"}
            sx={{ fontFamily: "'IBM Plex Mono', monospace" }}
          />
        </Tooltip>
      </Stack>

      {members.length === 1 && (
        <Typography variant="caption" color="text.secondary">
          Single-hotel cluster — assigned positions can override this
          multiplier individually in the Positions grid.
        </Typography>
      )}
    </Stack>
  );
}

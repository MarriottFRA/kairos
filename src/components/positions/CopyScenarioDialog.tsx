/**
 * CopyScenarioDialog — fill an empty scenario from another one instead of
 * retyping it, or fill an empty HOTEL from another hotel's setup.
 *
 * Two situations, one operation. A new budget year starts empty, so last year's
 * scenario is the source; a what-if wants to start from the plan it varies, so
 * this year's other scenario is the source. Positions are stored per scenario
 * and the year lives on the scenario, so both are just "copy scenario A into
 * scenario B" — the source list spans every year and is grouped by year so a
 * same-year sibling reads as a sibling rather than as a year.
 *
 * The copy is a snapshot: fresh position ids, the same lineage_id, fully
 * independent values. Inactive positions come across too — retaining them is
 * what the flag is for.
 *
 * The third situation is the cluster: one hotel's blocks are built and a
 * sibling property needs the same architecture. When the page offers hotel
 * sources (`hotelSources` — only while THIS hotel has no blocks and the user
 * may edit structure), they appear as one more group in the same source list,
 * and picking one switches the operation from "copy positions" to "copy blocks
 * & setup" — blocks, NI/SS schemes, KPI drivers, allocations, custom columns
 * and the budget calendar, never positions.
 *
 * The target must be empty; the backend rejects a merge and the reason is
 * shown here rather than swallowed. Creating a scenario that is already seeded
 * this way lives on the Manage scenarios dialog's "Start from" field.
 */

import { useMemo, useState } from "react";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  ListSubheader,
  MenuItem,
  TextField,
} from "@mui/material";
import { ScenarioDto } from "../../shared/positions/ipc";
import { HotelCopySetupResponse } from "../../shared/hotelCopy/ipc";
import { cloneScenario } from "../../services/scenarioService";
import { copyHotelSetup } from "../../services/hotelCopyService";
import {
  hasScenarioSources,
  renderScenarioSourceValue,
  scenarioSourceItems,
} from "./scenarioSourceOptions";

/** A hotel offered as a blocks-&-setup source. */
export interface HotelSourceOption {
  ou: string;
  name: string;
}

/** Select values must be strings; hotels share the scenario list under a
 *  prefix no scenario id (a UUID) can collide with. */
const HOTEL_VALUE_PREFIX = "hotel:";

export interface CopyScenarioDialogProps {
  open: boolean;
  ou: string | null;
  /** All scenarios for this hotel, across every year. */
  scenarios: ScenarioDto[];
  /** The scenario being copied INTO — the current selection. */
  targetScenarioId: string;
  targetYear: number;
  targetLabel: string;
  /** Hotels whose blocks & setup can be copied in. The page only supplies
   *  these while this hotel has no blocks and the user may edit structure —
   *  an empty list simply hides the group. */
  hotelSources: HotelSourceOption[];
  onClose: () => void;
  /** Copy landed — the page reloads its rows. */
  onCopied: (positions: number) => void;
  /** Setup copy landed — the page reloads blocks, calendar and columns too. */
  onSetupCopied: (result: HotelCopySetupResponse, sourceName: string) => void;
}

export default function CopyScenarioDialog({
  open,
  ou,
  scenarios,
  targetScenarioId,
  targetYear,
  targetLabel,
  hotelSources,
  onClose,
  onCopied,
  onSetupCopied,
}: CopyScenarioDialogProps) {
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceHotelOu = sourceId.startsWith(HOTEL_VALUE_PREFIX)
    ? sourceId.slice(HOTEL_VALUE_PREFIX.length)
    : null;
  const sourceHotel = sourceHotelOu
    ? hotelSources.find((hotel) => hotel.ou === sourceHotelOu) ?? null
    : null;

  // Grouped by year, newest first: the previous year is nearly always what you
  // want and sits directly under the current one, while this year's other
  // scenarios are visibly available for a what-if. Hotels come last — copying
  // another property's setup is the rarer, once-per-hotel act.
  const sourceItems = useMemo(() => {
    const items = scenarioSourceItems(scenarios, {
      excludeId: targetScenarioId,
      currentYear: targetYear,
    });
    if (hotelSources.length > 0) {
      items.push(
        <ListSubheader key="hotel-sources">
          Other hotels — blocks &amp; setup
        </ListSubheader>,
        ...hotelSources.map((hotel) => (
          <MenuItem key={hotel.ou} value={`${HOTEL_VALUE_PREFIX}${hotel.ou}`}>
            {hotel.name}
          </MenuItem>
        ))
      );
    }
    return items;
  }, [scenarios, targetScenarioId, targetYear, hotelSources]);
  const anySources =
    hasScenarioSources(scenarios, targetScenarioId) || hotelSources.length > 0;

  const renderScenarioValue = renderScenarioSourceValue(
    scenarios,
    hotelSources.length > 0
      ? "Choose a year, scenario or hotel"
      : "Choose a year or scenario"
  );
  const renderSourceValue = (value: unknown) => {
    const id = String(value ?? "");
    if (id.startsWith(HOTEL_VALUE_PREFIX)) {
      const hotelOu = id.slice(HOTEL_VALUE_PREFIX.length);
      return hotelSources.find((hotel) => hotel.ou === hotelOu)?.name ?? hotelOu;
    }
    return renderScenarioValue(value);
  };

  const handleCopy = async () => {
    if (!ou || !sourceId) return;
    if (!sourceHotel && !targetScenarioId) return;
    setBusy(true);
    setError(null);
    try {
      if (sourceHotel) {
        const result = await copyHotelSetup(ou, sourceHotel.ou);
        onSetupCopied(result, sourceHotel.name);
      } else {
        const result = await cloneScenario(ou, sourceId, targetScenarioId);
        onCopied(result.positions);
      }
      setSourceId("");
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : sourceHotel
            ? "Failed to copy the hotel's setup"
            : "Failed to copy the scenario"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {sourceHotel
          ? "Copy blocks & setup into this hotel"
          : `Copy positions into ${targetLabel}`}
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {sourceHotel ? (
            <>
              Copies {sourceHotel.name}&apos;s blocks, NI/SS schemes, KPI
              drivers, allocations, custom columns and budget calendar into this
              hotel, so the setup is not rebuilt by hand. Positions are not
              copied, and KPI figures recalculate from this hotel&apos;s own
              budget import.
            </>
          ) : (
            <>
              Every position is copied into {targetYear} — {targetLabel},
              including ones marked inactive. The copies are independent:
              editing them will not change the year or scenario you copied from.
            </>
          )}
        </DialogContentText>

        <TextField
          select
          fullWidth
          size="small"
          label="Copy from"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          disabled={busy || !anySources}
          slotProps={{
            // Shrunk because displayEmpty means the field always shows text.
            inputLabel: { shrink: true },
            select: {
              displayEmpty: true,
              renderValue: renderSourceValue,
            },
          }}
          helperText={
            anySources
              ? undefined
              : "There is no other year, scenario or hotel to copy from yet."
          }
        >
          {sourceItems}
        </TextField>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          startIcon={<ContentCopyIcon />}
          onClick={() => void handleCopy()}
          disabled={busy || !sourceId}
        >
          {sourceHotel ? "Copy blocks & setup" : "Copy positions"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

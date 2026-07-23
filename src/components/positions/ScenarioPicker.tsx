/**
 * ScenarioPicker — planning-scenario selection for the current budget year,
 * with a manage dialog (list / create / rename / delete).
 *
 * Renders as a ContextChip so it is the same control as the hotel and year
 * selectors sitting beside it in the app bar; "Manage scenarios…" is a footer
 * item in that menu rather than a separate icon button, which is what keeps the
 * bar to one shape per selection.
 *
 * The budget year itself is chosen by its own chip (backed by the persisted
 * `budgetYear` setting); this component lists the scenarios of that year,
 * guarantees the default "Planning" scenario exists (the backend creates it on
 * first list), and reports the selection upward so it can persist in
 * `planningScenarioId`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import CheckIcon from "@mui/icons-material/Check";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import LayersIcon from "@mui/icons-material/Layers";
import SettingsIcon from "@mui/icons-material/Settings";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ScenarioDto } from "../../shared/positions/ipc";
import {
  deleteScenario,
  listScenarios,
  saveScenario,
} from "../../services/scenarioService";
import ContextChip from "../ContextChip";

export interface ScenarioPickerProps {
  ou: string | null;
  /** Budget year the scenarios belong to (persisted setting). */
  year: number;
  /** Persisted planning-scenario id ("" = none chosen yet). */
  selectedId: string;
  /** Report a selection so the caller persists it. */
  onSelect: (scenarioId: string) => void;
  onError: (message: string) => void;
}

export default function ScenarioPicker({
  ou,
  year,
  selectedId,
  onSelect,
  onError,
}: ScenarioPickerProps) {
  const [scenarios, setScenarios] = useState<ScenarioDto[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!ou) {
      setScenarios([]);
      return;
    }
    try {
      // Passing the year makes the backend ensure the default "Planning"
      // scenario exists for it.
      setScenarios(await listScenarios(ou, year));
    } catch (error) {
      console.error("Failed to load scenarios:", error);
      onError(error instanceof Error ? error.message : "Failed to load scenarios");
    }
  }, [ou, year, onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const scenariosForYear = useMemo(
    () => scenarios.filter((s) => s.year === year),
    [scenarios, year]
  );

  // Heal the persisted selection: if it doesn't belong to this year's list,
  // fall back to "Planning" (or the first scenario) and persist that instead.
  useEffect(() => {
    if (scenariosForYear.length === 0) return;
    if (scenariosForYear.some((s) => s.id === selectedId)) return;
    const fallback =
      scenariosForYear.find((s) => s.label === "Planning") ?? scenariosForYear[0];
    onSelect(fallback.id);
  }, [scenariosForYear, selectedId, onSelect]);

  const selectedLabel =
    scenariosForYear.find((s) => s.id === selectedId)?.label ?? "Scenario";

  const handleCreate = async () => {
    if (!ou || !newLabel.trim()) return;
    setBusy(true);
    try {
      const created = await saveScenario(ou, { year, label: newLabel.trim() });
      setNewLabel("");
      await reload();
      onSelect(created.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to create scenario");
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (scenario: ScenarioDto) => {
    if (!ou || !renameValue.trim()) return;
    setBusy(true);
    try {
      await saveScenario(ou, {
        id: scenario.id,
        year: scenario.year,
        label: renameValue.trim(),
      });
      setRenamingId(null);
      await reload();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to rename scenario");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (scenario: ScenarioDto) => {
    if (!ou) return;
    setBusy(true);
    try {
      await deleteScenario(ou, scenario.id);
      await reload();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to delete scenario");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ContextChip
        icon={<LayersIcon />}
        label={selectedLabel}
        tooltip="Planning scenario — the what-if version positions are entered against"
        disabled={!ou}
      >
        {(close) => [
          ...scenariosForYear.map((scenario) => (
            <MenuItem
              key={scenario.id}
              selected={scenario.id === selectedId}
              onClick={() => {
                onSelect(scenario.id);
                close();
              }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                {scenario.id === selectedId && <CheckIcon fontSize="small" />}
              </ListItemIcon>
              <ListItemText primary={scenario.label} />
            </MenuItem>
          )),
          <Divider key="divider" />,
          <MenuItem
            key="manage"
            onClick={() => {
              setManageOpen(true);
              close();
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <SettingsIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Manage scenarios…" />
          </MenuItem>,
        ]}
      </ContextChip>

      <Dialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Scenarios — {year}</DialogTitle>
        <DialogContent>
          <List dense>
            {scenariosForYear.map((scenario) => (
              <ListItem
                key={scenario.id}
                secondaryAction={
                  <Stack direction="row" spacing={0.5}>
                    <IconButton
                      size="small"
                      onClick={() => {
                        setRenamingId(scenario.id);
                        setRenameValue(scenario.label);
                      }}
                      disabled={busy}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => void handleDelete(scenario)}
                      disabled={busy || scenariosForYear.length === 1}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                }
              >
                {renamingId === scenario.id ? (
                  <TextField
                    size="small"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleRename(scenario);
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void handleRename(scenario)}
                    autoFocus
                    sx={{ mr: 6 }}
                  />
                ) : (
                  <ListItemText
                    primary={scenario.label}
                    secondary={scenario.id === selectedId ? "Selected" : undefined}
                  />
                )}
              </ListItem>
            ))}
            {scenariosForYear.length === 0 && (
              <Typography variant="body2" sx={{ color: "text.secondary", py: 1 }}>
                No scenarios for {year} yet — create one below.
              </Typography>
            )}
          </List>

          <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: "center" }}>
            <TextField
              size="small"
              label="New scenario"
              placeholder="e.g. Aggressive hiring"
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreate();
              }}
              sx={{ flex: 1 }}
            />
            <Button
              variant="contained"
              disableElevation
              startIcon={<AddIcon />}
              onClick={() => void handleCreate()}
              disabled={busy || !newLabel.trim()}
            >
              Add
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManageOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

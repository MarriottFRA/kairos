/**
 * ReorderBlocksDialog — the user's own left-to-right order for block bands.
 * -----------------------------------------------------------
 * Blocks already carry a sort_order (blocks:reorder mirrors it onto their
 * definitions); this is the control for it. The list is dragged locally and
 * persisted ONCE on Save rather than per move: a committed order refreshes the
 * blocks model, which rebuilds the grid's column set and re-runs the live
 * simulation, and paying that per drag step would make a five-place move cost
 * five rebuilds for four orders nobody asked to see.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import { BlockDto, BlockType } from "../../shared/blocks/ipc";

/** Short type wording, so two blocks sharing a label are still tellable apart.
 *  Deliberately a local copy of BlockDialog's TYPE_SHAPE — six strings, against
 *  importing a 2,000-line dialog for them. */
const TYPE_SHAPE: Record<BlockType, string> = {
  MULTIPLIER: "Multiplier",
  FLAT_MONTHLY: "One amount each month",
  COUNT_RATE: "Count x rate",
  CUSTOM_MONTHLY: "Twelve monthly amounts",
  SOCIAL_SECURITY: "Rate bands",
  POOL_SPREAD: "Shared pot",
};

export interface ReorderBlocksDialogProps {
  open: boolean;
  /** The blocks in their saved order — the list this dialog starts from. */
  blocks: BlockDto[];
  /** Persisting: the Save button spins and the list is frozen. */
  busy: boolean;
  onSave: (orderedIds: string[]) => void;
  onClose: () => void;
}

/** Pure move-one-item — the single operation behind both drag and the arrows. */
function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export default function ReorderBlocksDialog({
  open,
  blocks,
  busy,
  onSave,
  onClose,
}: ReorderBlocksDialogProps) {
  const [order, setOrder] = useState<BlockDto[]>(blocks);
  /** The index currently being carried mid-drag, or null. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Re-seed whenever the dialog opens, and whenever the saved order changes
  // under it (a block added or deleted while this was closed).
  useEffect(() => {
    if (open) {
      setOrder(blocks);
      setDragIndex(null);
    }
  }, [open, blocks]);

  const savedIds = useMemo(() => blocks.map((block) => block.id).join(" "), [blocks]);
  const draftIds = useMemo(() => order.map((block) => block.id).join(" "), [order]);
  const dirty = savedIds !== draftIds;

  const move = (from: number, to: number) => {
    if (busy) return;
    setOrder((current) => moveItem(current, from, to));
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Block order</DialogTitle>
      <DialogContent dividers>
        <DialogContentText sx={{ mb: 1.5, fontSize: "0.8125rem" }}>
          Drag a block, or use the arrows, to set the order its columns appear in
          — left to right in the grid, top to bottom in the Edit position form.
          Only the order moves; the numbers are unchanged.
        </DialogContentText>

        {order.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: "center" }}>
            No blocks yet.
          </Typography>
        ) : (
          <List dense disablePadding sx={{ userSelect: "none" }}>
            {order.map((block, index) => {
              const dragging = dragIndex === index;
              return (
                <ListItem
                  key={block.id}
                  divider
                  draggable={!busy}
                  onDragStart={(event) => {
                    if (busy) return;
                    setDragIndex(index);
                    event.dataTransfer.effectAllowed = "move";
                    // Firefox starts no drag at all without a payload.
                    event.dataTransfer.setData("text/plain", block.id);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    // Reorder as the pointer passes, so the list under the
                    // cursor IS the result — no drop marker to interpret.
                    if (dragIndex === null || dragIndex === index) return;
                    setOrder((current) => moveItem(current, dragIndex, index));
                    setDragIndex(index);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragIndex(null);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  secondaryAction={
                    <Box sx={{ display: "flex", gap: 0.25 }}>
                      <Tooltip title="Move earlier">
                        <span>
                          <IconButton
                            size="small"
                            aria-label={`Move ${block.label} earlier`}
                            disabled={busy || index === 0}
                            onClick={() => move(index, index - 1)}
                          >
                            <ArrowUpwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Move later">
                        <span>
                          <IconButton
                            size="small"
                            edge="end"
                            aria-label={`Move ${block.label} later`}
                            disabled={busy || index === order.length - 1}
                            onClick={() => move(index, index + 1)}
                          >
                            <ArrowDownwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Box>
                  }
                  sx={{
                    cursor: busy ? "default" : "grab",
                    borderRadius: 1,
                    // The carried row fades in place; the gap it appears to
                    // leave is exactly where it would land.
                    opacity: dragging ? 0.45 : 1,
                    bgcolor: dragging ? "action.selected" : "transparent",
                    transition: "background-color 120ms ease",
                    "&:hover": { bgcolor: dragging ? "action.selected" : "action.hover" },
                    "&:active": { cursor: busy ? "default" : "grabbing" },
                  }}
                >
                  <DragIndicatorIcon
                    fontSize="small"
                    sx={{ color: "text.disabled", mr: 1, flexShrink: 0 }}
                  />
                  <Box
                    component="span"
                    sx={{
                      width: 22,
                      flexShrink: 0,
                      mr: 1,
                      color: "text.disabled",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: "0.75rem",
                    }}
                  >
                    {index + 1}
                  </Box>
                  <ListItemText
                    primary={block.label}
                    secondary={TYPE_SHAPE[block.blockType]}
                    slotProps={{
                      primary: { noWrap: true },
                      secondary: { noWrap: true, sx: { fontSize: "0.75rem" } },
                    }}
                    sx={{ pr: 8, my: 0 }}
                  />
                </ListItem>
              );
            })}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={busy || !dirty}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          onClick={() => onSave(order.map((block) => block.id))}
        >
          Save order
        </Button>
      </DialogActions>
    </Dialog>
  );
}

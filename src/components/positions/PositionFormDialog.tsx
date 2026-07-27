/**
 * Edit Position — one row, laid out as a form.
 * -----------------------------------------------------------
 * The grid spreads a position across ~79 catalog columns plus 2..14 per block,
 * so editing or reviewing one person means a lot of horizontal travel. This
 * dialog is the same row turned ninety degrees: catalog sections and blocks as
 * cards in a reflowing grid, month families folded behind their totals, and a
 * review rail that keeps the derived figures on screen while you type.
 *
 * It is an ADDITION, not a replacement — the grid stays fully editable, and both
 * surfaces write through the same path.
 *
 * Three things keep it honest:
 *   - values are read and written through the row's own GridColDef callbacks
 *     (gridValueBridge), so PERCENT scaling, ISO dates, PII masking and the two
 *     auto/override drop rules are inherited rather than re-implemented;
 *   - editability is columnFactory.cellEditable, the same predicate the grid's
 *     isCellEditable calls;
 *   - every commit goes straight to the page's handleRowUpdate, so there is one
 *     write path, one sanitizer, and one save-status dot.
 *
 * Saving is live, per field, exactly as in the grid: there is no Save button,
 * because a buffered draft could not show live FTE / Budget Year / block totals
 * without duplicating the whole derivation pipeline. Undo (Ctrl+Z) replays the
 * previous value through the same path and is the way out of a mistake.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import CloseIcon from "@mui/icons-material/Close";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import LinkIcon from "@mui/icons-material/Link";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import { BlockDto } from "../../shared/blocks/ipc";
import { HotelClusterDto } from "../../shared/hotelClusters/ipc";
import { AccountOption, DepartmentOption } from "../../shared/mappingTables/types";
import { CLUSTER_LINK_ROW_KEY } from "../../shared/positions/clusterSync";
import { FieldCatalog, FieldDef } from "../../shared/positions/fields";
import { BlockResultsById } from "../../shared/positions/liveSim";
import { buildPositionForm, FormCard, matchFormFields } from "../../shared/positions/positionForm";
import { COMPUTES, PositionRow } from "../../shared/positions/rowModel";
import { RowSaveStatus } from "../../services/positionsWriteQueue";
import {
  buildBlockColumns,
  slotPresentation,
} from "./blockColumns";
import {
  blockAccountKey,
  blockFieldKey,
  blockInputSlots,
  blockStatsAccountKey,
} from "../../shared/positions/blockRows";
import { buildColumns, cellEditable, ColumnFactoryContext } from "./columnFactory";
import { displayValue } from "./gridValueBridge";
import { headerPresentation } from "./headerMeta";
import PositionFormField from "./PositionFormField";

/** Read-only figures pinned to the rail, in reading order. */
const REVIEW_KEYS = [
  "headcount",
  "fte",
  "budgetYearBasicSalary",
  "fullYearWage",
  "yearlyManhoursPaid",
  "vacationEstimate",
] as const;

/** Identity line in the header: who this row is, before anything else. */
const IDENTITY_KEYS = ["firstName", "lastName", "title", "deptName"] as const;

const MAX_UNDO = 20;

interface UndoEntry {
  rowId: string;
  /** The row as it was before the edit — replayed wholesale through the same
   *  update path, so the undo is sanitized and diffed like any other edit. */
  before: PositionRow;
  label: string;
}

export interface PositionFormDialogProps {
  /** The LIVE row from page state (looked up by id each render), or null when
   *  closed — so derived values and block totals refresh as you type. */
  row: PositionRow | null;
  catalog: FieldCatalog;
  blocks: BlockDto[];
  blockResults: BlockResultsById | null;
  departments: DepartmentOption[];
  accounts: AccountOption[];
  vacationCostById: ReadonlyMap<string, number>;
  manhoursWorkedById: ReadonlyMap<string, number>;
  fteById: ReadonlyMap<string, number>;
  hotelClusters: HotelClusterDto[];
  currentOu: string | null;
  hotelNames?: ReadonlyMap<string, string>;
  masked: boolean;
  status?: RowSaveStatus;
  /** The cell the user opened from — focused first, so Alt+Enter lands where
   *  they were looking. */
  initialFocusField?: string | null;
  /** Place in the grid's current sort+filter, for the counter and the arrows. */
  index: number;
  count: number;
  /** The page's handleRowUpdate, unchanged. */
  onRowUpdate: (newRow: PositionRow, oldRow: PositionRow) => PositionRow;
  onNavigate: (delta: 1 | -1) => void;
  onEditBlock: (block: BlockDto) => void;
  onClose: () => void;
}

export default function PositionFormDialog({
  row,
  catalog,
  blocks,
  blockResults,
  departments,
  accounts,
  vacationCostById,
  manhoursWorkedById,
  fteById,
  hotelClusters,
  currentOu,
  hotelNames,
  masked,
  status,
  initialFocusField,
  index,
  count,
  onRowUpdate,
  onNavigate,
  onEditBlock,
  onClose,
}: PositionFormDialogProps) {
  // Hold the last row through MUI's exit transition so closing does not flash
  // an empty dialog (same trick as DeleteClusterPositionDialog).
  const lastRow = useRef<PositionRow | null>(row);
  if (row) lastRow.current = row;
  const shown = row ?? lastRow.current;

  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);

  const columns = useMemo(() => {
    const ctx: ColumnFactoryContext = {
      masked,
      numberFormat: new Intl.NumberFormat(),
      departments,
      accounts,
      vacationCostById,
      manhoursWorkedById,
      fteById,
      hotelClusters,
      currentOu,
      hotelNames,
    };
    // Rebuilt from the catalog rather than read off the grid's api: the form
    // must not inherit the user's column reordering or their collapsed-family
    // layout, and it has to work whether or not the grid is mounted.
    const all = [
      ...buildColumns(catalog, ctx),
      ...buildBlockColumns(blocks, {
        numberFormat: ctx.numberFormat,
        accounts,
        blockResults,
      }),
    ];
    return new Map(all.map((column) => [column.field, column]));
  }, [
    catalog,
    blocks,
    blockResults,
    masked,
    departments,
    accounts,
    vacationCostById,
    manhoursWorkedById,
    fteById,
    hotelClusters,
    currentOu,
    hotelNames,
  ]);

  const defs = useMemo(
    () => new Map(catalog.fields.map((def) => [def.key, def])),
    [catalog]
  );
  const maskableKeys = useMemo(
    () => new Set(catalog.fields.filter((def) => def.maskable).map((def) => def.key)),
    [catalog]
  );
  const cards = useMemo(() => buildPositionForm(catalog, blocks), [catalog, blocks]);

  // Block cells have no catalog def, and their headerName is prefixed with the
  // block label ("Pension — Multiplier") because a grid column has no other
  // context. Inside a card already titled "Pension" that reads as a stutter, so
  // the form takes the same short/unit pair the band header uses.
  const blockLabels = useMemo(() => {
    const labels = new Map<string, { short: string; unit: string }>();
    for (const block of blocks) {
      for (const slot of blockInputSlots(block)) {
        labels.set(blockFieldKey(block.costDefId, slot), slotPresentation(block, slot));
      }
      labels.set(blockAccountKey(block.costDefId), { short: "Account", unit: "posts to" });
      labels.set(blockStatsAccountKey(block.costDefId), {
        short: "Stats account",
        unit: "posts to",
      });
    }
    return labels;
  }, [blocks]);
  const matches = useMemo(
    () => (query.trim() ? matchFormFields(catalog, query) : null),
    [catalog, query]
  );

  const editCtx = useMemo(
    () => ({ masked, maskableKeys, hotelClusters, currentOu }),
    [masked, maskableKeys, hotelClusters, currentOu]
  );

  // Two commits can land in one tick (Enter blurs one field and focuses the
  // next), so the second must build on the first rather than on a stale prop.
  const liveRow = useRef<PositionRow | null>(row);
  liveRow.current = row;

  const commit = useCallback(
    (apply: (current: PositionRow) => PositionRow) => {
      const before = liveRow.current;
      if (!before) return;
      const next = apply(before);
      // Identity means the column's own setter dropped the edit — an untouched
      // auto field echoing its derived value back. Nothing to write.
      if (next === before) return;
      const applied = onRowUpdate(next, before);
      liveRow.current = applied;
      if (applied !== before) {
        setUndoStack((stack) =>
          [{ rowId: before.id, before, label: "change" }, ...stack].slice(0, MAX_UNDO)
        );
      }
    },
    [onRowUpdate]
  );

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const [top, ...rest] = stack;
      const current = liveRow.current;
      if (!top || !current || top.rowId !== current.id) return stack;
      // Replayed through the same path, so it is sanitized, diffed and queued
      // exactly like a fresh edit — an undo is just another write.
      liveRow.current = onRowUpdate(top.before, current);
      return rest;
    });
  }, [onRowUpdate]);

  const focusables = useCallback((): HTMLElement[] => {
    const root = bodyRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>("input, textarea, select, [role='combobox']")
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.tabIndex !== -1 &&
        element.offsetParent !== null
    );
  }, []);

  const step = useCallback(
    (delta: 1 | -1) => {
      const list = focusables();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = list[at + delta];
      if (!next) return;
      next.focus();
      if (next instanceof HTMLInputElement) next.select();
      next.scrollIntoView({ block: "nearest" });
    },
    [focusables]
  );

  /** The field key of whatever is focused, for restoring it after a row swap. */
  const focusedField = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    return active?.closest<HTMLElement>("[data-form-field]")?.dataset.formField ?? null;
  }, []);

  const focusField = useCallback((field: string | null | undefined) => {
    if (!field) return false;
    const wrapper = bodyRef.current?.querySelector<HTMLElement>(
      `[data-form-field="${CSS.escape(field)}"]`
    );
    const input = wrapper?.querySelector<HTMLElement>(
      "input:not([disabled]), textarea, [role='combobox']"
    );
    if (!input || input.tabIndex === -1) return false;
    input.focus();
    if (input instanceof HTMLInputElement) input.select();
    input.scrollIntoView({ block: "nearest" });
    return true;
  }, []);

  /** The field to re-focus once the next row has rendered. */
  const pendingFocus = useRef<string | null>(null);

  const navigate = useCallback(
    (delta: 1 | -1) => {
      // Commit whatever is focused first — blur is the commit trigger — then
      // land on the SAME field of the next row, which is what turns "fix merit
      // % on forty positions" into type / Alt+Down / type.
      const field = focusedField();
      (document.activeElement as HTMLElement | null)?.blur();
      pendingFocus.current = field;
      onNavigate(delta);
    },
    [focusedField, onNavigate]
  );

  // Focus on open, and re-focus the same field after stepping to another row.
  useEffect(() => {
    if (!row) return;
    const wanted = pendingFocus.current ?? initialFocusField ?? null;
    pendingFocus.current = null;
    const handle = requestAnimationFrame(() => {
      if (focusField(wanted)) return;
      focusables()[0]?.focus();
    });
    return () => cancelAnimationFrame(handle);
  }, [row?.id, initialFocusField, focusField, focusables, row]);

  // A row that vanishes under the dialog (deleted, filtered out, hotel swapped)
  // leaves stale undo entries pointing at a row nobody can see.
  useEffect(() => {
    setUndoStack((stack) => (stack[0]?.rowId === row?.id ? stack : []));
  }, [row?.id]);

  if (!shown) return null;

  const clusterLink =
    typeof shown[CLUSTER_LINK_ROW_KEY] === "string"
      ? (shown[CLUSTER_LINK_ROW_KEY] as string)
      : "";
  const sharedWith = clusterLink ? peerHotelNames(shown, hotelClusters, currentOu, hotelNames) : [];

  const identity = IDENTITY_KEYS.map((key) => {
    const column = columns.get(key);
    return column ? displayValue(column, shown) : "";
  }).filter(Boolean);

  const renderField = (key: string, dense = false) => {
    const column = columns.get(key);
    if (!column) return null;
    const def = defs.get(key);
    const presentation = def ? headerPresentation(def) : (blockLabels.get(key) ?? null);
    const dimmed = !!matches && !matches.has(key);

    return (
      <Box
        key={key}
        sx={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 120ms" }}
      >
        <PositionFormField
          column={column}
          def={def}
          row={shown}
          label={presentation?.short ?? String(column.headerName ?? key)}
          unit={dense ? null : presentation?.unit}
          hint={
            (def ? headerPresentation(def).hint : null) ??
            (column.description as string | undefined) ??
            null
          }
          editable={cellEditable(shown, column, editCtx)}
          lockNote={lockNoteFor(def, shown, masked)}
          warn={key === "vacationWeightsTotal" && weightsDrift(shown)}
          dense={dense}
          departments={departments}
          accounts={accounts}
          onCommit={commit}
        />
      </Box>
    );
  };

  const renderCard = (card: FormCard) => {
    const cardHidden =
      !!matches &&
      card.kind === "section" &&
      card.nodes.every((node) =>
        node.kind === "field" ? !matches.has(node.key) : !node.keys.some((k) => matches.has(k))
      );

    return (
      <Paper
        key={card.id}
        variant="outlined"
        sx={{
          p: 1.25,
          minWidth: 0,
          opacity: cardHidden ? 0.4 : 1,
          borderColor: card.kind === "block" ? "primary.light" : "divider",
        }}
      >
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ mb: 0.75, minWidth: 0, alignItems: "center" }}
        >
          <Typography
            variant="subtitle2"
            sx={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: card.kind === "block" ? "primary.main" : "text.primary",
            }}
          >
            {card.label || "Row"}
          </Typography>
          {card.block ? (
            <Tooltip title="Edit this block">
              <IconButton size="small" tabIndex={-1} onClick={() => onEditBlock(card.block!)}>
                <SettingsOutlinedIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>
        <Divider sx={{ mb: 1 }} />

        <Stack spacing={0.75}>
          {card.nodes.map((node) => {
            if (node.kind === "field") return renderField(node.key);

            const familyId = `${card.id}:${node.kind === "monthFamily" ? node.vector : "months"}`;
            const open = expanded[familyId] ?? false;
            return (
              <Box key={familyId}>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    {node.kind === "monthFamily" && node.summaryKey ? (
                      renderField(node.summaryKey)
                    ) : (
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        Monthly amounts
                      </Typography>
                    )}
                  </Box>
                  <Tooltip title={open ? "Hide the twelve months" : "Show the twelve months"}>
                    <IconButton
                      size="small"
                      tabIndex={-1}
                      onClick={() =>
                        setExpanded((state) => ({ ...state, [familyId]: !open }))
                      }
                    >
                      <ExpandMoreIcon
                        fontSize="inherit"
                        sx={{
                          transform: open ? "rotate(180deg)" : "none",
                          transition: "transform 120ms",
                        }}
                      />
                    </IconButton>
                  </Tooltip>
                </Stack>
                <Collapse in={open} unmountOnExit>
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "repeat(4, 1fr)",
                      gap: 0.75,
                      pt: 0.75,
                    }}
                  >
                    {node.keys.map((key) => renderField(key, true))}
                  </Box>
                </Collapse>
              </Box>
            );
          })}

          {card.totalKey ? (
            <>
              <Divider sx={{ mt: 0.5 }} />
              <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  Total
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
                >
                  {columns.get(card.totalKey)
                    ? displayValue(columns.get(card.totalKey)!, shown) || "—"
                    : "—"}
                </Typography>
              </Stack>
            </>
          ) : null}
        </Stack>
      </Paper>
    );
  };

  return (
    <Dialog
      open={!!row}
      onClose={onClose}
      maxWidth={false}
      slotProps={{ paper: { sx: { width: "min(1240px, 96vw)", height: "92vh" } } }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          // The commit itself is the focused field's own blur/Enter handler;
          // this only moves on. Autocompletes swallow Enter while their popup
          // is open, so a pick never skips a field.
          if ((event.target as HTMLElement)?.getAttribute("aria-expanded") === "true") return;
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          navigate(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          undo();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }}
    >
      {/* ── Header: who, where it lands, and where you are ── */}
      <Box
        sx={{
          px: 2,
          py: 1.25,
          borderBottom: 1,
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="h6" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {identity.join(" · ") || "Position"}
          </Typography>
          <SaveDot status={status} />
          {sharedWith.length > 0 ? (
            <Tooltip
              title={`Shared with ${sharedWith.join(
                ", "
              )} — edits here apply to all of them. FTE and the multiplier stay per-hotel.`}
            >
              <Chip
                size="small"
                icon={<LinkIcon />}
                label={`Shared with ${sharedWith.join(", ")}`}
                variant="outlined"
              />
            </Tooltip>
          ) : null}
          <Box sx={{ flex: 1 }} />

          <TextField
            size="small"
            inputRef={searchRef}
            placeholder="Jump to field…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery("");
              }
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ width: 200 }}
          />

          <Tooltip title="Undo the last change (Ctrl+Z)">
            <span>
              <IconButton size="small" onClick={undo} disabled={undoStack.length === 0}>
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>

          <Stack direction="row" spacing={0.25} sx={{ alignItems: "center" }}>
            <Tooltip title="Previous position (Alt+↑)">
              <span>
                <IconButton size="small" onClick={() => navigate(-1)} disabled={index <= 0}>
                  <KeyboardArrowUpIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Typography variant="caption" sx={{ color: "text.secondary", minWidth: 62, textAlign: "center" }}>
              {count > 0 ? `${index + 1} of ${count}` : "—"}
            </Typography>
            <Tooltip title="Next position (Alt+↓)">
              <span>
                <IconButton
                  size="small"
                  onClick={() => navigate(1)}
                  disabled={index < 0 || index >= count - 1}
                >
                  <KeyboardArrowDownIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          <Tooltip title="Done">
            <IconButton size="small" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {masked ? (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Employee PII is hidden — use Show PII in the toolbar to reveal and edit it.
          </Typography>
        ) : null}
      </Box>

      {/* ── Body + review rail ── */}
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box
          ref={bodyRef}
          sx={{
            flex: 1,
            minWidth: 0,
            overflowY: "auto",
            p: 1.5,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 1.5,
            alignItems: "start",
          }}
        >
          {weightsDrift(shown) ? (
            <Alert severity="warning" sx={{ gridColumn: "1 / -1", py: 0 }}>
              Vacation weights total{" "}
              {columns.get("vacationWeightsTotal")
                ? displayValue(columns.get("vacationWeightsTotal")!, shown)
                : ""}
              . The engine normalises them, but they are easier to reason about at 100%.
            </Alert>
          ) : null}
          {cards.map(renderCard)}
        </Box>

        <Box
          sx={{
            width: 210,
            flexShrink: 0,
            borderLeft: 1,
            borderColor: "divider",
            p: 1.5,
            overflowY: "auto",
            bgcolor: "action.hover",
          }}
        >
          <Typography variant="overline" sx={{ color: "text.secondary" }}>
            Review
          </Typography>
          <Stack spacing={0.75} sx={{ mt: 0.5 }}>
            {REVIEW_KEYS.map((key) => {
              const column = columns.get(key);
              if (!column) return null;
              const def = defs.get(key);
              return (
                <ReviewLine
                  key={key}
                  label={def ? headerPresentation(def).short : key}
                  value={displayValue(column, shown)}
                />
              );
            })}
          </Stack>

          {blocks.length > 0 ? (
            <>
              <Divider sx={{ my: 1.25 }} />
              <Stack spacing={0.75}>
                {blocks.map((block) => {
                  const column = columns.get(`blk:${block.costDefId}:total`);
                  if (!column) return null;
                  return (
                    <ReviewLine
                      key={block.id}
                      label={block.label}
                      value={displayValue(column, shown)}
                    />
                  );
                })}
              </Stack>
            </>
          ) : null}
        </Box>
      </Box>
    </Dialog>
  );
}

function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block", lineHeight: 1.2 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {value || "—"}
      </Typography>
    </Box>
  );
}

/** The row's save state — same four states, colours and wording as the grid's
 *  gutter dot, so "is it saved?" reads identically on both surfaces. */
function SaveDot({ status }: { status?: RowSaveStatus }) {
  if (!status) return null;
  switch (status) {
    case "dirty":
      return (
        <Tooltip title="Unsaved changes">
          <Box
            sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "warning.main" }}
          />
        </Tooltip>
      );
    case "saving":
      return <CircularProgress size={12} thickness={5} />;
    case "saved":
      return <CheckCircleOutlineIcon sx={{ fontSize: 16, color: "success.main" }} />;
    case "error":
      return (
        <Tooltip title="Save failed — will retry">
          <ErrorOutlineIcon sx={{ fontSize: 16, color: "error.main" }} />
        </Tooltip>
      );
  }
}

/**
 * Do the twelve vacation weights still add up?
 *
 * Same Σ and same 0.001 threshold the grid reddens its weight cells at
 * (columnFactory), read through the same COMPUTES entry so the two surfaces
 * cannot end up disagreeing about whether a row needs attention.
 */
function weightsDrift(row: PositionRow): boolean {
  return Math.abs(COMPUTES.vacationWeightsTotal(row) - 1) > 0.001;
}

/**
 * Why a field is locked. The grid can only mute a cell; a form has room to say
 * what would unlock it, which is most of the value of showing locked fields at
 * all.
 */
function lockNoteFor(
  def: FieldDef | undefined,
  row: PositionRow,
  masked: boolean
): string | null {
  if (!def) return null;
  if (masked && def.maskable) return "Hidden — use Show PII in the toolbar to reveal and edit.";
  if (def.storage === "COMPUTED") return "Calculated from the other fields on this row.";
  if (def.key === "clusterMultiplierOverride" && row.cluster) {
    return "Set by the cluster's own weights — only a single-hotel cluster can be overridden by hand.";
  }
  return null;
}

/** The other hotels a cluster position is shared with, named where possible. */
function peerHotelNames(
  row: PositionRow,
  clusters: HotelClusterDto[],
  currentOu: string | null,
  hotelNames?: ReadonlyMap<string, string>
): string[] {
  const clusterId = typeof row.cluster === "string" ? row.cluster : "";
  const cluster = clusters.find((candidate) => candidate.id === clusterId);
  return (cluster?.members ?? [])
    .filter((member) => member.ou !== (currentOu ?? ""))
    .map((member) => hotelNames?.get(member.ou) ?? member.ou);
}

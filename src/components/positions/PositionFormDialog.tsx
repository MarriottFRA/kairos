/**
 * Edit Position — one row, laid out as a form.
 * -----------------------------------------------------------
 * The grid spreads a position across ~79 catalog columns plus 2..14 per block,
 * so editing or reviewing one person means a lot of horizontal travel. This
 * dialog is the same row turned ninety degrees: a section rail on the left, the
 * row's sections and blocks as full-width bands down the middle, and a review
 * rail that keeps the derived figures on screen while you type.
 *
 * It is an ADDITION, not a replacement — the grid stays fully editable, and both
 * surfaces write through the same path.
 *
 * Layout, and why it is not a card grid: sections hold anywhere from one field
 * to fifteen, so laying them out as cards in a uniform column grid leaves a dead
 * gutter under every card shorter than its row-mate — CSS grid sizes a row to
 * its tallest item, and the raggedness grows with the number of blocks. Bands
 * remove the problem rather than balancing it: each band owns the full width, so
 * its height is dictated by its own content and there is no neighbour to align
 * against. Density then lives INSIDE the band, on one lattice of equal tracks
 * shared by every band in the form, so fields line up vertically from the top of
 * the dialog to the bottom.
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

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
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
import { DepartmentPickList } from "../../shared/positions/departmentPickList";
import type { DepartmentWritePolicy } from "../../shared/kairosSync/writePolicy";
import { CLUSTER_LINK_ROW_KEY } from "../../shared/positions/clusterSync";
import { FieldCatalog, FieldDef } from "../../shared/positions/fields";
import type { DerivedRowValuesRef } from "../../shared/positions/derivedRowValues";
import {
  buildPositionForm,
  fieldSpan,
  FormCard,
  FormNode,
  isEssentialField,
  matchFormFields,
} from "../../shared/positions/positionForm";
import { PositionRow } from "../../shared/positions/rowModel";
import { RowSaveStatus } from "../../services/positionsWriteQueue";
import { buildBlockColumns, poolWeightGate, slotPresentation } from "./blockColumns";
import {
  blockAccountKey,
  blockFieldKey,
  blockInputSlots,
  blockDepartmentKey,
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

/** The form's one lattice. Every band lays its fields on these tracks, so a
 *  field in Contract sits directly above a field in Basic Salary. */
const CELL_MIN = 188;
/** Month cells are narrow by nature — twelve of them, all the same shape. */
const MONTH_CELL_MIN = 116;

type Density = "essentials" | "all";

interface UndoEntry {
  rowId: string;
  /** The row as it was before the edit — replayed wholesale through the same
   *  update path, so the undo is sanitized and diffed like any other edit. */
  before: PositionRow;
  label: string;
}

/** A card plus what this view is actually going to draw of it. */
interface Band {
  card: FormCard;
  nodes: FormNode[];
  /** Fields the Essentials view is holding back — surfaced as "+N more". */
  hidden: number;
  /** Fields matching the current search, for the rail's counter. */
  hits: number;
}

export interface PositionFormDialogProps {
  /** The LIVE row from page state (looked up by id each render), or null when
   *  closed — so derived values and block totals refresh as you type. */
  row: PositionRow | null;
  catalog: FieldCatalog;
  blocks: BlockDto[];
  departments: DepartmentOption[];
  /** Which of them may be chosen. Omit for no restriction. */
  departmentPicks?: DepartmentPickList;
  accounts: AccountOption[];
  /** Vacation cost, manhours, FTE and live block totals per row — the same ref
   *  the grid gets, so the form and the cell behind it can never disagree. The
   *  form re-renders on every page render (the live row is looked up by id), so
   *  reading through the ref keeps it current without rebuilding its columns. */
  derived: DerivedRowValuesRef;
  hotelClusters: HotelClusterDto[];
  currentOu: string | null;
  hotelNames?: ReadonlyMap<string, string>;
  masked: boolean;
  /**
   * The server's write scope, exactly as the grid receives it.
   *
   * Without these the form was a hole straight through the department lock: its
   * `cellEditable` context omitted them, so every field on a delegated row came
   * back editable and its commits went into the same write queue as the grid's.
   * `undefined` means an unpublished plan and unrestricted editing, same as
   * everywhere else — the distinction from an empty allow-list is load-bearing.
   */
  writePolicy?: DepartmentWritePolicy;
  planLocked?: boolean;
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
  departments,
  departmentPicks,
  accounts,
  derived,
  hotelClusters,
  currentOu,
  hotelNames,
  masked,
  writePolicy,
  planLocked,
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
  const bandRefs = useRef(new Map<string, HTMLElement>());
  const [query, setQuery] = useState("");
  const [density, setDensity] = useState<Density>("essentials");
  const [openBands, setOpenBands] = useState<Record<string, boolean>>({});
  const [openFamilies, setOpenFamilies] = useState<Record<string, boolean>>({});
  /** Bands where the user asked for the fields Essentials holds back. */
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [activeBand, setActiveBand] = useState<string>("");
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);

  const columns = useMemo(() => {
    const ctx: ColumnFactoryContext = {
      masked,
      numberFormat: new Intl.NumberFormat(),
      departments,
      departmentPicks,
      accounts,
      derived,
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
        departments,
        derived,
      }),
    ];
    return new Map(all.map((column) => [column.field, column]));
    // As in PositionsGrid: `derived` is a stable ref, so nothing here moves
    // while the user types. The form reads live values through the ref.
  }, [
    catalog,
    blocks,
    masked,
    departments,
    departmentPicks,
    accounts,
    derived,
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
  // context. Inside a band already titled "Pension" that reads as a stutter, so
  // the form takes the same short/unit pair the band header uses. The owning
  // block's label rides along so the search box can match "pension" and land on
  // that block's cells.
  const blockLabels = useMemo(() => {
    const labels = new Map<string, { short: string; unit: string; block: string }>();
    for (const block of blocks) {
      for (const slot of blockInputSlots(block)) {
        labels.set(blockFieldKey(block.costDefId, slot), {
          ...slotPresentation(block, slot),
          block: block.label,
        });
      }
      labels.set(blockAccountKey(block.costDefId), {
        short: "Account",
        unit: "posts to",
        block: block.label,
      });
      labels.set(blockStatsAccountKey(block.costDefId), {
        short: "Stats account",
        unit: "posts to",
        block: block.label,
      });
      labels.set(blockDepartmentKey(block.costDefId), {
        short: "Department",
        unit: "books to",
        block: block.label,
      });
    }
    return labels;
  }, [blocks]);

  /** Field keys the search box is asking for, or null for "no filter". Covers
   *  block cells too — a search that silently skipped half the form would send
   *  the user back to the grid. */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const hits = new Set(matchFormFields(catalog, query));
    for (const [key, meta] of blockLabels) {
      if (
        meta.short.toLowerCase().includes(needle) ||
        meta.block.toLowerCase().includes(needle)
      ) {
        hits.add(key);
      }
    }
    return hits;
  }, [catalog, blockLabels, query]);

  const editCtx = useMemo(
    () => ({
      masked,
      maskableKeys,
      hotelClusters,
      currentOu,
      // The same server-side write scope the grid locks against. The form and
      // the grid must give one answer, not two — they share `cellEditable`
      // precisely so that a rule added in one place cannot be missing from the
      // other.
      writePolicy,
      planLocked,
      // Same pooled-weight lock the grid applies, so the form cannot offer an
      // edit the grid refuses (or the other way round).
      poolWeightEditable: poolWeightGate(blocks),
    }),
    [masked, maskableKeys, hotelClusters, currentOu, writePolicy, planLocked, blocks]
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

  // ── What each band draws ──────────────────────────────────────────────
  // Search wins over density: a field you went looking for is never withheld
  // because the Essentials view would have hidden it.
  const keysOf = (node: FormNode): string[] =>
    node.kind === "field"
      ? [node.key]
      : node.kind === "monthFamily"
        ? [node.summaryKey, ...node.keys].filter((key): key is string => !!key)
        : node.keys;

  /** The catalog def that decides whether a node is essential — a family is
   *  represented by its Σ, which is the only line of it the form shows folded. */
  const anchorDef = (node: FormNode): FieldDef | undefined =>
    node.kind === "field"
      ? defs.get(node.key)
      : node.kind === "monthFamily" && node.summaryKey
        ? defs.get(node.summaryKey)
        : undefined;

  const bands: Band[] = cards
    .map((card) => {
      const open = revealed[card.id] === true;
      let hidden = 0;
      let hits = 0;
      const nodes = card.nodes.filter((node) => {
        if (matches) {
          const hit = keysOf(node).some((key) => matches.has(key));
          if (hit) hits += 1;
          return hit;
        }
        const def = anchorDef(node);
        // Block slots have no def and are never held back: a block band that
        // showed only its title would be a worse answer than a long form.
        if (!def || open || density === "all" || isEssentialField(def)) return true;
        hidden += 1;
        return false;
      });
      return { card, nodes, hidden, hits };
    })
    // A block with no inputs at all (a plain SS scheme) still earns its band —
    // its Total is the thing the user came to read.
    .filter((band) => band.nodes.length > 0 || (!matches && !!band.card.totalKey));

  /** Until the body has been scrolled, "you are here" is the first band. */
  const currentBand = activeBand || bands[0]?.card.id || "";

  const jumpTo = (id: string) => {
    setOpenBands((state) => ({ ...state, [id]: true }));
    requestAnimationFrame(() => {
      const root = bodyRef.current;
      const element = bandRefs.current.get(id);
      if (root && element) root.scrollTop = element.offsetTop - 8;
    });
  };

  const syncActiveBand = () => {
    const root = bodyRef.current;
    if (!root) return;
    let current = bands[0]?.card.id ?? "";
    for (const band of bands) {
      const element = bandRefs.current.get(band.card.id);
      if (element && element.offsetTop - root.scrollTop <= 12) current = band.card.id;
    }
    setActiveBand((previous) => (previous === current ? previous : current));
  };

  const renderField = (
    key: string,
    options?: { dense?: boolean; action?: ReactNode }
  ) => {
    const column = columns.get(key);
    if (!column) return null;
    const def = defs.get(key);
    const presentation = def ? headerPresentation(def) : (blockLabels.get(key) ?? null);
    const span = options?.dense ? 1 : fieldSpan(key, def);

    return (
      <Box key={key} sx={{ minWidth: 0, gridColumn: `span ${span}` }}>
        <PositionFormField
          column={column}
          def={def}
          row={shown}
          label={presentation?.short ?? String(column.headerName ?? key)}
          unit={presentation?.unit}
          hint={
            (def ? headerPresentation(def).hint : null) ??
            (column.description as string | undefined) ??
            null
          }
          editable={cellEditable(shown, column, editCtx)}
          lockNote={lockNoteFor(def, shown, masked)}
          dense={options?.dense}
          action={options?.action}
          departments={departments}
          departmentPicks={departmentPicks}
          accounts={accounts}
          onCommit={commit}
        />
      </Box>
    );
  };

  /** The twelve cells of a family, as a full-width shelf under their Σ. */
  const renderMonths = (familyId: string, keys: string[]) => (
    <Box
      key={`${familyId}:months`}
      sx={{
        gridColumn: "1 / -1",
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${MONTH_CELL_MIN}px, 1fr))`,
        gap: 1,
        p: 1,
        borderRadius: 1,
        bgcolor: "action.hover",
      }}
    >
      {keys.map((key) => renderField(key, { dense: true }))}
    </Box>
  );

  const renderNode = (card: FormCard, node: FormNode) => {
    if (node.kind === "field") return renderField(node.key);

    const familyId = `${card.id}:${node.kind === "monthFamily" ? node.vector : "months"}`;
    const open = openFamilies[familyId] ?? false;
    const toggle = (
      <Tooltip title={open ? "Hide the twelve months" : "Show the twelve months"}>
        <IconButton
          size="small"
          tabIndex={-1}
          sx={{ p: 0.25 }}
          onClick={() => setOpenFamilies((state) => ({ ...state, [familyId]: !open }))}
        >
          <ExpandMoreIcon
            sx={{
              fontSize: 16,
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 120ms",
            }}
          />
        </IconButton>
      </Tooltip>
    );

    // A family with a Σ hangs off that field's own cell; one without (a
    // CUSTOM_MONTHLY block) gets a cell of the same shape holding just the
    // toggle, so the lattice stays intact either way.
    const head =
      node.kind === "monthFamily" && node.summaryKey ? (
        renderField(node.summaryKey, { action: toggle })
      ) : (
        <Box key={familyId} sx={{ minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.25, height: 18 }}>
            <Typography
              variant="caption"
              noWrap
              sx={{ flex: 1, minWidth: 0, color: "text.secondary", lineHeight: 1.2 }}
            >
              Monthly amounts
            </Typography>
            {toggle}
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", height: 40 }}>
            <Typography variant="body2" sx={{ color: "text.disabled" }}>
              {open ? "12 months" : "12 months hidden"}
            </Typography>
          </Box>
        </Box>
      );

    return (
      <Box key={familyId} sx={{ display: "contents" }}>
        {head}
        {open ? renderMonths(familyId, node.keys) : null}
      </Box>
    );
  };

  const renderBand = (band: Band) => {
    const { card } = band;
    const isBlock = card.kind === "block";
    // Sections are open by default; blocks fold away in the Essentials view,
    // where their Total in the header is usually the whole question.
    const defaultOpen = !isBlock || density === "all";
    const open = matches ? true : (openBands[card.id] ?? defaultOpen);
    const total =
      card.totalKey && columns.get(card.totalKey)
        ? displayValue(columns.get(card.totalKey)!, shown)
        : null;

    return (
      <Box
        key={card.id}
        component="section"
        ref={(element: HTMLElement | null) => {
          if (element) bandRefs.current.set(card.id, element);
          else bandRefs.current.delete(card.id);
        }}
        sx={{ scrollMarginTop: 8 }}
      >
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            position: "sticky",
            top: 0,
            zIndex: 2,
            alignItems: "center",
            minWidth: 0,
            py: 0.75,
            bgcolor: "background.paper",
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <IconButton
            size="small"
            tabIndex={-1}
            sx={{ p: 0.25 }}
            onClick={() => setOpenBands((state) => ({ ...state, [card.id]: !open }))}
          >
            <ExpandMoreIcon
              sx={{
                fontSize: 18,
                transform: open ? "none" : "rotate(-90deg)",
                transition: "transform 120ms",
              }}
            />
          </IconButton>
          <Typography
            variant="subtitle2"
            noWrap
            sx={{ minWidth: 0, color: isBlock ? "primary.main" : "text.primary" }}
          >
            {card.label || "Row"}
          </Typography>
          <Box sx={{ flex: 1, minWidth: 8 }} />
          {total ? (
            <Typography
              variant="body2"
              sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
            >
              {total}
            </Typography>
          ) : null}
          {card.block ? (
            <Tooltip title="Edit this block">
              <IconButton size="small" tabIndex={-1} onClick={() => onEditBlock(card.block!)}>
                <SettingsOutlinedIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>

        {open ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${CELL_MIN}px, 1fr))`,
              columnGap: 1.5,
              rowGap: 1.25,
              py: 1.5,
              alignItems: "start",
            }}
          >
            {band.nodes.map((node) => renderNode(card, node))}
            {band.hidden > 0 ? (
              <Box sx={{ gridColumn: "1 / -1" }}>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`+${band.hidden} more ${band.hidden === 1 ? "field" : "fields"}`}
                  onClick={() => setRevealed((state) => ({ ...state, [card.id]: true }))}
                />
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
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
          <Typography variant="h6" noWrap sx={{ minWidth: 0 }}>
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
          <Box sx={{ flex: 1, minWidth: 8 }} />

          <Tooltip title="Key fields hides posting accounts, mirrored codes and the rare overrides">
            <ToggleButtonGroup
              size="small"
              exclusive
              value={density}
              onChange={(_event, next: Density | null) => next && setDensity(next)}
              sx={{ "& .MuiToggleButton-root": { py: 0.25, px: 1, textTransform: "none" } }}
            >
              <ToggleButton value="essentials">Key</ToggleButton>
              <ToggleButton value="all">All</ToggleButton>
            </ToggleButtonGroup>
          </Tooltip>

          <TextField
            size="small"
            inputRef={searchRef}
            placeholder="Find a field…"
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
            sx={{ width: 180 }}
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

      {/* ── Section rail · bands · review rail ── */}
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box
          sx={{
            width: 190,
            flexShrink: 0,
            borderRight: 1,
            borderColor: "divider",
            overflowY: "auto",
            py: 1,
            px: 0.75,
            display: { xs: "none", md: "block" },
          }}
        >
          <Stack spacing={0.25}>
            {bands.map((band) => (
              <RailItem
                key={band.card.id}
                label={band.card.label || "Row"}
                block={band.card.kind === "block"}
                active={currentBand === band.card.id}
                badge={matches ? band.hits : null}
                onClick={() => jumpTo(band.card.id)}
              />
            ))}
            {matches && bands.length === 0 ? (
              <Typography variant="caption" sx={{ color: "text.secondary", px: 1 }}>
                No field matches “{query.trim()}”.
              </Typography>
            ) : null}
          </Stack>
        </Box>

        <Box
          ref={bodyRef}
          onScroll={syncActiveBand}
          sx={{
            flex: 1,
            minWidth: 0,
            position: "relative",
            overflowY: "auto",
            px: 2,
            pb: 4,
          }}
        >
          {bands.map(renderBand)}
          {bands.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 3 }}>
              No field matches “{query.trim()}”. Clear the search to see the whole position.
            </Typography>
          ) : null}
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
            display: { xs: "none", sm: "block" },
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
              <Typography
                variant="overline"
                sx={{ color: "text.secondary", display: "block", mt: 1.5 }}
              >
                Blocks
              </Typography>
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

/** One line of the section rail: where you are, and where a search landed. */
function RailItem({
  label,
  block,
  active,
  badge,
  onClick,
}: {
  label: string;
  block: boolean;
  active: boolean;
  badge: number | null;
  onClick: () => void;
}) {
  return (
    <ButtonBase
      onClick={onClick}
      tabIndex={-1}
      sx={{
        display: "flex",
        width: "100%",
        gap: 0.75,
        px: 1,
        py: 0.5,
        borderRadius: 1,
        borderLeft: "2px solid",
        borderColor: active ? "primary.main" : "transparent",
        bgcolor: active ? "action.selected" : "transparent",
        justifyContent: "flex-start",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Typography
        variant="body2"
        noWrap
        sx={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          fontWeight: active ? 600 : 400,
          color: block ? "primary.main" : active ? "text.primary" : "text.secondary",
        }}
      >
        {label}
      </Typography>
      {badge !== null ? (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {badge}
        </Typography>
      ) : null}
    </ButtonBase>
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

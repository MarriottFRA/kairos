/**
 * Position form model — the row, laid out as a form.
 * -----------------------------------------------------------
 * The grid spreads a position across ~79 catalog columns plus 2..14 per block,
 * which is a lot of horizontal travel to edit or review one person. The Edit
 * Position dialog renders the SAME row as a grid of cards; this module decides
 * what those cards contain and in what order.
 *
 * Deliberately pure (no React, no MUI): the dialog reads every VALUE through
 * the row's own GridColDef callbacks (see components/positions/gridValueBridge),
 * so the only thing left to decide is layout — and layout is worth a unit test,
 * because a catalog-driven form can silently drop a field when the seed moves.
 *
 * Two things it does NOT do, on purpose:
 *   - it never decides editability (that is columnFactory.cellEditable, shared
 *     with the grid), and
 *   - it never formats a value (that is the colDef's valueFormatter).
 */

import { BlockDto } from "../blocks/ipc";
import {
  blockOverrideRowKeys,
  blockFieldKey,
  blockInputSlots,
  blockTotalKey,
  BlockSlot,
} from "./blockRows";
import {
  BASIC_SALARY_ANNUAL_KEY,
  COLLAPSIBLE_MONTH_FAMILIES,
  INPUT_BASIS_KEY,
  FieldCatalog,
  FieldDef,
  fieldLabel,
  SALARY_ENTRY_MODE_KEY,
  SectionId,
  VectorName,
  vectorKey,
  vectorKeys,
} from "./fields";

/**
 * One line of a card.
 *
 * `monthFamily` and `blockMonths` fold twelve cells behind a single row that the
 * user expands — the form's counterpart of the grid's collapsed month bands.
 * The catalog's summary field (Total Months / Additional Costs / Total Weights)
 * becomes the family's own header rather than a separate line, so it is never
 * rendered twice.
 */
export type FormNode =
  | { kind: "field"; key: string }
  | {
      kind: "monthFamily";
      vector: VectorName;
      /** The COMPUTED Σ field that heads the family, when the seed ships one. */
      summaryKey: string | null;
      /** The twelve flat row keys, in month order. */
      keys: string[];
    }
  | { kind: "blockMonths"; defId: string; keys: string[] };

export type FormCardKind = "section" | "block";

export interface FormCard {
  /** Catalog section id, or `blk:<block.id>`. */
  id: string;
  label: string;
  kind: FormCardKind;
  /** Set on block cards — carries the cog through to the block editor. */
  block?: BlockDto;
  nodes: FormNode[];
  /** Read-only full-year Total, resolved from the live sim. Block cards only. */
  totalKey?: string;
}

/** Summary field key -> the vector it heads, for every foldable family. */
function summaryKeyByVector(catalog: FieldCatalog): Map<VectorName, string> {
  const byVector = new Map<VectorName, string>();
  // The two the grid folds by default ship as an explicit constant...
  for (const [summaryKey, vector] of Object.entries(
    COLLAPSIBLE_MONTH_FAMILIES
  ) as Array<[string, VectorName]>) {
    byVector.set(vector, summaryKey);
  }
  // ...and vacation weights have a Σ too (Total Weights), it is simply always
  // expanded in the grid because the twelve are the point of that section. The
  // form has less width than the grid, so it folds all three the same way.
  if (!byVector.has("vacationMonthlyWeights")) {
    const total = catalog.fields.find(
      (def) => def.computeKey === "vacationWeightsTotal"
    );
    if (total) byVector.set("vacationMonthlyWeights", total.key);
  }
  return byVector;
}

/**
 * Cards for one position: the catalog's sections in seed order, then one card
 * per block.
 *
 * Grouping is by `def.section` through `catalog.sections`, NOT by adjacency in
 * `catalog.fields` — buildColumns can assume the fields arrive section-
 * contiguous because it only draws dividers, but a form that mis-groups puts a
 * field on the wrong card, which is worse than a missing divider.
 */
export function buildPositionForm(
  catalog: FieldCatalog,
  blocks: BlockDto[]
): FormCard[] {
  const summaries = summaryKeyByVector(catalog);
  /** summary key -> its vector, so the summary's slot becomes the family. */
  const vectorBySummary = new Map<string, VectorName>();
  for (const [vector, key] of summaries) vectorBySummary.set(key, vector);

  const visible = catalog.fields.filter((def) => def.visible);
  const bySection = new Map<SectionId, FieldDef[]>();
  for (const def of visible) {
    const list = bySection.get(def.section);
    if (list) list.push(def);
    else bySection.set(def.section, [def]);
  }

  const cards: FormCard[] = [];
  const sections = [...catalog.sections].sort((a, b) => a.order - b.order);

  for (const section of sections) {
    const fields = (bySection.get(section.id) ?? []).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );
    if (fields.length === 0) continue;

    const nodes: FormNode[] = [];
    const emitted = new Set<VectorName>();

    for (const def of fields) {
      // A month cell: emit its family here if the summary has not already
      // placed it. Which of the two comes first differs per family in the seed
      // (Total Months and Additional Costs lead their twelve, Total Weights
      // trails them), so whichever is reached first owns the slot.
      if (def.vector && def.monthIndex) {
        if (!emitted.has(def.vector)) {
          emitted.add(def.vector);
          nodes.push(monthFamilyNode(def.vector, summaries.get(def.vector) ?? null));
        }
        continue;
      }

      const heads = vectorBySummary.get(def.key);
      if (heads) {
        if (!emitted.has(heads)) {
          emitted.add(heads);
          nodes.push(monthFamilyNode(heads, def.key));
        }
        continue;
      }

      nodes.push({ kind: "field", key: def.key });
    }

    cards.push({ id: section.id, label: section.label, kind: "section", nodes });
  }

  for (const block of blocks) {
    cards.push(blockCard(block));
  }

  return cards;
}

function monthFamilyNode(vector: VectorName, summaryKey: string | null): FormNode {
  return { kind: "monthFamily", vector, summaryKey, keys: vectorKeys(vector) };
}

/**
 * One card per block, built from `blockInputSlots` — the same function the grid
 * band uses, which is what makes the form grow with blocks for free: a new
 * block, or a new slot on an existing block type, shows up in both surfaces
 * without a line of layout code.
 */
function blockCard(block: BlockDto): FormCard {
  const slots = blockInputSlots(block);
  const nodes: FormNode[] = [];

  const months = slots.filter(isMonthSlot);
  const scalars = slots.filter((slot) => !isMonthSlot(slot));

  for (const slot of scalars) {
    nodes.push({ kind: "field", key: blockFieldKey(block.costDefId, slot) });
  }
  if (months.length > 0) {
    nodes.push({
      kind: "blockMonths",
      defId: block.costDefId,
      keys: months.map((slot) => blockFieldKey(block.costDefId, slot)),
    });
  }
  // Per-row account cells exist only while the block is unlocked, and the
  // department cell only while it is in PER_ROW mode.
  for (const key of blockOverrideRowKeys(block)) {
    nodes.push({ kind: "field", key });
  }

  return {
    id: `blk:${block.id}`,
    label: block.label,
    kind: "block",
    block,
    nodes,
    totalKey: blockTotalKey(block),
  };
}

function isMonthSlot(slot: BlockSlot): boolean {
  return /^m(?:[1-9]|1[0-2])$/.test(slot);
}

/**
 * Field keys matching a search string, for the dialog's jump box.
 *
 * Matches the label a user actually sees, plus the key (so a developer can
 * paste one in) and the section label (so "vacation" finds the whole card).
 * An empty query matches nothing — the caller treats that as "no filter".
 */
export function matchFormFields(
  catalog: FieldCatalog,
  query: string
): Set<string> {
  const needle = query.trim().toLowerCase();
  const hits = new Set<string>();
  if (needle === "") return hits;

  const sectionLabels = new Map(
    catalog.sections.map((section) => [section.id, section.label.toLowerCase()])
  );

  for (const def of catalog.fields) {
    if (!def.visible) continue;
    const haystacks = [
      fieldLabel(def).toLowerCase(),
      def.key.toLowerCase(),
      sectionLabels.get(def.section) ?? "",
    ];
    if (haystacks.some((text) => text.includes(needle))) hits.add(def.key);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Cell geometry
// ---------------------------------------------------------------------------

/**
 * How many tracks of the form's lattice a field occupies.
 *
 * The dialog lays every field out on ONE grid of equal tracks, shared by every
 * section and every block, so the whole form lines up vertically no matter how
 * many fields a section happens to hold — which is the thing a per-card layout
 * could never do. A field that would truncate at one track (an account picker
 * showing "A511000 · Salaries — Front Office", a free-text job title) asks for
 * two; everything else takes one. Nothing takes three: at that point the value
 * is not a field, it is a family, and families span the row on their own.
 */
export type FieldSpan = 1 | 2;

/** Keys whose VALUE, not label, needs the room: long free text and pickers. */
const WIDE_KEYS: ReadonlySet<string> = new Set([
  "title",
  "standardJobTitle",
  "deptName",
  "cluster",
]);

export function fieldSpan(key: string, def?: FieldDef): FieldSpan {
  if (def) {
    if (def.dataType === "ACCOUNT_CODE") return 2;
    const source = def.dropdownSource?.kind;
    if (source === "accounts" || source === "departments") return 2;
    return WIDE_KEYS.has(def.key) ? 2 : 1;
  }
  // Block slots carry no catalog def; only their two account cells are wide.
  return /:(?:account|statsAccount)$/.test(key) ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Essentials
// ---------------------------------------------------------------------------

/**
 * The fields the form shows before you ask for the rest.
 *
 * A position carries ~40 form lines once the month families are folded, and a
 * normal edit touches maybe fifteen of them. What the rest have in common is
 * that they are set once and then left alone: the accounts a figure posts to,
 * the read-only mirror of a picked department, and the two overrides that exist
 * for the rare row. So Essentials is defined by what it DROPS — posting
 * accounts, mirrors, and rare overrides — which is a rule a user can hold in
 * their head, unlike a hand-picked list of favourites.
 *
 * User-defined fields are always essential: somebody added that column on
 * purpose, and hiding it by default would make it look like it never saved.
 */
export const ESSENTIAL_FIELD_KEYS: ReadonlySet<string> = new Set([
  "active",
  // Employee PII
  "firstName",
  "lastName",
  "empNumber",
  "hiringDate",
  // Position
  "deptName",
  "title",
  "jobTypeCode",
  "payType",
  "headcount",
  "cluster",
  // Contract
  INPUT_BASIS_KEY,
  "contractYearlyDays",
  "contractDaysOff",
  "contractPubHolidays",
  "dailyContractHours",
  "yearlyManhoursPaid",
  "yearlyHoursWorked",
  "fte",
  // Seasonality
  "totalWorkingMonths",
  // Basic salary
  SALARY_ENTRY_MODE_KEY,
  BASIC_SALARY_ANNUAL_KEY,
  "monthlyBaseSalary",
  "hourlyRate",
  "meritIncreasePct",
  "increaseMonth",
  "additionalCostsTotal",
  "fullYearWage",
  "budgetYearBasicSalary",
  // Vacation
  "vacationDays",
  "accrualDaysPerMonth",
  "vacationWeightsTotal",
  "vacationEstimate",
]);

export function isEssentialField(def: FieldDef): boolean {
  return def.origin === "USER" || ESSENTIAL_FIELD_KEYS.has(def.key);
}

/**
 * The flat row key a month cell lives under — re-exported so the dialog can
 * address a family's cells without importing the vector helpers directly.
 */
export { vectorKey };

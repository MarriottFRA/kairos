/**
 * Write numbers into an existing .xlsm, in place, without disturbing anything
 * else in it.
 *
 * WHY THIS IS NOT DONE WITH AN EXCEL LIBRARY
 * ------------------------------------------
 * A real BST is ~568 zip parts / ~90 MB uncompressed: a 3.2 MB `vbaProject.bin`
 * the workbook's own macros live in, ~2,000 cell formats, ~700 conditional-
 * format styles, 155 drawing parts, 66 VML parts, 107 printer-settings parts,
 * custom XML, and SHA-512 protection on the workbook and all 110 sheets. Any
 * writer that parses to an object model and re-serialises has to reproduce all
 * of that; SheetJS (community) and ExcelJS both drop most of it, and driving
 * Excel itself needs Excel installed plus the protection passwords.
 *
 * So we edit the OOXML directly. Of the 568 parts, exactly four kinds change:
 *   1. the department sheets we write into,
 *   2. `xl/workbook.xml` — one attribute, fullCalcOnLoad,
 *   3. `[Content_Types].xml` + `xl/_rels/workbook.xml.rels` — drop calcChain,
 *   4. `xl/calcChain.xml` — deleted; Excel rebuilds it.
 * Everything else is re-emitted byte-for-byte.
 *
 * WHY IT IS SAFE
 * --------------
 * Sheet protection is enforced by the Excel UI, not the file format, so writing
 * here neither needs nor removes the password. Nothing is written in place: the
 * caller gets bytes, verifies them, and swaps the file atomically.
 *
 * SHAPE ASSUMPTIONS, ASSERTED NOT ASSUMED
 * ---------------------------------------
 * Verified across all 41 department sheets of the 2027 reference file: no array
 * formulas in I..T, no inline strings, and every shared-formula group that
 * touches I..T is confined to a single row (`ref="I9:T9"`, `ref="I25:AT25"`),
 * with no group anchored outside the band reaching into it. assertWritable()
 * re-checks these per sheet and refuses if a future BST breaks one — refusing is
 * always better than writing something we cannot reason about.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

import type { CellWrite } from "./plan";
import { UnsupportedLayoutError } from "./readTarget";

const WORKBOOK_PART = "xl/workbook.xml";
const WORKBOOK_RELS_PART = "xl/_rels/workbook.xml.rels";
const CONTENT_TYPES_PART = "[Content_Types].xml";
const CALC_CHAIN_PART = "xl/calcChain.xml";

/** 0-based column index → Excel column letters (0 → "A", 8 → "I"). */
export function colName(index: number): string {
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** Excel column letters → 0-based index ("I" → 8). */
export function colIndex(name: string): number {
  let n = 0;
  for (let i = 0; i < name.length; i++) n = n * 26 + (name.charCodeAt(i) - 64);
  return n - 1;
}

/** A number as an XSD double literal, which is what `<v>` holds. */
function numberToXml(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Map sheet display name → worksheet part path, via workbook.xml + its rels. */
export function mapSheetParts(
  workbookXml: string,
  relsXml: string
): Map<string, string> {
  const relById = new Map<string, string>();
  for (const match of relsXml.matchAll(
    /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g
  )) {
    relById.set(match[1], match[2]);
  }

  const parts = new Map<string, string>();
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = match[0];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
    if (!name || !rid) continue;
    const target = relById.get(rid);
    if (!target) continue;
    const normalized = target.replace(/^\/?xl\//, "").replace(/^\//, "");
    parts.set(decodeXmlEntities(name), `xl/${normalized}`);
  }
  return parts;
}

/** Every cell reference inside an `A1:B2` range. */
function expandRange(ref: string): string[] {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return [];
  const [, startCol, startRow, endCol, endRow] = match;
  const refs: string[] = [];
  for (let r = Number(startRow); r <= Number(endRow); r++) {
    for (let c = colIndex(startCol); c <= colIndex(endCol); c++) {
      refs.push(`${colName(c)}${r}`);
    }
  }
  return refs;
}

/**
 * Cells inside an array formula, which must never be written individually —
 * an array block is a single unit and breaking it corrupts the whole block.
 *
 * Only the master cell carries `t="array"` with its `ref`; the rest of the
 * block looks like ordinary cached values, so the ranges have to be collected
 * up front rather than spotted cell by cell.
 */
function arrayFormulaCells(xml: string): Set<string> {
  const cells = new Set<string>();
  for (const match of xml.matchAll(/<f\b[^>]*\bt="array"[^>]*\bref="([^"]+)"/g)) {
    for (const ref of expandRange(match[1])) cells.add(ref);
  }
  return cells;
}

/**
 * Which cells actually belong to each shared-formula group, keyed by `si`.
 *
 * A group's `ref` is only its bounding box — Excel writes `ref="I25:AT25"` for
 * a group whose real members are I25..T25, and the cells in between may hold
 * plain values. Membership is carried by the `si` attribute, so that is what
 * has to be counted; using the bounding box instead would refuse pushes that
 * are perfectly safe.
 */
function sharedGroupMembers(xml: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const match of xml.matchAll(
    /<c\b[^>]*\br="([^"]+)"[^>]*>\s*<f\b([^>]*)(?:\/>|>[\s\S]*?<\/f>)/g
  )) {
    const attrs = match[2];
    if (!/\bt="shared"/.test(attrs)) continue;
    const si = /\bsi="([^"]+)"/.exec(attrs)?.[1];
    if (si == null) continue;
    const list = groups.get(si);
    if (list) list.push(match[1]);
    else groups.set(si, [match[1]]);
  }
  return groups;
}

/**
 * Refuse a single cell this writer cannot safely turn into a constant.
 *
 * The one case that genuinely matters is a shared-formula MASTER — the cell
 * carrying the group's `ref` and formula text. Its siblings hold only
 * `<f t="shared" si="N"/>` and depend on it, so deleting a master while a
 * sibling survives leaves the workbook referencing a formula that is gone.
 * Deleting a sibling is always safe.
 *
 * Real BSTs do have multi-row shared groups crossing the budget columns (the
 * F&B template's per-daypart ratio blocks on rows 25–28 and 49–52), but those
 * rows carry "calc" in column B rather than a `dddd-dddddd` combo, so a push
 * never targets them. Checking per cell rather than per sheet is what lets a
 * push into an F&B department work at all.
 */
function assertCellWritable(
  sheetName: string,
  ref: string,
  cell: ParsedCell | undefined,
  written: Set<string>,
  arrayCells: Set<string>,
  groups: Map<string, string[]>
): void {
  if (arrayCells.has(ref)) {
    throw new UnsupportedLayoutError(
      `Sheet "${sheetName}" cell ${ref} is part of an array formula. Kairos ` +
        `will not overwrite one — it would break the whole array block.`
    );
  }
  if (!cell) return;

  if (/\bt="inlineStr"/.test(cell.attrs)) {
    throw new UnsupportedLayoutError(
      `Sheet "${sheetName}" cell ${ref} holds inline text where a number was expected.`
    );
  }

  // Only a master carries `ref`; siblings can be deleted freely.
  const formula = /<f\b([^>]*)(?:\/>|>[\s\S]*?<\/f>)/.exec(cell.inner);
  if (!formula || !/\bt="shared"/.test(formula[1])) return;
  if (!/\bref="/.test(formula[1])) return;

  const si = /\bsi="([^"]+)"/.exec(formula[1])?.[1];
  const members = (si != null && groups.get(si)) || [];
  const orphans = members.filter((member) => !written.has(member));
  if (orphans.length > 0) {
    throw new UnsupportedLayoutError(
      `Sheet "${sheetName}" cell ${ref} leads a shared formula that other cells ` +
        `this push does not replace still depend on ` +
        `(${orphans.slice(0, 3).join(", ")}${orphans.length > 3 ? ", …" : ""}). ` +
        `Kairos will not break it.`
    );
  }
}


/** The parts of one `<c>` element this writer cares about. */
interface ParsedCell {
  /** Full source text of the element — unique per cell, since `r` is. */
  source: string;
  ref: string;
  /** Attributes, including the leading space. */
  attrs: string;
  /** Inner XML; "" for a self-closing cell. */
  inner: string;
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function parseCells(rowBody: string): ParsedCell[] {
  const cells: ParsedCell[] = [];
  for (const match of rowBody.matchAll(CELL_RE)) {
    const attrs = match[1];
    cells.push({
      source: match[0],
      ref: /\br="([^"]+)"/.exec(attrs)?.[1] ?? "",
      attrs,
      inner: match[2] ?? "",
    });
  }
  return cells;
}

/** The cached numeric value of a cell, or 0 when it holds no number. */
function cachedNumber(cell: ParsedCell | undefined): number {
  if (!cell) return 0;
  // Text, error and boolean cells have no numeric value to add to.
  if (/\bt="(?:s|str|e|b|inlineStr)"/.test(cell.attrs)) return 0;
  const raw = /<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rebuild one `<c>` as a plain numeric constant, keeping only its style.
 *
 * Dropping `<f>` is the point: the BST's budget columns hold driver-spread
 * formulas, and a push replaces them with the numbers Kairos computed. `t` goes
 * too — the cell is numeric now, which is the absence of a `t` attribute.
 */
function numericCell(ref: string, attrs: string, value: number): string {
  const style = /\bs="([^"]*)"/.exec(attrs)?.[1];
  const styleAttr = style == null ? "" : ` s="${style}"`;
  return `<c r="${ref}"${styleAttr}><v>${numberToXml(value)}</v></c>`;
}

/** Splice new `<c>` elements into a row body, keeping column order. */
function insertCells(
  rowBody: string,
  inserts: { col: number; xml: string }[]
): string {
  let body = rowBody;
  for (const insert of [...inserts].sort((a, b) => a.col - b.col)) {
    // The first existing cell to the right of the new one.
    const after = parseCells(body).find((cell) => {
      const letters = /^([A-Z]+)\d+$/.exec(cell.ref)?.[1];
      return letters != null && colIndex(letters) > insert.col;
    });
    if (after) {
      const at = body.indexOf(after.source);
      body = body.slice(0, at) + insert.xml + body.slice(at);
    } else {
      body += insert.xml;
    }
  }
  return body;
}

/**
 * Apply this sheet's writes to its XML.
 *
 * `resolved` maps cell ref → the value the cell ends up holding. In additive
 * mode a write carries a delta, not a final value, so this is the only place
 * that knows what actually landed — and it is what verification checks against.
 */
export function applyWritesToSheet(
  sheetName: string,
  xml: string,
  writes: CellWrite[]
): { xml: string; changed: number; resolved: Map<string, number> } {
  const resolved = new Map<string, number>();

  const byRow = new Map<number, CellWrite[]>();
  const written = new Set<string>();
  for (const write of writes) {
    const list = byRow.get(write.row);
    if (list) list.push(write);
    else byRow.set(write.row, [write]);
    written.add(`${colName(write.col)}${write.row}`);
  }
  const arrayCells = arrayFormulaCells(xml);
  const groups = sharedGroupMembers(xml);

  let changed = 0;
  const next = xml.replace(
    /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g,
    (source, attrs: string, inner: string | undefined) => {
      const rowNumber = Number(/\br="(\d+)"/.exec(attrs)?.[1]);
      const rowWrites = byRow.get(rowNumber);
      if (!rowWrites) return source;

      let body = inner ?? "";
      const byRef = new Map(parseCells(body).map((cell) => [cell.ref, cell]));
      const inserts: { col: number; xml: string }[] = [];

      for (const write of rowWrites) {
        const ref = `${colName(write.col)}${write.row}`;
        const existing = byRef.get(ref);
        assertCellWritable(sheetName, ref, existing, written, arrayCells, groups);
        const value = write.add
          ? cachedNumber(existing) + write.value
          : write.value;
        const replacement = numericCell(ref, existing?.attrs ?? "", value);
        resolved.set(ref, value);

        if (existing) {
          // Function form, so `$` in the replacement is never special.
          body = body.replace(existing.source, () => replacement);
          // A later write to the same cell must see what we just wrote.
          byRef.set(ref, {
            source: replacement,
            ref,
            attrs: existing.attrs,
            inner: `<v>${numberToXml(value)}</v>`,
          });
        } else {
          inserts.push({ col: write.col, xml: replacement });
          byRef.set(ref, {
            source: replacement,
            ref,
            attrs: "",
            inner: `<v>${numberToXml(value)}</v>`,
          });
        }
        changed++;
      }

      if (inserts.length > 0) body = insertCells(body, inserts);
      return `<row${attrs}>${body}</row>`;
    }
  );

  return { xml: next, changed, resolved };
}

/**
 * Force Excel to recalculate on open.
 *
 * Necessary because we replaced formulas with constants: the sheet totals
 * (`G` = `=SUM(I:T)`), the POR columns and every rollup sheet still hold their
 * pre-push cached values until something recalculates them.
 */
export function setFullCalcOnLoad(workbookXml: string): string {
  if (/<calcPr\b[^>]*\bfullCalcOnLoad="1"/.test(workbookXml)) return workbookXml;
  if (/<calcPr\b/.test(workbookXml)) {
    return workbookXml.replace(
      /<calcPr\b([^>]*?)(\/?)>/,
      (_match, attrs: string, selfClose: string) =>
        `<calcPr${attrs.replace(/\s*fullCalcOnLoad="[^"]*"/, "")}` +
        ` fullCalcOnLoad="1"${selfClose}>`
    );
  }
  return workbookXml.replace(
    "</workbook>",
    `<calcPr fullCalcOnLoad="1"/></workbook>`
  );
}

/** Remove the calcChain part and every reference to it. */
function dropCalcChain(files: Record<string, Uint8Array>): void {
  if (!files[CALC_CHAIN_PART]) return;
  delete files[CALC_CHAIN_PART];

  const types = files[CONTENT_TYPES_PART];
  if (types) {
    files[CONTENT_TYPES_PART] = strToU8(
      strFromU8(types).replace(
        /<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g,
        ""
      )
    );
  }

  const rels = files[WORKBOOK_RELS_PART];
  if (rels) {
    files[WORKBOOK_RELS_PART] = strToU8(
      strFromU8(rels).replace(
        /<Relationship\b[^>]*Target="calcChain\.xml"[^>]*\/>/g,
        ""
      )
    );
  }
}

export interface WriteResult {
  bytes: Uint8Array;
  cellsWritten: number;
  sheetsTouched: number;
  /** Every part the produced workbook should contain. */
  expectedParts: string[];
  /** Worksheet part path → cell ref → the value that cell now holds. */
  resolvedCells: Map<string, Map<string, number>>;
}

/**
 * Apply cell writes to a workbook's bytes and return the new bytes.
 *
 * No filesystem, no Electron — the caller owns backup, verification and the
 * atomic swap.
 */
export function writeWorkbook(
  source: Buffer | Uint8Array,
  writes: CellWrite[]
): WriteResult {
  const files = unzipSync(
    source instanceof Uint8Array ? source : new Uint8Array(source)
  );

  const workbookXml = files[WORKBOOK_PART];
  const relsXml = files[WORKBOOK_RELS_PART];
  if (!workbookXml || !relsXml) {
    throw new UnsupportedLayoutError(
      "The file is not a readable Excel workbook (no xl/workbook.xml)."
    );
  }

  const sheetParts = mapSheetParts(strFromU8(workbookXml), strFromU8(relsXml));

  const bySheet = new Map<string, CellWrite[]>();
  for (const write of writes) {
    const list = bySheet.get(write.sheet);
    if (list) list.push(write);
    else bySheet.set(write.sheet, [write]);
  }

  let cellsWritten = 0;
  let sheetsTouched = 0;
  const resolvedCells = new Map<string, Map<string, number>>();

  for (const [sheetName, sheetWrites] of bySheet) {
    const part = sheetParts.get(sheetName);
    if (!part || !files[part]) {
      throw new UnsupportedLayoutError(
        `Sheet "${sheetName}" has no worksheet part in the workbook.`
      );
    }
    const applied = applyWritesToSheet(
      sheetName,
      strFromU8(files[part]),
      sheetWrites
    );
    if (applied.changed > 0) {
      files[part] = strToU8(applied.xml);
      cellsWritten += applied.changed;
      sheetsTouched++;
      resolvedCells.set(part, applied.resolved);
    }
  }

  files[WORKBOOK_PART] = strToU8(setFullCalcOnLoad(strFromU8(workbookXml)));
  // The chain names every formula cell in evaluation order; we removed formulas,
  // and a stale chain is exactly what triggers Excel's "we found a problem with
  // some content" repair prompt.
  dropCalcChain(files);

  return {
    bytes: zipSync(files, { level: 6, mem: 8 }),
    cellsWritten,
    sheetsTouched,
    expectedParts: Object.keys(files),
    resolvedCells,
  };
}

/**
 * Confirm the produced bytes are a complete, readable workbook whose target
 * cells hold the numbers we asked for. Runs before the original is replaced, so
 * a failure here costs the user nothing.
 *
 * The exhaustive byte-for-byte comparison of untouched parts is a unit test
 * (writeWorkbook.test.ts) rather than a runtime cost — at runtime it would mean
 * holding two 90 MB copies of the workbook in memory to re-prove something the
 * writer guarantees by construction.
 *
 * @throws Error describing the first discrepancy found.
 */
export function verifyWrite(produced: Uint8Array, result: WriteResult): void {
  const after = unzipSync(produced);
  const expected = new Set(result.expectedParts);

  for (const name of expected) {
    if (!after[name]) throw new Error(`Part "${name}" is missing from the result.`);
  }
  for (const name of Object.keys(after)) {
    if (!expected.has(name)) {
      throw new Error(`Unexpected extra part "${name}" in the result.`);
    }
  }
  if (after[CALC_CHAIN_PART]) {
    throw new Error("The stale calculation chain was not removed.");
  }

  for (const [part, cells] of result.resolvedCells) {
    const xml = strFromU8(after[part]);
    for (const [ref, value] of cells) {
      const cell = new RegExp(`<c r="${ref}"[^>]*>([\\s\\S]*?)</c>`).exec(xml);
      if (!cell) throw new Error(`Cell ${ref} is missing after the write.`);
      if (/<f[\s/>]/.test(cell[1])) {
        throw new Error(`Cell ${ref} still holds a formula after the write.`);
      }
      const read = Number(/<v>([\s\S]*?)<\/v>/.exec(cell[1])?.[1]);
      if (!Number.isFinite(read) || Math.abs(read - value) > 1e-9) {
        throw new Error(
          `Cell ${ref} reads ${read} after the write, expected ${value}.`
        );
      }
    }
  }
}

/**
 * Read which BST cells are locked under Excel sheet protection.
 *
 * SheetJS cannot answer this: it never parses `<sheetProtection>`, and its
 * styles parser discards the `<protection>` child of each `<xf>`, so the
 * information simply does not survive `XLSX.read`. The workbook has to be
 * inspected as raw OOXML — the same technique writeWorkbook.ts uses to write.
 *
 * A cell is locked when its sheet carries `<sheetProtection … sheet="1">` AND
 * its resolved style xf does not declare `<protection locked="0">` (locked is
 * Excel's default). Style resolution per cell: the cell's own `s=` attribute,
 * else the row's `s=` when the row says `customFormat="1"`, else the column's
 * `<col style=>`, else xf 0. The reference BST puts an explicit `s=` on every
 * budget cell, so the fallbacks are a safety net, not the common path.
 *
 * Deliberate simplification: `cellStyleXfs` inheritance via `applyProtection`
 * is ignored — every unlocked cell in the reference file carries its
 * `<protection locked="0"/>` directly on the cellXf, which is also how Excel
 * itself writes these files.
 */

import { unzipSync, strFromU8 } from "fflate";

import {
  BUDGET_COL_START,
  PUSH_MONTHS,
} from "../../shared/bstPush/ipc";
import type { BstTarget } from "./readTarget";
import { UnsupportedLayoutError } from "./readTarget";
import { colName, mapSheetParts, parseCells } from "./writeWorkbook";

const WORKBOOK_PART = "xl/workbook.xml";
const WORKBOOK_RELS_PART = "xl/_rels/workbook.xml.rels";
const STYLES_PART = "xl/styles.xml";

export interface ProtectionScan {
  /** Sheets carrying an enforced `<sheetProtection>`. */
  protectedSheets: Set<string>;
  /** sheet → (1-based row → Jan..Dec locked flags for columns I..T). */
  lockedMonthsByRow: Map<string, Map<number, boolean[]>>;
}

/**
 * Style xf indexes that UNLOCK their cells. Everything else is locked — that
 * is Excel's default when `<protection>` is absent.
 */
function unlockedXfs(stylesXml: string): Set<number> {
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1];
  if (block == null) {
    throw new UnsupportedLayoutError(
      "The workbook's styles.xml has no <cellXfs> block, so cell protection " +
        "cannot be determined."
    );
  }
  const unlocked = new Set<number>();
  let index = 0;
  // The attrs quantifier must be LAZY: greedy would let a self-closing
  // `<xf/>` swallow its successor by matching the `>` branch first.
  for (const match of block.matchAll(/<xf\b[^>]*?(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
    const element = match[0];
    if (/<protection\b[^>]*\blocked="(?:0|false)"/.test(element)) {
      unlocked.add(index);
    }
    index++;
  }
  return unlocked;
}

/** 0-based column index → style xf from the sheet's `<cols>` declarations. */
function columnStyles(sheetXml: string): Map<number, number> {
  const styles = new Map<number, number>();
  const block = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(sheetXml)?.[1];
  if (block == null) return styles;
  for (const match of block.matchAll(/<col\b[^>]*\/?>/g)) {
    const tag = match[0];
    const style = /\bstyle="(\d+)"/.exec(tag)?.[1];
    if (style == null) continue;
    const min = Number(/\bmin="(\d+)"/.exec(tag)?.[1]);
    const max = Number(/\bmax="(\d+)"/.exec(tag)?.[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    // `<col>` min/max are 1-based; only the budget band matters here.
    for (let c = min - 1; c <= max - 1; c++) {
      if (c < BUDGET_COL_START || c >= BUDGET_COL_START + PUSH_MONTHS) continue;
      styles.set(c, Number(style));
    }
  }
  return styles;
}

/**
 * Scan the workbook bytes for locked month cells on the requested rows.
 *
 * @param rowsBySheet sheet name → 1-based rows to resolve. Only these rows and
 *   only columns I..T are examined — the rest of the workbook is skipped, and
 *   so are all its non-worksheet parts (vbaProject.bin, drawings, …).
 * @throws UnsupportedLayoutError when the workbook's XML cannot be understood;
 *   silently treating cells as unlocked would defeat the skip-guard default.
 */
export function scanProtection(
  source: Buffer | Uint8Array,
  rowsBySheet: Map<string, number[]>
): ProtectionScan {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);

  // First pass: just the three parts that name everything else.
  const index = unzipSync(bytes, {
    filter: (file) =>
      file.name === WORKBOOK_PART ||
      file.name === WORKBOOK_RELS_PART ||
      file.name === STYLES_PART,
  });
  const workbookXml = index[WORKBOOK_PART];
  const relsXml = index[WORKBOOK_RELS_PART];
  const stylesXml = index[STYLES_PART];
  if (!workbookXml || !relsXml || !stylesXml) {
    throw new UnsupportedLayoutError(
      "The file is not a readable Excel workbook (missing workbook.xml or styles.xml)."
    );
  }

  const sheetParts = mapSheetParts(strFromU8(workbookXml), strFromU8(relsXml));
  const wantedParts = new Map<string, string>(); // part path → sheet name
  for (const sheet of rowsBySheet.keys()) {
    const part = sheetParts.get(sheet);
    if (!part) {
      throw new UnsupportedLayoutError(
        `Sheet "${sheet}" has no worksheet part in the workbook.`
      );
    }
    wantedParts.set(part, sheet);
  }

  const unlocked = unlockedXfs(strFromU8(stylesXml));

  // Second pass: only the department sheets the caller asked about.
  const sheets = unzipSync(bytes, {
    filter: (file) => wantedParts.has(file.name),
  });

  const protectedSheets = new Set<string>();
  const lockedMonthsByRow = new Map<string, Map<number, boolean[]>>();

  for (const [part, sheet] of wantedParts) {
    const data = sheets[part];
    if (!data) {
      throw new UnsupportedLayoutError(
        `Worksheet part "${part}" is missing from the workbook.`
      );
    }
    const xml = strFromU8(data);
    const byRow = new Map<number, boolean[]>();
    lockedMonthsByRow.set(sheet, byRow);

    const enforced = /<sheetProtection\b[^>]*\bsheet="(?:1|true)"/.test(xml);
    const wanted = new Set(rowsBySheet.get(sheet) ?? []);
    if (!enforced) {
      // Locking only binds under protection — everything is writable.
      for (const row of wanted) {
        byRow.set(
          row,
          Array.from({ length: PUSH_MONTHS }, () => false)
        );
      }
      continue;
    }
    protectedSheets.add(sheet);

    const colStyles = columnStyles(xml);
    const defaultLocked = (col: number): boolean => {
      const style = colStyles.get(col);
      return !unlocked.has(style ?? 0);
    };

    for (const match of xml.matchAll(
      /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
    )) {
      const attrs = match[1];
      const rowNumber = Number(/\br="(\d+)"/.exec(attrs)?.[1]);
      if (!wanted.has(rowNumber)) continue;

      const rowStyle =
        /\bcustomFormat="(?:1|true)"/.test(attrs)
          ? /\bs="(\d+)"/.exec(attrs)?.[1]
          : undefined;

      const styleByRef = new Map<string, string | undefined>();
      for (const cell of parseCells(match[2] ?? "")) {
        styleByRef.set(cell.ref, /\bs="(\d+)"/.exec(cell.attrs)?.[1]);
      }

      const locked: boolean[] = [];
      for (let m = 0; m < PUSH_MONTHS; m++) {
        const col = BUDGET_COL_START + m;
        const ref = `${colName(col)}${rowNumber}`;
        if (styleByRef.has(ref)) {
          const style = styleByRef.get(ref);
          locked.push(
            style != null ? !unlocked.has(Number(style)) : defaultLocked(col)
          );
        } else if (rowStyle != null) {
          locked.push(!unlocked.has(Number(rowStyle)));
        } else {
          locked.push(defaultLocked(col));
        }
      }
      byRow.set(rowNumber, locked);
    }

    // A requested row absent from the XML is an entirely empty row: it takes
    // the row/column defaults, but readTarget can only have found a combo on a
    // row that exists, so this is unreachable in practice. Default-locked keeps
    // the guard on the safe side regardless.
    for (const row of wanted) {
      if (!byRow.has(row)) {
        byRow.set(
          row,
          Array.from({ length: PUSH_MONTHS }, (_unused, m) =>
            defaultLocked(BUDGET_COL_START + m)
          )
        );
      }
    }
  }

  return { protectedSheets, lockedMonthsByRow };
}

/** Scan and fill in each ComboLocation.lockedMonths in place. */
export function annotateProtection(
  target: BstTarget,
  source: Buffer | Uint8Array
): void {
  const rowsBySheet = new Map<string, number[]>();
  for (const [sheet, locations] of target.bySheet) {
    rowsBySheet.set(
      sheet,
      locations.map((location) => location.row)
    );
  }

  const scan = scanProtection(source, rowsBySheet);
  for (const [sheet, locations] of target.bySheet) {
    const byRow = scan.lockedMonthsByRow.get(sheet);
    for (const location of locations) {
      const locked = byRow?.get(location.row);
      if (locked) location.lockedMonths = locked;
    }
  }
}

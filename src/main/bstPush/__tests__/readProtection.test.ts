/**
 * readProtection tests.
 *
 * Hand-authored OOXML, like writeWorkbook's tests, because the interesting
 * cases are exactly what SheetJS cannot produce: sheetProtection elements,
 * cellXfs with protection children, row-level and column-level default styles.
 *
 * Style table used throughout:
 *   xf 0 — default, locked (no <protection>)
 *   xf 1 — explicitly locked="1"
 *   xf 2 — unlocked (locked="0")
 *   xf 3 — unlocked via locked="false" spelling
 */

import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import { scanProtection } from "../readProtection";
import { UnsupportedLayoutError } from "../readTarget";

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="false" hidden="0"/></xf></cellXfs></styleSheet>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="0010" sheetId="1" r:id="rId1"/><sheet name="0020" sheetId="2" r:id="rId2"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;

/**
 * The protected sheet, one row per resolution rung:
 *   row 10 — cells with their own s=: I locked (xf 1), J unlocked (xf 2),
 *            K unlocked via locked="false" (xf 3), L..T absent (default locked,
 *            except where <cols> overrides).
 *   row 20 — no cells in I..T, but customFormat="1" s="2" → row default unlocks.
 *   row 30 — no cells, no row style → falls to <cols>: N..O (min 14 max 15,
 *            1-based) carry style 2 → those two unlock, the rest stay locked.
 *   row 40 — a PRESENT cell with no s= of its own on a styled row: per OOXML
 *            it is style 0, not the row's — the row style covers absent cells.
 */
const SHEET_PROTECTED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetProtection algorithmName="SHA-512" hashValue="abc" saltValue="def" spinCount="100000" sheet="1" scenarios="1"/><cols><col min="14" max="15" width="9" style="2"/></cols><sheetData><row r="10"><c r="I10" s="1"><v>1</v></c><c r="J10" s="2"><v>2</v></c><c r="K10" s="3"><v>3</v></c></row><row r="20" customFormat="1" s="2"><c r="A20"><v>0</v></c></row><row r="30"><c r="A30"><v>0</v></c></row><row r="40" customFormat="1" s="2"><c r="I40"><v>5</v></c><c r="J40" s="1"><v>6</v></c></row></sheetData></worksheet>`;

/** Same shapes, but no sheetProtection — nothing binds, everything writable. */
const SHEET_UNPROTECTED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="10"><c r="I10" s="1"><v>1</v></c></row></sheetData></worksheet>`;

function buildFixture(overrides: Record<string, string> = {}): Uint8Array {
  const parts: Record<string, string> = {
    "xl/workbook.xml": WORKBOOK,
    "xl/_rels/workbook.xml.rels": WORKBOOK_RELS,
    "xl/styles.xml": STYLES,
    "xl/worksheets/sheet1.xml": SHEET_PROTECTED,
    "xl/worksheets/sheet2.xml": SHEET_UNPROTECTED,
    ...overrides,
  };
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])
    )
  );
}

const locked = (
  scan: ReturnType<typeof scanProtection>,
  sheet: string,
  row: number
) => scan.lockedMonthsByRow.get(sheet)!.get(row)!;

describe("scanProtection", () => {
  const scan = scanProtection(
    buildFixture(),
    new Map([
      ["0010", [10, 20, 30, 40]],
      ["0020", [10]],
    ])
  );

  it("reports which sheets enforce protection", () => {
    expect(scan.protectedSheets.has("0010")).toBe(true);
    expect(scan.protectedSheets.has("0020")).toBe(false);
  });

  it("resolves a cell's own style, either unlocked spelling included", () => {
    const row10 = locked(scan, "0010", 10);
    expect(row10[0]).toBe(true); // I: xf 1, locked="1"
    expect(row10[1]).toBe(false); // J: xf 2, locked="0"
    expect(row10[2]).toBe(false); // K: xf 3, locked="false"
    expect(row10[3]).toBe(true); // L: absent cell, default xf 0 → locked
  });

  it("falls back to the row style when the row declares one", () => {
    // customFormat="1" s="2" → the whole band inherits the unlocked xf.
    expect(locked(scan, "0010", 20)).toEqual(Array(12).fill(false));
  });

  it("falls back to the column style, then the default", () => {
    const row30 = locked(scan, "0010", 30);
    // <col min="14" max="15" style="2"/> → 0-based cols 13..14 = months 5..6.
    expect(row30[5]).toBe(false);
    expect(row30[6]).toBe(false);
    expect(row30.filter(Boolean)).toHaveLength(10);
  });

  it("treats a present cell without s= as style 0, not the row's style", () => {
    const row40 = locked(scan, "0010", 40);
    // I40 exists with no s= → default xf 0 (locked); the unlocked row style
    // only stands in for cells absent from the XML.
    expect(row40[0]).toBe(true);
    expect(row40[1]).toBe(true); // J40 s="1" — its own locked style
    expect(row40[2]).toBe(false); // K40 absent → the row's unlocked xf 2
  });

  it("treats everything on an unprotected sheet as writable", () => {
    // I10 carries the locked xf, but nothing enforces it.
    expect(locked(scan, "0020", 10)).toEqual(Array(12).fill(false));
  });

  it("scans only the requested rows", () => {
    expect(scan.lockedMonthsByRow.get("0010")!.has(55)).toBe(false);
  });

  it("refuses a workbook it cannot understand rather than guessing", () => {
    // Guessing "unlocked" would silently defeat the skip guard's default.
    const noStyles = zipSync({
      "xl/workbook.xml": strToU8(WORKBOOK),
      "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
      "xl/worksheets/sheet1.xml": strToU8(SHEET_PROTECTED),
    });
    expect(() =>
      scanProtection(noStyles, new Map([["0010", [10]]]))
    ).toThrow(UnsupportedLayoutError);

    const noCellXfs = buildFixture({
      "xl/styles.xml": `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`,
    });
    expect(() =>
      scanProtection(noCellXfs, new Map([["0010", [10]]]))
    ).toThrow(UnsupportedLayoutError);

    expect(() =>
      scanProtection(buildFixture(), new Map([["9999", [1]]]))
    ).toThrow(UnsupportedLayoutError);
  });
});

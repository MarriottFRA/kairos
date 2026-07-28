/**
 * writeWorkbook tests.
 *
 * The fixture is hand-authored OOXML rather than a SheetJS-written workbook,
 * because the things that can go wrong here are exactly the things SheetJS
 * would not produce: cached formula values, shared formulas, self-closing
 * cells, a calcChain, and opaque binary parts (standing in for vbaProject.bin)
 * that must survive byte-for-byte.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  applyWritesToSheet,
  colIndex,
  colName,
  mapSheetParts,
  setFullCalcOnLoad,
  verifyWrite,
  writeWorkbook,
} from "../writeWorkbook";
import { applyToFile, backupPathFor } from "../applyToFile";
import { UnsupportedLayoutError, readTarget } from "../readTarget";
import type { CellWrite } from "../plan";
import {
  DEFAULT_CLEAR_PREFIXES,
  matchesClearRules,
} from "../../../shared/bstPush/ipc";
import { parseWorkbook } from "../../budgetImport/parseWorkbook";

// ── Fixture ─────────────────────────────────────────────────────────

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookProtection lockStructure="1"/><sheets><sheet name="0010" sheetId="1" r:id="rId1"/><sheet name="F&amp;B" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029"/></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>`;

/**
 * Row 21: a fully populated formula row (I..T), with a single-row shared group
 *         spanning past T — exactly the shape the real BST uses.
 * Row 33: I..T are empty, style-only, self-closing cells.
 * Row 40: only some month cells exist; the rest must be inserted in order.
 */
const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:AT60"/><sheetProtection algorithmName="SHA-512" hashValue="abc" sheet="1"/><sheetData><row r="2"><c r="E2" t="str"><f>"0010"</f><v>0010</v></c></row><row r="21" spans="1:52" ht="12.75"><c r="A21" s="29" t="s"><v>32</v></c><c r="B21" s="40" t="str"><f>$E$2&amp;"-510000"</f><v>0010-510000</v></c><c r="G21" s="23"><f t="shared" ref="G21:G25" si="1">SUM(I21:T21)</f><v>99</v></c><c r="I21" s="588"><f t="shared" ref="I21:AT21" si="2">IFERROR(($V$21/$V$315)*$I$315,0)</f><v>55.5</v></c><c r="J21" s="588"><f t="shared" si="2"/><v>56.5</v></c><c r="K21" s="588"><f>IFERROR(1,0)</f><v>57.5</v></c><c r="L21" s="588"><v>0</v></c><c r="M21" s="588"/><c r="N21" s="588"/><c r="O21" s="588"/><c r="P21" s="588"/><c r="Q21" s="588"/><c r="R21" s="588"/><c r="S21" s="588"/><c r="T21" s="588"/><c r="V21" s="589"><v>7</v></c></row><row r="33" spans="1:52"><c r="B33" s="40" t="str"><f>$E$2&amp;"-560320"</f><v>0010-560320</v></c><c r="I33" s="588"/><c r="J33" s="588"/><c r="T33" s="588"/></row><row r="40" spans="1:52"><c r="B40" s="40" t="str"><f>$E$2&amp;"-988000"</f><v>0010-988000</v></c><c r="A40" s="1" t="s"><v>9</v></c><c r="U40" s="7"><v>3</v></c></row><row r="55" spans="1:52"/></sheetData></worksheet>`;

const SHEET2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>`;

const CALC_CHAIN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="I21" i="1"/><c r="G21" i="1"/></calcChain>`;

/** Opaque bytes standing in for vbaProject.bin — must survive untouched. */
const VBA = new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 37) % 256));

function buildFixture(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    "xl/workbook.xml": strToU8(WORKBOOK),
    "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": strToU8(SHEET1),
    "xl/worksheets/sheet2.xml": strToU8(SHEET2),
    "xl/calcChain.xml": strToU8(CALC_CHAIN),
    "xl/vbaProject.bin": VBA,
    "xl/printerSettings/printerSettings1.bin": VBA.slice(0, 64),
  });
}

const monthWrites = (
  sheet: string,
  row: number,
  value: number,
  add = false
): CellWrite[] =>
  Array.from({ length: 12 }, (_, m) => ({
    sheet,
    row,
    col: 8 + m,
    value,
    ...(add ? { add: true } : {}),
  }));

function sheetXmlOf(bytes: Uint8Array, part = "xl/worksheets/sheet1.xml"): string {
  return strFromU8(unzipSync(bytes)[part]);
}

// ── Column maths ────────────────────────────────────────────────────

describe("column helpers", () => {
  it("round-trips the columns that matter", () => {
    expect(colName(0)).toBe("A");
    expect(colName(8)).toBe("I");
    expect(colName(19)).toBe("T");
    expect(colName(26)).toBe("AA");
    expect(colName(45)).toBe("AT");
    for (const name of ["A", "I", "T", "Z", "AA", "AT", "BB"]) {
      expect(colName(colIndex(name))).toBe(name);
    }
  });
});

describe("mapSheetParts", () => {
  it("maps display names, decoding XML entities", () => {
    const parts = mapSheetParts(WORKBOOK, WORKBOOK_RELS);
    expect(parts.get("0010")).toBe("xl/worksheets/sheet1.xml");
    expect(parts.get("F&B")).toBe("xl/worksheets/sheet2.xml");
  });
});

// ── The shape guard ─────────────────────────────────────────────────

describe("the per-cell safety guard", () => {
  it("accepts the reference shape", () => {
    expect(() =>
      applyWritesToSheet("0010", SHEET1, monthWrites("0010", 21, 1))
    ).not.toThrow();
  });

  it("refuses to write a cell inside an array formula", () => {
    const xml = SHEET1.replace(
      '<c r="K21" s="588"><f>',
      '<c r="K21" s="588"><f t="array" ref="K21:K22">'
    );
    expect(() =>
      applyWritesToSheet("0010", xml, monthWrites("0010", 21, 1))
    ).toThrow(UnsupportedLayoutError);
  });

  it("allows a master whose real members are all being replaced", () => {
    // The fixture's group is declared ref="I21:AT21" but its only members are
    // I21 (master) and J21 — both inside the push. A bounding-box check would
    // refuse this; membership is what counts.
    expect(() =>
      applyWritesToSheet("0010", SHEET1, monthWrites("0010", 21, 1))
    ).not.toThrow();
  });

  it("refuses to orphan a member the push does not replace", () => {
    // Add a sibling at V21 — outside the budget columns, so the push would
    // delete the master it depends on.
    const xml = SHEET1.replace(
      '<c r="V21" s="589"><v>7</v></c>',
      '<c r="V21" s="589"><f t="shared" si="2"/><v>7</v></c>'
    );
    expect(() =>
      applyWritesToSheet("0010", xml, monthWrites("0010", 21, 1))
    ).toThrow(/shared formula/);
  });

  it("ignores multi-row shared groups the push never touches", () => {
    // Real BSTs put 4-row ratio blocks across I..T on rows marked "calc" in
    // column B. Writing a different row must not be blocked by them.
    const xml = SHEET1.replace(
      "<row r=\"55\" spans=\"1:52\"/>",
      '<row r="25"><c r="I25" s="1"><f t="shared" ref="I25:T28" si="9">IFERROR(I7/I$418,"")</f><v>0.5</v></c></row><row r="55" spans="1:52"/>'
    );
    expect(() =>
      applyWritesToSheet("0010", xml, monthWrites("0010", 33, 1))
    ).not.toThrow();
  });

  it("refuses inline text where a number belongs", () => {
    const xml = SHEET1.replace(
      '<c r="L21" s="588"><v>0</v></c>',
      '<c r="L21" s="588" t="inlineStr"><is><t>x</t></is></c>'
    );
    expect(() =>
      applyWritesToSheet("0010", xml, monthWrites("0010", 21, 1))
    ).toThrow(/inline text/);
  });
});

// ── Writing cells ───────────────────────────────────────────────────

describe("applyWritesToSheet", () => {
  it("replaces formulas with constants and keeps the style", () => {
    const { xml, changed } = applyWritesToSheet(
      "0010",
      SHEET1,
      monthWrites("0010", 21, 12.5)
    );
    expect(changed).toBe(12);
    expect(xml).toContain('<c r="I21" s="588"><v>12.5</v></c>');
    expect(xml).toContain('<c r="T21" s="588"><v>12.5</v></c>');
    // Every formula in the band is gone…
    expect(xml).not.toContain("IFERROR");
    // …but the totals column keeps its own shared formula.
    expect(xml).toContain('<f t="shared" ref="G21:G25" si="1">SUM(I21:T21)</f>');
  });

  it("fills empty self-closing cells without disturbing the row", () => {
    const { xml } = applyWritesToSheet("0010", SHEET1, monthWrites("0010", 33, 4));
    expect(xml).toContain('<c r="I33" s="588"><v>4</v></c>');
    expect(xml).toContain('<c r="T33" s="588"><v>4</v></c>');
    // Column B is a formula and must never be touched.
    expect(xml).toContain('<c r="B33" s="40" t="str"><f>$E$2&amp;"-560320"</f>');
  });

  it("inserts missing cells in column order", () => {
    const { xml } = applyWritesToSheet("0010", SHEET1, monthWrites("0010", 40, 2));
    const row = /<row r="40"[^>]*>([\s\S]*?)<\/row>/.exec(xml)![1];
    const order = [...row.matchAll(/<c r="([A-Z]+)40"/g)].map((m) => m[1]);
    expect(order).toEqual([
      "B", "A", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U",
    ]);
    // The pre-existing U40 value survives, after the inserted block.
    expect(row).toContain('<c r="U40" s="7"><v>3</v></c>');
  });

  it("adds to the cached value in additive mode", () => {
    const { xml, resolved } = applyWritesToSheet(
      "0010",
      SHEET1,
      monthWrites("0010", 21, 10, true)
    );
    // I21 cached 55.5 → 65.5; M21 was empty → 10.
    expect(xml).toContain('<c r="I21" s="588"><v>65.5</v></c>');
    expect(xml).toContain('<c r="M21" s="588"><v>10</v></c>');
    expect(resolved.get("I21")).toBe(65.5);
    expect(resolved.get("M21")).toBe(10);
  });

  it("leaves untouched rows exactly as they were", () => {
    const { xml } = applyWritesToSheet("0010", SHEET1, monthWrites("0010", 33, 1));
    expect(xml).toContain('<row r="55" spans="1:52"/>');
    expect(xml).toContain('<c r="V21" s="589"><v>7</v></c>');
  });
});

describe("setFullCalcOnLoad", () => {
  it("adds the attribute, preserving the tag's form", () => {
    expect(setFullCalcOnLoad(WORKBOOK)).toContain(
      '<calcPr calcId="191029" fullCalcOnLoad="1"/>'
    );
  });

  it("is idempotent", () => {
    const once = setFullCalcOnLoad(WORKBOOK);
    expect(setFullCalcOnLoad(once)).toBe(once);
  });
});

// ── The whole workbook ──────────────────────────────────────────────

describe("writeWorkbook", () => {
  const source = buildFixture();
  const writes = [...monthWrites("0010", 21, 12.5), ...monthWrites("0010", 33, 0)];
  const result = writeWorkbook(source, writes);

  it("writes the cells it was asked to", () => {
    expect(result.cellsWritten).toBe(24);
    expect(result.sheetsTouched).toBe(1);
    const xml = sheetXmlOf(result.bytes);
    expect(xml).toContain('<c r="I21" s="588"><v>12.5</v></c>');
    expect(xml).toContain('<c r="I33" s="588"><v>0</v></c>');
  });

  it("leaves EVERY untouched part byte-for-byte identical", () => {
    const before = unzipSync(source);
    const after = unzipSync(result.bytes);
    const mutable = new Set([
      "xl/worksheets/sheet1.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "[Content_Types].xml",
      "xl/calcChain.xml",
    ]);

    for (const name of Object.keys(before)) {
      if (mutable.has(name)) continue;
      expect(after[name], `${name} is missing`).toBeDefined();
      expect(Array.from(after[name]), `${name} changed`).toEqual(
        Array.from(before[name])
      );
    }
    // Nothing appeared, nothing vanished except calcChain.
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .filter((name) => name !== "xl/calcChain.xml")
        .sort()
    );
  });

  it("keeps the macro project and the protection intact", () => {
    const after = unzipSync(result.bytes);
    expect(Array.from(after["xl/vbaProject.bin"])).toEqual(Array.from(VBA));
    expect(sheetXmlOf(result.bytes)).toContain("<sheetProtection");
    expect(strFromU8(after["xl/workbook.xml"])).toContain(
      '<workbookProtection lockStructure="1"/>'
    );
  });

  it("drops the stale calculation chain and forces a recalc on open", () => {
    const after = unzipSync(result.bytes);
    expect(after["xl/calcChain.xml"]).toBeUndefined();
    expect(strFromU8(after["[Content_Types].xml"])).not.toContain("calcChain");
    expect(strFromU8(after["xl/_rels/workbook.xml.rels"])).not.toContain(
      "calcChain.xml"
    );
    expect(strFromU8(after["xl/workbook.xml"])).toContain('fullCalcOnLoad="1"');
  });

  it("passes its own verification", () => {
    expect(() => verifyWrite(result.bytes, result)).not.toThrow();
  });

  it("verification catches a workbook that lost a part", () => {
    const broken = unzipSync(result.bytes);
    delete broken["xl/vbaProject.bin"];
    expect(() => verifyWrite(zipSync(broken), result)).toThrow(/missing/);
  });

  it("refuses a sheet it cannot address", () => {
    expect(() => writeWorkbook(source, monthWrites("9999", 1, 1))).toThrow(
      UnsupportedLayoutError
    );
  });
});

// ── The safety layer ────────────────────────────────────────────────

describe("backupPathFor", () => {
  it("names the copy beside the original, stamped", () => {
    const at = new Date(2026, 6, 27, 14, 32);
    expect(backupPathFor(path.join("C:", "b", "Budget.xlsm"), at)).toBe(
      path.join("C:", "b", "Budget (Kairos backup 2026-07-27 1432).xlsm")
    );
  });
});

describe("applyToFile", () => {
  it("backs up, swaps atomically, and leaves a readable workbook", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kairos-bst-test-"));
    const file = path.join(dir, "Budget.xlsm");
    fs.writeFileSync(file, buildFixture());
    const originalBytes = fs.readFileSync(file);

    const applied = applyToFile(file, monthWrites("0010", 21, 7.25), {
      backup: true,
      now: () => new Date(2026, 6, 27, 14, 32),
    });

    expect(applied.cellsWritten).toBe(12);
    expect(applied.backupPath).toBe(
      path.join(dir, "Budget (Kairos backup 2026-07-27 1432).xlsm")
    );
    // The backup is the untouched original…
    expect(Array.from(fs.readFileSync(applied.backupPath!))).toEqual(
      Array.from(originalBytes)
    );
    // …and the file itself now holds the pushed values.
    expect(sheetXmlOf(fs.readFileSync(file))).toContain(
      '<c r="I21" s="588"><v>7.25</v></c>'
    );
    // No temp file left behind.
    expect(fs.readdirSync(dir).some((name) => name.includes(".tmp"))).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the original untouched when the workbook is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kairos-bst-test-"));
    const file = path.join(dir, "Budget.xlsm");
    fs.writeFileSync(file, buildFixture());
    const before = Array.from(fs.readFileSync(file));

    expect(() =>
      applyToFile(file, monthWrites("9999", 1, 1), { backup: false })
    ).toThrow(UnsupportedLayoutError);

    expect(Array.from(fs.readFileSync(file))).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(["Budget.xlsm"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── Opt-in: the real 15 MB macro-enabled workbook ───────────────────
// The fixture proves the mechanics; this proves them at the scale and shape
// that actually ships — 568 parts, a 3.2 MB VBA project, sheet protection, and
// ~19,000 shared-formula cells inside the write band.

const realFile = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Downloads",
  "2027 BGT_Spread_File - 75AZB Bvlgari Hotel Roma.xlsm"
);
const hasRealFile = (() => {
  try {
    return fs.existsSync(realFile);
  } catch {
    return false;
  }
})();

describe.runIf(hasRealFile)("writeWorkbook (real 75AZB file)", () => {
  it("rewrites a real BST, preserving every part it did not target", () => {
    const source = fs.readFileSync(realFile);
    const before = unzipSync(source);

    // Rows verified against the reference workbook: 0010-510600 is row 178,
    // 0410-988112 (standard work week hours) is row 269.
    const writes = [
      ...monthWrites("0010", 178, 61.25),
      ...monthWrites("0410", 269, 41.2),
    ];

    const started = Date.now();
    const result = writeWorkbook(source, writes);
    const elapsed = Date.now() - started;
    // Not an assertion about speed so much as a tripwire: this is a
    // user-facing button, and a regression here would be felt.
    expect(elapsed).toBeLessThan(30_000);

    verifyWrite(result.bytes, result);
    expect(result.cellsWritten).toBe(24);
    expect(result.sheetsTouched).toBe(2);

    const after = unzipSync(result.bytes);

    // Part inventory: only calcChain is gone.
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .filter((name) => name !== "xl/calcChain.xml")
        .sort()
    );

    // Every part except the four kinds we touch is byte-identical — the 3.2 MB
    // macro project, all 110 sheets we did not write, styles, drawings, VML,
    // printer settings and custom XML.
    const mutable = new Set([
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "[Content_Types].xml",
      "xl/calcChain.xml",
    ]);
    const touchedSheets = new Set(
      ["0010", "0410"].map((name) =>
        mapSheetParts(
          strFromU8(before["xl/workbook.xml"]),
          strFromU8(before["xl/_rels/workbook.xml.rels"])
        ).get(name)!
      )
    );
    let compared = 0;
    for (const name of Object.keys(before)) {
      if (mutable.has(name) || touchedSheets.has(name)) continue;
      expect(Buffer.compare(Buffer.from(after[name]), Buffer.from(before[name])), `${name} changed`).toBe(0);
      compared++;
    }
    expect(compared).toBeGreaterThan(500);

    // The macro project survives verbatim.
    expect(
      Buffer.compare(
        Buffer.from(after["xl/vbaProject.bin"]),
        Buffer.from(before["xl/vbaProject.bin"])
      )
    ).toBe(0);

    // The touched sheets keep their protection and their prior-year columns,
    // and now hold constants where the driver spread used to be.
    const sheet = strFromU8(after[[...touchedSheets][0]]);
    expect(sheet).toContain("<sheetProtection");
    expect(/<c r="I178"[^>]*><v>61.25<\/v><\/c>/.test(sheet)).toBe(true);
    expect(/<c r="T178"[^>]*><v>61.25<\/v><\/c>/.test(sheet)).toBe(true);
    // Column B stays a formula; the prior-year block is untouched.
    expect(sheet).toContain('$E$2&amp;"-510600"');
    expect(/<c r="V178"[^>]*>/.test(sheet)).toBe(true);
  }, 120_000);

  it("survives a full-scale push across every department sheet", () => {
    // The shape of a real push: zero every payroll/stat row in the workbook,
    // then write values back. This is what caught the F&B template's 4-row
    // shared-formula ratio blocks, which a sheet-wide guard wrongly refused.
    const source = fs.readFileSync(realFile);
    const target = readTarget(source, path.basename(realFile));

    const writes: CellWrite[] = [];
    for (const locations of target.bySheet.values()) {
      for (const location of locations) {
        const account = location.combo.slice(5);
        if (!matchesClearRules(account, DEFAULT_CLEAR_PREFIXES)) continue;
        for (let m = 0; m < 12; m++) {
          writes.push({ sheet: location.sheet, row: location.row, col: 8 + m, value: 0 });
        }
        if (account.startsWith("5106")) {
          for (let m = 0; m < 12; m++) {
            writes.push({
              sheet: location.sheet,
              row: location.row,
              col: 8 + m,
              value: 40 + m,
            });
          }
        }
      }
    }

    expect(writes.length).toBeGreaterThan(40_000);
    const result = writeWorkbook(source, writes);
    verifyWrite(result.bytes, result);
    expect(result.cellsWritten).toBe(writes.length);
    expect(result.sheetsTouched).toBeGreaterThan(30);

    // The whole workbook still parses, and the macro project is untouched.
    const after = unzipSync(result.bytes);
    expect(
      Buffer.compare(
        Buffer.from(after["xl/vbaProject.bin"]),
        Buffer.from(unzipSync(source)["xl/vbaProject.bin"])
      )
    ).toBe(0);
    expect(parseWorkbook(Buffer.from(result.bytes), "pushed.xlsm").rows.length)
      .toBeGreaterThan(200);
  }, 180_000);

  it("round-trips: what the push writes, the pull reads back", () => {
    // The strongest check the two features can give each other. Push known
    // values in BST units, then run the actual budget-import parser over the
    // result and confirm it recovers them — including the ×1000 currency rule
    // and the units-as-is rule for 9-accounts.
    const pushed = writeWorkbook(fs.readFileSync(realFile), [
      ...monthWrites("0010", 178, 61.25), // 510600 — currency, thousands
      ...monthWrites("0410", 269, 41.2), // 988112 — a stat, raw units
    ]).bytes;

    const dataset = parseWorkbook(Buffer.from(pushed), "pushed.xlsm");
    const wage = dataset.rows.find((row) => row.combo === "0010-510600")!;
    const hours = dataset.rows.find((row) => row.combo === "0410-988112")!;

    // Bucket 1 (the BUDGET block, columns I..T) is what a push targets.
    expect(wage.cells.slice(0, 12)).toEqual(new Array(12).fill(61_250));
    expect(hours.cells.slice(0, 12)).toEqual(new Array(12).fill(41.2));
  }, 120_000);
});

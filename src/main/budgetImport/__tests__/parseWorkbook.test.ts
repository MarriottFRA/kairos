/**
 * parseWorkbook tests.
 *
 * The core cases build a tiny synthetic workbook in-memory (no external files)
 * that reproduces the BGT Spread File layout: a "Setup Fields" metadata sheet,
 * a 4-digit department sheet, a "MarketSeg Raw data" sheet, and a non-data sheet
 * that must be ignored. A second, opt-in block spot-checks the real example
 * files when they are present in the user's Downloads folder.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import { parseWorkbook, isDataSheet } from "../parseWorkbook";
import { WIDE_CELL_COUNT } from "../../../shared/budgetImport/ipc";

/** Cell helpers for hand-building the Setup Fields sheet. */
function setupSheet(): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = { "!ref": "A1:AT50" };
  const put = (addr: string, v: string) => {
    (ws as any)[addr] = { t: "s", v };
  };
  put("B3", "Aloft Madrid Gran Via");
  put("B5", "XMWX4");
  put("B7", "EUR");
  put("B9", "Jun-26");
  put("D5", "1LWX4");
  put("I46", "BUDGET");
  put("V46", "ACT/FCST");
  put("AI46", "ACTUAL");
  put("I47", "Yr 2027");
  put("V47", "Yr 2026");
  put("AI47", "Yr 2025");
  return ws;
}

/** Build a 46-wide data row: desc in A, combo in B, the three month blocks. */
function dataRow(
  combo: string,
  desc: string,
  b1: number,
  b2: number,
  b3: number
): unknown[] {
  const row: unknown[] = new Array(46).fill(null);
  row[0] = desc;
  row[1] = combo;
  for (let m = 0; m < 12; m++) {
    row[8 + m] = b1 + m; // I..T
    row[21 + m] = b2 + m; // V..AG
    row[34 + m] = b3 + m; // AI..AT
  }
  return row;
}

function buildWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, setupSheet(), "Setup Fields");

  // Department sheet "0010": one real combo row, one subtotal row to skip, and
  // one all-zero combo row that must be dropped.
  const dept: unknown[][] = [];
  dept[6] = dataRow("0010-414001", "Total Rooms", 101, 201, 301); // Excel row 7
  dept[7] = [null, "RmRev", 9, 9, 9]; // subtotal label, must be skipped
  const zeroRow: unknown[] = new Array(46).fill(null);
  zeroRow[0] = "All zero";
  zeroRow[1] = "0010-499999"; // combo present but every month blank → dropped
  dept[8] = zeroRow;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dept), "0010");

  // Market-segment sheet with its own combo.
  const seg: unknown[][] = [];
  seg[8] = dataRow("0010-961010", "Premium", 10, 20, 30); // Excel row 9
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(seg),
    "MarketSeg Raw data"
  );

  // A rollup sheet whose B column has a combo-looking value — must be ignored
  // because "Rooms" is not a data sheet.
  const rollup: unknown[][] = [];
  rollup[6] = dataRow("9999-999999", "should be ignored", 1, 1, 1);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rollup), "Rooms");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("isDataSheet", () => {
  it("accepts 4-digit dept sheets and MarketSeg, rejects the rest", () => {
    expect(isDataSheet("0010")).toBe(true);
    expect(isDataSheet("0190")).toBe(true);
    expect(isDataSheet("MarketSeg Raw data")).toBe(true);
    expect(isDataSheet("Rooms")).toBe(false);
    expect(isDataSheet("tpl_rooms")).toBe(false);
    expect(isDataSheet("Setup Fields")).toBe(false);
  });
});

describe("parseWorkbook (synthetic)", () => {
  const dataset = parseWorkbook(buildWorkbook(), "test.xlsx");

  it("reads Setup Fields metadata and normalizes the OU", () => {
    expect(dataset.meta.ou).toBe("OU1LWX4");
    expect(dataset.meta.hotelName).toBe("Aloft Madrid Gran Via");
    expect(dataset.meta.bu).toBe("XMWX4");
    expect(dataset.meta.currency).toBe("EUR");
    expect(dataset.meta.asOfPeriod).toBe("Jun-26");
    expect(dataset.meta.sourceFileName).toBe("test.xlsx");
  });

  it("reads the three self-describing buckets (type + rotated year)", () => {
    expect(dataset.buckets).toEqual([
      { index: 1, type: "BUDGET", year: 2027 },
      { index: 2, type: "ACT/FCST", year: 2026 },
      { index: 3, type: "ACTUAL", year: 2025 },
    ]);
  });

  it("keeps valid combos, skipping subtotals, rollups, and all-zero rows", () => {
    const combos = dataset.rows.map((r) => r.combo).sort();
    expect(combos).toEqual(["0010-414001", "0010-961010"]);
  });

  it("normalizes dept/account (D/A prefixes) and lays out the 36 cells", () => {
    const row = dataset.rows.find((r) => r.combo === "0010-414001")!;
    expect(row.dept).toBe("D0010");
    expect(row.account).toBe("A414001");
    expect(row.description).toBe("Total Rooms");
    expect(row.cells).toHaveLength(WIDE_CELL_COUNT);
  });

  it("scales non-A9 accounts by 1000, keeping A9 accounts as-is", () => {
    // 414001 is not an A9 account → thousands → ×1000.
    const pl = dataset.rows.find((r) => r.combo === "0010-414001")!;
    expect(pl.cells[0]).toBe(101_000); // bucket1 Jan
    expect(pl.cells[11]).toBe(112_000); // bucket1 Dec
    expect(pl.cells[24]).toBe(301_000); // bucket3 Jan

    // 961010 is an A9 account → actual units → unscaled.
    const a9 = dataset.rows.find((r) => r.combo === "0010-961010")!;
    expect(a9.account).toBe("A961010");
    expect(a9.cells[0]).toBe(10); // bucket1 Jan (from dataRow base 10)
    expect(a9.cells[24]).toBe(30); // bucket3 Jan (from dataRow base 30)
  });

  it("throws on a workbook without a Setup Fields sheet", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1]]), "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(() => parseWorkbook(buf, "bad.xlsx")).toThrow(/Setup Fields/);
  });
});

// Opt-in spot check against a real example file, when present locally.
const realFile = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Downloads",
  "2027 BGT_Spread_File - 1LWX4 Aloft Madrid Gran Via.xlsm"
);
const hasRealFile = (() => {
  try {
    return fs.existsSync(realFile);
  } catch {
    return false;
  }
})();

describe.runIf(hasRealFile)("parseWorkbook (real 1LWX4 file)", () => {
  it("extracts the expected OU, buckets, normalized codes and non-empty rows", () => {
    const dataset = parseWorkbook(fs.readFileSync(realFile), path.basename(realFile));
    expect(dataset.meta.ou).toBe("OU1LWX4");
    expect(dataset.buckets[0].year).toBe(2027);
    expect(dataset.buckets[1].year).toBe(2026);
    expect(dataset.buckets[2].year).toBe(2025);
    // Plenty of real data, and every kept row is normalized + non-empty.
    expect(dataset.rows.length).toBeGreaterThan(200);
    expect(dataset.rows.every((r) => /^D\d{4}$/.test(r.dept))).toBe(true);
    expect(dataset.rows.every((r) => /^A\d{6}$/.test(r.account))).toBe(true);
    expect(dataset.rows.every((r) => r.cells.some((c) => c !== 0))).toBe(true);
  });
});

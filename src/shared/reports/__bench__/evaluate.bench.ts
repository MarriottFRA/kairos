/**
 * Report engine benchmark — the perf target from the plan: a report of ~100
 * measures over ~2,000 dept × account rows with ~5,000-row maps should
 * evaluate in single-digit milliseconds once the sources are built, and the
 * build itself (rows + maps → indexes) should stay well under 100 ms.
 *
 * As with kernel.bench.ts: vitest's harness inflates absolute numbers by
 * roughly 10×, so read these for regression tracking, not as wall-clock
 * promises. `npm run bench -- src/shared/reports`.
 */

import { bench, describe } from "vitest";
import { compileDefinition } from "../compile";
import { evaluateReport } from "../engine";
import { MapRowInput, ValueSourceInput, buildMapIndex, buildValueSource } from "../sources";
import type { Atom, Measure, ReportDefinition, ReportRow } from "../types";

const DEPTS = Array.from({ length: 40 }, (_, i) => `D${String(100 + i * 10).padStart(4, "0")}`);
const ACCOUNTS = Array.from({ length: 50 }, (_, i) => `A5${String(10000 + i * 137).padStart(5, "0")}`);
const STATS = ["A972540", "A988101", "A988102", "A988699"];

function rows(): ValueSourceInput[] {
  const out: ValueSourceInput[] = [];
  for (const dept of DEPTS) {
    for (const account of ACCOUNTS) {
      out.push({
        dept,
        account,
        months: Array.from({ length: 12 }, (_, m) => 1000 + (m * 37) % 100),
      });
    }
    for (const account of STATS) {
      out.push({ dept, account, months: [5, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0], encoding: "LEVEL" });
    }
  }
  return out; // 40 × 54 = 2,160 combos
}

function maps(): { depts: MapRowInput[]; accounts: MapRowInput[] } {
  const level = (entries: Record<number, string>) =>
    Array.from({ length: 31 }, (_, i) => entries[i] ?? null);
  const depts: MapRowInput[] = [];
  for (let i = 0; i < 400; i++) {
    depts.push({
      code: `D${String(100 + i * 10).padStart(4, "0")}`,
      levels: level({ 2: i < 300 ? "Lodging Operations" : "Owner", 7: `Group ${i % 12}` }),
    });
  }
  const accounts: MapRowInput[] = [];
  for (let i = 0; i < 4600; i++) {
    accounts.push({
      code: `A5${String(10000 + i * 137).padStart(5, "0")}`,
      levels: level({ 9: i % 3 === 0 ? "Total Payroll" : "Other", 12: i % 2 === 0 ? "Associate Wages" : "Associate Benefits" }),
    });
  }
  for (const stat of STATS) accounts.push({ code: stat, levels: level({ 9: "Statistics" }) });
  return { depts, accounts };
}

function definition(): ReportDefinition {
  const atoms: Atom[] = [];
  const measures: Measure[] = [];
  const reportRows: ReportRow[] = [];
  for (let i = 0; i < 12; i++) {
    atoms.push({
      id: `wages_g${i}`,
      filters: [
        { kind: "dept_level", level: 7, values: [`Group ${i}`] },
        { kind: "acc_level", level: 12, values: ["Associate Wages"] },
      ],
    });
    atoms.push({
      id: `benefits_g${i}`,
      filters: [
        { kind: "dept_level", level: 7, values: [`Group ${i}`] },
        { kind: "acc_level", level: 12, values: ["Associate Benefits"] },
      ],
    });
    atoms.push({
      id: `heads_g${i}`,
      filters: [
        { kind: "dept_level", level: 7, values: [`Group ${i}`] },
        { kind: "acc_base", codes: ["A972540"] },
      ],
    });
    measures.push({ id: `payroll_g${i}`, formula: `wages_g${i} + benefits_g${i}` });
    measures.push({ id: `per_head_g${i}`, formula: `div(payroll_g${i}, heads_g${i})` });
    measures.push({ id: `benefit_pct_g${i}`, formula: `pct(benefits_g${i}, payroll_g${i})` });
    reportRows.push({ type: "measure", measureId: `payroll_g${i}` });
    reportRows.push({ type: "measure", measureId: `per_head_g${i}` });
    reportRows.push({ type: "measure", measureId: `benefit_pct_g${i}` });
  }
  atoms.push({ id: "all_payroll", filters: [{ kind: "acc_level", level: 9, values: ["Total Payroll"] }] });
  atoms.push({ id: "base_only", filters: [{ kind: "dept_base", codes: DEPTS.slice(0, 5) }, { kind: "acc_prefix", prefixes: ["A51"] }] });
  measures.push({ id: "grand_total", formula: measures.filter((m) => m.id.startsWith("payroll_")).map((m) => m.id).join(" + ") });
  measures.push({ id: "share", formula: "pct(base_only, all_payroll)" });
  reportRows.push({ type: "measure", measureId: "grand_total" });
  reportRows.push({ type: "measure", measureId: "share" });
  return { id: "bench", name: "bench", version: 1, atoms, measures, rows: reportRows };
}

const ROWS = rows();
const MAP_ROWS = maps();
const COMPILED = compileDefinition(definition());
const SOURCE = buildValueSource("kairos", ROWS);
const MAPS = buildMapIndex("v", MAP_ROWS.depts, MAP_ROWS.accounts);

describe("report engine", () => {
  bench("build value source (2,160 combos)", () => {
    buildValueSource("kairos", ROWS);
  });

  bench("build map index (5,000 rows)", () => {
    buildMapIndex("v", MAP_ROWS.depts, MAP_ROWS.accounts);
  });

  bench("evaluate ~40 measures / 38 atoms, warm sources", () => {
    evaluateReport(COMPILED, { getSource: () => SOURCE, maps: MAPS });
  });

  bench("evaluate with a cold map index (level sets rebuilt)", () => {
    evaluateReport(COMPILED, {
      getSource: () => SOURCE,
      maps: buildMapIndex("v", MAP_ROWS.depts, MAP_ROWS.accounts),
    });
  });
});

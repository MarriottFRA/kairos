/**
 * The budget pack in main: the universe of combos across the columns'
 * sources, the page list, one page evaluated, and the whole pack as a
 * workbook.
 *
 * The universe is what makes a pack honest: a department or account present
 * only in the BST (a line the hotel budgets by hand) or only in Kairos (a
 * block posting to an account the BST never held) gets its row either way,
 * because the pages are generated from the union of every series column's
 * primary store. That store is exactly what the column would read, resolved
 * by the same plan the engine uses.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import ExcelJS from "exceljs";
import { ReportColumnSpec, SeriesColumnSpec, isSeriesColumn } from "../../shared/reports/columns";
import { compileDefinition } from "../../shared/reports/compile";
import type {
  ReportsAtomCombosResponse,
  ReportsPackEvaluateResponse,
  ReportsPackPagesResponse,
} from "../../shared/reports/ipc";
import {
  PackLayout,
  PackPage,
  PackUniverse,
  buildPackPageDefinition,
  layoutPack,
  packLabelsOf,
} from "../../shared/reports/packs";
import type { ReportDefinition, ReportWarning } from "../../shared/reports/types";
import type { OuScope } from "../positions/ouScope";
import {
  EvaluateColumnsOptions,
  ReportDbs,
  evaluateReportColumns,
  listAtomCombos,
  planColumns,
} from "./evaluate";
import {
  ReportWorkbookMeta,
  UNPUSHED_WARNING,
  addSourcesSheet,
  includesUnpushedPlan,
} from "./excel/workbook";
import { COLOR, FONT, sanitizeSheetName, solid } from "./excel/styles";
import { writeGridSheet } from "./excel/writeGrid";
import { getMapIndex } from "./mapsIndex";

type Db = InstanceType<typeof Database>;

/** A definition with nothing in it: enough for planColumns to resolve the
 *  columns' sources without reaching any atom. */
const PROBE: ReportDefinition = { id: "pack_probe", name: "probe", version: 1, atoms: [], measures: [], rows: [] };
const PROBE_COMPILED = compileDefinition(PROBE);

interface PackContext {
  universe: PackUniverse;
  layout: PackLayout;
  labels: ReturnType<typeof packLabelsOf>;
}

async function packContext(
  dbs: ReportDbs,
  scope: OuScope,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions
): Promise<PackContext> {
  const plan = await planColumns(dbs, scope, PROBE_COMPILED, columns, options);
  const universe = new Map<string, Set<string>>();
  const swallow = (_warning: ReportWarning): void => undefined;
  for (const spec of columns) {
    if (!isSeriesColumn(spec)) continue;
    const source = plan.contextFor(spec).getSource({ source: "kairos" }, swallow);
    if (!source) continue;
    for (const entry of source.entries) {
      let accounts = universe.get(entry.dept);
      if (!accounts) universe.set(entry.dept, (accounts = new Set()));
      accounts.add(entry.account);
    }
  }
  const labels = packLabelsOf(getMapIndex(dbs.localDb as Db));
  return { universe, labels, layout: layoutPack(universe, labels) };
}

export async function listPackPages(
  dbs: ReportDbs,
  scope: OuScope,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions
): Promise<ReportsPackPagesResponse> {
  const { layout } = await packContext(dbs, scope, columns, options);
  return { pages: layout.pages, departments: layout.departments, groups: layout.groups };
}

export async function evaluatePackPage(
  dbs: ReportDbs,
  scope: OuScope,
  pageId: string,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions
): Promise<ReportsPackEvaluateResponse> {
  const context = await packContext(dbs, scope, columns, options);
  const page = context.layout.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`The budget pack has no page "${pageId}".`);
  return evaluatePage(dbs, scope, page, context, columns, options);
}

/** The drill-down for a generated page: the same universe, the same definition. */
export async function listPackAtomCombos(
  dbs: ReportDbs,
  scope: OuScope,
  pageId: string,
  atomId: string,
  column: SeriesColumnSpec,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions
): Promise<ReportsAtomCombosResponse> {
  const context = await packContext(dbs, scope, columns, options);
  const page = context.layout.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`The budget pack has no page "${pageId}".`);
  const compiled = compileDefinition(buildPackPageDefinition(page, context.layout, context.universe, context.labels));
  return listAtomCombos(dbs, scope, compiled, atomId, column, options);
}

async function evaluatePage(
  dbs: ReportDbs,
  scope: OuScope,
  page: PackPage,
  context: PackContext,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions
): Promise<ReportsPackEvaluateResponse> {
  const definition = buildPackPageDefinition(page, context.layout, context.universe, context.labels);
  const compiled = compileDefinition(definition);
  const response = await evaluateReportColumns(dbs, scope, compiled, columns, options);
  const refs: Record<string, string[]> = {};
  for (const [id, measure] of compiled.measures) refs[id] = [...measure.refs];
  return { ...response, page, detail: { definition, refs } };
}

/** Tab colours per page kind — PS Loader's. */
const TAB_COLOR: Record<PackPage["kind"], string> = {
  summary: COLOR.header,
  summary_reporting: COLOR.header,
  total: COLOR.section,
  group: "FF2D5F8A",
  department: COLOR.separator,
};

/**
 * The whole pack as a workbook: Contents first (a hyperlinked table of the
 * sheets, uppercase group names as its headings), then Summary, Summary
 * reporting, Hotel total, and per group its summary and — when asked — its
 * departments. With `pageId`, that one page alone (plus Sources, no
 * Contents) — how the Reports rail exports a pack page it shows on its own.
 */
export async function buildPackWorkbook(
  dbs: ReportDbs,
  scope: OuScope,
  columns: readonly ReportColumnSpec[],
  options: EvaluateColumnsOptions,
  meta: ReportWorkbookMeta,
  includeDepartments: boolean,
  pageId?: string
): Promise<ExcelJS.Workbook> {
  const context = await packContext(dbs, scope, columns, options);
  if (pageId && !context.layout.pages.some((p) => p.id === pageId)) {
    throw new Error(`The budget pack has no page "${pageId}".`);
  }
  const unpushed = includesUnpushedPlan(columns);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kairos";
  wb.created = meta.generatedAt;
  const taken = new Set<string>();

  let contents: ExcelJS.Worksheet | null = null;
  if (!pageId) {
    const contentsName = sanitizeSheetName("Contents", taken);
    taken.add(contentsName);
    contents = wb.addWorksheet(contentsName, { properties: { tabColor: { argb: COLOR.header } } });
  }

  const entries: Array<{ page: PackPage; sheet: string }> = [];
  let last: ReportsPackEvaluateResponse | null = null;
  for (const page of context.layout.pages) {
    if (pageId ? page.id !== pageId : page.kind === "department" && !includeDepartments) continue;
    const response = await evaluatePage(dbs, scope, page, context, columns, options);
    last = response;
    const sheetName = sanitizeSheetName(
      page.kind === "group" ? `${page.group} SUMMARY` : page.kind === "total" ? "HOTEL TOTAL" : page.title,
      taken
    );
    taken.add(sheetName);
    const ws = wb.addWorksheet(sheetName, { properties: { tabColor: { argb: unpushed ? COLOR.warning : TAB_COLOR[page.kind] } } });
    writeGridSheet(ws, {
      title: response.detail.definition.name,
      subtitle: `${meta.hotelName} · ${meta.scenarioLabel}`,
      generatedAt: meta.generatedAt.toLocaleString(),
      warning: unpushed ? UNPUSHED_WARNING : null,
      rows: response.rows,
      columns: response.columns,
      months: meta.months,
      thousands: meta.thousands === true,
    });
    entries.push({ page, sheet: sheetName });
  }
  if (last) {
    addSourcesSheet(wb, last, { ...meta, reportName: pageId ? last.detail.definition.name : "Budget pack" }, taken);
  }
  if (!contents) return wb;

  // Contents.
  contents.getColumn(1).width = 48;
  contents.getColumn(2).width = 28;
  contents.getCell(1, 1).value = `${meta.hotelName} — Budget pack`;
  contents.getCell(1, 1).font = FONT.title;
  contents.getCell(2, 1).value = meta.scenarioLabel;
  contents.getCell(2, 1).font = FONT.subtitle;
  contents.getCell(3, 1).value = `Generated: ${meta.generatedAt.toLocaleString()}`;
  contents.getCell(3, 1).font = FONT.muted;
  if (unpushed) {
    contents.getCell(4, 1).value = UNPUSHED_WARNING;
    contents.getCell(4, 1).font = FONT.warning;
  }
  let row = 6;
  let currentGroup: string | null = null;
  for (const { page, sheet } of entries) {
    if (page.group && page.group !== currentGroup) {
      currentGroup = page.group;
      const cell = contents.getCell(row, 1);
      cell.value = page.group.toUpperCase();
      cell.font = FONT.bold;
      cell.fill = solid(COLOR.category);
      row += 1;
    }
    const cell = contents.getCell(row, 1);
    cell.value = { text: page.kind === "department" ? `    ${page.title}` : page.title, hyperlink: `#'${sheet}'!A1` };
    cell.font = { size: 10, color: { argb: "FF1D4ED8" }, underline: true };
    contents.getCell(row, 2).value = page.kind;
    contents.getCell(row, 2).font = FONT.muted;
    row += 1;
  }
  return wb;
}

/**
 * The built-in definitions against a fixture that speaks the workbook's
 * vocabulary — the map labels at the levels the "Payroll FTE report
 * definitions" workbook names — so a line here ties to a row there.
 */

import { describe, expect, it } from "vitest";
import { ACC, CODES, DEPT } from "../catalog";
import { findReportDefinition } from "../definitions";
import { EvaluationContext, evaluateReport } from "../engine";
import { buildMapIndex, buildValueSource } from "../sources";

const flat = (value: number) => new Array(12).fill(value);
const levels = (entries: Record<number, string>) =>
  Array.from({ length: 31 }, (_, i) => entries[i] ?? null);

// Departments: Rooms (D0010), Restaurant (D0210), A&G (D0410), Payroll Cost
// Allocation (D0499), a NOI department (D0480 — also the reserve's).
const MAPS = buildMapIndex(
  "v1",
  [
    { code: "D0010", levels: levels({ 2: DEPT.lodgingOperations, 5: DEPT.roomsAndReservation5, 7: DEPT.roomsAndReservation, 10: DEPT.rooms }) },
    { code: "D0210", levels: levels({ 2: DEPT.lodgingOperations, 5: DEPT.totalFoodAndBeverage, 7: DEPT.totalFoodAndBeverage, 14: DEPT.restaurant }) },
    { code: "D0410", levels: levels({ 2: DEPT.lodgingOperations, 7: DEPT.administrativeAndGeneral }) },
    { code: "D0499", levels: levels({ 2: DEPT.lodgingOperations, 7: DEPT.payrollCostAllocation }) },
    { code: "D0480", levels: levels({ 2: DEPT.noi }) },
  ],
  [
    { code: "A300100", levels: levels({ 1: ACC.ebitda, 4: ACC.profitAmount, 6: ACC.revenue }) },
    { code: "A310100", levels: levels({ 1: ACC.ebitda, 4: ACC.profitAmount, 6: ACC.revenue }) },
    { code: "A511000", levels: levels({ 1: ACC.ebitda, 4: ACC.profitAmount, 6: ACC.totalExpenses, 9: ACC.totalPayroll, 12: ACC.associateWages, 15: ACC.totalManagementSalaries }) },
    { code: "A512000", levels: levels({ 1: ACC.ebitda, 4: ACC.profitAmount, 6: ACC.totalExpenses, 9: ACC.totalPayroll, 12: ACC.associateWages, 15: ACC.totalHourlyWages, 21: ACC.hourlyWages }) },
    { code: CODES.vacationLeave, levels: levels({ 1: ACC.ebitda, 4: ACC.profitAmount, 6: ACC.totalExpenses, 9: ACC.totalPayroll, 12: ACC.associateBenefits, 14: ACC.paidTimeOff }) },
    { code: "A610201", levels: levels({ 1: ACC.ebitda, 4: ACC.profitAmount, 6: ACC.totalExpenses }) },
    { code: "A701110", levels: levels({ 1: ACC.noi }) },
    { code: CODES.roomsAvailable, levels: levels({ 1: ACC.statistics }) },
    { code: CODES.roomsSold, levels: levels({ 1: ACC.statistics }) },
    // Manager hours: in Total Manhours, but not in the hours that drive FTE.
    { code: "A988308", levels: levels({ 1: ACC.statistics, 4: ACC.totalManhours, 6: "Non Prod Hours" }) },
    { code: "A988699", levels: levels({ 1: ACC.statistics, 4: ACC.totalManhours, 6: ACC.manhoursExclOvertimeAndManagers, 9: ACC.manHours }) },
    { code: "A988101", levels: levels({ 1: ACC.statistics }) },
  ]
);

const SOURCE = buildValueSource("bst", [
  { dept: "D0010", account: "A300100", months: flat(100000) }, // rooms revenue
  { dept: "D0210", account: "A310100", months: flat(40000) }, // F&B revenue
  { dept: "D0010", account: "A511000", months: flat(10000) }, // rooms mgmt salaries
  { dept: "D0010", account: "A512000", months: flat(15000) }, // rooms hourly wages
  { dept: "D0010", account: CODES.vacationLeave, months: flat(1000) }, // rooms vacation
  { dept: "D0210", account: "A512000", months: flat(12000) }, // restaurant hourly wages
  { dept: "D0410", account: "A511000", months: flat(8000) }, // A&G salaries
  { dept: "D0499", account: "A511000", months: flat(999) }, // payroll cost allocation — excluded from total
  { dept: "D0010", account: "A610201", months: flat(3000) }, // guest supplies
  { dept: "D0480", account: "A701110", months: flat(500) }, // replacement reserve
  { dept: "D0010", account: CODES.roomsAvailable, months: flat(3000) },
  { dept: "D0010", account: CODES.roomsSold, months: flat(2100) },
  { dept: "D0010", account: "A988308", months: flat(4000) }, // manager hours
  { dept: "D0210", account: "A988308", months: flat(2000) },
  { dept: "D0010", account: "A988699", months: flat(3000) }, // staff hours
  { dept: "D0210", account: "A988699", months: flat(1500) },
  { dept: "D0010", account: "A988101", months: [2, ...flat(0).slice(1)], total: 2, encoding: "LEVEL" }, // two managers
]);

const context = (overrides: Partial<EvaluationContext> = {}): EvaluationContext => ({
  getSource: () => SOURCE,
  maps: MAPS,
  ...overrides,
});

const rowsOf = (id: string, ctx = context()) => {
  const report = evaluateReport(findReportDefinition(id)!, ctx);
  return { report, byLabel: new Map(report.rows.map((r) => [r.label, r.values])) };
};

describe("Summary P&L", () => {
  const { report, byLabel } = rowsOf("summary_pl");

  it("computes the rooms block and the sales lines as the workbook defines them", () => {
    expect(report.warnings).toEqual([]);
    expect(byLabel.get("Occupancy")![0]).toBeCloseTo(70);
    expect(byLabel.get("Occupancy")![12]).toBeCloseTo(70); // ratio of the totals
    expect(byLabel.get("ADR Rate")![0]).toBeCloseTo(100000 / 2100);
    expect(byLabel.get("RevPAR")![0]).toBeCloseTo(100000 / 3000);
    expect(byLabel.get("Total Sales")![0]).toBe(140000);
    expect(byLabel.get("Rooms Sales")![0]).toBe(100000);
    expect(byLabel.get("F&B Sales")![0]).toBe(40000);
  });

  it("builds profit as revenue minus expenses, revenue positive", () => {
    // Lodging Operations expenses: 10000+15000+1000+12000+8000+999+3000 = 49999
    expect(byLabel.get("Gross Operating Profit")![0]).toBe(140000 - 49999);
    expect(byLabel.get("Rooms Dept Profit")![0]).toBe(100000 - (10000 + 15000 + 1000 + 3000));
    expect(byLabel.get("F&B Dept Profit")![0]).toBe(40000 - 12000);
    expect(byLabel.get("Department Profit")![0]).toBe(71000 + 28000);
    expect(byLabel.get("Net Operating Income")![0]).toBe(140000 - 49999 + 500 - 500);
  });

  it("uses the hierarchy form of Total Payroll, excluding Payroll Cost Allocation", () => {
    expect(byLabel.get("Total Payroll")![0]).toBe(10000 + 15000 + 1000 + 12000 + 8000);
    expect(byLabel.get("Payroll % per Total Revenue")![0]).toBeCloseTo((46000 / 140000) * 100);
    expect(byLabel.get("Administrative & General w/o CC")![0]).toBe(8000);
    expect(byLabel.get("Room CPOR")![0]).toBeCloseTo(29000 / 2100);
  });
});

describe("Payroll & FTE summary", () => {
  it("breaks payroll down as the workbook's rows do, with no department scope on the wage lines", () => {
    const { report, byLabel } = rowsOf("payroll_fte_summary");
    // Only the params default: hours per FTE was not resolved.
    expect(report.warnings.map((w) => w.code)).toEqual(["PARAM_DEFAULTED"]);
    expect(byLabel.get("Total Payroll")![0]).toBe(46000);
    expect(byLabel.get("Total Wages")![0]).toBe(10000 + 15000 + 12000 + 8000 + 999);
    expect(byLabel.get("Total Management Wages")![0]).toBe(10000 + 8000 + 999);
    expect(byLabel.get("Hourly Wages")![0]).toBe(27000);
    expect(byLabel.get("Vacation Leave")![0]).toBe(1000);
    expect(byLabel.get("Total Benefits")![0]).toBe(1000);
    expect(byLabel.get("Total Rooms")![0]).toBe(26000);
    expect(byLabel.get("Total Restaurant")![0]).toBe(12000);
    expect(byLabel.get("Total Admin & General")![0]).toBe(8000);
    expect(byLabel.get("Rooms Payroll POR")![0]).toBeCloseTo(26000 / 2100);
    expect(byLabel.get("F&B Payroll as % of F&B Revenue")![0]).toBeCloseTo(30);
  });

  it("derives FTE as manager heads plus staff hours over the work week × 52, annualising the wage per FTE", () => {
    const { byLabel, report } = rowsOf(
      "payroll_fte_summary",
      context({ getParam: (p) => (p.builtin === "weekly_hours" ? { months: flat(45), total: 45 } : null) })
    );
    expect(report.warnings).toEqual([]);
    // Every hours account, manager hours included.
    expect(byLabel.get("Total Manhours")![0]).toBe(10500);
    expect(byLabel.get("Total Manhours")![12]).toBe(126000);
    // Only the "excl Overtime and Manager Hours × Man Hours" node drives FTE.
    expect(byLabel.get("Hours driving FTE")![0]).toBe(4500);
    expect(byLabel.get("Hours per FTE")![0]).toBeCloseTo(45 * (52 / 12));
    expect(byLabel.get("Hours per FTE")![12]).toBe(45 * 52);
    const hourly = 4500 / (45 * (52 / 12));
    expect(byLabel.get("Hours-driven")![0]).toBeCloseTo(hourly);
    expect(byLabel.get("Hours-driven")![12]).toBeCloseTo(54000 / 2340); // the year's average, not ×12
    expect(byLabel.get("Managers (heads)")![0]).toBe(2);
    expect(byLabel.get("Managers (heads)")![12]).toBe(2); // a level's year figure is its mean
    expect(byLabel.get("Total FTE")![0]).toBeCloseTo(2 + hourly);
    expect(byLabel.get("Total FTE")![12]).toBeCloseTo(2 + hourly);
    // wages / FTE × 12 in a month; the year's wages / average FTE in the Total.
    const fte = 2 + hourly;
    expect(byLabel.get("Total Average Annual Wage by FTE")![0]).toBeCloseTo((45999 / fte) * 12);
    expect(byLabel.get("Total Average Annual Wage by FTE")![12]).toBeCloseTo((45999 * 12) / fte);
  });
});

describe("Rooms & Reservation KPIs", () => {
  it("prices supplies per room night sold and shares of room sales", () => {
    const { byLabel } = rowsOf("rooms_kpi");
    expect(byLabel.get("Guest Supplies")![0]).toBeCloseTo(3000 / 2100);
    expect(byLabel.get("Payroll")![0]).toBeCloseTo(26);
    // Controllables = Profit Amount less Revenue, Total Payroll: the supplies.
    expect(byLabel.get("Other Expenses")![0]).toBeCloseTo(3);
    expect(byLabel.get("Double Occupancy %")![0]).toBeCloseTo(-100); // no bed nights in the fixture
  });
});

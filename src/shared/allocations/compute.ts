/**
 * Allocations — pure spread math (VBA `Full_Alloc_Recalc` reproduced).
 *
 * Two steps, both side-effect-free so they unit-test without a database:
 *   1. aggregateDepartmentMetrics — roll the hotel's active positions up to
 *      per-department driver totals. Every per-head metric is weighted by the
 *      position's headcount (a Kairos row is a multiplier: Count = 5 → five
 *      identical people), mirroring the engine's own stat math
 *      (statFte = fte × headcount). VBA summed per-associate; this is the
 *      faithful equivalent.
 *   2. computeSpreadGrid — for each allocation: pick the base value per
 *      department, zero the excluded departments, then normalize to a percentage
 *      of the column total (× 100). A zero column total yields all-zero (no
 *      divide-by-zero).
 */

import type { CalendarContext } from "../engine/types";
import { resolveYearlyHoursWorked } from "../positions/engineInput";
import type { PositionRecord } from "../positions/ipc";
import type { AllocationDto, SpreadBase } from "./ipc";

/** Per-department roll-up of every spread driver. */
export interface DeptMetrics {
  headcount: number;
  fte: number;
  manhoursWorked: number;
  manhoursPaid: number;
  baseSalary: number;
  contractDays: number;
  vacationDays: number;
}

/** One department's aggregated metrics, keyed by its (possibly blank) code. */
export interface DepartmentAgg {
  departmentCode: string;
  metrics: DeptMetrics;
}

function emptyMetrics(): DeptMetrics {
  return {
    headcount: 0,
    fte: 0,
    manhoursWorked: 0,
    manhoursPaid: 0,
    baseSalary: 0,
    contractDays: 0,
    vacationDays: 0,
  };
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Aggregate active positions into per-department metrics. Inactive positions are
 * dropped (not budgeted), matching loadScenarioInput. Contract Days / Manhours
 * Paid read from the POSITION_EXTRA blob (contractYearlyDays, contractDaysOff);
 * Manhours Worked resolves the calendar-derived value the same way the engine
 * input does. Departments preserve first-seen order.
 */
export function aggregateDepartmentMetrics(
  positions: PositionRecord[],
  calendar: Pick<CalendarContext, "realDays">
): DepartmentAgg[] {
  const byDept = new Map<string, DeptMetrics>();

  for (const p of positions) {
    if (!p.active) continue;
    const code = p.departmentCode ?? "";
    let metrics = byDept.get(code);
    if (!metrics) {
      metrics = emptyMetrics();
      byDept.set(code, metrics);
    }

    const h = num(p.headcount);
    const contractYearlyDays = num(p.extraValues?.contractYearlyDays);
    const contractDaysOff = num(p.extraValues?.contractDaysOff);
    const dailyHours = num(p.dailyContractHours);
    const manhoursWorked = resolveYearlyHoursWorked(
      num(p.yearlyHoursWorked),
      { vacationDays: num(p.vacationDays), dailyContractHours: dailyHours },
      calendar
    );

    metrics.headcount += h;
    metrics.fte += num(p.fte) * h;
    metrics.manhoursWorked += manhoursWorked * h;
    metrics.manhoursPaid += (contractYearlyDays - contractDaysOff) * dailyHours * h;
    metrics.baseSalary += num(p.monthlyBaseSalary) * h;
    metrics.contractDays += contractYearlyDays * h;
    metrics.vacationDays += num(p.vacationDays) * h;
  }

  return [...byDept.entries()].map(([departmentCode, metrics]) => ({
    departmentCode,
    metrics,
  }));
}

/** The raw (un-normalized) driver value for one department under one base.
 *  FLAT gives every department an equal weight of 1. */
export function baseValue(base: SpreadBase, metrics: DeptMetrics): number {
  switch (base) {
    case "HEADCOUNT":
      return metrics.headcount;
    case "FTE":
      return metrics.fte;
    case "MANHOURS_WORKED":
      return metrics.manhoursWorked;
    case "MANHOURS_PAID":
      return metrics.manhoursPaid;
    case "BASE_SALARY":
      return metrics.baseSalary;
    case "CONTRACT_DAYS":
      return metrics.contractDays;
    case "VACATION_DAYS":
      return metrics.vacationDays;
    case "FLAT":
      return 1;
    default:
      return 0;
  }
}

/**
 * Compute the spread percentages for one allocation across the given
 * departments: base value per department, excluded departments zeroed, then each
 * normalized to a percentage of the total (× 100). Total 0 ⇒ all zero.
 * Returns a map departmentCode → percent.
 */
export function computeAllocationColumn(
  allocation: Pick<AllocationDto, "spreadBase" | "excludedDepartments">,
  departments: DepartmentAgg[]
): Map<string, number> {
  const excluded = new Set(allocation.excludedDepartments);
  const raw = departments.map((dept) =>
    excluded.has(dept.departmentCode)
      ? 0
      : baseValue(allocation.spreadBase, dept.metrics)
  );
  const total = raw.reduce((sum, value) => sum + value, 0);

  const out = new Map<string, number>();
  departments.forEach((dept, index) => {
    out.set(dept.departmentCode, total > 0 ? (raw[index] / total) * 100 : 0);
  });
  return out;
}

/**
 * The full grid: for every department, a map of allocationId → percent.
 * Keyed by departmentCode so the handler can attach names for display.
 */
export function computeSpreadGrid(
  allocations: AllocationDto[],
  departments: DepartmentAgg[]
): Map<string, Record<string, number>> {
  const rows = new Map<string, Record<string, number>>();
  for (const dept of departments) rows.set(dept.departmentCode, {});

  for (const allocation of allocations) {
    const column = computeAllocationColumn(allocation, departments);
    for (const dept of departments) {
      const values = rows.get(dept.departmentCode)!;
      values[allocation.id] = column.get(dept.departmentCode) ?? 0;
    }
  }
  return rows;
}

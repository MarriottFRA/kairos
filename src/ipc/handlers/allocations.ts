/**
 * Allocations IPC handlers.
 *
 * CRUD over per-hotel allocation definitions in the plaintext local store, plus
 * the computed spread grid. The grid is derived on demand: the hotel's active
 * positions (encrypted store) are rolled up per department (headcount-weighted),
 * then each allocation's chosen base is normalized to 100 across departments
 * (see src/shared/allocations/compute.ts). Every channel is OU-gated (registered
 * with ouScopeMiddleware in ipc/index.ts). Mutations return the full refreshed
 * view so the renderer updates in one round-trip (blocks idiom).
 */

import { IpcHandler, IpcResult } from "../types";
import { getCalendarYear, localDbHandle } from "../../local_db";
import { secureDb } from "../../secure_db";
import { resolveOuScope } from "../../main/positions/ouScope";
import { prepared } from "../../main/positions/stmtCache";
import {
  deleteAllocation,
  listAllocations,
  saveAllocation,
} from "../../main/allocations/repo";
import { loadScenarioValues } from "../../main/positions/positionsRepo";
import { listDepartments } from "../../main/mappingTables/repo";
import {
  aggregateDepartmentMetrics,
  computeSpreadGrid,
} from "../../shared/allocations/compute";
import {
  ALLOCATIONS_CHANNELS,
  AllocationInput,
  AllocationsViewResponse,
} from "../../shared/allocations/ipc";
import { buildDefaultCalendar, DEFAULT_WEEKEND_MASK } from "../../shared/calendar";
import { buildCalendarContext } from "../../shared/engine/calendarContext";

function ok<T>(data: T): IpcResult<T> {
  return { success: true, data, timestamp: Date.now() };
}

function fail<T>(error: unknown, data: T): IpcResult<T> {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { success: false, error: message, data, timestamp: Date.now() };
}

const EMPTY: AllocationsViewResponse = { allocations: [], departments: [] };

type Scope = ReturnType<typeof resolveOuScope>;

function requireScenarioId(request: any): string {
  const scenarioId = String(request?.scenarioId ?? "");
  if (!scenarioId) throw new Error("A scenarioId is required.");
  return scenarioId;
}

/** The scenario's budget year, needed to resolve the calendar for worked-hours. */
function scenarioYear(scope: Scope, scenarioId: string): number {
  const row = prepared(
    localDbHandle(),
    `SELECT year FROM scenarios WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).get(scenarioId, scope.ou) as { year: number } | undefined;
  if (!row) throw new Error(`Scenario not found in this hotel: ${scenarioId}`);
  return row.year;
}

/**
 * The full view: definitions + the computed department grid. Departments are the
 * distinct codes among the scenario's active positions, named from the mapping
 * tables (blank grouped as "(No department)"), sorted by name with the blank
 * bucket last.
 */
async function buildView(
  scope: Scope,
  scenarioId: string
): Promise<AllocationsViewResponse> {
  const localDb = localDbHandle();
  const allocations = listAllocations(localDb, scope);

  const year = scenarioYear(scope, scenarioId);
  // Calendars were saved under whatever OU form the hotel switcher held at the
  // time (bare 5-digit or OU-prefixed), so try both before the default.
  const calendarYear =
    (await getCalendarYear(scope.ou, year)) ??
    (await getCalendarYear(scope.ou.replace(/^OU/, ""), year)) ??
    buildDefaultCalendar(scope.ou, year, DEFAULT_WEEKEND_MASK);
  const calendar = buildCalendarContext(calendarYear);

  const values = loadScenarioValues(secureDb(), scope, scenarioId);
  const departmentsAgg = aggregateDepartmentMetrics(values.positions, calendar);
  const grid = computeSpreadGrid(allocations, departmentsAgg);

  const nameByCode = new Map(
    listDepartments(localDb).map((option) => [option.code, option.name])
  );

  const departments = departmentsAgg
    .map((dept) => ({
      departmentCode: dept.departmentCode,
      departmentName:
        dept.departmentCode === ""
          ? "(No department)"
          : nameByCode.get(dept.departmentCode) ?? dept.departmentCode,
      values: grid.get(dept.departmentCode) ?? {},
    }))
    .sort((a, b) => {
      // Blank bucket always last; otherwise by display name.
      if ((a.departmentCode === "") !== (b.departmentCode === "")) {
        return a.departmentCode === "" ? 1 : -1;
      }
      return a.departmentName.localeCompare(b.departmentName);
    });

  return { allocations, departments };
}

export function createAllocationsHandlers(): Record<string, IpcHandler> {
  /** Definitions + computed grid for one scenario. */
  const list: IpcHandler<any, IpcResult<AllocationsViewResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      return ok(await buildView(scope, scenarioId));
    } catch (error) {
      console.error("Allocations list failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Create or update an allocation; returns the refreshed view. */
  const save: IpcHandler<any, IpcResult<AllocationsViewResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      const input = request?.allocation as AllocationInput | undefined;
      if (!input) throw new Error("Missing allocation payload.");
      saveAllocation(localDbHandle(), scope, input, {
        now: new Date().toISOString(),
      });
      return ok(await buildView(scope, scenarioId));
    } catch (error) {
      console.error("Allocations save failed:", error);
      return fail(error, EMPTY);
    }
  };

  /** Soft-delete an allocation; returns the refreshed view. */
  const del: IpcHandler<any, IpcResult<AllocationsViewResponse>> = async (
    _event,
    request
  ) => {
    try {
      const scope = resolveOuScope(request);
      const scenarioId = requireScenarioId(request);
      const allocationId = String(request?.allocationId ?? "");
      if (!allocationId) throw new Error("Missing allocationId.");
      deleteAllocation(localDbHandle(), scope, allocationId, {
        now: new Date().toISOString(),
      });
      return ok(await buildView(scope, scenarioId));
    } catch (error) {
      console.error("Allocations delete failed:", error);
      return fail(error, EMPTY);
    }
  };

  return {
    [ALLOCATIONS_CHANNELS.list]: list,
    [ALLOCATIONS_CHANNELS.save]: save,
    [ALLOCATIONS_CHANNELS.delete]: del,
  };
}

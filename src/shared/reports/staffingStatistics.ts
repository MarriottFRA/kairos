/**
 * Staffing statistics — heads, FTE and hours for the hotel, each department
 * group, each department and each position, with the hours broken down by
 * the account they post to.
 *
 * Read off the scenario's engine output LINES, not the positions: a line
 * carries the position that produced it, so a department's figure is exactly
 * the sum of its positions' (plus any manual input, allocation or buyout
 * line, which get rows of their own) and the hotel figure is exactly what the
 * results cache — and therefore every other report — holds. The department
 * is the line's, not the position's, for the same reason the payroll bridge
 * says: the cache is keyed by the line.
 *
 * What counts, per line's account:
 *   heads          the pinned position count (A972540), a LEVEL: a month is
 *                  its running sum, the year is where it ends up (December),
 *                  as vec.cum reads it for every report.
 *   manager heads  A988101 / A988113 — the heads that ARE FTE (catalog/
 *                  staffing): a LEVEL whose year is its mean.
 *   hours          every account on the maps' "Total Manhours" node, split by
 *                  what the node below says it is (HoursKind). Only the "excl
 *                  Overtime and Manager Hours × Man Hours" kind drives FTE —
 *                  the same filters as the report catalog, so FTE here is the
 *                  FTE the Payroll & FTE summary shows. Unmapped A988 codes
 *                  are hours of kind "other" (counted, not FTE).
 *   FTE            manager heads + FTE-driving hours ÷ one full-timer's hours
 *                  (the effective week × 52/12 a month, × 52 the year).
 *
 * Grouping is the department map's level 10 (decided 2026-09-10), falling
 * back to level 7 where 10 is blank, ordered by the pack's level-7 order. A
 * level-10 label that sits under two level-7 groups is two groups, named
 * apart — "Other Profit Departments" is both an operated department and a
 * payroll allocation, and they must not add together.
 *
 * Grade mixing: an hours account is only reportable by grade if one grade
 * books to it. Per department × hours account the builder records which
 * grade tiers (managers, supervisors, associates — casuals count as
 * associates) put hours there, and flags three things: more than one tier
 * (can't split the account by grade), manager hours on an FTE-driving
 * account (managers already count by head: counted twice), and supervisor /
 * associate hours on a manager-hours account (left out of FTE).
 *
 * Pure: the read is main/positions/staffingStatistics.ts.
 */

import { bareAccount, bareDept } from "../positions/comboKey";
import {
  HEADCOUNT_ACCOUNT_BY_JOB_TYPE,
  POSITION_COUNT_ACCOUNT,
  WEEKLY_HOURS_STAT_ACCOUNT,
} from "../positions/systemAccounts";
import { ACC } from "./catalog/helpers";
import { MANAGER_FTE_ACCOUNTS } from "./catalog/staffing";
import type { ReportRunInfo } from "./ipc";
import {
  DETAIL_GROUP_LEVEL,
  DetailGroupRef,
  PackLabels,
  UNMAPPED_DETAIL_KEY,
  compareDetailGroups,
  detailGroupNames,
  detailGroupOf,
} from "./packs";
import { bucketForJobType } from "./staffingOverview";
import type { ReportWarning } from "./types";
import type { WeeklyHoursInfo } from "./weeklyHours";

/** Department map level the report groups by. */
export const STAFFING_GROUP_LEVEL = DETAIL_GROUP_LEVEL;

const MONTHS = 12;
export const YEAR_SLOT = 12;
const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** What an hours account is, by the node under "Total Manhours" it sits on. */
export type HoursKind = "fte" | "overtime" | "manager" | "buyout" | "other";

export const HOURS_KINDS: readonly HoursKind[] = ["fte", "overtime", "manager", "buyout", "other"];

export const HOURS_KIND_LABELS: Record<HoursKind, string> = {
  fte: "Drive FTE",
  overtime: "Overtime",
  manager: "Manager hours",
  buyout: "Buyout",
  other: "Other hours",
};

const OVERTIME_NODE = "Total Manhours - Overtime";
const MANAGER_HOURS_NODE = "Non Prod Hours";
const BUYOUT_NODE = "Buyout Manhours";

export type StaffingAccountRole = { role: "heads" } | { role: "managerHeads" } | { role: "hours"; kind: HoursKind };

export interface StaffingAccountLabels {
  accountLabel(code: string, level: number): string | null;
}

const MANAGER_HEADS = new Set(MANAGER_FTE_ACCOUNTS.map(bareAccount));
/** Every graded headcount account — the supervisor one is a head count, not hours, maps or no maps. */
const GRADED_HEADS = new Set(Object.values(HEADCOUNT_ACCOUNT_BY_JOB_TYPE).map(bareAccount));
const POSITION_COUNT = bareAccount(POSITION_COUNT_ACCOUNT);
const WEEKLY_HOURS = bareAccount(WEEKLY_HOURS_STAT_ACCOUNT);

/** What the report reads an account as, or null for an account it ignores. */
export function classifyStaffingAccount(account: string, labels: StaffingAccountLabels): StaffingAccountRole | null {
  const code = bareAccount(account);
  if (code === POSITION_COUNT) return { role: "heads" };
  if (MANAGER_HEADS.has(code)) return { role: "managerHeads" };
  if (GRADED_HEADS.has(code) || code === WEEKLY_HOURS) return null;
  const l4 = labels.accountLabel(code, 4);
  if (l4 === ACC.totalManhours) {
    const l6 = labels.accountLabel(code, 6);
    const l9 = labels.accountLabel(code, 9);
    if (l6 === ACC.manhoursExclOvertimeAndManagers && l9 === ACC.manHours) return { role: "hours", kind: "fte" };
    if (l9 === BUYOUT_NODE) return { role: "hours", kind: "buyout" };
    if (l6 === OVERTIME_NODE) return { role: "hours", kind: "overtime" };
    if (l6 === MANAGER_HOURS_NODE) return { role: "hours", kind: "manager" };
    return { role: "hours", kind: "other" };
  }
  // Mapped as something else (the headcount stats, the work week…): not hours.
  if (l4 !== null) return null;
  // Unmapped: the family Kairos posts hours to. Counted, never FTE — the
  // report catalog's FTE needs the maps too.
  return code.startsWith("988") ? { role: "hours", kind: "other" } : null;
}

/** A memoising classifier over one set of labels. */
export function staffingAccountClassifier(labels: StaffingAccountLabels): (account: string) => StaffingAccountRole | null {
  const cache = new Map<string, StaffingAccountRole | null>();
  return (account) => {
    const code = bareAccount(account);
    if (!cache.has(code)) cache.set(code, classifyStaffingAccount(code, labels));
    return cache.get(code)!;
  };
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

export type GradeTier = "mgr" | "svsr" | "assoc";

export const GRADE_TIERS: readonly GradeTier[] = ["mgr", "svsr", "assoc"];

export const GRADE_TIER_LABELS: Record<GradeTier, string> = {
  mgr: "Managers",
  svsr: "Supervisors",
  assoc: "Associates",
};

/** Casuals are associates here; Buyout Labour is no grade at all. */
export function tierOf(jobTypeCode: string | null | undefined): GradeTier | null {
  const bucket = bucketForJobType(jobTypeCode);
  if (!bucket) return null;
  return bucket === "casual" ? "assoc" : bucket;
}

export type GradeMixKind = "mixed" | "manager_hours_drive_fte" | "staff_hours_outside_fte";

export const GRADE_MIX_MESSAGES: Record<GradeMixKind, string> = {
  mixed: "More than one grade books hours to this account, so it can't be reported by grade.",
  manager_hours_drive_fte:
    "Manager hours are on an FTE-driving account. Managers already count as FTE by head, so these hours count them twice.",
  staff_hours_outside_fte: "Supervisor or associate hours are on a manager-hours account, which is left out of FTE.",
};

/** The two kinds that change the FTE figure, not just the reporting. */
export const distortsFte = (kind: GradeMixKind): boolean => kind !== "mixed";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One engine output line, as the read hands it over. */
export interface StaffingStatsLine {
  dept: string;
  account: string;
  months: readonly number[];
  encoding: "LEVEL" | "AMOUNT";
  /** The position that produced it; null for manual input, allocations, buyouts, setup. */
  position: { id: string; title: string; jobTypeCode: string | null; deleted: boolean } | null;
  /** What a line with no position is called ("Manual input · Extra hours"). */
  sourceLabel: string;
}

/** Thirteen slots each: Jan..Dec, then the year. */
export interface StaffingStatsValues {
  /** Position count; the year is the December level. */
  heads: number[];
  /** Manager heads; the year is the mean level. */
  managerHeads: number[];
  /** FTE-driving hours ÷ one full-timer's hours. */
  hoursFte: number[];
  /** managerHeads + hoursFte. */
  fte: number[];
  /** Every hours account. */
  hours: number[];
  /** Hours per bare account code. */
  byAccount: Record<string, number[]>;
}

export interface StaffingMixCell {
  kinds: GradeMixKind[];
  /** Departments at or below this row flagged on the account (0 on a position). */
  departments: number;
}

export type StaffingStatsNodeKind = "hotel" | "group" | "department" | "position" | "other";

export interface StaffingStatsNode {
  /** Unique across the tree. */
  id: string;
  kind: StaffingStatsNodeKind;
  label: string;
  /** Bare department code, on a department. */
  code: string | null;
  jobTypeCode: string | null;
  tier: GradeTier | null;
  /** A position deleted since the run (its lines stay until the next one). */
  deleted: boolean;
  values: StaffingStatsValues;
  /** Bare account code → the grade-mix flags on it. */
  mix: Record<string, StaffingMixCell>;
  children: StaffingStatsNode[];
}

export interface StaffingStatsAccount {
  /** Bare code. */
  code: string;
  name: string | null;
  kind: HoursKind;
}

/** One flagged department × hours account. */
export interface GradeMixEntry {
  dept: string;
  deptName: string;
  group: string;
  account: string;
  accountName: string | null;
  accountKind: HoursKind;
  kinds: GradeMixKind[];
  /** The year's hours each tier put on the account. */
  hoursByTier: Record<GradeTier, number>;
  /** How many positions of each tier did. */
  positionsByTier: Record<GradeTier, number>;
}

export interface StaffingStatisticsResponse {
  scenarioId: string;
  year: number;
  run: ReportRunInfo | null;
  /** The effective week FTE divided by, and where it was read. */
  weeklyHours: WeeklyHoursInfo | null;
  /** Hours of one FTE per slot (the week × 52/12 a month, × 52 the year). */
  fteHours: number[];
  groupLevel: number;
  /** Hours accounts with a figure anywhere, FTE-driving first. */
  accounts: StaffingStatsAccount[];
  /** The hotel; its children are the groups. */
  hotel: StaffingStatsNode;
  gradeMix: GradeMixEntry[];
  /** Bare department codes with no group at either level. */
  unmappedDepartments: string[];
  warnings: ReportWarning[];
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

const UNMAPPED_KEY = UNMAPPED_DETAIL_KEY;

/** The pack's detail grouping, shared with Summary reporting. */
export type StaffingGroupRef = DetailGroupRef;

/** A department's group: its level-10 label, else its level-7 one, else unmapped. */
export const staffingGroupOf = detailGroupOf;

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

interface Accumulator {
  headsDelta: number[];
  headsLevel: number[];
  mgrDelta: number[];
  mgrLevel: number[];
  fteHours: number[];
  hours: number[];
  byAccount: Map<string, number[]>;
}

const months0 = () => new Array<number>(MONTHS).fill(0);

const newAccumulator = (): Accumulator => ({
  headsDelta: months0(),
  headsLevel: months0(),
  mgrDelta: months0(),
  mgrLevel: months0(),
  fteHours: months0(),
  hours: months0(),
  byAccount: new Map(),
});

function addMonths(into: number[], from: readonly number[]): void {
  for (let m = 0; m < MONTHS; m++) into[m] += Number(from[m]) || 0;
}

interface Draft {
  node: Omit<StaffingStatsNode, "values" | "children">;
  acc: Accumulator;
  children: Map<string, Draft>;
  /** Groups only. */
  group?: StaffingGroupRef;
}

function draft(id: string, kind: StaffingStatsNodeKind, label: string, extra: Partial<StaffingStatsNode> = {}): Draft {
  return {
    node: { id, kind, label, code: null, jobTypeCode: null, tier: null, deleted: false, mix: {}, ...extra },
    acc: newAccumulator(),
    children: new Map(),
  };
}

/** A LEVEL read as levels: January-plus-changes run up, plus anything posted as levels already. */
function levels(delta: readonly number[], level: readonly number[]): number[] {
  const out = new Array<number>(MONTHS + 1).fill(0);
  let running = 0;
  for (let m = 0; m < MONTHS; m++) {
    running += delta[m];
    out[m] = running + level[m];
  }
  return out;
}

function amounts(months: readonly number[]): number[] {
  const out = [...months, 0];
  out[YEAR_SLOT] = months.reduce((sum, value) => sum + value, 0);
  return out;
}

const safeDiv = (a: number, b: number) => (Math.abs(b) < 1e-12 ? 0 : a / b);

function finalValues(acc: Accumulator, fteHours: readonly number[]): StaffingStatsValues {
  const heads = levels(acc.headsDelta, acc.headsLevel);
  heads[YEAR_SLOT] = heads[MONTHS - 1];
  const managerHeads = levels(acc.mgrDelta, acc.mgrLevel);
  managerHeads[YEAR_SLOT] = managerHeads.slice(0, MONTHS).reduce((sum, value) => sum + value, 0) / MONTHS;
  const fteDriving = amounts(acc.fteHours);
  const hoursFte = fteDriving.map((value, slot) => safeDiv(value, Number(fteHours[slot]) || 0));
  return {
    heads,
    managerHeads,
    hoursFte,
    fte: managerHeads.map((value, slot) => value + hoursFte[slot]),
    hours: amounts(acc.hours),
    byAccount: Object.fromEntries([...acc.byAccount].map(([code, months]) => [code, amounts(months)])),
  };
}

interface TierTally {
  hours: Record<GradeTier, number>;
  positions: Record<GradeTier, Set<string>>;
}

const zeroTiers = (): Record<GradeTier, number> => ({ mgr: 0, svsr: 0, assoc: 0 });

function mixKinds(kind: HoursKind, hours: Record<GradeTier, number>): GradeMixKind[] {
  const out: GradeMixKind[] = [];
  const present = GRADE_TIERS.filter((tier) => Math.abs(hours[tier]) > EPSILON);
  if (present.length > 1) out.push("mixed");
  if (kind === "fte" && Math.abs(hours.mgr) > EPSILON) out.push("manager_hours_drive_fte");
  if (kind === "manager" && (Math.abs(hours.svsr) > EPSILON || Math.abs(hours.assoc) > EPSILON)) out.push("staff_hours_outside_fte");
  return out;
}

/** The flags one position's own hours raise on an account of this kind. */
function positionMixKinds(kind: HoursKind, tier: GradeTier | null): GradeMixKind[] {
  if (kind === "fte" && tier === "mgr") return ["manager_hours_drive_fte"];
  if (kind === "manager" && (tier === "svsr" || tier === "assoc")) return ["staff_hours_outside_fte"];
  return [];
}

function mergeMix(into: Record<string, StaffingMixCell>, account: string, kinds: readonly GradeMixKind[], departments: number): void {
  const cell = (into[account] ??= { kinds: [], departments: 0 });
  for (const kind of kinds) if (!cell.kinds.includes(kind)) cell.kinds.push(kind);
  cell.departments += departments;
}

const TIER_ORDER: Record<string, number> = { mgr: 0, svsr: 1, assoc: 2 };

export function buildStaffingStatistics(
  lines: Iterable<StaffingStatsLine>,
  fteHours: readonly number[],
  labels: PackLabels
): Pick<StaffingStatisticsResponse, "accounts" | "hotel" | "gradeMix" | "unmappedDepartments"> {
  const classify = staffingAccountClassifier(labels);
  const hotel = draft("hotel", "hotel", "Total hotel");
  const groupOfDept = new Map<string, Draft>();
  const deptDrafts = new Map<string, Draft>();
  const accountKinds = new Map<string, HoursKind>();
  const tallies = new Map<string, Map<string, TierTally>>();
  const unmapped = new Set<string>();

  for (const line of lines) {
    const role = classify(line.account);
    if (!role) continue;
    const account = bareAccount(line.account);
    const dept = bareDept(line.dept);

    let deptDraft = deptDrafts.get(dept);
    let groupDraft = groupOfDept.get(dept);
    if (!deptDraft || !groupDraft) {
      const ref = staffingGroupOf(labels, dept);
      if (ref.key === UNMAPPED_KEY) unmapped.add(dept);
      groupDraft = hotel.children.get(ref.key);
      if (!groupDraft) {
        groupDraft = draft(`g:${ref.key}`, "group", ref.label);
        groupDraft.group = ref;
        hotel.children.set(ref.key, groupDraft);
      }
      deptDraft = draft(`d:${dept}`, "department", labels.deptName(dept) ?? dept, { code: dept });
      groupDraft.children.set(dept, deptDraft);
      deptDrafts.set(dept, deptDraft);
      groupOfDept.set(dept, groupDraft);
    }

    let leaf: Draft;
    const position = line.position;
    if (position) {
      const key = `p:${position.id}`;
      leaf =
        deptDraft.children.get(key) ??
        draft(`p:${dept}:${position.id}`, "position", position.title, {
          jobTypeCode: position.jobTypeCode,
          tier: tierOf(position.jobTypeCode),
          deleted: position.deleted,
        });
      deptDraft.children.set(key, leaf);
    } else {
      const key = `o:${line.sourceLabel}`;
      leaf = deptDraft.children.get(key) ?? draft(`o:${dept}:${line.sourceLabel}`, "other", line.sourceLabel);
      deptDraft.children.set(key, leaf);
    }

    const level = line.encoding === "LEVEL";
    for (const target of [hotel.acc, groupDraft.acc, deptDraft.acc, leaf.acc]) {
      if (role.role === "heads") addMonths(level ? target.headsDelta : target.headsLevel, line.months);
      else if (role.role === "managerHeads") addMonths(level ? target.mgrDelta : target.mgrLevel, line.months);
      else {
        addMonths(target.hours, line.months);
        if (role.kind === "fte") addMonths(target.fteHours, line.months);
        let byAccount = target.byAccount.get(account);
        if (!byAccount) target.byAccount.set(account, (byAccount = months0()));
        addMonths(byAccount, line.months);
      }
    }

    if (role.role !== "hours") continue;
    accountKinds.set(account, role.kind);
    const tier = leaf.node.tier;
    if (!position || !tier) continue;
    const yearHours = line.months.reduce<number>((sum, value) => sum + (Number(value) || 0), 0);
    if (Math.abs(yearHours) <= EPSILON) continue;
    let byAccount = tallies.get(dept);
    if (!byAccount) tallies.set(dept, (byAccount = new Map()));
    let tally = byAccount.get(account);
    if (!tally) byAccount.set(account, (tally = { hours: zeroTiers(), positions: { mgr: new Set(), svsr: new Set(), assoc: new Set() } }));
    tally.hours[tier] += yearHours;
    tally.positions[tier].add(position.id);
    const own = positionMixKinds(role.kind, tier);
    if (own.length > 0) mergeMix(leaf.node.mix, account, own, 0);
  }

  // Groups named alike under two level-7 parents are told apart by the parent.
  const groupNames = detailGroupNames([...hotel.children.values()].map((group) => group.group!));
  for (const group of hotel.children.values()) group.node.label = groupNames.get(group.group!.key)!;

  // The flags, department by department, rolled up to the group and hotel.
  const gradeMix: GradeMixEntry[] = [];
  for (const [dept, byAccount] of tallies) {
    const deptDraft = deptDrafts.get(dept)!;
    const groupDraft = groupOfDept.get(dept)!;
    for (const [account, tally] of byAccount) {
      const accountKind = accountKinds.get(account) ?? "other";
      const kinds = mixKinds(accountKind, tally.hours);
      if (kinds.length === 0) continue;
      mergeMix(deptDraft.node.mix, account, kinds, 1);
      mergeMix(groupDraft.node.mix, account, kinds, 1);
      mergeMix(hotel.node.mix, account, kinds, 1);
      gradeMix.push({
        dept,
        deptName: deptDraft.node.label,
        group: groupDraft.node.label,
        account,
        accountName: labels.accountName(account),
        accountKind,
        kinds,
        hoursByTier: { ...tally.hours },
        positionsByTier: { mgr: tally.positions.mgr.size, svsr: tally.positions.svsr.size, assoc: tally.positions.assoc.size },
      });
    }
  }

  const finish = (d: Draft, children: Draft[]): StaffingStatsNode => ({
    ...d.node,
    values: finalValues(d.acc, fteHours),
    children: children.map((child) => finish(child, sortedChildren(child))),
  });

  const groups = [...hotel.children.values()].sort(
    (a, b) => compareDetailGroups(a.group!, b.group!) || a.node.label.localeCompare(b.node.label)
  );
  const hotelNode = finish(hotel, groups);

  const groupOrder = new Map(hotelNode.children.map((group, index) => [group.label, index]));
  gradeMix.sort(
    (a, b) =>
      (groupOrder.get(a.group) ?? 0) - (groupOrder.get(b.group) ?? 0) || a.dept.localeCompare(b.dept) || a.account.localeCompare(b.account)
  );

  const kindRank = (kind: HoursKind) => HOURS_KINDS.indexOf(kind);
  const accounts: StaffingStatsAccount[] = [...accountKinds]
    .filter(([code]) => (hotelNode.values.byAccount[code] ?? []).some((value) => Math.abs(value) > EPSILON))
    .map(([code, kind]) => ({ code, name: labels.accountName(code), kind }))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.code.localeCompare(b.code));

  return { accounts, hotel: hotelNode, gradeMix, unmappedDepartments: [...unmapped].sort() };
}

function sortedChildren(d: Draft): Draft[] {
  const children = [...d.children.values()];
  if (d.node.kind === "group") return children.sort((a, b) => (a.node.code ?? "").localeCompare(b.node.code ?? ""));
  if (d.node.kind === "department") {
    return children.sort(
      (a, b) =>
        Number(a.node.kind === "other") - Number(b.node.kind === "other") ||
        (TIER_ORDER[a.node.tier ?? ""] ?? 3) - (TIER_ORDER[b.node.tier ?? ""] ?? 3) ||
        a.node.label.localeCompare(b.node.label)
    );
  }
  return children;
}

/** The hours of an account kind on a node, per slot. */
export function hoursOfKind(values: StaffingStatsValues, accounts: readonly StaffingStatsAccount[], kind: HoursKind): number[] {
  const out = new Array<number>(MONTHS + 1).fill(0);
  for (const account of accounts) {
    if (account.kind !== kind) continue;
    const series = values.byAccount[account.code];
    if (series) for (let slot = 0; slot <= MONTHS; slot++) out[slot] += series[slot];
  }
  return out;
}

const hoursText = (value: number) => `${Math.round(value).toLocaleString("en")} h`;

/**
 * What a flagged cell says: on a department, who put how many hours there
 * and why it matters; on a position, what its own hours do; on a group or the
 * hotel, how many departments below are flagged.
 */
export function describeMix(
  node: Pick<StaffingStatsNode, "kind">,
  cell: StaffingMixCell,
  entry?: Pick<GradeMixEntry, "hoursByTier"> | null
): string {
  const messages = cell.kinds.map((kind) => GRADE_MIX_MESSAGES[kind]).join(" ");
  if (node.kind === "department" && entry) {
    const who = GRADE_TIERS.filter((tier) => Math.abs(entry.hoursByTier[tier]) > EPSILON)
      .map((tier) => `${GRADE_TIER_LABELS[tier]} ${hoursText(entry.hoursByTier[tier])}`)
      .join(" · ");
    return `${who}. ${messages}`;
  }
  if (node.kind === "hotel" || node.kind === "group") {
    const n = cell.departments;
    return `${n} department${n === 1 ? "" : "s"} below flagged on this account. ${messages}`;
  }
  return messages;
}

/** "988308 - Manager Hours" → "Manager Hours"; the code when there is no name. */
export function shortAccountName(account: StaffingStatsAccount): string {
  const name = (account.name ?? "").replace(/^\s*\d+\s*-\s*/, "").trim();
  return name || account.code;
}

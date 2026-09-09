/**
 * Column configuration — what a report is compared against, as column specs
 * the engine evaluates. Replaces the fixed presets (decided 2026-09-09).
 *
 * The primary column follows the SOURCE MODE: `bst` reads the scenario
 * year's budget bucket as pulled (the default, and the only unflagged
 * reading — what the BST holds is the record), `plan` lays the scenario's
 * results over it (the opt-in, flagged everywhere it shows).
 *
 * A COMPARISON is one of:
 *   - a BST OFFSET: the workbook carries three sets of twelve columns. The
 *     first set is the one Kairos writes (the budget); offset 1 is the next
 *     set (bucket 2, typically this year's act/fcst), offset 2 the final set
 *     (bucket 3, typically last year's actuals). They are read by position,
 *     not by year, so they are whatever the pull holds — the labels say what.
 *   - a SCENARIO, read as its own plan (its bucket, its results): a hand-built
 *     "last year" scenario compares as a whole P&L rather than as payroll alone.
 *
 * Each comparison may be followed by its absolute and percent variances.
 */

import type { ReportColumnSpec } from "./columns";
import { ID_PATTERN } from "./compile";

export type SourceMode = "bst" | "plan";

/** Offset 1 = bucket 2, offset 2 = bucket 3. */
export type BstOffset = 1 | 2;

export type CompareRef =
  | { kind: "bst"; offset: BstOffset }
  | { kind: "scenario"; scenarioId: string };

export interface ColumnConfig {
  compares: CompareRef[];
  /** Show `a − b` after each comparison. */
  showAbs: boolean;
  /** Show `100 × (a − b) ÷ |b|` after each comparison. */
  showPct: boolean;
}

/** Budget beside the next set of columns, with both variances — the old "vs LY". */
export const DEFAULT_COLUMN_CONFIG: ColumnConfig = {
  compares: [{ kind: "bst", offset: 1 }],
  showAbs: true,
  showPct: true,
};

export interface ScenarioRef {
  id: string;
  label: string;
  year: number;
}

/** One pulled bucket, as the import summary describes it. */
export interface BucketLabelInput {
  index: number;
  type: string;
  year: number | null;
}

export interface BuildColumnsInput {
  scenario: ScenarioRef;
  mode: SourceMode;
  /** Every scenario a comparison may name; unknown ids are skipped. */
  scenarios: readonly ScenarioRef[];
  /** The current pull's buckets, for the labels; empty when nothing is pulled. */
  buckets?: readonly BucketLabelInput[];
}

export const bucketIndexOf = (offset: BstOffset): 2 | 3 => (offset === 1 ? 2 : 3);

/** "ACT/FCST 2026", or "BST set 2" when the pull holds no such bucket. */
export function bstOffsetLabel(offset: BstOffset, buckets: readonly BucketLabelInput[] = []): string {
  const index = bucketIndexOf(offset);
  const bucket = buckets.find((b) => b.index === index);
  const parts = [bucket?.type?.trim() || "", bucket?.year ? String(bucket.year) : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : `BST set ${index}`;
}

export function compareLabel(
  ref: CompareRef,
  scenarios: readonly ScenarioRef[],
  buckets: readonly BucketLabelInput[] = []
): string {
  if (ref.kind === "bst") return bstOffsetLabel(ref.offset, buckets);
  const scenario = scenarios.find((s) => s.id === ref.scenarioId);
  return scenario ? `${scenario.label} ${scenario.year} (plan)` : "Missing scenario";
}

export const sameCompare = (a: CompareRef, b: CompareRef): boolean =>
  a.kind === "bst" ? b.kind === "bst" && a.offset === b.offset : b.kind === "scenario" && a.scenarioId === b.scenarioId;

export function primaryColumn({ scenario, mode }: Pick<BuildColumnsInput, "scenario" | "mode">): ReportColumnSpec {
  return mode === "plan"
    ? { id: "budget", label: `Plan ${scenario.year} (unpushed)`, series: { kind: "plan", scenarioId: scenario.id } }
    : {
        id: "budget",
        label: `Budget ${scenario.year}`,
        series: { kind: "bst", relativeTo: scenario.id, bucket: { type: "BUDGET" } },
      };
}

/** A column id from a comparison: `bst2`, `bst3`, `s_<scenario id>` (id-safe). */
function compareColumnId(ref: CompareRef): string {
  if (ref.kind === "bst") return `bst${bucketIndexOf(ref.offset)}`;
  const safe = ref.scenarioId.replace(/[^A-Za-z0-9_]/g, "_");
  return `s_${safe}`;
}

/**
 * The columns a configuration asks for. A comparison naming a scenario that
 * is not in `scenarios` is skipped rather than failing the whole grid — the
 * stored configuration outlives the scenarios it named.
 */
export function buildConfigColumns(config: ColumnConfig, input: BuildColumnsInput): ReportColumnSpec[] {
  const { scenario, scenarios, buckets = [] } = input;
  const out: ReportColumnSpec[] = [primaryColumn(input)];
  const used = new Set<string>(["budget"]);
  for (const ref of config.compares) {
    let id = compareColumnId(ref);
    if (!ID_PATTERN.test(id)) id = `c${out.length}`;
    if (used.has(id)) continue;
    let spec: ReportColumnSpec;
    if (ref.kind === "bst") {
      spec = {
        id,
        label: bstOffsetLabel(ref.offset, buckets),
        series: { kind: "bst", relativeTo: scenario.id, bucket: { index: bucketIndexOf(ref.offset) } },
      };
    } else {
      const other = scenarios.find((s) => s.id === ref.scenarioId);
      if (!other) continue;
      spec = { id, label: `${other.label} ${other.year} (plan)`, series: { kind: "plan", scenarioId: other.id } };
    }
    used.add(id);
    out.push(spec);
    const short = compareLabel(ref, scenarios, buckets).replace(/ \(plan\)$/, "");
    if (config.showAbs) out.push({ id: `${id}_v`, label: `vs ${short}`, variance: { a: "budget", b: id, mode: "abs" } });
    if (config.showPct) {
      out.push({ id: `${id}_v_pct`, label: `vs ${short} %`, variance: { a: "budget", b: id, mode: "pct" } });
    }
  }
  return out;
}

/** One line for the settings bar: "vs ACT/FCST 2026, Planning 2026" or "Budget only". */
export function describeColumnConfig(
  config: ColumnConfig,
  scenarios: readonly ScenarioRef[],
  buckets: readonly BucketLabelInput[] = []
): string {
  const named = config.compares
    .filter((ref) => ref.kind === "bst" || scenarios.some((s) => s.id === ref.scenarioId))
    .map((ref) => compareLabel(ref, scenarios, buckets).replace(/ \(plan\)$/, ""));
  return named.length ? `vs ${named.join(", ")}` : "Budget only";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A stored configuration → a valid one, or the default when it is not usable. */
export function normalizeColumnConfig(raw: unknown): ColumnConfig {
  if (!isRecord(raw) || !Array.isArray(raw.compares)) return DEFAULT_COLUMN_CONFIG;
  const compares: CompareRef[] = [];
  for (const item of raw.compares) {
    if (!isRecord(item)) continue;
    let ref: CompareRef | null = null;
    if (item.kind === "bst" && (item.offset === 1 || item.offset === 2)) ref = { kind: "bst", offset: item.offset };
    else if (item.kind === "scenario" && typeof item.scenarioId === "string" && item.scenarioId.trim()) {
      ref = { kind: "scenario", scenarioId: item.scenarioId.trim() };
    }
    if (ref && !compares.some((c) => sameCompare(c, ref!))) compares.push(ref);
  }
  return {
    compares,
    showAbs: typeof raw.showAbs === "boolean" ? raw.showAbs : true,
    showPct: typeof raw.showPct === "boolean" ? raw.showPct : true,
  };
}

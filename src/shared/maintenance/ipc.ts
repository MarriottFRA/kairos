/**
 * Storage cleanup — shared types + IPC channel names.
 *
 * Nearly every delete in Kairos is a soft delete: the row keeps its data and
 * gains a `deleted_at` stamp, which is what makes the Positions undo snackbar,
 * "Recently removed" columns and block restore possible. Nothing sweeps those
 * rows up afterwards except the field-catalog grace window (see
 * services/fieldCatalogService.sweepRemovedFields), so they accumulate for the
 * life of the install.
 *
 * This feature is the manual broom: scan both stores for `deleted_at` rows,
 * show what would go, then purge them permanently and VACUUM. Whole install,
 * every hotel — it is a maintenance action, not an per-plan one.
 */

export const MAINTENANCE_CHANNELS = {
  /** Count what is currently recoverable-but-deleted. Read-only. */
  scanDeleted: "maintenance:scan-deleted",
  /** Permanently remove it. Irreversible. */
  purgeDeleted: "maintenance:purge-deleted",
  /** Change the automatic-sweep retention window. */
  setAutoCleanup: "maintenance:set-auto-cleanup",
} as const;

/**
 * Retention windows offered for the automatic sweep, in days. 0 = off.
 *
 * The window is what keeps the automatic sweep safe: everything inside it is
 * still undoable/restorable, and only older rows are taken. The manual button
 * ignores it and takes everything.
 */
export const AUTO_CLEANUP_CHOICES: ReadonlyArray<number> = [0, 7, 30, 90];

/** Matches the long-standing removed-column grace window. */
export const DEFAULT_AUTO_CLEANUP_DAYS = 30;

export interface AutoCleanupConfig {
  /** Days to keep deleted rows before sweeping them. 0 = never sweep. */
  retentionDays: number;
  /** ISO timestamp of the last automatic sweep, or null if it never ran. */
  lastRunAt: string | null;
  /** Rows the last automatic sweep removed. */
  lastRunRemoved: number;
}

export const DEFAULT_AUTO_CLEANUP_CONFIG: AutoCleanupConfig = {
  retentionDays: DEFAULT_AUTO_CLEANUP_DAYS,
  lastRunAt: null,
  lastRunRemoved: 0,
};

/**
 * Rows removed (or removable) per category. Counts are install-wide across
 * every OU, and span both the plaintext structure store and the encrypted
 * value store.
 */
export interface CleanupTally {
  /** Deleted plans (scenarios). Purging one takes its whole contents with it. */
  scenarios: number;
  /** Position rows: soft-deleted ones plus every row filed under a deleted plan. */
  positions: number;
  /** PII sidecar rows removed alongside those positions. */
  positionPii: number;
  /** Per-position block values removed (with their position, or their block). */
  componentValues: number;
  /** Manual dept × account override rows. */
  buyoutRows: number;
  /** Buyout & Manual Input sheet rows. */
  manualInputRows: number;
  /** Deleted blocks (the user-facing config). */
  blocks: number;
  /** The cost-component definitions those blocks compiled into. */
  componentDefinitions: number;
  /** Removed user-added grid columns (their values are scrubbed too). */
  fields: number;
  /** Deleted Social Security / NI schemes, with their brackets. */
  ssSchemes: number;
  /** Deleted allocation definitions. */
  allocations: number;
  /** Deleted KPI drivers, with their patterns, accounts and cached values. */
  kpiDrivers: number;
  /** Deleted hotel clusters, with their membership rows. */
  hotelClusters: number;
  /** Cached engine output lines orphaned by the rows above. */
  engineOutputLines: number;
}

export const EMPTY_CLEANUP_TALLY: CleanupTally = {
  scenarios: 0,
  positions: 0,
  positionPii: 0,
  componentValues: 0,
  buyoutRows: 0,
  manualInputRows: 0,
  blocks: 0,
  componentDefinitions: 0,
  fields: 0,
  ssSchemes: 0,
  allocations: 0,
  kpiDrivers: 0,
  hotelClusters: 0,
  engineOutputLines: 0,
};

/** Display order + labels for the tally, shared by the card and its dialog. */
export const CLEANUP_GROUPS: ReadonlyArray<{
  key: keyof CleanupTally;
  label: string;
}> = [
  { key: "scenarios", label: "Plans" },
  { key: "positions", label: "Positions" },
  { key: "positionPii", label: "Personal details" },
  { key: "componentValues", label: "Block values" },
  { key: "blocks", label: "Blocks" },
  { key: "componentDefinitions", label: "Cost components" },
  { key: "fields", label: "Grid columns" },
  { key: "ssSchemes", label: "Social security schemes" },
  { key: "allocations", label: "Allocations" },
  { key: "kpiDrivers", label: "KPI drivers" },
  { key: "hotelClusters", label: "Hotel clusters" },
  { key: "manualInputRows", label: "Manual input rows" },
  { key: "buyoutRows", label: "Buyout rows" },
  { key: "engineOutputLines", label: "Cached result lines" },
];

export function cleanupTotal(tally: CleanupTally): number {
  return CLEANUP_GROUPS.reduce((sum, group) => sum + (tally[group.key] || 0), 0);
}

export interface CleanupScanResponse {
  tally: CleanupTally;
  total: number;
  /**
   * False when the encrypted store is locked — the plaintext counts are still
   * real, but positions/values cannot be counted and a purge must not run
   * (half of it would land, orphaning the other half).
   */
  secureAvailable: boolean;
  /** Combined on-disk size of both database files, in bytes. */
  databaseBytes: number;
  /** Current automatic-sweep settings and when it last ran. */
  autoCleanup: AutoCleanupConfig;
  /**
   * How much of `total` is already past the retention window, i.e. what the
   * next automatic sweep would take. 0 when the sweep is off.
   */
  autoEligible: number;
}

export interface SetAutoCleanupRequest {
  /** One of AUTO_CLEANUP_CHOICES. */
  retentionDays: number;
}

export interface CleanupPurgeResponse {
  /** What was actually removed. */
  tally: CleanupTally;
  total: number;
  /** Disk space handed back by the post-purge VACUUM, in bytes (never < 0). */
  bytesReclaimed: number;
}

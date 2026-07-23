/**
 * Field Catalog Service
 * Renderer-side access to the dynamic column catalog. The main process seeds
 * system fields idempotently on every get, so callers always receive the
 * current app version's columns merged with the user's customizations.
 */

import {
  FieldDataType,
  FieldCatalog,
  SectionId,
} from "../shared/positions/fields";
import {
  FieldCatalogPatch,
  FieldCatalogPurgeResponse,
  FieldCatalogResponse,
  POSITIONS_CHANNELS,
  RemovedFieldDto,
} from "../shared/positions/ipc";

function ipc() {
  const api = (window as any)?.ipcApi;
  if (!api?.sendIpcRequest) {
    throw new Error("IPC API not available");
  }
  return api;
}

export async function getFieldCatalog(ou: string): Promise<FieldCatalogResponse> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.fieldCatalogGet, { ou });
  return response.data as FieldCatalogResponse;
}

export async function saveFieldCatalog(
  ou: string,
  patches: FieldCatalogPatch[]
): Promise<FieldCatalogResponse> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.fieldCatalogSave, {
    ou,
    patches,
  });
  return response.data as FieldCatalogResponse;
}

/** PII columns are encrypted alongside the identity fields; every other section
 *  stores its extras next to the engine data. */
function storageForSection(section: SectionId): "PII_EXTRA" | "POSITION_EXTRA" {
  return section === "pii" ? "PII_EXTRA" : "POSITION_EXTRA";
}

/**
 * A sort_order that lands the new column at the END of its section rather than
 * the end of the grid. The band's children must stay contiguous or the grid
 * draws the section banner twice, so we take the midpoint between the section's
 * last field and whatever follows it (the seed leaves gaps of 10 for exactly
 * this).
 */
function sortOrderAtEndOfSection(catalog: FieldCatalog, section: SectionId): number {
  const inSection = catalog.fields.filter((def) => def.section === section);
  if (inSection.length === 0) return 100000;
  const last = Math.max(...inSection.map((def) => def.sortOrder));
  const following = catalog.fields
    .map((def) => def.sortOrder)
    .filter((order) => order > last);
  const next = following.length > 0 ? Math.min(...following) : last + 20;
  const midpoint = Math.floor((last + next) / 2);
  return midpoint > last ? midpoint : last + 1;
}

/**
 * Add a hotel-wide column to a section.
 *
 * This is a single INSERT into `field_catalog` — no table alteration, no
 * backfill, no touching the position rows. Existing positions read the new key
 * as absent from their `extra_values` blob, which is exactly "empty"; a value
 * is only ever written for the rows the user actually types into. Cost is O(1)
 * in the number of positions.
 *
 * Returns the refreshed catalog plus the generated key, which the caller needs
 * to splice into the grid's saved column order.
 */
export async function addSectionField(
  ou: string,
  catalog: FieldCatalog,
  section: SectionId,
  defaultLabel: string,
  dataType: FieldDataType
): Promise<{ catalog: FieldCatalogResponse; key: string }> {
  const before = new Set(catalog.fields.map((def) => def.key));
  const updated = await saveFieldCatalog(ou, [
    {
      create: { section, dataType, defaultLabel, storage: storageForSection(section) },
      sortOrder: sortOrderAtEndOfSection(catalog, section),
    },
  ]);
  const created = updated.fields.find((def) => !before.has(def.key));
  if (!created) throw new Error("The column was not created");
  return { catalog: updated, key: created.key };
}

/**
 * Soft-delete a user column. Reversible via {@link restoreField} until the
 * automatic sweep (or a manual purge) hard-deletes it. Only USER-origin,
 * unlocked fields are removable — the repo rejects anything else. The data in
 * every position's extra_values blob is left intact so the undo is lossless.
 */
export async function removeSectionField(
  ou: string,
  key: string
): Promise<FieldCatalogResponse> {
  return saveFieldCatalog(ou, [{ key, remove: true }]);
}

/** Clear a column's soft delete — the "Recently removed" restore. */
export async function restoreField(
  ou: string,
  key: string
): Promise<FieldCatalogResponse> {
  return saveFieldCatalog(ou, [{ key, restore: true }]);
}

/** Soft-deleted user columns, newest first, each with a cross-scenario value
 *  count (null if the secure store was locked). */
export async function listRemovedFields(ou: string): Promise<RemovedFieldDto[]> {
  const response = await ipc().sendIpcRequest(
    POSITIONS_CHANNELS.fieldCatalogRemoved,
    { ou }
  );
  return (response.data as RemovedFieldDto[]) ?? [];
}

/** Permanently delete removed columns and scrub their values. Returns the keys
 *  actually purged. */
export async function purgeFields(ou: string, keys: string[]): Promise<string[]> {
  const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.fieldCatalogPurge, {
    ou,
    keys,
  });
  return (response.data as FieldCatalogPurgeResponse).purged;
}

/**
 * Automatic cleanup: purge removed columns that hold no data, or whose removal
 * is older than the grace window. Best-effort — a locked secure store (or any
 * failure) resolves to "nothing purged" rather than surfacing an error, since
 * this runs unattended on load.
 */
export async function sweepRemovedFields(
  ou: string,
  graceDays = 30
): Promise<string[]> {
  try {
    const response = await ipc().sendIpcRequest(POSITIONS_CHANNELS.fieldCatalogPurge, {
      ou,
      sweepGraceDays: graceDays,
    });
    return (response.data as FieldCatalogPurgeResponse).purged;
  } catch {
    return [];
  }
}

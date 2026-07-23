/**
 * PositionsWriteQueue — coalescing, debounced persistence for the grid.
 * -----------------------------------------------------------
 * One instance per grid mount, bound to one (ou, scenarioId). Edits coalesce
 * per (row, field) — a second edit to the same cell overwrites the pending
 * value (field-level last-write-wins, correct for a single-writer app). A
 * whole-column fill enqueues N row patches that flush as ONE batch-write IPC
 * call and one SQLite transaction.
 *
 * Timing: 500 ms trailing debounce with a 2 s max-wait cap, so continuous
 * typing still persists. Flushes are serialized — edits arriving while a
 * batch is in flight buffer into the next one, preserving order.
 *
 * Failure: the failed batch is merged back UNDER any newer pending edits
 * (newer wins) and retried with backoff (0.5 s / 2 s / 8 s). SECURE_DB_LOCKED
 * stops retries — the session needs re-auth, not another attempt.
 */

import {
  ComponentValuePatch,
  PositionCreate,
  PositionsBatchWriteRequest,
  SECURE_DB_LOCKED,
} from "../shared/positions/ipc";
import { RowPatch } from "../shared/positions/rowModel";
import { batchWrite } from "./positionsService";

export type RowSaveStatus = "dirty" | "saving" | "saved" | "error";
export type QueueState = "idle" | "dirty" | "saving" | "error" | "locked";

export interface QueueSnapshot {
  state: QueueState;
  pendingRows: number;
  statusByRow: ReadonlyMap<string, RowSaveStatus>;
  lastError: string | null;
}

interface PendingWork {
  creates: Map<string, PositionCreate>;
  positionPatches: Map<string, Record<string, unknown>>;
  piiPatches: Map<string, Record<string, unknown>>;
  /** Block inputs, keyed `positionId|componentDefId` for field-level LWW.
   *  Kept in their own lane even for draft rows — the repo applies creates
   *  before component patches inside one transaction. */
  componentPatches: Map<string, ComponentValuePatch["fields"]>;
  deletes: Set<string>;
  restores: Set<string>;
}

function componentKey(positionId: string, componentDefId: string): string {
  return `${positionId}|${componentDefId}`;
}

function positionIdOfComponentKey(key: string): string {
  return key.slice(0, key.indexOf("|"));
}

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2000;
const RETRY_DELAYS_MS = [500, 2000, 8000];
const SAVED_FLASH_MS = 1500;

function emptyWork(): PendingWork {
  return {
    creates: new Map(),
    positionPatches: new Map(),
    piiPatches: new Map(),
    componentPatches: new Map(),
    deletes: new Set(),
    restores: new Set(),
  };
}

function workIsEmpty(work: PendingWork): boolean {
  return (
    work.creates.size === 0 &&
    work.positionPatches.size === 0 &&
    work.piiPatches.size === 0 &&
    work.componentPatches.size === 0 &&
    work.deletes.size === 0 &&
    work.restores.size === 0
  );
}

/** Merge `base` under `top` — top's fields win. */
function mergeFields(
  base: Record<string, unknown> | undefined,
  top: Record<string, unknown> | undefined
): Record<string, unknown> {
  return { ...(base ?? {}), ...(top ?? {}) };
}

export class PositionsWriteQueue {
  private pending = emptyWork();
  private inFlight: PendingWork | null = null;
  private statusByRow = new Map<string, RowSaveStatus>();
  private savedTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;

  private paused = false; // during clipboard paste
  private disposed = false;
  private locked = false;
  private lastError: string | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly ou: string,
    private readonly scenarioId: string,
    private readonly onChange: (snapshot: QueueSnapshot) => void
  ) {}

  // ── Enqueue ─────────────────────────────────────────────────────

  enqueueCreate(create: PositionCreate): void {
    this.pending.creates.set(create.id, create);
    this.pending.deletes.delete(create.id);
    this.markDirty(create.id);
    this.schedule();
  }

  enqueuePatch(rowId: string, patch: RowPatch): void {
    if (this.pending.deletes.has(rowId)) return; // edits to a deleted row are moot

    const create = this.pending.creates.get(rowId);
    if (create) {
      // The row hasn't been persisted yet — fold the edit into its create.
      create.fields = mergeFields(create.fields, patch.positionFields);
      create.pii = mergeFields(create.pii, patch.piiFields);
    } else {
      if (Object.keys(patch.positionFields).length > 0) {
        this.pending.positionPatches.set(
          rowId,
          mergeFields(this.pending.positionPatches.get(rowId), patch.positionFields)
        );
      }
      if (Object.keys(patch.piiFields).length > 0) {
        this.pending.piiPatches.set(
          rowId,
          mergeFields(this.pending.piiPatches.get(rowId), patch.piiFields)
        );
      }
    }
    this.markDirty(rowId);
    this.schedule();
  }

  /** Block-input edit for one (position, block definition). Field-level LWW
   *  like position patches; rides the same flush/status machinery. */
  enqueueComponentPatch(
    positionId: string,
    componentDefId: string,
    fields: ComponentValuePatch["fields"]
  ): void {
    if (this.pending.deletes.has(positionId)) return;
    const key = componentKey(positionId, componentDefId);
    this.pending.componentPatches.set(key, {
      ...this.pending.componentPatches.get(key),
      ...fields,
    });
    this.markDirty(positionId);
    this.schedule();
  }

  enqueueDelete(rowId: string): void {
    // A never-persisted draft just evaporates.
    if (this.pending.creates.delete(rowId)) {
      this.pending.positionPatches.delete(rowId);
      this.pending.piiPatches.delete(rowId);
      this.dropComponentPatches(rowId);
      this.clearStatus(rowId);
      this.emit();
      return;
    }
    this.pending.positionPatches.delete(rowId);
    this.pending.piiPatches.delete(rowId);
    this.dropComponentPatches(rowId);
    this.pending.restores.delete(rowId);
    this.pending.deletes.add(rowId);
    this.markDirty(rowId);
    this.schedule();
  }

  private dropComponentPatches(rowId: string): void {
    for (const key of [...this.pending.componentPatches.keys()]) {
      if (positionIdOfComponentKey(key) === rowId) {
        this.pending.componentPatches.delete(key);
      }
    }
  }

  enqueueRestore(rowId: string): void {
    this.pending.deletes.delete(rowId);
    this.pending.restores.add(rowId);
    this.markDirty(rowId);
    this.schedule();
  }

  /** Pause scheduling during clipboard paste so a flush doesn't race mid-paste. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.schedule();
  }

  // ── Flush ───────────────────────────────────────────────────────

  /** Immediate flush (blur, unmount, scope switch). Resolves when the queue
   *  has drained or failed into retry/locked state. */
  async flushNow(): Promise<void> {
    this.clearTimers();
    await this.flush();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.flushNow();
    this.disposed = true;
    this.clearTimers();
    for (const timer of this.savedTimers.values()) clearTimeout(timer);
    this.savedTimers.clear();
  }

  private schedule(): void {
    this.emit();
    if (this.paused || this.disposed || this.locked) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);

    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => void this.flush(), MAX_WAIT_MS);
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.retryTimer = null;
  }

  private async flush(): Promise<void> {
    // Serialize: if a flush is running, wait for it, then run (picks up
    // anything that buffered in the meantime).
    if (this.flushing) {
      await this.flushing;
    }
    if (workIsEmpty(this.pending) || this.disposed || this.locked) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;

    const work = this.pending;
    this.pending = emptyWork();
    this.inFlight = work;

    for (const rowId of this.rowIdsOf(work)) {
      this.statusByRow.set(rowId, "saving");
    }
    this.emit();

    const request: PositionsBatchWriteRequest = {
      ou: this.ou,
      scenarioId: this.scenarioId,
      creates: [...work.creates.values()],
      positionPatches: [...work.positionPatches.entries()].map(([id, fields]) => ({
        id,
        fields,
      })),
      piiPatches: [...work.piiPatches.entries()].map(([positionId, fields]) => ({
        positionId,
        fields,
      })),
      componentValuePatches: [...work.componentPatches.entries()].map(
        ([key, fields]) => ({
          positionId: positionIdOfComponentKey(key),
          componentDefId: key.slice(key.indexOf("|") + 1),
          fields,
        })
      ),
      softDeleteIds: [...work.deletes],
      restoreIds: [...work.restores],
    };

    this.flushing = (async () => {
      try {
        await batchWrite(request);
        this.retryCount = 0;
        this.lastError = null;
        for (const rowId of this.rowIdsOf(work)) {
          // A row edited again mid-flight stays dirty, not saved.
          if (this.rowIsPending(rowId)) continue;
          this.statusByRow.set(rowId, "saved");
          this.scheduleSavedClear(rowId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.remergeFailedWork(work);
        if (message === SECURE_DB_LOCKED) {
          this.locked = true;
        } else {
          this.scheduleRetry();
        }
        for (const rowId of this.rowIdsOf(work)) {
          this.statusByRow.set(rowId, "error");
        }
      } finally {
        this.inFlight = null;
        this.flushing = null;
        this.emit();
        if (!workIsEmpty(this.pending) && !this.locked && !this.disposed) {
          this.schedule();
        }
      }
    })();

    await this.flushing;
  }

  /** Put failed work back, but never over the top of newer pending edits. */
  private remergeFailedWork(work: PendingWork): void {
    for (const [id, create] of work.creates) {
      const newer = this.pending.creates.get(id);
      if (newer) {
        newer.fields = mergeFields(create.fields, newer.fields);
        newer.pii = mergeFields(create.pii, newer.pii);
      } else if (!this.pending.deletes.has(id)) {
        // Newer plain patches for this id fold back INTO the create.
        create.fields = mergeFields(create.fields, this.pending.positionPatches.get(id));
        create.pii = mergeFields(create.pii, this.pending.piiPatches.get(id));
        this.pending.positionPatches.delete(id);
        this.pending.piiPatches.delete(id);
        this.pending.creates.set(id, create);
      }
    }
    for (const [id, fields] of work.positionPatches) {
      if (this.pending.deletes.has(id)) continue;
      const create = this.pending.creates.get(id);
      if (create) {
        create.fields = mergeFields(fields, create.fields);
      } else {
        this.pending.positionPatches.set(
          id,
          mergeFields(fields, this.pending.positionPatches.get(id))
        );
      }
    }
    for (const [id, fields] of work.piiPatches) {
      if (this.pending.deletes.has(id)) continue;
      const create = this.pending.creates.get(id);
      if (create) {
        create.pii = mergeFields(fields, create.pii);
      } else {
        this.pending.piiPatches.set(
          id,
          mergeFields(fields, this.pending.piiPatches.get(id))
        );
      }
    }
    for (const [key, fields] of work.componentPatches) {
      if (this.pending.deletes.has(positionIdOfComponentKey(key))) continue;
      // Failed fields go back UNDER newer pending edits (newer wins).
      this.pending.componentPatches.set(key, {
        ...fields,
        ...this.pending.componentPatches.get(key),
      });
    }
    for (const id of work.deletes) {
      if (!this.pending.restores.has(id)) this.pending.deletes.add(id);
    }
    for (const id of work.restores) {
      if (!this.pending.deletes.has(id)) this.pending.restores.add(id);
    }
  }

  private scheduleRetry(): void {
    const delay =
      RETRY_DELAYS_MS[Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1)];
    this.retryCount += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.flush(), delay);
  }

  // ── Status bookkeeping ──────────────────────────────────────────

  private rowIdsOf(work: PendingWork): Set<string> {
    return new Set([
      ...work.creates.keys(),
      ...work.positionPatches.keys(),
      ...work.piiPatches.keys(),
      ...[...work.componentPatches.keys()].map(positionIdOfComponentKey),
      ...work.deletes,
      ...work.restores,
    ]);
  }

  private rowIsPending(rowId: string): boolean {
    if (
      this.pending.creates.has(rowId) ||
      this.pending.positionPatches.has(rowId) ||
      this.pending.piiPatches.has(rowId) ||
      this.pending.deletes.has(rowId) ||
      this.pending.restores.has(rowId)
    ) {
      return true;
    }
    for (const key of this.pending.componentPatches.keys()) {
      if (positionIdOfComponentKey(key) === rowId) return true;
    }
    return false;
  }

  private markDirty(rowId: string): void {
    const timer = this.savedTimers.get(rowId);
    if (timer) {
      clearTimeout(timer);
      this.savedTimers.delete(rowId);
    }
    this.statusByRow.set(rowId, "dirty");
  }

  private clearStatus(rowId: string): void {
    this.statusByRow.delete(rowId);
  }

  private scheduleSavedClear(rowId: string): void {
    const existing = this.savedTimers.get(rowId);
    if (existing) clearTimeout(existing);
    this.savedTimers.set(
      rowId,
      setTimeout(() => {
        if (this.statusByRow.get(rowId) === "saved") {
          this.statusByRow.delete(rowId);
          this.emit();
        }
        this.savedTimers.delete(rowId);
      }, SAVED_FLASH_MS)
    );
  }

  private emit(): void {
    if (this.disposed) return;
    const pendingRows = this.rowIdsOf(this.pending).size;
    let state: QueueState = "idle";
    if (this.locked) state = "locked";
    else if (this.lastError) state = "error";
    else if (this.inFlight) state = "saving";
    else if (pendingRows > 0) state = "dirty";
    this.onChange({
      state,
      pendingRows,
      statusByRow: this.statusByRow,
      lastError: this.lastError,
    });
  }
}

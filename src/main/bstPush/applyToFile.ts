/**
 * The safety layer around the workbook writer: never leave the user's BST worse
 * than we found it.
 *
 * Order of operations, and why:
 *   1. Refuse if Excel has the file open. Excel keeps its own copy in memory and
 *      writes the whole thing on save, so a push under an open workbook would be
 *      silently discarded the moment the user hits Ctrl+S — the most confusing
 *      possible failure.
 *   2. Copy the original beside itself, if the user asked for a backup.
 *   3. Build the new bytes in memory and verify them.
 *   4. Write a temp file in the SAME directory, then rename over the original.
 *      Same directory so the rename is a same-volume atomic move rather than a
 *      copy; a crash at any point before it leaves the original intact.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import type { CellWrite } from "./plan";
import { verifyWrite, writeWorkbook } from "./writeWorkbook";

/**
 * Read a workbook's bytes even if Excel holds the file open. A plain read
 * usually succeeds (Excel opens shared-read), but on a Windows lock (EBUSY /
 * EPERM) we fall back to a temp-copy read. Mirrors the reader the pull uses.
 */
export function readWorkbookBytes(filePath: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
    const tmp = path.join(
      os.tmpdir(),
      `kairos-bst-${randomUUID()}${path.extname(filePath)}`
    );
    try {
      fs.copyFileSync(filePath, tmp);
      return fs.readFileSync(tmp);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/**
 * True when Excel (or another Office app) appears to have the workbook open.
 *
 * Office drops an `~$Name.xlsm` owner file next to the document while it is
 * open. That is the reliable signal; a write probe is the fallback for the case
 * where the owner file is suppressed (some network shares).
 */
export function isWorkbookOpen(filePath: string): boolean {
  const owner = path.join(
    path.dirname(filePath),
    `~$${path.basename(filePath)}`
  );
  if (fs.existsSync(owner)) return true;

  // A probe: open for append. Excel takes a deny-write lock on Windows.
  try {
    fs.closeSync(fs.openSync(filePath, "r+"));
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EBUSY" || code === "EPERM" || code === "EACCES";
  }
}

/** `Budget.xlsm` → `Budget (Kairos backup 2026-07-27 1432).xlsm`. */
export function backupPathFor(filePath: string, when: Date): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}${pad(when.getMinutes())}`;
  return path.join(dir, `${base} (Kairos backup ${stamp})${ext}`);
}

export interface ApplyOptions {
  backup: boolean;
  /** Injectable for tests. */
  now?: () => Date;
}

export interface ApplyResult {
  cellsWritten: number;
  sheetsTouched: number;
  backupPath: string | null;
}

/**
 * Apply cell writes to the workbook at `filePath`.
 *
 * @throws if the file is open in Excel, if the writer refuses the workbook's
 *         shape, or if verification fails — in every case the original file is
 *         left exactly as it was.
 */
export function applyToFile(
  filePath: string,
  writes: CellWrite[],
  options: ApplyOptions
): ApplyResult {
  const now = options.now ?? (() => new Date());

  if (isWorkbookOpen(filePath)) {
    throw new Error(
      `"${path.basename(filePath)}" is open in Excel. Close it first — ` +
        `otherwise Excel would overwrite the push the next time it saves.`
    );
  }

  const original = readWorkbookBytes(filePath);
  const result = writeWorkbook(original, writes);
  // Prove the bytes are a complete, readable workbook holding our numbers
  // BEFORE anything on disk changes.
  verifyWrite(result.bytes, result);

  let backupPath: string | null = null;
  if (options.backup) {
    backupPath = backupPathFor(filePath, now());
    fs.copyFileSync(filePath, backupPath);
  }

  const temp = `${filePath}.kairos-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, result.bytes);
    // Same directory, so this is an atomic same-volume move.
    fs.renameSync(temp, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }

  return {
    cellsWritten: result.cellsWritten,
    sheetsTouched: result.sheetsTouched,
    backupPath,
  };
}

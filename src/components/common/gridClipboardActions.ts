/**
 * Mouse-driven Copy / Paste for the cellSelection grids.
 * -----------------------------------------------------
 * The grids' clipboard behaviour lives entirely inside MUI: Ctrl+C is a native
 * keydown listener on the grid root (useGridClipboard), and Ctrl+V enters
 * through the grid's `cellKeyDown` event (useGridClipboardImport), where MUI
 * mounts a hidden capture <input>, focuses it, and lets the browser's native
 * `paste` deliver the clipboard text to it. Neither path is exposed on apiRef,
 * and re-implementing either would fork the exact pipeline the keyboard uses —
 * the range serializer, the Excel-shaped splitter, processRowUpdate and the
 * isCellEditable gate that keeps masked PII and locked departments read-only.
 *
 * So the mouse route re-enters through the same doors the keyboard uses:
 *
 *  - Copy dispatches a synthetic Ctrl+C keydown at the grid root. MUI's
 *    handler does all of its own work (serialize the selection, write it with
 *    navigator.clipboard.writeText), so the event alone is enough.
 *
 *  - Paste reads the clipboard here — allowed, because Electron grants
 *    clipboard-read and a menu click is a user gesture — then dispatches a
 *    synthetic Ctrl+V at the cell. MUI mounts and focuses its capture input
 *    synchronously, before its first await; a real Ctrl+V's default action
 *    would now deliver the native paste to it, and since a synthetic keydown
 *    has no default action, the ClipboardEvent is delivered by hand instead,
 *    carrying the text just read. Everything downstream is the untouched
 *    Ctrl+V pipeline, so text copied in Excel pastes exactly as it would
 *    with the keyboard.
 *
 * The one internal this leans on is that capture-input handshake, guarded
 * below by shape (a zero-width input inside the grid that took focus). If an
 * upgrade changes the handshake, menu paste degrades to a silent no-op and
 * the keyboard path is untouched.
 */

import type { GridRowId, useGridApiRef } from "@mui/x-data-grid-premium";

type GridApiRef = ReturnType<typeof useGridApiRef>;

/** MUI's shortcut matchers read legacy `event.keyCode`, which the
 *  KeyboardEvent constructor refuses to set — shadowed per instance. */
function shortcutKeydown(key: string, keyCode: number): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "keyCode", { get: () => keyCode });
  return event;
}

/** Copy the current selection — the cell range, or the checked rows if any —
 *  exactly as Ctrl+C would. */
export function copyGridSelectionToClipboard(apiRef: GridApiRef): void {
  apiRef.current?.rootElementRef?.current?.dispatchEvent(
    shortcutKeydown("c", 67)
  );
}

/**
 * Paste the clipboard at `cell`, exactly as Ctrl+V would with that cell
 * focused: a range selection fills the range, a block of rows spreads down
 * and right, and every write still passes isCellEditable + processRowUpdate.
 */
export async function pasteClipboardIntoGrid(
  apiRef: GridApiRef,
  cell: { id: GridRowId; field: string }
): Promise<void> {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return; // Clipboard unreadable (no permission / non-text content).
  }
  if (!text) return;
  const rootEl = apiRef.current?.rootElementRef?.current;
  const cellEl = apiRef.current?.getCellElement(cell.id, cell.field);
  if (!rootEl || !cellEl) return;

  cellEl.dispatchEvent(shortcutKeydown("v", 86));

  // MUI's keydown handler has now mounted and focused its capture input — or
  // declined (a cell is mid-edit, paste disabled), in which case nothing here
  // matches and the paste ends as the keyboard's would: doing nothing.
  const capture = document.activeElement;
  if (
    !(capture instanceof HTMLInputElement) ||
    !rootEl.contains(capture) ||
    capture.style.width !== "0px"
  ) {
    return;
  }
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  capture.dispatchEvent(new ClipboardEvent("paste", { clipboardData }));
}

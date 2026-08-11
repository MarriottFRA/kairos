/**
 * One copied row fills every row of a pasted-into cell range.
 *
 * MUI already does exactly this — but only in defaultPasteResolver's
 * row-selection branch ("If only one row is pasted - paste it to all selected
 * rows"). `cellSelection` sends a dragged range down the earlier cell branch
 * instead, which indexes pastedData[rowIndex], so copying one row of a
 * twelve-month family into a four-row range fills the first row and silently
 * skips the rest. Repeating the row to the height of the range makes the two
 * branches agree.
 *
 * Hooked through `splitClipboardPastedText` rather than on keydown because that
 * is the one supported seam ahead of the resolver, and it only runs on Ctrl+V —
 * nothing is added to the render, scroll or typing paths.
 *
 * Shared so the two editable cellSelection grids cannot drift: this only
 * matters once a grid can select a cell range at all, so every grid that turns
 * `cellSelection` on and accepts pastes wants it.
 */

import type { useGridApiRef } from "@mui/x-data-grid-premium";

type GridApiRef = ReturnType<typeof useGridApiRef>;

/** Build the `splitClipboardPastedText` handler for a grid. */
export function makeCellRangePasteSplitter(apiRef: GridApiRef) {
  return (text: string, delimiter = "\t"): string[][] => {
    const rows = text
      // Excel on Windows appends a trailing newline (MUI's own default does
      // this too — this callback replaces that default wholesale).
      .replace(/\r?\n$/, "")
      .split(/\r\n|\n|\r/)
      .map((row) => row.split(delimiter));
    // A single cell already fills a whole range (isSingleValuePasted), and a
    // genuine multi-row clipboard must keep mapping 1:1 — leave both alone.
    if (rows.length !== 1 || rows[0].length < 2) return rows;
    const selected = apiRef.current?.getSelectedCellsAsArray() ?? [];
    const rowCount = new Set(selected.map((cell) => cell.id)).size;
    if (rowCount < 2) return rows;
    // Copies, not the same array n times: the resolver's other branch consumes
    // rows with pastedData.shift().
    return Array.from({ length: rowCount }, () => rows[0].slice());
  };
}

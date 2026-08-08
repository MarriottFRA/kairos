/**
 * Clipboard paste parsers.
 * -----------------------------------------------------------
 * MUI copies the *formatted* value of a cell (`serializeCellValue` reads
 * `cellParams.formattedValue`) but pastes through `colDef.pastedValueParser ??
 * colDef.valueParser`, skipping the cell entirely when the result is
 * `undefined`. Any column whose formatter is not the identity therefore fails
 * to round-trip through Ctrl+C / Ctrl+V unless it declares the inverse here:
 *
 *  - numbers come back carrying the locale's thousands separators, and the
 *    grid's default numeric parser turns "30,000" into NaN;
 *  - singleSelect columns come back as the option *label*, while MUI's default
 *    parser strict-compares (`===`) against the option *value* — so a copied
 *    "Salaried (30/360)" is tested against "SALARIED" and never matches. For
 *    numeric option values (Increase Month) no clipboard string can ever match.
 *
 * Convention throughout, following the cluster-multiplier parser these were
 * generalised from: an empty cell proposes a clear, unrecognised input returns
 * `undefined` so the paste is rejected and the cell keeps what it had. Garbage
 * must never blank real data — a mis-aligned paste across a range would
 * otherwise wipe a column.
 *
 * "Proposes" because these run before sanitizeRow, which has the last word: a
 * null it returns for an emptied numeric cell is NaN to `toNumber`, so that row
 * key reverts to its old value rather than clearing. The parsers still return
 * null rather than undefined there, to keep the distinction between "the user
 * pasted a blank" and "the user pasted something this column can't read" — only
 * the latter should be a hard reject for callers that do honour a clear.
 */

/** An option list as the column factory builds them for singleSelect columns. */
export interface PasteOption {
  value: string | number;
  label: string;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Inverse of a number cell's `valueFormatter`, derived from the very
 * `Intl.NumberFormat` that produced the text so the two can't drift apart.
 *
 * Returns null for an empty cell (clear), undefined for anything non-numeric
 * (reject) — which also covers pasting a masked cell's dots.
 */
export function makeNumberPasteParser(format: Intl.NumberFormat) {
  const parts = format.formatToParts(12345.6);
  const group = parts.find((part) => part.type === "group")?.value ?? ",";
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  // Several locales group with NBSP or narrow NBSP, but a user retyping the
  // same number reaches for a plain space — strip every flavour of whitespace
  // alongside the locale's own mark.
  const separators = new RegExp(
    `[\\s\\u00a0\\u202f${escapeRegExp(group)}]`,
    "g"
  );

  return (value: unknown): number | null | undefined => {
    const raw = String(value ?? "").replace(separators, "");
    if (raw === "") return null;
    const normalised = decimal === "." ? raw : raw.split(decimal).join(".");
    const num = Number(normalised);
    return Number.isFinite(num) ? num : undefined;
  };
}

/**
 * Inverse of the PERCENT formatter ("5%" -> 0.05), reusing the same
 * whole-percent rule as that column's `valueParser`: values above 1 are read as
 * whole percentages. Unlike the typed-edit parser this rejects garbage rather
 * than falling back to 0, so a bad paste can't silently zero a merit increase.
 */
export function makePercentPasteParser(format: Intl.NumberFormat) {
  const parseNumber = makeNumberPasteParser(format);
  return (value: unknown): number | undefined => {
    const num = parseNumber(String(value ?? "").replace(/%/g, ""));
    // An empty percent cell reads as 0%, matching what the column's own
    // valueParser does for an emptied edit.
    if (num === null) return 0;
    if (num === undefined) return undefined;
    return num > 1 ? num / 100 : num;
  };
}

/**
 * Accepts either face of an option — the label the grid copied, or the stored
 * value — and returns the option's ORIGINAL typed value, so a numeric option
 * list (Increase Month's 1..13) gets a number back rather than a string.
 * Matching is trimmed and case-insensitive; no match rejects the paste.
 */
export function makeOptionPasteParser(options: readonly PasteOption[]) {
  const byKey = new Map<string, string | number>();
  // First option to claim a key wins, so a duplicate label further down the
  // list can't silently redirect a paste to the wrong value.
  const add = (key: string, value: string | number) => {
    const normalised = key.trim().toLowerCase();
    if (normalised !== "" && !byKey.has(normalised)) {
      byKey.set(normalised, value);
    }
  };
  for (const option of options) {
    add(String(option.value), option.value);
    add(option.label, option.value);
  }
  const blank = options.find((option) => option.value === "");

  return (value: unknown): string | number | undefined => {
    const raw = String(value ?? "").trim();
    // Clearing is only offered where the list has a blank option to clear to
    // (Cluster's "None"). Elsewhere the value is required, so an empty paste is
    // a reject rather than a way to punch holes in the column.
    if (raw === "") return blank ? blank.value : undefined;
    return byKey.get(raw.toLowerCase());
  };
}

/**
 * Canonical JSON — the input to every content hash the sync protocol sends.
 * -----------------------------------------------------------
 * The server stores our hashes and compares them for equality; it never
 * recomputes one (see KAIROS_API_FOR_DESKTOP.md §4.1 — "whatever your hash
 * function is, it is the protocol"). So the only hard requirement is that the
 * SAME logical entity serialises identically every time, on this machine and on
 * the colleague's machine that pulled it.
 *
 * Two things break that if you let them:
 *
 *   1. Key order. `JSON.stringify` emits insertion order, and a row read back
 *      out of SQLite after a pull has a different insertion order from the row
 *      the DTO builder made. Keys are therefore sorted at every object level.
 *   2. Number formatting. `-0` stringifies as `0` on one path and `-0` on
 *      another depending on how it was arithmetic'd into existence, and
 *      exponent-range values differ between languages. Both are normalised in
 *      `canonicalNumber` below.
 *
 * Arrays are NEVER reordered — `seasonality` and `monthly_values` are positional
 * and sorting them would change their meaning.
 *
 * `undefined` is dropped (as `JSON.stringify` does) but `null` is preserved: the
 * DTOs use `null` for "column is NULL", which is a real, distinguishable state.
 *
 * This module is pure and Electron-free so both bundles and the tests can import
 * it. The sha256 half lives in src/main/kairosSync/hash.ts (needs node:crypto).
 */

/**
 * Anything the canonicaliser can serialise.
 *
 * The public entry points take `unknown` rather than this, because the values
 * they are handed are entity payloads and structure documents typed as
 * `Record<string, unknown>` — narrowing them at the call site would mean a cast
 * at every one. The type is still worth naming: it documents what is actually
 * supported, and anything outside it (a Date, a Map, a class instance) would
 * serialise to something the round trip cannot reproduce.
 */
export type Canonicalizable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Canonicalizable[]
  | { [key: string]: Canonicalizable };

/**
 * The number of decimal places a float is rounded to before serialising.
 *
 * Nine is comfortably finer than anything the engine means (money to the cent,
 * rates to a basis point, vacation weights to a fraction) and coarse enough that
 * the accumulated error of a float round-trip through SQLite REAL never shows up
 * as a changed hash. Without it, `0.1 + 0.2` hashing differently from `0.3`
 * would make a row look dirty forever and re-publish on every sync.
 */
const DECIMALS = 9;
/** Derived, not written twice — the two drifting apart would be silent. */
const FACTOR = 10 ** DECIMALS;

/**
 * Values at or above this are clamped rather than serialised.
 *
 * JS switches `toString` to exponent notation at 1e21, and an exponent-notation
 * number is exactly where JS and Python's JSON writers stop agreeing (`1e+21`
 * both ways, but `1e-7` against `1e-07`). The structure document's hash is
 * RE-COMPUTED server-side, so a disagreement there is a 422. Clamping well below
 * the switch-over costs nothing: no figure in a payroll plan is legitimately a
 * quadrillion.
 */
const MAX_MAGNITUDE = 1e15;

/**
 * Values below this are snapped to zero — the other half of the same problem.
 *
 * JS uses exponent notation *below* 1e-6 too (`0.0000001` stringifies as
 * `"1e-7"`), and rounding to nine decimals does not prevent it: 1e-7 is already
 * exact at nine. Anything smaller than a millionth cannot represent a cent, an
 * hour or a rate anybody typed, so it is arithmetic residue and zero is the
 * honest value for it.
 */
const MIN_MAGNITUDE = 1e-6;

/**
 * Normalise a number to a form that serialises identically everywhere.
 *
 * - NaN and ±Infinity become `null`. `JSON.stringify` already does this, but
 *   doing it here means the value is visible as null to the caller rather than
 *   appearing only in the output string.
 * - `-0` becomes `0`. They are `===` equal but stringify differently, so a
 *   subtraction that happened to land on negative zero would otherwise change a
 *   row's hash without changing its meaning.
 * - Everything else is rounded to DECIMALS and clamped to ±MAX_MAGNITUDE.
 */
export function canonicalNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return 0; // collapses -0
  if (Number.isInteger(value) && Math.abs(value) <= MAX_MAGNITUDE) return value;

  const clamped = Math.min(Math.abs(value), MAX_MAGNITUDE) * Math.sign(value);
  const rounded = Math.round(clamped * FACTOR) / FACTOR;
  // Below a millionth, `rounded` is still exact but stringifies as an exponent —
  // so the snap has to happen after the rounding, not instead of it.
  if (Math.abs(rounded) < MIN_MAGNITUDE) return 0;
  return rounded;
}

/**
 * Rebuild a value with every object's keys in sorted order and every number
 * normalised. Returns the value ready for a plain `JSON.stringify`.
 *
 * Kept separate from the stringify step because the structure-document path
 * needs the normalised OBJECT (to send as the request body) as well as its
 * hash — sending the un-normalised body and hashing the normalised one is
 * precisely how a docHash mismatch happens.
 */
export function canonicalize(value: unknown): Canonicalizable {
  if (value === null || value === undefined) return value as null | undefined;

  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    // Positional — order is meaning. `undefined` inside an array stringifies as
    // `null`, so make that explicit rather than dialect-dependent.
    return value.map((item) => (item === undefined ? null : canonicalize(item)));
  }

  const source = value as Record<string, unknown>;
  const out: { [key: string]: Canonicalizable } = {};
  for (const key of Object.keys(source).sort()) {
    const child = source[key];
    if (child === undefined) continue; // dropped, as JSON.stringify would
    out[key] = canonicalize(child);
  }
  return out;
}

/**
 * The canonical string form: sorted keys, normalised numbers, no whitespace.
 *
 * Byte-for-byte what `json.dumps(sort_keys=True, separators=(",",":"),
 * ensure_ascii=False)` produces on the server for the same document, which is
 * what `PUT /kairos/ou/{ou}/structure` verifies its `docHash` against.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

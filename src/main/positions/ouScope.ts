/**
 * OuScope — the structural OU-gating primitive.
 * -----------------------------------------------------------
 * Every positions repository function requires an OuScope, and the ONLY way to
 * construct one is resolveOuScope(), which validates the 7-character OU format
 * ("OU" + 5 digits, e.g. OU12345). Repositories bind scope.ou into every WHERE
 * and INSERT and ignore any `ou` embedded in row payloads — so a query that
 * isn't OU-scoped is a compile error, not a code-review catch, and a row
 * object cannot smuggle itself into another hotel's data.
 *
 * Cross-OU (cluster) access is a separate explicit multi-scope API — never a
 * default. There are exactly three, all narrow and all greppable:
 *   main/hotelClusters/repo.ts   the cluster assignment view + clear
 *   main/positions/clusterSync.ts cluster-position sibling rows
 *   main/hotelCopy/copySetup.ts  copy another hotel's setup into this one
 * All mint a scope per target hotel through resolveOuScope() and bind it the
 * same way a single-hotel query would; none ever runs an unscoped write.
 */

// Canonical form: "OU" + a 5-character alphanumeric unit code (e.g. OU25RJ2).
// The code is NOT numeric-only — real units mix letters and digits.
const OU_CANONICAL = /^OU[A-Z0-9]{5}$/;
// A bare 5-character code (the un-prefixed form some sources may carry).
const OU_BARE = /^[A-Z0-9]{5}$/;

export interface OuScope {
  readonly ou: string;
  /** Brand: only resolveOuScope() can produce this type. */
  readonly __brand: "OuScope";
}

export class InvalidOuError extends Error {
  constructor(received: unknown) {
    super(
      `INVALID_OU: expected a hotel OU ("OU" + 5 alphanumeric characters, e.g. OU25RJ2), got ${JSON.stringify(
        received
      )}`
    );
    this.name = "InvalidOuError";
  }
}

/**
 * Canonicalize an OU to the stored 7-character form ("OU" + 5-char unit code,
 * e.g. OU25RJ2 — the same form the hotel switcher persists as
 * selectedHotelOu). A bare 5-character code gets the "OU" prefix added, since
 * the prefix is what distinguishes an operating unit from the company's other
 * 5-character identifiers. Returns null when the value is neither form.
 */
export function normalizeOu(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  if (OU_CANONICAL.test(raw)) return raw;
  if (OU_BARE.test(raw)) return `OU${raw}`;
  return null;
}

/** Validate, canonicalize, and brand an OU (accepts a string or {ou} request). */
export function resolveOuScope(request: unknown): OuScope {
  const raw =
    typeof request === "string"
      ? request
      : typeof (request as { ou?: unknown })?.ou === "string"
        ? (request as { ou: string }).ou
        : "";
  const ou = normalizeOu(raw);
  if (!ou) {
    throw new InvalidOuError(raw);
  }
  return { ou } as OuScope;
}

export function isValidOu(value: unknown): boolean {
  return normalizeOu(value) !== null;
}

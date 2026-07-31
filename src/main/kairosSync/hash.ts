/**
 * Content hashes for the sync protocol.
 * -----------------------------------------------------------
 * The server stores these and compares them for equality; it never recomputes
 * one, so this function IS the protocol (KAIROS_API_FOR_DESKTOP.md §4.1). The
 * only thing that must hold is that the same logical entity hashes the same on
 * every machine — see `shared/kairosSync/canonical.ts` for how that is arranged.
 *
 * Twelve base64url characters is not a stylistic choice: `content_hash` is
 * `String(16)` on the server and `base_hash`/`hash` are capped at 16 on the
 * wire, so a longer digest would be rejected. Nine bytes of SHA-256 encode to
 * exactly twelve characters with no padding.
 *
 * Seventy-two bits is far short of collision resistance in the cryptographic
 * sense, and deliberately so — a hash here answers "did this row change?" for
 * one row within one plan, where the alternative to a collision is a missed
 * update rather than a forged one. Authority comes from the session and the
 * department scope, never from a hash.
 *
 * Separate from the canonicaliser because this half needs node:crypto and so
 * cannot be imported by the renderer bundle.
 */

import { createHash } from "crypto";
import { canonicalJson } from "../../shared/kairosSync/canonical";

/** Bytes of SHA-256 kept. 9 bytes → 12 base64url chars, the column width. */
const DIGEST_BYTES = 9;

/**
 * The 12-character base64url content hash of a canonicalised value.
 *
 * base64url rather than base64 because these travel in URLs on the recovery
 * paths and land in a `String(16)` column; `+` and `/` would need escaping in
 * one and `=` padding would waste four of the sixteen characters.
 */
export function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest()
    .subarray(0, DIGEST_BYTES)
    .toString("base64url");
}

/**
 * The full hex SHA-256 of a canonicalised document.
 *
 * Used for `docHash` on `PUT /ou/{ou}/structure` and `contentHash` on a BST
 * upload, both of which the server RE-COMPUTES and compares (unlike entity
 * hashes, which it takes on trust). Those two are the only places where our
 * canonical form has to agree with Python's `json.dumps`, which is why
 * `canonicalNumber` clamps exponent-range floats.
 */
export function documentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** SHA-256 of raw bytes, hex. Upload part checksums and `declaredHash`. */
export function bytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

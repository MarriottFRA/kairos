/**
 * UUIDv7 generator (RFC 9562) — time-ordered, sync-friendly ids.
 * No npm dependency; works in the renderer, main process, and workers
 * (all provide crypto.getRandomValues).
 *
 * Layout: 48-bit unix-ms timestamp | ver 7 | 12 random bits | var 10 | 62 random bits.
 * A per-millisecond monotonic counter in the rand_a field keeps ids generated
 * in the same millisecond sortable in creation order.
 */

let lastMs = -1;
let seq = 0;

export function uuidv7(): string {
  const now = Date.now();
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
  } else {
    lastMs = now;
    seq = Math.floor(Math.random() * 0x800); // start low so the counter has room
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian timestamp
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // version 7 + 12-bit monotonic sequence
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  // RFC 4122 variant
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return (
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
    "-" + hex.slice(16, 20) + "-" + hex.slice(20)
  );
}

/**
 * Kairos brand mark -> PNG + ICO.
 *
 * Renders the same mark the app shows above the "Kairos" wordmark on the
 * landing/login screens (see src/components/KairosMark.tsx): a grey ring, a
 * teal half-arc rotated -18deg, and a teal centre dot — on a dark rounded
 * plaque so it reads on both light and dark taskbars.
 *
 * Zero dependencies: analytic SDF rasteriser + hand-rolled PNG/ICO encoders.
 * Run: node scripts/generate-brand-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'images');

// ── palette (kept in sync with sceneVars() in src/routes/landing.tsx) ────────
const BG_INNER = [0x10, 0x20, 0x2a]; // radial highlight, top-left
const BG_OUTER = [0x0a, 0x0d, 0x13]; // page background, dark
const ACCENT = [0x34, 0xe0, 0xab]; // --accent (dark mode)
const RING_GREY = [0xee, 0xf2, 0xf7]; // --text, laid down at low alpha
const RING_GREY_A = 0.3; // --line is .09 on screen; icons need more contrast

// ── geometry, as fractions of the icon edge ─────────────────────────────────
const PLAQUE_RADIUS = 0.2222; // rounded-square corner
const RING_R = 0.3;
const RING_HW = 0.0375; // half stroke width
const DOT_R = 0.078;
// The CSS mark colours the top+right borders (a 180deg span centred on 45deg,
// clockwise from 12 o'clock) then rotates the whole ring by -18deg.
const ARC_START = 45 - 90 - 18; // -63deg
const ARC_SWEEP = 180;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Coverage from a signed distance, antialiased over one pixel. */
const cov = (d) => clamp01(0.5 - d);

/** Angle of (dx, dy) in degrees, clockwise from 12 o'clock, in [0, 360). */
function angleCW(dx, dy) {
  const a = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

/** Rounded-rectangle SDF centred at the origin. */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Stroked-arc SDF with round caps; angles clockwise from 12 o'clock. */
function sdArc(px, py, R, hw, startDeg, sweepDeg) {
  const rel = (angleCW(px, py) - startDeg + 720) % 360;
  if (rel <= sweepDeg) return Math.abs(Math.hypot(px, py) - R) - hw;
  // Outside the sweep: fall back to the nearer round cap.
  let best = Infinity;
  for (const deg of [startDeg, startDeg + sweepDeg]) {
    const rad = (deg * Math.PI) / 180;
    const ex = R * Math.sin(rad);
    const ey = -R * Math.cos(rad);
    best = Math.min(best, Math.hypot(px - ex, py - ey) - hw);
  }
  return best;
}

/** Source-over composite of a straight (non-premultiplied) colour onto dst. */
function over(dst, i, rgb, alpha) {
  if (alpha <= 0) return;
  const sa = alpha;
  const da = dst[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  for (let c = 0; c < 3; c++) {
    const s = rgb[c] / 255;
    const d = dst[i + c] / 255;
    dst[i + c] = Math.round(((s * sa + d * da * (1 - sa)) / oa) * 255);
  }
  dst[i + 3] = Math.round(oa * 255);
}

/** Rasterise the mark at `size` px into an RGBA buffer. */
function render(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const c = size / 2;
  const plaqueR = PLAQUE_RADIUS * size;
  const ringR = RING_R * size;
  const ringHw = RING_HW * size;
  const dotR = DOT_R * size;
  // Highlight sits toward the top-left, mirroring the login page's gradient.
  const gx = size * 0.24;
  const gy = size * 0.2;
  const gRadius = size * 1.05;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;

      // Plaque, with a soft radial tint from BG_INNER to BG_OUTER.
      const plaque = cov(sdRoundRect(px, py, c, c, plaqueR));
      if (plaque > 0) {
        const t = clamp01(Math.hypot(x + 0.5 - gx, y + 0.5 - gy) / gRadius);
        const rgb = [0, 1, 2].map((k) => BG_OUTER[k] + (BG_INNER[k] - BG_OUTER[k]) * (1 - t));
        over(buf, i, rgb, plaque);
      }

      // Grey ring (full circle), then the teal half-arc on top of it.
      over(buf, i, RING_GREY, cov(Math.abs(Math.hypot(px, py) - ringR) - ringHw) * RING_GREY_A);
      over(buf, i, ACCENT, cov(sdArc(px, py, ringR, ringHw, ARC_START, ARC_SWEEP)));

      // Centre dot.
      over(buf, i, ACCENT, cov(Math.hypot(px, py) - dotR));
    }
  }
  return buf;
}

// ── PNG encoder (8-bit RGBA, filter 0) ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO encoder ─────────────────────────────────────────────────────────────
// 32bpp bottom-up BGRA DIB for the small sizes (widest tooling support), PNG
// for 128/256 (keeps the file small; supported since Vista).
function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows + AND-mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4; // rows padded to 4 bytes
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size, 0)]);
}

function encodeIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dirEntries = [];
  const blobs = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dirEntries.push(e);
    blobs.push(data);
  }
  return Buffer.concat([dir, ...dirEntries, ...blobs]);
}

// ── ICNS encoder (macOS) ────────────────────────────────────────────────────
// Modern PNG-bearing types only, matching what `iconutil` emits.
const ICNS_TYPES = [
  ['ic11', 32], // 16pt @2x
  ['ic12', 64], // 32pt @2x
  ['ic07', 128],
  ['ic13', 256], // 128pt @2x
  ['ic08', 256],
  ['ic14', 512], // 256pt @2x
  ['ic09', 512],
  ['ic10', 1024], // 512pt @2x
];

function encodeIcns(pngFor) {
  const parts = [];
  for (const [type, size] of ICNS_TYPES) {
    const png = pngFor(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ── main ────────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIZES = [32, 64, 128, 256, 512, 1024];

const ICNS_SIZES = ICNS_TYPES.map(([, s]) => s);

const rendered = new Map();
for (const s of new Set([...ICO_SIZES, ...PNG_SIZES, ...ICNS_SIZES])) rendered.set(s, render(s));

const pngCache = new Map();
const pngFor = (s) => {
  if (!pngCache.has(s)) pngCache.set(s, encodePng(rendered.get(s), s));
  return pngCache.get(s);
};

for (const s of PNG_SIZES) {
  const name = s === 512 ? 'kairos_logo.png' : `kairos_logo_${s}.png`;
  const png = pngFor(s);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`  ${name.padEnd(22)} ${s}x${s}  ${png.length} bytes`);
}

const ico = encodeIco(
  ICO_SIZES.map((s) => ({
    size: s,
    data: s >= 128 ? pngFor(s) : encodeDib(rendered.get(s), s),
  }))
);
writeFileSync(join(OUT_DIR, 'kairos_logo.ico'), ico);
console.log(`  kairos_logo.ico        ${ICO_SIZES.join(',')}  ${ico.length} bytes`);

const icns = encodeIcns(pngFor);
writeFileSync(join(OUT_DIR, 'kairos_logo.icns'), icns);
console.log(`  kairos_logo.icns       ${[...new Set(ICNS_SIZES)].join(',')}  ${icns.length} bytes`);

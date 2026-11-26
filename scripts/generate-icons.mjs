import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'icons');

/**
 * Compute IEEE 802.3 CRC-32 for PNG chunks.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance helpers in normalized 512x512 coordinate space
function distSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom > 0 ? Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom)) : 0;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.hypot(dx, dy);
}

function distRoundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function distArc(px, py, cx, cy, r, a0, a1) {
  // Sample closest angle along circular arc [a0, a1]
  let ang = Math.atan2(py - cy, px - cx);
  // Normalize relative to midpoint
  const mid = (a0 + a1) * 0.5;
  while (ang - mid > Math.PI) ang -= Math.PI * 2;
  while (ang - mid < -Math.PI) ang += Math.PI * 2;
  const clamped = Math.max(a0, Math.min(a1, ang));
  const ax = cx + Math.cos(clamped) * r;
  const ay = cy + Math.sin(clamped) * r;
  return Math.hypot(px - ax, py - ay);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function renderIconRgba(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  const aa = 1.25 * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * scale;
      const py = (y + 0.5) * scale;

      // Warm diagonal terracotta gradient (#D2785B -> #B85C40)
      const g = Math.max(0, Math.min(1, (px + py) / 1024));
      let r = lerp(210, 184, g);
      let gr = lerp(120, 92, g);
      let b = lerp(91, 64, g);

      // Subtle inner hairline frame
      const frameD = Math.abs(distRoundedRect(px, py, 256, 256, 212, 212, 84)) - 2;
      const frameAlpha = (1 - smoothstep(-aa, aa, frameD)) * 0.22;
      r = lerp(r, 250, frameAlpha);
      gr = lerp(gr, 247, frameAlpha);
      b = lerp(b, 242, frameAlpha);

      // Hanger geometry in 512x512 coordinates (stroke half-width = 13)
      const strokeHalf = 13;
      const dHookArc = distArc(px, py, 258, 152, 28, Math.PI * 0.92, Math.PI * 2.24);
      const dHookJoin = distSegment(px, py, 278, 171, 256, 188);
      const dStem = distSegment(px, py, 256, 188, 256, 210);
      const dLeft = distSegment(px, py, 256, 210, 108, 316);
      const dRight = distSegment(px, py, 256, 210, 404, 316);
      const dLeftCurve = distSegment(px, py, 108, 316, 118, 344);
      const dRightCurve = distSegment(px, py, 404, 316, 394, 344);
      const dBottom = distSegment(px, py, 118, 344, 394, 344);

      const hangerStrokeDist = Math.min(
        dHookArc,
        dHookJoin,
        dStem,
        dLeft,
        dRight,
        dLeftCurve,
        dRightCurve,
        dBottom,
      ) - strokeHalf;

      // Center decorative dot
      const dDot = Math.hypot(px - 256, py - 284) - 14;
      const fgDist = Math.min(hangerStrokeDist, dDot);
      const fgAlpha = 1 - smoothstep(-aa, aa, fgDist);

      r = lerp(r, 250, fgAlpha);
      gr = lerp(gr, 247, fgAlpha);
      b = lerp(b, 242, fgAlpha);

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(r);
      rgba[idx + 1] = Math.round(gr);
      rgba[idx + 2] = Math.round(b);
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

mkdirSync(ICONS_DIR, { recursive: true });

const targets = [
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
];

for (const { name, size } of targets) {
  const rgba = renderIconRgba(size);
  const png = encodePng(size, size, rgba);
  const outPath = join(ICONS_DIR, name);
  writeFileSync(outPath, png);
  console.log(`Generated ${name} (${size}x${size}, ${png.length} bytes)`);
}

'use strict';

// Generates extension/icons/icon{16,32,48,128}.png: a white briefcase with a check mark on a blue
// rounded square. Pure Node (zlib only), so the icons can be rebuilt without any image tooling.
// Usage: npm run icons

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 8; // samples per pixel per axis, for anti-aliasing
const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

// Shapes in a 0..1 coordinate space, painted in order; the last shape covering a point wins.
const LAYERS = [
  { color: BLUE, hit: (x, y) => inRoundedRect(x, y, 0, 0, 1, 1, 0.22) },
  { color: WHITE, hit: (x, y) => inRoundedRect(x, y, 0.35, 0.18, 0.65, 0.4, 0.07) },
  { color: BLUE, hit: (x, y) => inRoundedRect(x, y, 0.43, 0.26, 0.57, 0.4, 0.02) },
  { color: WHITE, hit: (x, y) => inRoundedRect(x, y, 0.16, 0.33, 0.84, 0.81, 0.09) },
  { color: BLUE, hit: (x, y) => nearPolyline(x, y, [[0.36, 0.57], [0.46, 0.67], [0.65, 0.47]], 0.045) },
];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function nearPolyline(x, y, points, halfWidth) {
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(x, y, points[i - 1], points[i]) <= halfWidth) return true;
  }
  return false;
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          let color = null;
          for (const layer of LAYERS) if (layer.hit(x, y)) color = layer.color;
          if (!color) continue;
          covered++;
          for (let c = 0; c < 3; c++) sum[c] += color[c];
        }
      }
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) pixels[i + c] = covered ? Math.round(sum[c] / covered) : 0;
      pixels[i + 3] = Math.round((covered / samples) * 255);
    }
  }
  return pixels;
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); // filter byte 0
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

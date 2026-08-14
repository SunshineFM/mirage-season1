#!/usr/bin/env node
/**
 * Generate PWA PNG icons for Mirage
 * Sky blue (#0284C7) background with white "m" letter
 * Pure Node.js — no external dependencies
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ---- CRC32 ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t   = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// ---- Draw an "m" glyph on an RGBA canvas ----
// The glyph is a simplified sans-serif lowercase m using filled rectangles
function drawM(pixels, W, H) {
  const pw = 4; // bytes per pixel (RGBA)
  function setWhite(x, y) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * pw;
    pixels[i] = 255; pixels[i+1] = 255; pixels[i+2] = 255; pixels[i+3] = 255;
  }
  function fillRect(x, y, w, h) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        setWhite(x + dx, y + dy);
  }

  // Scale the "m" to ~55% of the icon size, centered
  const s = Math.round(W * 0.55); // glyph bounding box
  const ox = Math.round((W - s) / 2);
  const oy = Math.round((H - s * 0.6) / 2); // vertical center (m is half-height)

  // "m" is drawn in a grid relative to s×(s*0.6) box:
  //  ██ ████ ████
  //  █   █    █
  //  █   █    █
  //  █   █    █
  // Stem width = ~13%, bump top at 0%, bump bottom at 100%
  const sw = Math.max(2, Math.round(s * 0.13)); // stem width
  const gh = Math.round(s * 0.60);             // glyph height
  const bs = Math.round(s * 0.02);             // small gap between stems

  // Left stem
  fillRect(ox,                    oy, sw, gh);
  // Left bump arc top (horizontal bar)
  const midL = ox + sw;
  const midLW = Math.round(s * 0.36);
  fillRect(midL, oy, midLW, sw); // top connector left arc
  // Middle stem
  const midStemX = midL + midLW - sw;
  fillRect(midStemX,              oy + sw, sw, gh - sw);
  // Right bump arc top
  const midR = midStemX + sw;
  const midRW = Math.round(s * 0.36);
  fillRect(midR, oy, midRW, sw); // top connector right arc
  // Right stem
  const rightStemX = midR + midRW - sw;
  fillRect(rightStemX,            oy + sw, sw, gh - sw);
}

// ---- Create PNG buffer ----
function createPNG(size) {
  const W = size, H = size;
  // Fill sky-blue background #0284C7 = [2, 132, 199]
  const pixels = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H * 4; i += 4) {
    pixels[i]   = 2;
    pixels[i+1] = 132;
    pixels[i+2] = 199;
    pixels[i+3] = 255;
  }

  // Draw the "m"
  drawM(pixels, W, H);

  // Build raw PNG scanlines (filter type 0 = None before each row)
  const rows = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    rows[y * (1 + W * 4)] = 0; // filter = None
    pixels.copy(rows, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const compressed = zlib.deflateSync(rows, { level: 9 });

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR (13 bytes)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Generate ----
const out = path.join(__dirname, '..', 'public');
fs.mkdirSync(out, { recursive: true });

for (const size of [192, 512]) {
  const png = createPNG(size);
  const dest = path.join(out, `icon-${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`Generated ${dest} (${png.length} bytes)`);
}
console.log('Done.');

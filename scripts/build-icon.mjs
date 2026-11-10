#!/usr/bin/env node

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const ASSETS = resolve(ROOT, 'assets');
const PREVIEW = resolve(ROOT, '.artifacts/icon-preview');
const GRID = 64;

const COLORS = {
  navy: [20, 18, 47, 255],
  ink: [7, 6, 20, 255],
  cream: [255, 222, 163, 255],
  orange: [255, 105, 38, 255],
  clear: [0, 0, 0, 0],
};

const pixels = new Uint8Array(GRID * GRID * 4);

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
  pixels.set(color, (y * GRID + x) * 4);
}

function fillRect(x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) setPixel(px, py, color);
  }
}

// Transparent, stepped corners make the app tile itself part of the pixel art.
for (let y = 0; y < GRID; y += 1) {
  const edge = Math.min(y, GRID - 1 - y);
  const inset = edge < 2 ? 12 : edge < 4 ? 8 : edge < 6 ? 6 : edge < 8 ? 4 : edge < 12 ? 2 : 0;
  fillRect(inset, y, GRID - inset * 2, 1, COLORS.navy);
}

// One quiet symbol: a roof, one agent, and one monitor.
const roofBlocks = [
  [8, 28], [12, 24], [16, 20], [20, 16], [24, 12], [28, 8],
  [32, 12], [36, 16], [40, 20], [44, 24], [48, 28],
];
for (const [x, y] of roofBlocks) fillRect(x, y, 8, 4, COLORS.cream);
fillRect(8, 28, 4, 24, COLORS.cream);
fillRect(52, 28, 4, 24, COLORS.cream);

// Agent head and shoulders, with a two-pixel dark keyline.
fillRect(26, 22, 12, 14, COLORS.ink);
fillRect(23, 25, 18, 8, COLORS.ink);
fillRect(28, 24, 8, 10, COLORS.orange);
fillRect(25, 27, 14, 4, COLORS.orange);
fillRect(22, 37, 20, 4, COLORS.ink);
fillRect(20, 40, 24, 10, COLORS.ink);
fillRect(24, 39, 16, 4, COLORS.orange);
fillRect(22, 41, 4, 7, COLORS.orange);
fillRect(38, 41, 4, 7, COLORS.orange);

// Monitor, stand, and base.
fillRect(24, 40, 16, 13, COLORS.ink);
fillRect(26, 42, 12, 8, COLORS.navy);
fillRect(30, 53, 4, 5, COLORS.cream);
fillRect(27, 58, 10, 3, COLORS.cream);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function pngBuffer(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    const sourceY = Math.floor((y * GRID) / size);
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.floor((x * GRID) / size);
      const source = (sourceY * GRID + sourceX) * 4;
      raw.set(pixels.subarray(source, source + 4), row + 1 + x * 4);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(ASSETS, { recursive: true });
mkdirSync(PREVIEW, { recursive: true });

writeFileSync(resolve(ASSETS, 'icon.png'), pngBuffer(1024));

function icnsChunk(type, size) {
  const image = pngBuffer(size);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(image.length + 8, 4);
  return Buffer.concat([header, image]);
}

const icnsImages = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
].map(([type, size]) => icnsChunk(type, size));
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 4, 'ascii');
icnsHeader.writeUInt32BE(8 + icnsImages.reduce((sum, image) => sum + image.length, 0), 4);
writeFileSync(resolve(ASSETS, 'icon.icns'), Buffer.concat([icnsHeader, ...icnsImages]));

for (const size of [16, 32, 64, 128, 256]) {
  writeFileSync(resolve(PREVIEW, `icon-${size}.png`), pngBuffer(size));
}

rmSync(resolve(ROOT, '.artifacts/icon.iconset'), { recursive: true, force: true });

console.log('Built assets/icon.png, assets/icon.icns, and icon previews.');

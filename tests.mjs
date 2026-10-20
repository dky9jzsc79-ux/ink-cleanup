/*
Copyright (C) 2026 Mason
SPDX-License-Identifier: GPL-2.0-or-later
Ink Cleanup is free software, licensed under GPL version 2 or any later version.
See LICENSE. This program is provided without warranty.
*/
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as vm from 'node:vm';
import * as zlib from 'node:zlib';

// ─── Test framework ──────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  FAIL: ' + msg); }
}

function approxEqual(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', expected ~' + b + ')');
}

function test(name, fn) {
  console.log(name);
  try { fn(); } catch (e) {
    failed++; failures.push(name + ': ' + e.message);
    console.log('  ERROR: ' + e.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────

// Create a minimal valid PNG (8-bit grayscale, type 0) from raw pixel data
function createGrayscalePNG(width, height, pixels, dpi) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 0;   // colour type (grayscale)
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // pHYs chunk (optional, pixels per meter)
  let phys = Buffer.alloc(0);
  if (dpi) {
    const ppm = Math.round(dpi / 0.0254);
    const physData = Buffer.alloc(9);
    physData.writeUInt32BE(ppm, 0); // x pixels per unit
    physData.writeUInt32BE(ppm, 4); // y pixels per unit
    physData[8] = 1; // unit: meter
    phys = makeChunk('pHYs', physData);
  }

  // IDAT
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width)] = 0; // filter byte: none
    for (let x = 0; x < width; x++) {
      raw[y * (1 + width) + 1 + x] = pixels[y * width + x];
    }
  }
  const compressed = zlib.deflateSync(raw);
  const idat = makeChunk('IDAT', compressed);

  // IEND
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, phys, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// CRC32 for PNG
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Parse PNG chunks
function parsePNGChunks(buf) {
  if (buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
    throw new Error('Not a PNG file');
  }
  const chunks = [];
  let offset = 8; // skip signature
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.slice(offset + 8, offset + 8 + length);
    chunks.push({ type, data, offset });
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return chunks;
}

// ─── Pure JS implementations of pipeline math for testing ────

// DivideSrc: result = dst / src (scaled to 0-255 range in Q8)
// The report says: a.composite(b, DivideSrc) produces dst/src
// where a is the destination (scan) and b is the source (blurred)
// result = clamp(a / b * Quantum.Max) but in Q8: result = a * 255 / b
// Actually from the report: a=#404040 (64), b=#808080 (128), DivideSrc -> 128
// 64/128 * 255 = 127.5 -> 128. So formula is: dst * 255 / src
function divideSrc(dstVal, srcVal) {
  if (srcVal === 0) return 255;
  return Math.min(255, Math.round(dstVal * 255 / srcVal));
}

// DivideDst: a=#404040 (64), b=#808080 (128), DivideDst -> white (255)
// result = src * 255 / dst = 128 * 255 / 64 = 510 -> clamp to 255
function divideDst(dstVal, srcVal) {
  if (dstVal === 0) return 255;
  return Math.min(255, Math.round(srcVal * 255 / dstVal));
}

// Load the real page and worker functions by evaluating the pure script block of index.html
function loadAppFunctions() {
  const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf-8');
  const pureScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const page = vm.runInContext(pureScript + '\n;({ scaledSizes, WORKER_SOURCE });', vm.createContext({}));
  const workerSelf = { postMessage() {} };
  const workerContext = vm.createContext({ self: workerSelf, importScripts() {}, setTimeout, Uint8Array });
  const worker = vm.runInContext(page.scaledSizes.toString() + '\n' + page.WORKER_SOURCE +
    '\n;({ jsSpeckFilter, computeGuard, isAllWhite, prepareOutput, processImage, setEngine: m => { M = m; enginePromise = Promise.resolve(m); } });', workerContext);
  return { ...page, ...worker, workerSelf };
}

const { scaledSizes, jsSpeckFilter, computeGuard, isAllWhite, prepareOutput, processImage, setEngine, workerSelf } = loadAppFunctions();

// Fake magick-wasm engine that records every image operation with the image size it ran at.
// Pixel reads return white, so the worker stops at its empty-result check after compositing.
function fakeImage(width, height, log) {
  const state = { width, height, hasAlpha: false };
  const behaviour = {
    resize(w, h) { state.width = w; state.height = h; },
    clone(cb) { cb(fakeImage(state.width, state.height, log)); },
    getPixels(cb) { return cb({ toByteArray: (x, y, w, h) => new Uint8Array(w * h).fill(255) }); }
  };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        log.push({ op: key, width: state.width, args });
        return behaviour[key] ? behaviour[key](...args) : undefined;
      };
    }
  });
}

// Mirrors magick-wasm 0.0.43 Percentage: toDouble() is the raw value, _toQuantum() scales by Quantum.max
function FakePercentage(v) { this.value = v; }
FakePercentage.prototype.toDouble = function () { return this.value; };
FakePercentage.prototype._toQuantum = function () { return 255 * this.value / 100; };

function runPipeline(srcW, srcH, params, isExport) {
  const log = [];
  const messages = [];
  const names = new Proxy({}, { get: (t, key) => key });
  setEngine({
    ImageMagick: { read(bytes, cb) { cb(fakeImage(srcW, srcH, log)); } },
    Percentage: FakePercentage,
    Quantum: { max: 255 },
    MorphologySettings: function () {},
    FilterType: names, CompositeOperator: names, MagickColors: names, AlphaAction: names,
    ColorSpace: names, MorphologyMethod: names
  });
  workerSelf.postMessage = m => messages.push(m);
  processImage({ genId: 1, bytes: new Uint8Array(0), params, isExport });
  return { log, messages };
}

function countComponents(values, w, h) {
  return jsSpeckFilter(new Uint8Array(values), w, h, 0).components;
}

function speckFilter(values, w, h, cutoff) {
  const result = jsSpeckFilter(new Uint8Array(values), w, h, cutoff);
  return { values: result.values, removed: result.components - countComponents(result.values, w, h) };
}

// ─── Tests ───────────────────────────────────────────────────

console.log('\n=== Ink Cleanup Tests ===\n');

// 1. Divide direction regression test
test('DivideSrc direction: 64/128 -> 128', () => {
  const result = divideSrc(64, 128);
  assert(result === 128, 'DivideSrc(64, 128) should be 128, got ' + result);
});

test('DivideSrc: equal values -> 255', () => {
  const result = divideSrc(128, 128);
  assert(result === 255, 'DivideSrc(128, 128) should be 255, got ' + result);
});

test('DivideSrc: white/white -> 255', () => {
  const result = divideSrc(255, 255);
  assert(result === 255, 'DivideSrc(255, 255) should be 255, got ' + result);
});

test('DivideSrc: zero source -> 255 (avoid division by zero)', () => {
  const result = divideSrc(100, 0);
  assert(result === 255, 'DivideSrc(100, 0) should be 255 to avoid div by zero, got ' + result);
});

test('DivideDst direction: 128*255/64 -> 255 (clamped)', () => {
  const result = divideDst(64, 128);
  assert(result === 255, 'DivideDst(64, 128) should be 255 (clamped), got ' + result);
});

test('DivideDst: 128*255/255 -> 128', () => {
  const result = divideDst(255, 128);
  assert(result === 128, 'DivideDst(255, 128) should be 128, got ' + result);
});

// 2. Uniform paper and empty result handling
test('Uniform paper: divideSrc(200, 200) -> 255 (normalized to white)', () => {
  const result = divideSrc(200, 200);
  assert(result === 255, 'Uniform paper should normalize to white, got ' + result);
});

test('All-white input is reported as an empty result', () => {
  const w = 10, h = 10;
  const values = new Uint8Array(w * h).fill(255);
  assert(isAllWhite(values), 'Worker should report an all-white image as empty');
  values[55] = 200;
  assert(!isAllWhite(values), 'Worker should not report an image with ink as empty');
});

test('All-black input: divideSrc(0, 0) -> 255 (not NaN)', () => {
  const result = divideSrc(0, 0);
  assert(result === 255, 'All-black should not produce NaN, got ' + result);
});

// 5. 8-connected components including diagonal
test('8-connected: diagonal components are single component', () => {
  // 5x5 grid with diagonal dots
  const w = 5, h = 5;
  const values = new Uint8Array(w * h);
  values[0 * w + 0] = 1;   // (0,0)
  values[1 * w + 1] = 1;   // (1,1) - diagonal neighbor
  values[2 * w + 2] = 1;   // (2,2) - diagonal neighbor
  const count = countComponents(values, w, h);
  assert(count === 1, 'Diagonal-connected pixels should be 1 component, got ' + count);
});

test('8-connected: separated pixels are distinct components', () => {
  const w = 5, h = 5;
  const values = new Uint8Array(w * h);
  values[0 * w + 0] = 1;
  values[0 * w + 2] = 1;  // separated by 1 white pixel
  values[4 * w + 4] = 1;
  const count = countComponents(values, w, h);
  assert(count === 3, 'Three separated pixels should be 3 components, got ' + count);
});

// 6. More than 256 components (Q8 label limit regression)
test('8-connected: handles >256 components', () => {
  const w = 600, h = 1;
  const values = new Uint8Array(w * h);
  for (let i = 0; i < 300; i++) values[i * 2] = 1;
  const count = countComponents(values, w, h);
  assert(count === 300, 'Should handle 300 components (above Q8 limit of ~256), got ' + count);
});

test('8-connected: 1000 components all labeled', () => {
  const w = 2000, h = 1;
  const values = new Uint8Array(w * h);
  for (let i = 0; i < 1000; i++) values[i * 2] = 1;
  const count = countComponents(values, w, h);
  assert(count === 1000, 'Should handle 1000 components, got ' + count);
});

// 7. Specks below, at, and above cutoff
test('Speck filter: removes components below cutoff', () => {
  const w = 10, h = 1;
  const values = new Uint8Array(w * h);
  values[0] = 1; values[1] = 1; // size 2 component
  values[5] = 1; // size 1 component (speck)
  const { removed } = speckFilter(values, w, h, 2);
  assert(removed === 1, 'Should remove 1 speck (size 1 < cutoff 2), got ' + removed);
});

test('Speck filter: keeps components at cutoff (>=cutoff)', () => {
  const w = 10, h = 1;
  const values = new Uint8Array(w * h);
  values[0] = 1; values[1] = 1; // size 2
  const { removed } = speckFilter(values, w, h, 2);
  assert(removed === 0, 'Should keep component at cutoff (size 2 >= cutoff 2), got removed=' + removed);
});

test('Speck filter: removes components above some cutoff but below higher cutoff', () => {
  const w = 10, h = 1;
  const values = new Uint8Array(w * h);
  values[0] = 1; values[1] = 1; values[2] = 1; // size 3
  values[5] = 1; // size 1
  const r1 = speckFilter(values, w, h, 5);
  assert(r1.removed === 2, 'With cutoff 5, both should be removed, got ' + r1.removed);
  const r2 = speckFilter(values, w, h, 1);
  assert(r2.removed === 0, 'With cutoff 1, nothing removed (all >= 1), got ' + r2.removed);
});

test('Speck filter: zero cutoff bypasses filtering', () => {
  const w = 10, h = 1;
  const values = new Uint8Array(w * h);
  values[0] = 1; // size 1 speck
  const { removed, values: result } = speckFilter(values, w, h, 0);
  assert(removed === 0, 'Zero cutoff should bypass, got removed=' + removed);
  assert(result[0] === 1, 'Speck should remain with zero cutoff');
});

// 8. Legitimate detached dots kept
test('Speck filter: legitimate small dot at cutoff is kept', () => {
  const w = 20, h = 1;
  const values = new Uint8Array(w * h);
  // A 4-pixel dot (i-dot) and a long stroke
  values[0] = 1; values[1] = 1; values[2] = 1; values[3] = 1; // 4px dot
  for (let i = 10; i < 18; i++) values[i] = 1; // 8px stroke
  const { removed } = speckFilter(values, w, h, 4);
  assert(removed === 0, '4px dot should be kept with cutoff 4, got removed=' + removed);
});

test('Speck filter: tiny dot below cutoff removed, larger dot kept', () => {
  const w = 20, h = 1;
  const values = new Uint8Array(w * h);
  values[0] = 1; // 1px speck
  values[2] = 1; values[3] = 1; values[4] = 1; values[5] = 1; // 4px dot
  const { removed, values: result } = speckFilter(values, w, h, 4);
  assert(removed === 1, '1px speck removed, 4px dot kept, got removed=' + removed);
  assert(result[0] === 0, '1px speck should be cleared');
  assert(result[2] === 1, '4px dot should remain');
});

// 10. Scaled lengths and areas
test('Scaled sizes: 4 px² area and 1 px dilation at 3x -> 36 px², radius 3', () => {
  const { areaCutoff, diskRadius } = scaledSizes(4, 1, 3);
  assert(areaCutoff === 36, 'Area cutoff should be 36, got ' + areaCutoff);
  assert(diskRadius === 3, 'Disk radius should be 3, got ' + diskRadius);
});

test('Scaled sizes: 4 px² at 1x -> 4', () => {
  const { areaCutoff } = scaledSizes(4, 1, 1);
  assert(areaCutoff === 4, 'Area cutoff should be 4, got ' + areaCutoff);
});

test('Scaled sizes: zero dilation -> no dilation', () => {
  const { diskRadius } = scaledSizes(4, 0, 3);
  assert(diskRadius === 0, 'Zero dilation should give radius 0, got ' + diskRadius);
});

test('Scaled sizes: zero speck area -> nothing removed', () => {
  const { areaCutoff } = scaledSizes(0, 1, 3);
  const { removed } = speckFilter(new Uint8Array([1, 0, 0]), 3, 1, areaCutoff);
  assert(removed === 0, 'Zero area should remove nothing, got removed=' + removed);
});

// 12. Worker stage order
const PIPELINE_PARAMS = { blur: 30, blackPoint: 8, whitePoint: 92, upsample: 3, speckArea: 4, dilation: 1, trimFuzz: 2, border: 12, dpi: 300 };

function stageOrder(log) {
  return log.filter(e => ['blur', 'composite', 'normalize', 'resize', 'level'].includes(e.op))
    .map(e => e.op === 'composite' ? e.args[1] : e.op);
}

test('Pipeline: export flat-fields at source scale, then upsamples, levels and masks', () => {
  const params = { ...PIPELINE_PARAMS, blur: 30, upsample: 3 };
  const { log, messages } = runPipeline(200, 100, params, true);
  const order = stageOrder(log);
  const expected = ['blur', 'DivideSrc', 'normalize', 'resize', 'level', 'Lighten'];
  assert(JSON.stringify(order) === JSON.stringify(expected), 'Stage order should be ' + expected.join(',') + ', got ' + order.join(','));
  const blur = log.find(e => e.op === 'blur');
  assert(blur.width === 200 && blur.args[1] === 30, 'Blur should run at source width with unscaled sigma, got width ' + blur.width + ' sigma ' + blur.args[1]);
  const resize = log.find(e => e.op === 'resize');
  assert(resize.args[0] === 600 && resize.args[1] === 300, 'Export should upsample to 600x300, got ' + resize.args.slice(0, 2));
  assert(messages.length === 1 && messages[0].type === 'empty-result', 'Fake white image should end as empty-result');
});

test('Pipeline: downscaled draft flat-fields at draft size with scaled sigma', () => {
  const { log } = runPipeline(1000, 1000, { ...PIPELINE_PARAMS, blur: 20 }, false);
  const order = stageOrder(log);
  const expected = ['resize', 'blur', 'DivideSrc', 'normalize', 'level', 'Lighten'];
  assert(JSON.stringify(order) === JSON.stringify(expected), 'Draft stage order should be ' + expected.join(',') + ', got ' + order.join(','));
  const draftW = log.find(e => e.op === 'resize').args[0];
  assert(draftW < 1000, 'Draft should downscale the source, got width ' + draftW);
  const blur = log.find(e => e.op === 'blur');
  assert(blur.width === draftW, 'Draft blur should run at draft width ' + draftW + ', got ' + blur.width);
  approxEqual(blur.args[1], 20 * draftW / 1000, 1e-9, 'Draft blur sigma should scale by the draft ratio');
});

test('Pipeline: small-source draft flat-fields at source scale before upsampling', () => {
  const { log } = runPipeline(100, 100, { ...PIPELINE_PARAMS, blur: 20 }, false);
  const order = stageOrder(log);
  assert(order.indexOf('normalize') < order.indexOf('resize'), 'Normalize should precede the upsample, got ' + order.join(','));
  const blur = log.find(e => e.op === 'blur');
  assert(blur.width === 100 && blur.args[1] === 20, 'Blur should run at source scale with unscaled sigma');
});

test('Pipeline: zero blur skips flat-field', () => {
  const { log } = runPipeline(100, 100, { ...PIPELINE_PARAMS, blur: 0 }, true);
  const order = stageOrder(log);
  assert(!order.includes('blur') && !order.includes('DivideSrc') && !order.includes('normalize'), 'Zero blur should skip flat-field, got ' + order.join(','));
});

// 13. PNG IHDR depth 8 and colour type 0 with no alpha
test('PNG IHDR: depth 8, colour type 0 (grayscale)', () => {
  const w = 4, h = 4;
  const pixels = new Uint8Array(w * h).fill(128);
  const png = createGrayscalePNG(w, h, pixels, 300);
  const chunks = parsePNGChunks(png);
  const ihdr = chunks.find(c => c.type === 'IHDR');
  assert(ihdr !== undefined, 'IHDR chunk should exist');
  assert(ihdr.data[8] === 8, 'Bit depth should be 8, got ' + ihdr.data[8]);
  assert(ihdr.data[9] === 0, 'Colour type should be 0 (grayscale), got ' + ihdr.data[9]);
});

test('PNG: no alpha (no tRNS chunk)', () => {
  const w = 4, h = 4;
  const pixels = new Uint8Array(w * h).fill(128);
  const png = createGrayscalePNG(w, h, pixels, 300);
  const chunks = parsePNGChunks(png);
  const trns = chunks.find(c => c.type === 'tRNS');
  assert(trns === undefined, 'Should have no tRNS chunk');
});

test('PNG: no palette (no PLTE chunk)', () => {
  const w = 4, h = 4;
  const pixels = new Uint8Array(w * h).fill(128);
  const png = createGrayscalePNG(w, h, pixels, 300);
  const chunks = parsePNGChunks(png);
  const plte = chunks.find(c => c.type === 'PLTE');
  assert(plte === undefined, 'Should have no PLTE chunk');
});

// 14. pHYs near chosen DPI
test('PNG pHYs: 300 dpi -> ~11811 ppm', () => {
  const dpi = 300;
  const ppm = Math.round(dpi / 0.0254);
  assert(ppm === 11811, '300 dpi should be 11811 ppm, got ' + ppm);
  const w = 4, h = 4;
  const pixels = new Uint8Array(w * h).fill(128);
  const png = createGrayscalePNG(w, h, pixels, dpi);
  const chunks = parsePNGChunks(png);
  const phys = chunks.find(c => c.type === 'pHYs');
  assert(phys !== undefined, 'pHYs chunk should exist');
  const xPpm = phys.data.readUInt32BE(0);
  const yPpm = phys.data.readUInt32BE(4);
  assert(xPpm === 11811, 'pHYs x should be 11811, got ' + xPpm);
  assert(yPpm === 11811, 'pHYs y should be 11811, got ' + yPpm);
  assert(phys.data[8] === 1, 'pHYs unit should be 1 (meter)');
});

test('PNG pHYs: 72 dpi -> ~2835 ppm', () => {
  const dpi = 72;
  const ppm = Math.round(dpi / 0.0254);
  const expected = 2835;
  assert(Math.abs(ppm - expected) <= 1, '72 dpi should be ~2835 ppm, got ' + ppm);
});

test('PNG pHYs: 600 dpi -> ~23622 ppm', () => {
  const dpi = 600;
  const ppm = Math.round(dpi / 0.0254);
  assert(ppm === 23622, '600 dpi should be 23622 ppm, got ' + ppm);
});

// 15. Guard: binary vs soft edges
test('Guard: binary edges have 0% soft fraction', () => {
  // 5x5 with a hard step: left half black (0), right half white (255)
  const w = 5, h = 5;
  const values = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      values[y * w + x] = x < 2 ? 0 : 255;
    }
  }
  const guard = computeGuard(values, w, h);
  assert(guard.band > 0, 'Should have edge band pixels');
  assert(guard.gray === 0, 'Binary edges should have 0 intermediate tones, got ' + guard.gray);
  assert(guard.fraction === 0, 'Binary edges should have 0% soft fraction, got ' + guard.fraction);
});

test('Guard: soft ramp edges have high soft fraction', () => {
  // 7x1 with a gradual ramp: 0, 40, 80, 128, 180, 220, 255
  const w = 7, h = 1;
  const values = new Uint8Array([0, 40, 80, 128, 180, 220, 255]);
  // Expand to 7x3 for 3x3 neighborhood
  const w2 = 7, h2 = 3;
  const values2 = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      values2[y * w2 + x] = values[x];
    }
  }
  const guard = computeGuard(values2, w2, h2);
  assert(guard.band > 0, 'Should have edge band pixels');
  assert(guard.fraction > 0.5, 'Ramp should have >50% intermediate tones, got ' + guard.fraction);
});

test('Guard: insufficient evidence with no edges', () => {
  const w = 10, h = 10;
  const values = new Uint8Array(w * h).fill(128); // uniform gray
  const guard = computeGuard(values, w, h);
  assert(guard.band === 0, 'Uniform image should have 0 edge band pixels');
});

test('Pipeline: level maps input at the black-point percentage to 0 on a ramp', () => {
  const { log } = runPipeline(200, 100, { ...PIPELINE_PARAMS, blackPoint: 8, whitePoint: 92 }, true);
  const [black, white] = log.find(e => e.op === 'level').args;
  // magick-wasm 0.0.43 level() passes black.toDouble() as a raw quantum and white._toQuantum()
  const lo = black.toDouble(), hi = white._toQuantum();
  const level = v => Math.max(0, Math.min(255, Math.round((v - lo) * 255 / (hi - lo))));
  const ramp = Array.from({ length: 256 }, (_, v) => level(v));
  const lastBlack = ramp.lastIndexOf(0), firstWhite = ramp.indexOf(255);
  assert(lastBlack === 20, 'Input 20 (8%) should be the last to map to 0, got ' + lastBlack);
  assert(firstWhite === 235, 'Input 235 (92%) should be the first to map to 255, got ' + firstWhite);
});

test('Guard: edge band detects black-white boundary', () => {
  const w = 4, h = 4;
  const values = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      values[y * w + x] = x < 2 ? 0 : 255;
    }
  }
  const guard = computeGuard(values, w, h);
  assert(guard.band > 0, 'Should detect edge band at black-white boundary');
});

// 12b. Worker skips stale queued drafts
async function sendToWorker(messages) {
  const posted = [];
  const names = new Proxy({}, { get: (t, key) => key });
  setEngine({
    ImageMagick: { read(bytes, cb) { cb(fakeImage(10, 10, [])); } },
    Percentage: FakePercentage,
    Quantum: { max: 255 },
    MorphologySettings: function () {},
    FilterType: names, CompositeOperator: names, MagickColors: names, AlphaAction: names,
    ColorSpace: names, MorphologyMethod: names
  });
  workerSelf.postMessage = m => posted.push(m);
  await Promise.all(messages.map(data => workerSelf.onmessage({ data })));
  return posted;
}

{
  const name = 'Worker: queued drafts only process the newest, exports always run';
  console.log(name);
  try {
    const draft = genId => ({ type: 'process', genId, bytes: new Uint8Array(0), params: PIPELINE_PARAMS, isExport: false });
    const posted = await sendToWorker([draft(1), draft(2), { ...draft(1), isExport: true }, draft(3)]);
    const drafts = posted.filter(m => !m.isExport).map(m => m.genId);
    assert(JSON.stringify(drafts) === '[3]', 'Only draft 3 should run, got ' + JSON.stringify(drafts));
    assert(posted.filter(m => m.isExport).length === 1, 'The export should still run');
  } catch (e) {
    failed++; failures.push(name + ': ' + e.message);
    console.log('  ERROR: ' + e.message);
  }
}

test('Output conversion: black ink and exact inverse-gray alpha, explicit PNG settings', () => {
  const names = new Proxy({}, { get: (t, key) => key });
  setEngine({ AlphaAction: names, ColorType: names, MagickFormat: names, DensityUnit: names, Density: function(dpi) { this.dpi = dpi; } });
  for (const transparent of [true, false]) {
    const defines = {};
    let pam, alpha;
    const img = {
      width: 5, height: 1,
      getPixels: cb => cb({ toByteArray: () => Uint8Array.from([0, 40, 128, 220, 255]) }),
      read: bytes => { pam = Buffer.from(bytes); },
      alpha: action => { alpha = action; }, strip() {},
      settings: { setDefine: (format, key, value) => { defines[key] = value; } }
    };
    prepareOutput(img, transparent, 300);
    assert(defines['color-type'] === (transparent ? 4 : 0), 'Output has selected color type');
    assert(defines['bit-depth'] === 8 && img.depth === 8, 'Output forces eight bits');
    assert(defines['include-chunk'] === 'pHYs' && img.density.dpi === 300, 'Output preserves DPI');
    if (transparent) {
      assert(pam.subarray(0, pam.length - 10).toString().includes('TUPLTYPE GRAYSCALE_ALPHA'), 'PAM declares gray plus alpha');
      assert(pam.subarray(-10).equals(Buffer.from([0,255,0,215,0,127,0,35,0,0])), 'Black ink retains exact inverse-gray soft ramp');
    } else assert(!pam && alpha === 'Off', 'White mode retains grayscale and disables alpha');
  }
});

test('Guard: alpha uses clear exterior and retains the grayscale edge metrics', () => {
  const gray = Uint8Array.from([0, 40, 80, 128, 180, 220, 255]);
  const a = computeGuard(gray, 7, 1);
  const b = computeGuard(gray.map(v => 255 - v), 7, 1, 0);
  assert(JSON.stringify(a) === JSON.stringify(b), 'Complementing values and exterior preserves metrics');
  assert(computeGuard(new Uint8Array(100), 10, 10, 0).band === 0, 'Clear alpha image has no artificial boundary');
});

// Optional real encoder integration; the default suite remains dependency-free.
if (process.argv.includes('--wasm')) {
  const M = await import('@imagemagick/magick-wasm');
  await M.initializeImageMagick(readFileSync(join(import.meta.dirname, 'node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm')));
  setEngine(M);
  for (const transparent of [true, false]) {
    test('WASM worker: encoded guard measures ' + (transparent ? 'alpha' : 'gray'), () => {
      const pixels = Uint8Array.from({ length: 210 }, (_, i) => [0, 40, 80, 128, 180, 220, 255][i % 7]);
      const messages = [];
      workerSelf.postMessage = msg => messages.push(msg);
      processImage({ genId: 1, bytes: createGrayscalePNG(7, 30, pixels, 72), isExport: true, forVector: true,
        params: { ...PIPELINE_PARAMS, blur: 0, upsample: 1, blackPoint: 0, whitePoint: 100, speckArea: 0, dilation: 0, border: 2, transparent } });
      const result = messages[0];
      assert(result?.type === 'done', 'Real worker completes: ' + JSON.stringify(result?.error));
      if (result?.type !== 'done') return;
      assert(result.guard.channel === (transparent ? 'alpha' : 'gray'), 'Worker reports encoded measurement channel');
      M.ImageMagick.read(result.pngBytes, img => {
        const values = img.getPixels(p => p.toByteArray(0, 0, img.width, img.height, transparent ? 'A' : 'I'));
        const expected = computeGuard(values, img.width, img.height, transparent ? 0 : 255);
        assert(result.guard.band === expected.band && result.guard.gray === expected.gray, 'Worker measures real encoded pixels');
        assert(result.guard.gray > 0, 'Pipeline retains intermediate edge samples');
        assert(values[0] === (transparent ? 0 : 255), 'Border follows selected output background');
        assert(result.vectorGray.length === img.width * img.height && result.vectorGray.every((v,i) => v === (transparent ? 255-values[i] : values[i])), 'Vector handoff uses exact encoded full-resolution gray in either PNG mode');
      });
    });
    test('WASM PNG: ' + (transparent ? 'transparent' : 'white') + ' output chunks and exact edge samples', () => {
      const gray = Uint8Array.from([0, 40, 128, 220, 255]);
      M.ImageMagick.read(createGrayscalePNG(5, 1, gray, 72), img => {
        prepareOutput(img, transparent, 300);
        img.write(M.MagickFormat.Png, bytes => {
          const chunks = parsePNGChunks(Buffer.from(bytes));
          const ihdr = chunks.find(c => c.type === 'IHDR').data;
          assert(ihdr[8] === 8 && ihdr[9] === (transparent ? 4 : 0), 'Actual PNG has eight-bit selected color type');
          assert(!chunks.some(c => ['PLTE', 'tRNS'].includes(c.type)), 'Actual PNG has no palette or tRNS');
          const phys = chunks.find(c => c.type === 'pHYs')?.data;
          assert(phys && phys.readUInt32BE(0) === 11811 && phys.readUInt32BE(4) === 11811 && phys[8] === 1, 'Actual PNG retains 300 DPI after strip');
          M.ImageMagick.read(bytes, decoded => {
            const values = decoded.getPixels(p => p.toByteArray(0, 0, 5, 1, transparent ? 'A' : 'I'));
            assert(Buffer.from(values).equals(Buffer.from(transparent ? gray.map(v => 255 - v) : gray)), 'Encoded edge ramp survives exactly');
            if (transparent) {
              const ink = decoded.getPixels(p => p.toByteArray(0, 0, 5, 1, 'I'));
              assert(ink.every(v => v === 0), 'Every transparent-output ink sample is black');
            }
          });
        });
      });
    });
  }
}

let downloadHarness;
// Exercise actual UI wiring without adding a browser dependency.
test('UI wiring: background, reset, and separate Raster/Vector previews', () => {
  const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
  const elements = new Map();
  const listeners = new Map();
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attrs, id] = match;
    let value = attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
    if (tag === 'select') {
      const body = html.slice(match.index + match[0].length).split('</select>')[0];
      value = body.match(/<option\b[^>]*\bvalue="([^"]+)"/)?.[1] ?? '';
    }
    const textContent = tag === 'p' ? html.slice(match.index + match[0].length).split('<')[0] : '';
    elements.set(id, {
      value, open: /\bopen\b/.test(attrs), textContent, style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      getContext() { return { clearRect() {}, drawImage() {} }; },
      focus() { this.focused = true; },
      setAttribute(name, value) { this.attrs[name] = value; }, attrs: {},
      addEventListener(event, handler) { listeners.set(id + ':' + event, handler); }
    });
  }
  const timers = new Map();
  let timerId = 0;
  const timerDelays = new Map();
  const messages = [];
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) },
    setTimeout(fn, delay) { timers.set(++timerId, fn); timerDelays.set(timerId, delay); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    captureMessage: message => messages.push(message)
  });
  const vectorHint = elements.get('vectorStatus').textContent;
  assert(vectorHint.length > 0, 'Vector status carries an initial hint');
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  const fire = (id, event) => listeners.get(id + ':' + event)();
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  assert(elements.get('outputBackground').value === 'transparent', 'Dropdown initially selects Transparent');
  assert(!html.includes('recipeText') && html.includes('<code class="tool">-blur</code>') && html.includes('<code class="tool">--alphamax</code>'), 'No recipe pane; labels carry the operators');
  vm.runInContext('originalBytes = new Uint8Array([1]); worker = { postMessage: captureMessage };', context);
  assert(vm.runInContext('getParams().dilation === 1 && getParams().trimFuzz === 2',context), 'Fixed support dilation and trim fuzz preserve defaults');
  elements.get('vectorSpeck').value='9';
  assert(vm.runInContext('vectorOptions().speck === 9 && vectorOptions().turd === 9',context), 'Minimum component area also drives Potrace turdsize');
  elements.get('vectorSpeck').value='4';
  elements.get('outputBackground').value = 'white';
  fire('outputBackground', 'change');
  flush();
  assert(messages.at(-1).params.transparent === false && !messages.at(-1).isExport, 'White selection requests opaque draft and guard processing');
  vm.runInContext('requestProcess(true)', context);
  assert(messages.at(-1).params.transparent === false && messages.at(-1).isExport, 'Export uses White selection at full resolution');
  elements.get('outputBackground').value = 'transparent';
  fire('outputBackground', 'change');
  flush();
  assert(messages.at(-1).params.transparent === true, 'Switching back requests alpha draft and guard processing');
  elements.get('outputBackground').value = 'white';
  elements.get('previewBackground').value = 'red';
  fire('previewBackground', 'change');
  assert(elements.get('afterWrap').dataset.background === 'red', 'Red backdrop updates the raster preview');
  elements.get('blurSlider').value = '99';
  fire('resetBtn', 'click');
  flush();
  assert(elements.get('outputBackground').value === 'transparent', 'Reset restores Transparent');
  assert(elements.get('previewBackground').value === 'white' && elements.get('afterWrap').dataset.background === 'white', 'Reset restores white preview');
  assert(messages.at(-1).params.transparent === true && messages.at(-1).params.blur === 30, 'Reset reprocesses default settings and alpha guard');
  assert(vm.runInContext('vectorOptions().speck === 4 && vectorOptions().turd === 4',context), 'Reset restores shared vector speck default');
  assert(String(elements.get('upsampleVal').textContent) === '300', 'Reset shows -resize as a percentage');
  vm.runInContext('requestProcess(true)', context);
  assert(messages.at(-1).params.transparent === true && messages.at(-1).isExport, 'Export after reset uses transparent output');
  assert(!elements.get('afterCanvas').hidden && !elements.get('vectorCanvas').hidden, 'Both preview canvases remain visible after reset');
  assert(elements.get('vectorStatus').textContent.startsWith('Waiting'), 'Raster edits announce automatic tracing');
  // The existing measured-risk thresholds control the whole guard's red surface.
  for (const [band, gray, fraction, expected] of [
    [100, 0, 0, 'true'], [100, 4, .04, 'true'], [100, 5, .05, 'true'],
    [100, 19, .19, 'true'], [100, 20, .20, 'false'], [99, 0, 0, 'false']
  ]) {
    vm.runInContext(`updateGuard({band:${band},gray:${gray},fraction:${fraction}}, 'draft')`, context);
    assert(elements.get('aliasingGuard').dataset.risk === expected, 'Guard risk state at band ' + band + ', fraction ' + fraction);
  }
  vm.runInContext('setAfterInfo("raster", "1470 × 300 px"); setAfterInfo("vector", "171 × 33 mm");', context);
  assert(elements.get('afterInfo').textContent === '1470 × 300 px' && elements.get('vectorInfo').textContent === '171 × 33 mm', 'Both preview dimensions persist independently');
  elements.get('vectorPreviewBackground').value = 'red';
  fire('vectorPreviewBackground', 'change');
  assert(elements.get('vectorWrap').dataset.background === 'red' && elements.get('afterWrap').dataset.background === 'white', 'Vector backdrop changes independently of the raster');
  const vectorMessages = [];
  context.Blob = class { constructor(parts) { this.parts = parts; } };
  context.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };
  context.Worker = class { postMessage(message) { vectorMessages.push(message); } terminate() {} };
  context.Image = class { set src(value) { this.onload(); } };
  const completeDraft = () => vm.runInContext('handleProcessDone({genId:currentGenId,isExport:false,pngBytes:new Uint8Array([1]),width:2,height:1,guard:{band:100,gray:30,fraction:.3},source:"draft"})', context);
  const completeCleanup = request => vm.runInContext('handleWorkerMessage({data:{type:"done",forVector:true,isExport:true,genId:' + request.genId + ',vectorGray:new Uint8Array([0,255]),width:2,height:1}})', context);
  assert(!elements.has('traceBtn') && !elements.has('vectorCancelBtn'), 'Automatic tracing needs no Trace or Cancel button');
  completeDraft();
  assert(messages.at(-1).forVector && messages.at(-1).isExport, 'A completed draft automatically requests full-resolution cleanup');
  completeCleanup(messages.at(-1));
  assert(vectorMessages.at(-1).gray.length === 2, 'Full-resolution gray automatically reaches the tracer');
  vm.runInContext('vectorDocument = {}; vectorResult = {paths:[]}; vectorCanvas.width = 100; vectorCanvas.height = 20; setAfterInfo("vector", "8 × 2 mm"); setVectorBusy(false);', context);
  const beforeEdits = messages.length;
  elements.get('vectorOffset').value = '12';
  fire('vectorOffset', 'input'); fire('vectorOffset', 'input');
  assert(messages.length === beforeEdits, 'Rapid edits wait for debounce');
  assert(elements.get('vectorCanvas').width === 100 && elements.get('vectorInfo').textContent === '8 × 2 mm', 'Pending trace retains old canvas and dimensions');
  assert(elements.get('vectorStatus').textContent.startsWith('Waiting') && elements.get('vectorExportBtn').disabled, 'Pending status explains work while stale export is disabled');
  assert([...timers.keys()].every(id => timerDelays.get(id) === 180), 'Live processing uses 180 ms debounce');
  flush();
  const obsolete = messages.at(-1);
  assert(messages.length === beforeEdits + 1 && obsolete.forVector, 'Potrace edits coalesce into fresh full-resolution cleanup');
  fire('vectorOffset', 'input'); flush();
  const latest = messages.at(-1), count = vectorMessages.length;
  completeCleanup(obsolete);
  assert(vectorMessages.length === count, 'Stale cleanup cannot launch a trace');
  completeCleanup(latest);
  assert(vectorMessages.at(-1).options.offset === 12, 'Latest settings reach automatic trace');
  vm.runInContext('vectorWorker.onmessage({data:{id:vectorId-1,type:"vector-error",error:"stale"}})', context);
  assert(!elements.get('vectorStatus').textContent.includes('stale'), 'Stale trace response cannot replace status');
  fire('blurSlider', 'input'); flush();
  const draft = messages.at(-1);
  assert(!draft.forVector && !draft.isExport, 'Raster edits first refresh the draft');
  const beforePending = messages.length;
  fire('vectorOffset', 'input'); flush();
  assert(messages.length === beforePending, 'Potrace edits during a pending draft wait for that draft');
  completeDraft();
  assert(messages.at(-1).forVector, 'Next successful draft resumes automatic tracing');
  const beforeStale = messages.length;
  vm.runInContext('handleProcessDone({genId:currentGenId-1,isExport:false,pngBytes:new Uint8Array([1]),width:99,height:99})', context);
  assert(messages.length === beforeStale && elements.get('afterCanvas').width === 2, 'Stale image decode cannot repaint or start a trace');
  const whitePointBefore = elements.get('whitePointSlider').value;
  elements.get('whitePointSlider').value = elements.get('blackPointSlider').value;
  fire('whitePointSlider', 'input'); flush();
  assert(elements.get('vectorStatus').textContent.startsWith('White point'), 'Invalid levels stop automatic tracing with a useful error');
  elements.get('whitePointSlider').value = whitePointBefore;
  fire('whitePointSlider', 'input'); flush(); completeDraft();
  assert(messages.at(-1).forVector, 'Corrected levels resume automatic tracing');
  elements.get('vectorAuto').checked = true; fire('vectorAuto', 'change');
  assert(elements.get('vectorThreshold').disabled, 'Automatic threshold disables manual level');
  elements.get('vectorAuto').checked = false; fire('vectorAuto', 'change');
  assert(!elements.get('vectorThreshold').disabled, 'Manual mode enables threshold');
  vm.runInContext('invalidateVector(true)', context);
  vm.runInContext('vectorDocument = {}; vectorBusy = false;', context);
  fire('afterWrap', 'click');
  assert(elements.get('workspace').dataset.expanded === 'raster', 'Raster click expands its workspace');
  assert(elements.get('restoreLayout').textContent === 'Show all', 'Expanded view has a concise restore label');
  assert(!elements.get('rasterControls').hidden && !elements.get('rasterOutput').hidden, 'Expanded raster retains controls and output');
  assert(elements.get('beforeColumn').hidden && elements.get('vectorControls').hidden && elements.get('vectorOutput').hidden, 'Other panels minimize during raster expansion');
  elements.get('blurSlider').value = '31';
  fire('blurSlider', 'input'); flush();
  assert(messages.at(-1).params.blur === 31 && elements.get('workspace').dataset.expanded === 'raster', 'Raster sliders still process while expanded');
  fire('afterWrap', 'click');
  assert(!elements.get('workspace').dataset.expanded && !elements.get('beforeColumn').hidden && !elements.get('vectorControls').hidden, 'Second click restores all panels');
  assert(elements.get('afterWrap').focused, 'Restoring returns focus to the preview');
  vm.runInContext('vectorDocument = {}; vectorRasterGray = new Uint8Array([0,255]); vectorRasterSize = {width:2,height:1};', context);
  fire('vectorWrap', 'click');
  assert(!elements.get('vectorControls').hidden && !elements.get('vectorOutput').hidden && elements.get('rasterControls').hidden && elements.get('rasterOutput').hidden, 'Vector expansion retains only its tool and output');
  elements.get('vectorOffset').value = '9';
  fire('vectorOffset', 'input'); flush();
  completeDraft(); completeCleanup(messages.at(-1));
  assert(vectorMessages.at(-1).options.offset === 9 && elements.get('workspace').dataset.expanded === 'vector', 'Expanded vector controls retrace live');
  vm.runInContext('invalidateVector(true)', context);
  assert(!elements.get('vectorWrap').disabled, 'Expanded vector stays clickable while updating');
  fire('restoreLayout', 'click');
  assert(!elements.get('workspace').dataset.expanded && !elements.get('rasterControls').hidden && !elements.get('vectorWrap').disabled, 'Minimized strip restores layout with the retained vector preview');
  fire('beforeWrap', 'click');
  assert(!elements.get('beforeColumn').hidden && elements.get('rasterControls').hidden && elements.get('vectorControls').hidden, 'Before expands independently');
  fire('restoreLayout', 'click');
  assert(!html.includes('loupe-wrap') && !html.includes('nearest-neighbor'), 'Hover magnifiers and their labels are removed');

  downloadHarness = {context,elements,fire,flush,messages};
  const workerErrors = [];
  context.console = { error: (...args) => workerErrors.push(args) };
  context.location = { origin: 'null' };
  vm.runInContext('vectorRasterGray = new Uint8Array([0,255]); vectorRasterSize = {width:2,height:1}; requestVectorTrace(); vectorWorker.onerror({type:"error"});', context);
  const opaqueFailure = elements.get('vectorStatus').textContent;
  assert(opaqueFailure.includes('event=error') && opaqueFailure.includes('origin=null') && opaqueFailure.includes('filename=unavailable'), 'Opaque worker failure reports event and missing browser details');
  assert(!opaqueFailure.includes('undefined') && opaqueFailure.includes('try another browser'), 'Opaque-origin error gives actionable browser guidance');
  assert(workerErrors.length === 1 && workerErrors[0][2].type === 'error', 'Original failure event is logged to the console');
  const details = vm.runInContext('describeTracerError({message:"Import blocked",type:"error",filename:"blob:test",lineno:7,colno:3,error:new Error("Fetch failed")}, "http://localhost")', context);
  assert(details.includes('Import blocked') && details.includes('filename=blob:test') && details.includes('line=7') && details.includes('column=3') && details.includes('Fetch failed'), 'Detailed worker failure preserves location and error object');
  context.Worker = class { constructor() { throw new Error('Workers unavailable'); } };
  vm.runInContext('requestVectorTrace()', context);
  assert(elements.get('vectorStatus').textContent.includes('Workers unavailable') && !vm.runInContext('vectorBusy', context), 'Synchronous worker construction failure is reported and clears busy state');



});

// Native Save As and the fallback share the same name/MIME contract.
await (async () => {
  console.log('Export saves: names, MIME, picker timing, cancellation and duplicate guards');
  try {
    const {context,elements,fire,messages}=downloadHarness;
    const picks=[],writes=[],downloads=[],objects=new Map(),revoked=[],sharedCalls=[];
    context.recordSharedSave=(name,mime,extension)=>sharedCalls.push({name,mime,extension});
    vm.runInContext("const realExportFile=exportFile; exportFile=(blob,name,mime,extension)=>{recordSharedSave(name,mime,extension);return realExportFile(blob,name,mime,extension)}",context);
    let serial=0;
    context.Blob=Blob;
    context.Worker=class {postMessage(message){messages.push(message);} terminate(){}};
    context.URL={createObjectURL(blob){const url='blob:save-'+(++serial);objects.set(url,blob);return url;},revokeObjectURL(url){revoked.push(url);}};
    context.document.createElement=()=>{const a={click(){downloads.push({name:a.download,url:a.href,blob:objects.get(a.href)});}};return a;};
    context.document.body={appendChild(){},removeChild(){}};
    const handle={async createWritable(){return {async write(blob){writes.push(blob);},async close(){},async abort(){}};}};
    context.showSaveFilePicker=options=>{picks.push(options);return Promise.resolve(handle);};
    vm.runInContext('originalBytes=new Uint8Array([1]); originalFileName="seal ink.PNG"; worker={postMessage:captureMessage}; pngSaveJob=null; vectorResult={paths:["M0 0L3000 0L3000 1500L0 1500z"]}; vectorDocument={svg:"<svg xmlns=\\"http://www.w3.org/2000/svg\\"/>"}; vectorBusy=false; vectorCleanupPending=false; draftPending=false; clearTimeout(debounceTimer); clearTimeout(vectorDebounceTimer); debounceTimer=vectorDebounceTimer=null; vectorRenderedId=vectorId;',context);
    elements.get('outputBackground').value='transparent';
    const expected={png:'image/png',svg:'image/svg+xml',pdf:'application/pdf',dxf:'application/dxf'};
    for(const [format,mime] of Object.entries(expected)) {
      elements.get('exportBtn').disabled=elements.get('vectorExportBtn').disabled=false;
      elements.get('vectorFormat').value=format==='png'?'svg':format;
      const before=picks.length;
      const promise=fire(format==='png'?'exportBtn':'vectorExportBtn','click');
      assert(picks.length===before+1,'Picker is called synchronously from '+format+' click');
      const options=picks.at(-1),name='seal ink_'+(format==='png'?'clean':'vector')+'.'+format;
      assert(options.suggestedName===name && options.types[0].accept[mime][0]==='.'+format,'Picker name, MIME and extension agree for '+format);
      if(format==='png') { await new Promise(resolve=>setImmediate(resolve)); vm.runInContext('finishPNGExport({pngBytes:new Uint8Array([1,2,3])})',context); }
      await promise;
      assert(writes.at(-1).type===mime,'Written Blob has correct '+format+' MIME');
    }
    assert(downloads.length===0,'Native save never also starts an anchor download');
    assert(sharedCalls.length===4 && sharedCalls.map(call=>call.extension).join(',')==='.png,.svg,.pdf,.dxf','PNG and every vector format call the same exportFile interface');
    let releaseVector;
    context.showSaveFilePicker=()=>new Promise(resolve=>releaseVector=resolve);
    vm.runInContext('globalThis.encodedDXF=0; const realDXF=assembleVectorDXF; assembleVectorDXF=(...args)=>{encodedDXF++;return realDXF(...args)}',context);
    elements.get('vectorFormat').value='dxf';elements.get('vectorExportBtn').disabled=false;
    const vectorPending=fire('vectorExportBtn','click');
    assert(vm.runInContext('encodedDXF===0',context),'Vector serialization waits until the same picker used by PNG returns');
    releaseVector(handle);await vectorPending;
    assert(vm.runInContext('encodedDXF===1',context),'DXF is encoded once after choosing its destination');
    const before=picks.length,requested=messages.length;
    let choose;
    context.showSaveFilePicker=options=>{picks.push(options);return new Promise(resolve=>choose=resolve);};
    elements.get('exportBtn').disabled=false;
    const pending=fire('exportBtn','click');fire('exportBtn','click');fire('vectorExportBtn','click');
    assert(picks.length===before+1 && messages.length===requested,'Global save guard blocks same-button and cross-format duplicate pickers');
    assert(vm.runInContext('pipelinePaused && worker===null && vectorWorker===null',context),'Both workers are stopped while the picker is unresolved');
    elements.get('blurSlider').value='44';
    fire('blurSlider','input');
    assert(messages.length===requested && vm.runInContext('resumePipelineRequested',context),'Edits during picker defer pipeline work until it closes');
    choose(handle);await new Promise(resolve=>setImmediate(resolve));
    assert(!vm.runInContext('pipelinePaused',context),'Pipeline resumes after picker selection');
    assert(messages.at(-1).params.blur!==44,'PNG cleanup uses the click-time settings snapshot');
    vm.runInContext('finishPNGExport({pngBytes:new Uint8Array([1])})',context);
    await pending;
    vm.runInContext('clearTimeout(debounceTimer); debounceTimer=null; draftPending=false; vectorBusy=false; vectorRenderedId=vectorId;',context);
    const writeCount=writes.length;
    await vm.runInContext('finishPNGExport({pngBytes:new Uint8Array([1])})',context);
    assert(writes.length===writeCount,'Repeated PNG completion cannot save twice');
    context.showSaveFilePicker=()=>Promise.reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));
    const count=messages.length;
    await fire('exportBtn','click');
    assert(messages.length===count && !elements.get('exportBtn').disabled,'Cancel saves nothing and unlocks PNG export');
    elements.get('vectorExportBtn').disabled=false;
    await fire('vectorExportBtn','click');
    assert(writes.length===writeCount && downloads.length===0,'Vector cancellation never falls back to a download');
    context.showSaveFilePicker=undefined;
    for(const [format,mime] of Object.entries(expected)) {
      elements.get('exportBtn').disabled=elements.get('vectorExportBtn').disabled=false;
      elements.get('vectorFormat').value=format==='png'?'svg':format;
      const promise=fire(format==='png'?'exportBtn':'vectorExportBtn','click');
      if(format==='png') vm.runInContext('finishPNGExport({pngBytes:new Uint8Array([1])})',context);
      await promise;
      const saved=downloads.at(-1);
      assert(saved.name==='seal ink_'+(format==='png'?'clean':'vector')+'.'+format && saved.blob.type===mime,'Fallback filename and MIME agree for '+format);
    }
    assert(downloads.length===4 && revoked.length===0,'Each fallback clicks once; no timer revokes an active dialog URL');
    elements.get('vectorExportBtn').disabled=true;
    await fire('vectorExportBtn','click');
    assert(downloads.length===4,'Stale disabled vector export cannot save');
  } catch(error) {failed++;failures.push('Export save tests: '+error.message);console.log('  ERROR: '+error.stack);}
})();

test('Monochrome: readable text contrast', () => {
  const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
  const root = html.match(/:root\s*\{([^}]+)\}/)[1];
  const colors = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[a-f\d]+);/g)].map(m => [m[1], m[2]]));
  const luminance = color => {
    const hex = color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color;
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return channels.reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  for (const [fg, bg] of [['foreground', 'background'], ['background', 'foreground'],
    ['muted-foreground', 'background'], ['muted-foreground', 'muted'], ['background', 'risk-red']]) {
    const [low, high] = [luminance(colors[fg]), luminance(colors[bg])].sort((a, b) => a - b);
    assert((high + 0.05) / (low + 0.05) >= 4.5, fg + ' on ' + bg + ' maintains readable contrast');
  }
  assert(colors['image-white'] === '#fff', 'White image background retains literal white semantics');
});

// Vector helpers use full-resolution gray samples, independently of the PNG mode.
const vectorPureScript = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const { otsuThreshold, vectorMask, traceBounds, assembleVectorSVG, assembleVectorPDF, assembleVectorDXF, flattenVectorContours, DXF_FLATTEN_TOLERANCE } = vm.runInContext(vectorPureScript + '\n;({ otsuThreshold, vectorMask, traceBounds, assembleVectorSVG, assembleVectorPDF, assembleVectorDXF, flattenVectorContours, DXF_FLATTEN_TOLERANCE });', vm.createContext({}));
const vectorDefaults = { auto: true, threshold: 128, offset: 0, speck: 4 };

test('Vector threshold: Otsu separates uneven ink/paper classes and centers plateaus', () => {
  assert(otsuThreshold(Uint8Array.from([0,0,255,255])) === 127, 'Binary plateau uses midpoint');
  const samples = Uint8Array.from([20,20,30,40,190,200,210,220]);
  const t = otsuThreshold(samples);
  assert(t >= 40 && t < 190, 'Otsu separates ink from paper');
  const positive = vectorMask(samples, 8, 1, { ...vectorDefaults, speck: 0, auto: false, threshold: 100, offset: 100 });
  assert(positive.threshold === 200 && positive.ink === 6, 'Manual threshold plus positive offset retains pale ink');
  const high = vectorMask(samples, 8, 1, { ...vectorDefaults, speck: 0, auto: false, threshold: 254, offset: 100 });
  assert(high.threshold === 254, 'Threshold clamps below paper white');
  assert(vectorMask(new Uint8Array(10).fill(255), 5, 2, vectorDefaults).empty, 'White remains empty');
  assert(vectorMask(new Uint8Array(10), 5, 2, vectorDefaults).ink === 10, 'Solid black remains ink');
  assert(vectorMask(new Uint8Array([10]), 1, 1, { ...vectorDefaults, speck: 0, auto: false, threshold: 20, offset: -100 }).empty, 'Negative offset clamps to zero');
});

test('Vector mask: 8-connected area cutoff, tight crop, padding and coverage', () => {
  const gray = new Uint8Array(10*8).fill(255);
  for (const [x,y] of [[2,2],[3,2],[2,3],[3,3],[5,5],[6,6],[9,0]]) gray[y*10+x] = 0;
  const copy = Uint8Array.from(gray);
  const filtered = vectorMask(gray, 10, 8, { ...vectorDefaults, speck: 2 });
  assert(filtered.ink === 6, 'At-cutoff diagonal dot retained; below-cutoff speck removed');
  assert(filtered.width === 7 && filtered.height === 7 && filtered.left === 1 && filtered.top === 1, 'Tight bitmap includes one background pixel of padding');
  assert(filtered.coverage === 6/25, 'Coverage denominator is tight ink bounding rectangle');
  assert(filtered.data[0] === 255 && filtered.data[3] === 255, 'Padding is opaque white for tracer');
  assert(gray.every((v,i) => v === copy[i]), 'Full-resolution gray input remains unchanged');
  assert(vectorMask(gray, 10, 8, { ...vectorDefaults, speck: 5 }).empty, 'All below-cutoff blobs removed');
  assert(vectorMask(gray, 10, 8, { ...vectorDefaults, speck: 0 }).ink === 7, 'Zero bypasses component filtering');
});

test('Vector paths: exact cubic extrema, relative contours and holes', () => {
  const b = traceBounds(['M0 0 C0 100 100 100 100 0 L0 0z']);
  assert(b.maxY === 75 && b.maxX === 100, 'Bounds follow curve extrema instead of control points');
  const relative = traceBounds(['M20 50 l0 -30 160 0 0 60 -160 0z m50 0 l0 -10 20 0 0 20 -20 0z']);
  assert(relative.minX === 20 && relative.maxX === 180 && relative.minY === 20 && relative.maxY === 80, 'Relative points and post-close move use correct origin');
  assert(relative.count === 2, 'Path count includes hole contour');
  for (const path of ['M0 0L10 0L10 10', 'M0 0L10 0z\"/><script>', 'M0 0LNaN 0z', 'M0 0L10z']) {
    let rejected = false; try { traceBounds([path]); } catch { rejected = true; }
    assert(rejected, 'Rejects unclosed or invalid trace output');
  }
});

test('SVG assembly: tight physical bounds, transparent filled holes, safe colour', () => {
  const paths = ['M20 20l3000 0 0 1500 -3000 0z m100 100l100 0 0 100 -100 0z'];
  const result = assembleVectorSVG(paths, 160, 300, '#123abc');
  assert(result.svg.includes('width="25.4mm" height="12.7mm"'), '300 pixels at 300 DPI is one inch');
  assert(result.svg.includes('viewBox="2 8 300 150"'), 'ViewBox flips tracer Y and trims margins');
  assert(result.svg.includes('translate(0 160) scale(0.1 -0.1)'), 'Retains documented Potrace coordinate transform');
  assert(result.svg.includes('fill="#123abc" fill-rule="evenodd" stroke="none"'), 'Ink is selected colour, holes stay clear');
  assert(!/<(?:image|rect|script)\b/.test(result.svg), 'SVG contains only vector ink and transparent paper');
  assert(result.pathCount === 2, 'Counts closed contours including counters');
  assert(assembleVectorSVG(paths, 160, 600, '#000000').svg.includes('width="12.7mm"'), 'DPI changes physical size without changing paths');
  for (const [dpi,color] of [[0,'#000000'], [NaN,'#000000'], [300,'red" onload="bad']]) {
    let rejected = false; try { assembleVectorSVG(paths, 160, dpi, color); } catch { rejected = true; }
    assert(rejected, 'Rejects invalid size or colour');
  }
});

test('DXF: solid hatch structure, loops, physical coordinates and colour', () => {
  const paths = ['M20 80L3020 80L3020 1580L20 1580z', 'M120 180L220 180L220 280L120 280z'];
  const dxf = assembleVectorDXF(paths, 300, '#123abc');
  const lines = dxf.trim().split('\n');
  const pairs = []; for (let i=0;i<lines.length;i+=2) pairs.push([+lines[i],lines[i+1]]);
  assert(pairs.filter(p=>p[0]===0 && p[1]==='SECTION').length === 6 && dxf.endsWith('0\nEOF\n'), 'DXF sections and EOF');
  assert(/9\n\$ACADVER\n\s*1\nAC1018\n/.test(dxf) && /9\n\$INSUNITS\n\s*70\n4\n/.test(dxf), 'DXF 2004 and millimetres');
  const hatchStart = pairs.findIndex(p=>p[0]===0 && p[1]==='HATCH');
  const hatchEnd = pairs.findIndex((p,i)=>i>hatchStart && p[0]===0);
  const hatch = pairs.slice(hatchStart,hatchEnd);
  const get = code => hatch.find(p=>p[0]===code)?.[1];
  assert(pairs.filter(p=>p[1]==='HATCH').length === 1 && get(70)==='1' && get(2)==='SOLID' && get(75)==='0', 'One SOLID odd-parity HATCH');
  assert(+get(420)===0x123abc && get(8)==='INK', 'True colour and ink layer');
  assert(+get(91)===paths.length, 'One boundary per contour including hole');
  const loops = hatch.flatMap((p,i)=>p[0]===92 ? [hatch.slice(i,i+13)] : []);
  assert(loops.every(l=>l[0][1]==='2' && l[1][1]==='0' && l[2][1]==='1' && l[3][1]==='4' && l[12][0]===97), 'Closed non-bulged polyline boundaries');
  const vertices = loops[0].slice(4,12).map(p=>+p[1]);
  assert(JSON.stringify(vertices)===JSON.stringify([0,0,25.4,0,25.4,12.7,0,12.7]), '300 pixels at 300 DPI is 25.4 mm with lower-left origin');
  const svg = assembleVectorSVG(paths, 160, 300, '#123abc');
  approxEqual(vertices[5], (160-8-svg.bounds.y)*25.4/300, 1e-8, 'CAD Y flips preview screen Y');
  assert(assembleVectorDXF(paths,600,'#000000').includes('10\n12.7\n'), 'DPI scales DXF coordinates');
});

test('Exports: independent parsers when installed', () => {
  const dir=mkdtempSync(join(import.meta.dirname,'.export-check-'));
  try {
    const paths=['M20 20l3000 0 0 1500 -3000 0z m100 100l100 0 0 100 -100 0z'];
    writeFileSync(join(dir,'check.svg'),assembleVectorSVG(paths,160,300,'#000000').svg);
    writeFileSync(join(dir,'check.pdf'),assembleVectorPDF(paths,300,'#000000'));
    writeFileSync(join(dir,'check.dxf'),assembleVectorDXF(paths,300,'#000000'));
    const python=process.env.INK_CLEANUP_PYTHON || 'python3';
    const xml=spawnSync(python,['-c','import sys,xml.etree.ElementTree as E; r=E.parse(sys.argv[1]).getroot(); assert r.tag=="{http://www.w3.org/2000/svg}svg"',join(dir,'check.svg')],{encoding:'utf8'});
    if(xml.error?.code==='ENOENT') console.log('  SKIP: Python XML parser unavailable');
    else assert(xml.status===0,'Independent XML parser accepts SVG: '+xml.stderr);
    const pdf=spawnSync('pdfinfo',[join(dir,'check.pdf')],{encoding:'utf8'});
    if(pdf.error?.code==='ENOENT') console.log('  SKIP: pdfinfo unavailable');
    else assert(pdf.status===0 && /Pages:\s+1/.test(pdf.stdout),'Independent PDF parser accepts one-page PDF: '+pdf.stderr);
    const installed=spawnSync(python,['-c','import ezdxf'],{encoding:'utf8'});
    if(installed.status!==0) console.log('  SKIP: ezdxf unavailable (set INK_CLEANUP_PYTHON to its interpreter)');
    else {
      const result=spawnSync(python,['-c',`import sys,ezdxf
from ezdxf.lldxf.const import BOUNDARY_PATH_POLYLINE
d=ezdxf.readfile(sys.argv[1]);a=d.audit()
assert not a.errors and not a.fixes, ([str(e) for e in a.errors],[str(e) for e in a.fixes])
h=list(d.modelspace().query('HATCH'));assert len(h)==1 and len(h[0].paths)==2
assert h[0].dxf.handle=='1000' and h[0].dxf.owner==d.modelspace().block_record_handle
assert d.layers.has_entry('INK') and d.header['$INSUNITS']==4
assert all(p.is_closed and p.path_type_flags & BOUNDARY_PATH_POLYLINE for p in h[0].paths)
`,join(dir,'check.dxf')],{encoding:'utf8'});
      assert(result.status===0,'ezdxf audit has zero errors/fixes and one owned HATCH with two closed loops: '+result.stderr);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('DXF: adaptive cubic flattening stays within source pixel tolerance', () => {
  for (const controls of [[0,0,0,100,100,100,100,0], [0,0,200,0,-100,0,100,0], [0,0,100,100,-100,100,0,0]]) {
    const [ax,ay,bx,by,cx,cy,dx,dy] = controls;
    const loop = flattenVectorContours([`M${ax} ${ay}C${bx} ${by} ${cx} ${cy} ${dx} ${dy}L0 -10z`])[0];
    let max = 0;
    for(let i=0;i<=2000;i++) {
      const t=i/2000, u=1-t;
      const x=u**3*ax+3*u*u*t*bx+3*u*t*t*cx+t**3*dx, y=u**3*ay+3*u*u*t*by+3*u*t*t*cy+t**3*dy;
      let nearest=Infinity;
      for(let j=1;j<loop.length;j++) {
        const [a,b]=loop[j-1], [c,d]=loop[j], vx=c-a, vy=d-b;
        const q=Math.max(0,Math.min(1,((x-a)*vx+(y-b)*vy)/(vx*vx+vy*vy)||0));
        nearest=Math.min(nearest,Math.hypot(x-a-q*vx,y-b-q*vy)/10);
      }
      max=Math.max(max,nearest);
    }
    assert(loop.length>3 && max<=DXF_FLATTEN_TOLERANCE, 'Curve, collinear reversal and cusp stay within 0.05 pixels');
  }
});

test('PDF: physical page, true cubics, holes, colour, background and byte offsets', () => {
  const paths = ['M20 20l3000 0 0 1500 -3000 0z m100 100c0 100 100 100 100 0l-100 0z'];
  const pdf = assembleVectorPDF(paths, 300, '#123abc');
  assert(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'), 'PDF header and EOF');
  assert(pdf.includes('/MediaBox [0 0 72 36]'), 'One inch by half inch at 300 DPI');
  assert(pdf.includes('/Count 1') && !/\/Subtype \/Image|\/Font/.test(pdf), 'Single vector-only page');
  assert(pdf.includes('0.024 0 0 0.024 -0.48 -0.48 cm'), 'Preserves upward Y and translates tight bounds');
  assert(pdf.includes('120 220 220 220 220 120 c'), 'Relative cubic becomes absolute PDF cubic');
  assert(pdf.includes('20 20 m') && pdf.includes('3020 20 l') && pdf.includes('h\n120 120 m'), 'Move, implicit lines, close and relative post-close move');
  assert(pdf.includes('\nf*\n') && !pdf.includes(' re f'), 'One even-odd fill keeps holes and paper unpainted');
  assert(pdf.includes('0.07058824 0.22745098 0.7372549 rg'), 'Selected RGB ink');
  const white = assembleVectorPDF(paths, 300, '#000000', 'white');
  assert(white.includes('1 1 1 rg\n0 0 72 36 re f\n0 0 0 rg'), 'Opaque white rectangle behind ink');
  assert(assembleVectorPDF(paths, 600, '#000000').includes('/MediaBox [0 0 36 18]'), 'DPI changes physical page');
  const curve = assembleVectorPDF(['M0 0C0 100 100 100 100 0L0 0z'], 72, '#000000');
  assert(curve.includes('/MediaBox [0 0 10 7.5]'), 'Page uses cubic extrema, not control bounds');
  for (const document of [pdf, white, curve]) {
    assert(Buffer.byteLength(document) === document.length, 'ASCII byte count is exact');
    const xref = Number(document.match(/startxref\n(\d+)/)[1]);
    assert(document.slice(xref).startsWith('xref\n0 5\n'), 'startxref points to xref');
    const entries = document.slice(xref).split('\n').slice(3, 7);
    entries.forEach((entry, i) => assert(document.slice(Number(entry.slice(0,10))).startsWith((i+1) + ' 0 obj\n'), 'Object offset resolves'));
    const stream = document.match(/\/Length (\d+) >>\nstream\n([\s\S]*?)endstream/);
    assert(+stream[1] === Buffer.byteLength(stream[2]), 'Stream length matches exact bytes');
  }
  const tiny = assembleVectorPDF(['M0 0L100 0L100 100L0.00000001 100z'], 300, '#000000');
  assert(tiny.includes('0.00000001 100 l'), 'Small coordinates use decimal PDF numbers, never exponents');
  for (const args of [[paths,0,'#000000'], [paths,NaN,'#000000'], [paths,300,'red'], [paths,300,'#000000','red'], [['M0 0L10 10'],300,'#000000']]) {
    let rejected = false; try { assembleVectorPDF(...args); } catch { rejected = true; }
    assert(rejected, 'Invalid PDF input rejected');
  }
});

// ─── Summary ─────────────────────────────────────────────────
console.log('\n=== Summary ===');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  - ' + f));
}
process.exit(failed > 0 ? 1 : 0);

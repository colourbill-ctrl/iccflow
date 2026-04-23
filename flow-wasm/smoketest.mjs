import createIccFlowModule from './build/iccflow.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_CMYK_PROFILE = '/usr/share/color/icc/colord/FOGRA39L_coated.icc';

const [, , tiffPathArg, dstPathArg, outArg] = process.argv;
const tiffPath = tiffPathArg || null;  // null = synthesize a 16×16 CMYK gradient
const dstPath  = dstPathArg || DEFAULT_CMYK_PROFILE;
const outPath  = outArg || '/tmp/iccflow_test_out.tif';

const srgbBytes = new Uint8Array(readFileSync(
  new URL('../frontend/public/wasm/sRGB.icc', import.meta.url)));

const mod = await createIccFlowModule();

// Need a source profile (we'll use the same one for both if it round-trips).
const dstBytes = new Uint8Array(readFileSync(dstPath));

// Synthesize a tiny 16×16 CMYK TIFF if no path supplied.
const tiffBytes = tiffPath
  ? new Uint8Array(readFileSync(tiffPath))
  : makeCmykTiff(16, 16);

console.log('1. inspectTiff…');
const info = mod.inspectTiff(tiffBytes);
if (info.status !== 'ok') { console.error('FAILED:', info.message); process.exit(1); }
console.log(`   ${info.width} × ${info.height} · ${info.channels}ch · ${info.bitsPerSample}bpp · ${info.colorSpace}`);
console.log(`   hasEmbedded: ${info.hasEmbeddedIcc}`);

console.log('\n2. inspectProfile (dst)…');
const dstInfo = mod.inspectProfile(dstBytes);
if (dstInfo.status !== 'ok') { console.error('FAILED:', dstInfo.message); process.exit(1); }
console.log(`   ${dstInfo.dataSpace} · ${dstInfo.deviceClassName} · ${dstInfo.description}`);

// For the synthesized image we must supply both src and dst (no embedded).
// Use the same CMYK profile for both → identity-ish round-trip through PCS.
const srcBytes = info.hasEmbeddedIcc ? new Uint8Array(0) : dstBytes;

console.log('\n3. applyFlow…');
const t0 = performance.now();
let r;
try {
  r = mod.applyFlow(tiffBytes, srcBytes, dstBytes, 1, 1, srgbBytes);
} catch (e) {
  const msg = mod.getExceptionMessage ? mod.getExceptionMessage(e) : String(e);
  console.error('FAILED:', msg); process.exit(1);
}
const ms = performance.now() - t0;

if (r.status !== 'ok') { console.error('FAILED:', r.message); process.exit(1); }

console.log(`   took ${ms.toFixed(0)} ms`);
console.log(`   dst: ${r.width} × ${r.height} · ${r.dstChannels}ch · ${r.dstSpace}`);
console.log(`   softProofed: ${r.softProofed}`);
console.log(`   dstTiff: ${r.dstTiffBytes.length} bytes`);
console.log(`   preview: ${r.previewRgba.length} bytes (RGBA)`);

writeFileSync(outPath, r.dstTiffBytes);
console.log(`\nwrote ${outPath}`);

// ── Minimal CMYK TIFF generator ───────────────────────────────────────────
// Uncompressed, interleaved, 8-bit per channel, PHOTOMETRIC_SEPARATED.
// Pixels: horizontal gradient in each channel for visual sanity.
function makeCmykTiff(w, h) {
  const pixelBytes = w * h * 4;
  const bpsOff    = 8;                    // inline [8,8,8,8] → 8 bytes
  const resOffC   = bpsOff + 8;           // 8 bytes for x-res rational
  const resOffM   = resOffC + 8;          // 8 bytes for y-res rational
  const ifdOff    = resOffM + 8;          // ← IFD starts after aux values
  const numTags   = 12;
  const stripOff  = ifdOff + 2 + numTags * 12 + 4;
  const total     = stripOff + pixelBytes;

  const buf = new Uint8Array(total);
  const dv  = new DataView(buf.buffer);

  // Header
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49);   // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOff, true);

  // Aux values
  dv.setUint16(bpsOff + 0, 8, true);
  dv.setUint16(bpsOff + 2, 8, true);
  dv.setUint16(bpsOff + 4, 8, true);
  dv.setUint16(bpsOff + 6, 8, true);
  dv.setUint32(resOffC + 0, 72, true); dv.setUint32(resOffC + 4, 1, true);
  dv.setUint32(resOffM + 0, 72, true); dv.setUint32(resOffM + 4, 1, true);

  // IFD
  dv.setUint16(ifdOff, numTags, true);
  const tag = (i, id, type, count, value) => {
    const off = ifdOff + 2 + i * 12;
    dv.setUint16(off + 0, id,    true);
    dv.setUint16(off + 2, type,  true);
    dv.setUint32(off + 4, count, true);
    dv.setUint32(off + 8, value, true);
  };
  tag(0,  256, 4, 1,   w);            // ImageWidth
  tag(1,  257, 4, 1,   h);            // ImageLength
  tag(2,  258, 3, 4,   bpsOff);       // BitsPerSample (offset — 4 shorts don't fit in 4 bytes)
  tag(3,  259, 3, 1,   1);            // Compression = none
  tag(4,  262, 3, 1,   5);            // Photometric = Separated (CMYK)
  tag(5,  273, 4, 1,   stripOff);     // StripOffsets
  tag(6,  277, 3, 1,   4);            // SamplesPerPixel
  tag(7,  278, 4, 1,   h);            // RowsPerStrip (one strip)
  tag(8,  279, 4, 1,   pixelBytes);   // StripByteCounts
  tag(9,  282, 5, 1,   resOffC);      // XResolution
  tag(10, 283, 5, 1,   resOffM);      // YResolution
  tag(11, 296, 3, 1,   2);            // ResolutionUnit = inch
  dv.setUint32(ifdOff + 2 + numTags * 12, 0, true);  // next IFD = 0

  // Pixels: CMYK gradient so each channel exercises something
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const p = stripOff + (y * w + x) * 4;
      buf[p + 0] = Math.round((x       / (w - 1 || 1)) * 255);  // C
      buf[p + 1] = Math.round((y       / (h - 1 || 1)) * 255);  // M
      buf[p + 2] = Math.round(((x + y) / (w + h - 2 || 1)) * 255); // Y
      buf[p + 3] = 0;                                           // K
    }
  }
  return buf;
}

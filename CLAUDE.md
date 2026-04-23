# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**iccflow** is a web-based tool that applies a chain of ICC profiles to a CMYK
TIFF image. Sibling project to **icctools** (validate/inspect) and **icceval**
(round-trip / PRMG). iccflow is the *transform* app: take a source profile,
take a destination profile, run the pixels through the iccDEV CMM, return a
destination TIFF plus a soft-proofed sRGB preview for the browser to display.

iccDEV source is at `/home/colour/code/iccdev` and must **not** be modified.

## Relationship to icctools / icceval

| App | Port | Purpose |
|-----|------|---------|
| icctools | 5173 | Validate + inspect a single profile |
| icceval  | 5174 | Round-trip / PRMG evaluation of a single profile |
| iccflow  | 5175 | Apply src → dst profile chain to a CMYK TIFF |

Each app is its own repo, its own WASM module, and its own deploy. Shared
patterns (WASM lazy-load, DropZone component, CSS tokens) are copied rather
than shared to keep deploy cadences independent.

## Layout

| Path | Contents |
|------|----------|
| `frontend/` | Vite + React SPA (port 5175 in dev). Loads `public/wasm/iccflow.{mjs,wasm}` and the soft-proof `public/wasm/sRGB.icc`. |
| `flow-wasm/` | Emscripten project: `flow-wrapper.cpp` + standalone `CMakeLists.txt` compiling IccProfLib sources + libtiff (vendored via FetchContent). Produces `iccflow.{mjs,wasm}`. |
| `scripts/build-wasm.sh` | Rebuilds the WASM, copies artifacts into `frontend/public/wasm/`, refreshes `SHA256SUMS`. |
| `scripts/deploy.sh`     | Rebuild + rsync to chardata:/var/www/iccflow/. |

Both packages use ES modules (`"type": "module"`).

## Dev commands

```bash
# frontend only — transform runs in the browser
cd frontend
npm install          # first time
npm run dev          # http://localhost:5175
npm run build        # production build → frontend/dist/

# rebuild the WASM (includes a libtiff fetch the first run)
source ~/emsdk-install/emsdk/emsdk_env.sh
scripts/build-wasm.sh
```

## flow-wasm details

`flow-wrapper.cpp` exports three embind functions:

```cpp
val inspectTiff(Uint8Array bytes);
// { status, width, height, channels, bitsPerSample, photometric,
//   photometricName, colorSpace, hasEmbeddedIcc, embeddedIccBytes,
//   embedded: { deviceClass, dataSpace, pcs, description, isDeviceLink } }

val inspectProfile(Uint8Array bytes);
// { status, deviceClass, dataSpace, pcs, description, isDeviceLink, ... }

val applyFlow(tiff, srcProfile, dstProfile, srcIntent, dstIntent, softProof);
// { status, message, dstTiffBytes (Uint8Array), previewRgba (Uint8ClampedArray),
//   width, height, srcSpace, dstSpace, srcIsDeviceLink, softProofed, ... }
```

### CMM pipeline

Mirrors `iccDEV/Tools/CmdLine/IccApplyProfiles/iccApplyProfiles.cpp`:

1. Decode source TIFF via libtiff (MEMFS hop — libtiff I/O expects paths).
2. Build main chain `[srcProfile, dstProfile]` using `CIccCmm::AddXform(pMem, nSize, intent, …)`. If srcProfile is DeviceLink, skip dstProfile entirely.
3. Build preview chain `[src, dst, dst, sRGB]` (or `[link, link, sRGB]` for DeviceLink) so the CMM can return to PCS after the dst/link and then convert to sRGB for canvas display. Classic soft-proof chain.
4. Per-pixel: normalize 8-bit → float → `Apply` → denormalize. Two passes: one for output TIFF (raw dst pixels), one for RGBA preview.
5. Encode output TIFF via libtiff (LZW, interleaved, embedded dst profile).

### v1 scope / gates

- **Input**: CMYK TIFF (4-channel, 8-bit, PHOTOMETRIC_SEPARATED, contiguous planar). Other formats return `{status:"error", message:"…"}`.
- **Source profile**: must be CMYK dataSpace, or a DeviceLink. Otherwise rejected.
- **Destination profile**: any dataSpace. Non-RGB/Gray dst triggers soft-proof via the shipped sRGB v4 profile.
- **Save**: TIFF (LZW, contiguous, dest ICC embedded).

### libtiff configuration

FetchContent pulls libtiff v4.6.0. Everything optional is OFF (JPEG, LZMA,
Zstd, WebP, JBIG, pixarlog, libdeflate, zlib). Kept: base codecs (none, LZW,
packbits, ccitt). No external deps beyond the wasm toolchain.

## Frontend component hierarchy

```
App.jsx                       — state owner, derives validation + errors
├── SourceImagePanel.jsx      — left column: drop TIFF, show colorSpace, embedded ICC, use-embedded toggle
├── ProfileStackPanel.jsx     — middle: src ICC + dst ICC + intent selects; greys out dst on DeviceLink
└── OutputImagePanel.jsx      — right column: preview canvas + Save TIFF button
```

Shared `Panel.module.css` with colour tokens from `src/index.css` matching
icctools/icceval (crimson `#BF003F` accent, Verdana on grey).

## Deployment

Production: `https://chardata.colourbill.com:5175/`. Same Lightsail box as
icctools/icceval, different port. Port 5175 must be opened in the Lightsail
firewall (AWS console) for external reachability. nginx server block lives
at `/etc/nginx/sites-available/iccflow` and mirrors the icctools CSP.

/**
 * iccflow WASM wrapper — CMM pipeline for CMYK TIFF → (soft-proof) → CMYK TIFF.
 *
 * Exposes three embind functions:
 *   inspectTiff(Uint8Array)     → object   (image metadata + embedded ICC)
 *   inspectProfile(Uint8Array)  → object   (ICC header + description)
 *   applyFlow(tiff, srcIcc, dstIcc, srcIntent, dstIntent, softProof) → object
 *                                         (dst TIFF bytes + sRGB RGBA preview)
 *
 * Mirrors iccDEV/Tools/CmdLine/IccApplyProfiles/iccApplyProfiles.cpp, condensed
 * to: build CIccCmm chain from in-memory profiles, decode source TIFF via
 * libtiff/MEMFS, apply per-pixel, re-encode destination TIFF with embedded
 * destination ICC. For preview we run the same pixels through a second CMM
 * (src→dst→sRGB) so CMYK outputs can be displayed on a browser canvas.
 *
 * libtiff's build system expects paths, so we route I/O through MEMFS —
 * same pattern as icctools' xml-wrapper. In-RAM either way; MEMFS is just
 * an existing virtual FS that TIFFOpen() accepts.
 */

#include "IccCmm.h"
#include "IccDefs.h"
#include "IccProfile.h"
#include "IccUtil.h"
#include "IccTag.h"
#include "IccIO.h"
#include "IccProfLibVer.h"

#include <tiffio.h>
#include <nlohmann/json.hpp>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::ordered_json;

namespace {

// ── MEMFS helpers ───────────────────────────────────────────────────────────

bool writeFile(const char* path, const void* data, std::size_t size) {
  FILE* f = std::fopen(path, "wb");
  if (!f) return false;
  bool ok = std::fwrite(data, 1, size, f) == size;
  std::fclose(f);
  return ok;
}

bool readFile(const char* path, std::vector<std::uint8_t>& out) {
  FILE* f = std::fopen(path, "rb");
  if (!f) return false;
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  if (n < 0) { std::fclose(f); return false; }
  std::fseek(f, 0, SEEK_SET);
  out.resize(static_cast<std::size_t>(n));
  bool ok = std::fread(out.data(), 1, out.size(), f) == out.size();
  std::fclose(f);
  return ok;
}

// ── JS interop ──────────────────────────────────────────────────────────────

emscripten::val makeUint8Array(const std::uint8_t* data, std::size_t size) {
  emscripten::val u8 = emscripten::val::global("Uint8Array").new_(size);
  u8.call<void>("set",
    emscripten::val(emscripten::typed_memory_view(size, data)));
  return u8;
}

emscripten::val makeUint8ClampedArray(const std::uint8_t* data, std::size_t size) {
  emscripten::val arr = emscripten::val::global("Uint8ClampedArray").new_(size);
  arr.call<void>("set",
    emscripten::val(emscripten::typed_memory_view(size, data)));
  return arr;
}

emscripten::val valFromJson(const json& j) {
  return emscripten::val::global("JSON").call<emscripten::val>("parse",
    emscripten::val(j.dump()));
}

// ── ICC label helpers ───────────────────────────────────────────────────────

const char* deviceClassName(icProfileClassSignature c) {
  switch (c) {
    case icSigInputClass:      return "Input (scnr)";
    case icSigDisplayClass:    return "Display (mntr)";
    case icSigOutputClass:     return "Output (prtr)";
    case icSigLinkClass:       return "DeviceLink (link)";
    case icSigAbstractClass:   return "Abstract (abst)";
    case icSigColorSpaceClass: return "ColorSpace (spac)";
    case icSigNamedColorClass: return "NamedColor (nmcl)";
    default:                   return "Unknown";
  }
}

const char* colorSpaceName(icColorSpaceSignature c) {
  switch (c) {
    case icSigXYZData:     return "XYZ";
    case icSigLabData:     return "Lab";
    case icSigLuvData:     return "Luv";
    case icSigYCbCrData:   return "YCbCr";
    case icSigYxyData:     return "Yxy";
    case icSigRgbData:     return "RGB";
    case icSigGrayData:    return "Gray";
    case icSigHsvData:     return "HSV";
    case icSigHlsData:     return "HLS";
    case icSigCmykData:    return "CMYK";
    case icSigCmyData:     return "CMY";
    case icSig2colorData:  return "2-colour";
    case icSig3colorData:  return "3-colour";
    case icSig4colorData:  return "4-colour";
    case icSig5colorData:  return "5-colour";
    case icSig6colorData:  return "6-colour";
    case icSig7colorData:  return "7-colour";
    case icSig8colorData:  return "8-colour";
    default:               return "Unknown";
  }
}

// Read the profileDescriptionTag text. Returns empty string if not parseable.
std::string profileDescription(CIccProfile* p) {
  if (!p) return {};
  CIccTag* t = p->FindTag(icSigProfileDescriptionTag);
  if (!t) return {};
  // Multilocalized + text tags both respond to GetText via their Describe()
  // formatted output, but that's verbose. Reach for CIccTagMultiLocalizedUnicode
  // or CIccTagTextDescription via RTTI if available; otherwise fall back to a
  // short slice of Describe().
  std::string desc;
  t->Describe(desc, 0);
  // Trim whitespace; the Describe output often includes "\"Text\"" — grab the
  // first quoted run if present.
  auto q1 = desc.find('"');
  if (q1 != std::string::npos) {
    auto q2 = desc.find('"', q1 + 1);
    if (q2 != std::string::npos) return desc.substr(q1 + 1, q2 - q1 - 1);
  }
  // Otherwise first non-empty line.
  auto nl = desc.find('\n');
  return (nl == std::string::npos) ? desc : desc.substr(0, nl);
}

// Open a CIccProfile from JS bytes (attaches — vec must outlive the profile).
struct ProfileHolder {
  std::vector<std::uint8_t> bytes;
  CIccProfile* profile = nullptr;
  ~ProfileHolder() { delete profile; }
};

bool openProfile(emscripten::val bytesVal, ProfileHolder& out, std::string& err) {
  out.bytes = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bytesVal);
  if (out.bytes.size() < 128) { err = "profile bytes too small"; return false; }
  out.profile = OpenIccProfile(out.bytes.data(),
                               static_cast<icUInt32Number>(out.bytes.size()));
  if (!out.profile) { err = "failed to parse ICC profile"; return false; }
  return true;
}

json profileHeaderJson(CIccProfile* p) {
  const icHeader& h = p->m_Header;
  return {
    {"deviceClass",      std::string(1, 0) /*placeholder*/},
    {"deviceClassName",  deviceClassName(h.deviceClass)},
    {"deviceClassSig",   static_cast<std::uint32_t>(h.deviceClass)},
    {"dataSpace",        colorSpaceName(h.colorSpace)},
    {"dataSpaceSig",     static_cast<std::uint32_t>(h.colorSpace)},
    {"pcs",              colorSpaceName(h.pcs)},
    {"pcsSig",           static_cast<std::uint32_t>(h.pcs)},
    {"isDeviceLink",     h.deviceClass == icSigLinkClass},
    {"description",      profileDescription(p)},
  };
}

// ── TIFF inspection ─────────────────────────────────────────────────────────

struct TiffInfo {
  std::uint32_t width = 0, height = 0;
  std::uint16_t samples = 0, bitsPerSample = 0, photometric = 0, planar = 0;
  std::vector<std::uint8_t> embeddedIcc;
  bool ok = false;
};

const char* photoName(std::uint16_t p) {
  switch (p) {
    case PHOTOMETRIC_MINISWHITE: return "MinIsWhite";
    case PHOTOMETRIC_MINISBLACK: return "MinIsBlack";
    case PHOTOMETRIC_RGB:        return "RGB";
    case PHOTOMETRIC_PALETTE:    return "Palette";
    case PHOTOMETRIC_MASK:       return "Mask";
    case PHOTOMETRIC_SEPARATED:  return "Separated (CMYK)";
    case PHOTOMETRIC_YCBCR:      return "YCbCr";
    case PHOTOMETRIC_CIELAB:     return "CIELab";
    case PHOTOMETRIC_ICCLAB:     return "ICCLab";
    default:                     return "Unknown";
  }
}

// Infer the ICC color-space signature implied by (samples, photometric) — so
// we can compare it to the user-supplied source profile's dataSpace.
const char* impliedColorSpace(const TiffInfo& t) {
  if (t.photometric == PHOTOMETRIC_SEPARATED && t.samples >= 4) return "CMYK";
  if (t.photometric == PHOTOMETRIC_RGB && t.samples >= 3) return "RGB";
  if (t.photometric == PHOTOMETRIC_MINISBLACK ||
      t.photometric == PHOTOMETRIC_MINISWHITE) return "Gray";
  if (t.photometric == PHOTOMETRIC_CIELAB ||
      t.photometric == PHOTOMETRIC_ICCLAB) return "Lab";
  return "Unknown";
}

bool readTiffInfo(const char* path, TiffInfo& info, std::string& err) {
  TIFF* tif = TIFFOpen(path, "r");
  if (!tif) { err = "not a readable TIFF"; return false; }
  TIFFGetField(tif, TIFFTAG_IMAGEWIDTH,      &info.width);
  TIFFGetField(tif, TIFFTAG_IMAGELENGTH,     &info.height);
  TIFFGetField(tif, TIFFTAG_SAMPLESPERPIXEL, &info.samples);
  TIFFGetField(tif, TIFFTAG_BITSPERSAMPLE,   &info.bitsPerSample);
  TIFFGetField(tif, TIFFTAG_PHOTOMETRIC,     &info.photometric);
  TIFFGetField(tif, TIFFTAG_PLANARCONFIG,    &info.planar);

  std::uint32_t iccLen = 0;
  void* iccData = nullptr;
  if (TIFFGetField(tif, TIFFTAG_ICCPROFILE, &iccLen, &iccData) && iccLen && iccData) {
    info.embeddedIcc.assign(
      static_cast<const std::uint8_t*>(iccData),
      static_cast<const std::uint8_t*>(iccData) + iccLen);
  }

  info.ok = info.width > 0 && info.height > 0 && info.samples > 0;
  TIFFClose(tif);
  if (!info.ok) { err = "TIFF missing width/height/samples"; return false; }
  return true;
}

} // namespace

// ── inspectProfile ──────────────────────────────────────────────────────────

static emscripten::val inspectProfile(emscripten::val bytesVal) {
  ProfileHolder pholder;
  std::string err;
  if (!openProfile(bytesVal, pholder, err)) {
    return valFromJson({{"status", "error"}, {"message", err}});
  }
  json r = profileHeaderJson(pholder.profile);
  r["status"] = "ok";
  return valFromJson(r);
}

// ── inspectTiff ─────────────────────────────────────────────────────────────

static emscripten::val inspectTiff(emscripten::val bytesVal) {
  auto bytes = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bytesVal);
  if (bytes.size() < 8) {
    return valFromJson({{"status", "error"}, {"message", "file too small to be a TIFF"}});
  }

  const char* path = "/tmp/iccflow_in.tif";
  if (!writeFile(path, bytes.data(), bytes.size())) {
    return valFromJson({{"status", "error"}, {"message", "MEMFS write failed"}});
  }

  TiffInfo t;
  std::string err;
  bool ok = readTiffInfo(path, t, err);
  std::remove(path);
  if (!ok) {
    return valFromJson({{"status", "error"}, {"message", err}});
  }

  json r = {
    {"status",        "ok"},
    {"width",         t.width},
    {"height",        t.height},
    {"channels",      t.samples},
    {"bitsPerSample", t.bitsPerSample},
    {"photometric",   t.photometric},
    {"photometricName", photoName(t.photometric)},
    {"colorSpace",    impliedColorSpace(t)},
    {"planar",        t.planar},
    {"hasEmbeddedIcc", !t.embeddedIcc.empty()},
  };

  if (!t.embeddedIcc.empty()) {
    CIccProfile* emb = OpenIccProfile(t.embeddedIcc.data(),
                                      static_cast<icUInt32Number>(t.embeddedIcc.size()));
    if (emb) {
      r["embedded"] = profileHeaderJson(emb);
      delete emb;
    } else {
      r["embedded"] = {{"status", "unparseable"}};
    }
  }

  emscripten::val obj = valFromJson(r);
  if (!t.embeddedIcc.empty()) {
    obj.set("embeddedIccBytes", makeUint8Array(t.embeddedIcc.data(), t.embeddedIcc.size()));
  }
  return obj;
}

// ── applyFlow ───────────────────────────────────────────────────────────────
//
// Steps:
//   1. Decode source TIFF from MEMFS → width, height, samples, bps, pixels.
//   2. Build the "output" CMM chain: [srcProfile, dstProfile?]. srcProfile is
//      either the JS-supplied bytes or the TIFF's embedded ICC; dstProfile is
//      skipped entirely if src is DeviceLink.
//   3. Build the "preview" chain = output chain + softProof (sRGB).
//      If the output dataspace is already RGB/Gray we skip softProof and just
//      widen to RGBA8 for canvas.
//   4. Run both pipelines row-by-row. Dst pixels go back into a MEMFS TIFF we
//      then read to return to JS. Preview pixels go straight into an RGBA
//      buffer.
//   5. Return both buffers plus metadata.

static icFloatNumber unitClip(icFloatNumber v) {
  if (std::isnan(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

static emscripten::val applyFlow(
    emscripten::val tiffBytesVal,
    emscripten::val srcProfileBytesVal,   // may be empty Uint8Array / null
    emscripten::val dstProfileBytesVal,   // may be empty for DeviceLink
    int srcIntent,
    int dstIntent,
    emscripten::val softProofBytesVal) {  // may be empty; only used for non-RGB dst

  auto tiffBytes = emscripten::convertJSArrayToNumberVector<std::uint8_t>(tiffBytesVal);
  auto srcBytes  = emscripten::convertJSArrayToNumberVector<std::uint8_t>(srcProfileBytesVal);
  auto dstBytes  = emscripten::convertJSArrayToNumberVector<std::uint8_t>(dstProfileBytesVal);
  auto sRgbBytes = emscripten::convertJSArrayToNumberVector<std::uint8_t>(softProofBytesVal);

  auto fail = [](const std::string& m) {
    return valFromJson({{"status", "error"}, {"message", m}});
  };

  // 1. Decode source TIFF ------------------------------------------------------
  const char* srcPath = "/tmp/iccflow_src.tif";
  if (!writeFile(srcPath, tiffBytes.data(), tiffBytes.size()))
    return fail("MEMFS write failed (src)");

  TIFF* srcTif = TIFFOpen(srcPath, "r");
  if (!srcTif) { std::remove(srcPath); return fail("unreadable source TIFF"); }

  std::uint32_t width = 0, height = 0;
  std::uint16_t sps = 0, bps = 0, photo = 0, planar = PLANARCONFIG_CONTIG;
  float xres = 72, yres = 72;
  std::uint16_t resUnit = RESUNIT_INCH;
  TIFFGetField(srcTif, TIFFTAG_IMAGEWIDTH,      &width);
  TIFFGetField(srcTif, TIFFTAG_IMAGELENGTH,     &height);
  TIFFGetField(srcTif, TIFFTAG_SAMPLESPERPIXEL, &sps);
  TIFFGetField(srcTif, TIFFTAG_BITSPERSAMPLE,   &bps);
  TIFFGetField(srcTif, TIFFTAG_PHOTOMETRIC,     &photo);
  TIFFGetField(srcTif, TIFFTAG_PLANARCONFIG,    &planar);
  TIFFGetFieldDefaulted(srcTif, TIFFTAG_XRESOLUTION, &xres);
  TIFFGetFieldDefaulted(srcTif, TIFFTAG_YRESOLUTION, &yres);
  TIFFGetFieldDefaulted(srcTif, TIFFTAG_RESOLUTIONUNIT, &resUnit);

  if (bps != 8) {
    TIFFClose(srcTif); std::remove(srcPath);
    return fail("only 8-bit TIFFs are supported in this build");
  }
  if (planar != PLANARCONFIG_CONTIG) {
    TIFFClose(srcTif); std::remove(srcPath);
    return fail("planar (separated) TIFFs are not supported yet — only interleaved");
  }

  // Pull embedded ICC if the user didn't pass a src profile.
  std::vector<std::uint8_t> embeddedIcc;
  std::uint32_t embLen = 0; void* embData = nullptr;
  if (TIFFGetField(srcTif, TIFFTAG_ICCPROFILE, &embLen, &embData) && embLen && embData) {
    embeddedIcc.assign(
      static_cast<const std::uint8_t*>(embData),
      static_cast<const std::uint8_t*>(embData) + embLen);
  }

  // Read pixels into an interleaved byte buffer.
  std::vector<std::uint8_t> srcPixels;
  std::size_t rowBytes = static_cast<std::size_t>(TIFFScanlineSize(srcTif));
  srcPixels.resize(rowBytes * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    if (TIFFReadScanline(srcTif, srcPixels.data() + y * rowBytes, y) < 0) {
      TIFFClose(srcTif); std::remove(srcPath);
      return fail("TIFF read failed at row " + std::to_string(y));
    }
  }
  TIFFClose(srcTif);
  std::remove(srcPath);

  // 2. Build output CMM chain ------------------------------------------------
  const std::vector<std::uint8_t>& srcIccBytes =
      !srcBytes.empty() ? srcBytes : embeddedIcc;
  if (srcIccBytes.empty()) {
    return fail("no source profile provided and image has no embedded profile");
  }

  // We need to peek at the source profile's deviceClass before deciding
  // whether to include the destination profile.
  CIccProfile* probe = OpenIccProfile(srcIccBytes.data(),
                                      static_cast<icUInt32Number>(srcIccBytes.size()));
  if (!probe) return fail("failed to parse source profile");
  bool srcIsLink = probe->m_Header.deviceClass == icSigLinkClass;
  icColorSpaceSignature srcDataSpace = probe->m_Header.colorSpace;
  delete probe;

  if (!srcIsLink && dstBytes.empty()) {
    return fail("a destination profile is required (source is not a DeviceLink)");
  }

  // CMYK-only input gate (v1 scope).
  if (sps == 4 && photo != PHOTOMETRIC_SEPARATED) {
    return fail("4-channel TIFF but not CMYK (PHOTOMETRIC_SEPARATED)");
  }
  if (srcDataSpace == icSigCmykData && sps != 4) {
    return fail("source profile is CMYK but image has " + std::to_string(sps) + " channels");
  }
  if (photo == PHOTOMETRIC_SEPARATED && srcDataSpace != icSigCmykData) {
    return fail("image is CMYK but source profile is not CMYK");
  }

  auto addXform = [](CIccCmm& cmm, const std::vector<std::uint8_t>& bytes, int intent) -> icStatusCMM {
    return cmm.AddXform(
        const_cast<icUInt8Number*>(bytes.data()),
        static_cast<icUInt32Number>(bytes.size()),
        intent < 0 ? icUnknownIntent : (icRenderingIntent)intent,
        icInterpLinear,
        nullptr, icXformLutColor, true, nullptr, false);
  };

  CIccCmm outCmm(icSigUnknownData, icSigUnknownData, true);
  if (addXform(outCmm, srcIccBytes, srcIntent) != icCmmStatOk)
    return fail("AddXform (source) failed");
  if (!srcIsLink) {
    if (addXform(outCmm, dstBytes, dstIntent) != icCmmStatOk)
      return fail("AddXform (destination) failed");
  }
  icStatusCMM st = outCmm.Begin();
  if (st != icCmmStatOk)
    return fail("CMM chain rejected (code " + std::to_string(st) + ") — incompatible profiles?");

  icColorSpaceSignature outSrcSpace = outCmm.GetSourceSpace();
  icColorSpaceSignature outDstSpace = outCmm.GetDestSpace();
  int nSrcSamples = icGetSpaceSamples(outSrcSpace);
  int nDstSamples = icGetSpaceSamples(outDstSpace);

  if (nSrcSamples != (int)sps)
    return fail("image has " + std::to_string(sps) +
                " channels, profile expects " + std::to_string(nSrcSamples));

  // 3. Build preview chain ---------------------------------------------------
  //
  // For CMYK (or any non-RGB) destinations we need to show the result on a
  // browser canvas. Classic soft-proof pattern: go source → PCS → dest → PCS
  // → display, which means chaining the destination profile *twice* — first
  // as the simulated output, then again to re-enter PCS for the display leg.
  // For DeviceLink source that's [link → link → sRGB]; for a normal src/dst
  // it's [src → dst → dst → sRGB]. The CMM auto-flips each profile between
  // A2B and B2A based on its chain position, so the duplicate entry is what
  // actually produces the PCS re-entry.
  bool needSoftProof = outDstSpace != icSigRgbData && outDstSpace != icSigGrayData;
  CIccCmm previewCmm(icSigUnknownData, icSigUnknownData, true);
  bool previewReady = false;
  if (needSoftProof) {
    if (sRgbBytes.empty())
      return fail("destination is not RGB/Gray — sRGB soft-proof profile required");
    if (addXform(previewCmm, srcIccBytes, srcIntent) != icCmmStatOk)
      return fail("preview AddXform (source) failed");
    if (!srcIsLink) {
      if (addXform(previewCmm, dstBytes, dstIntent) != icCmmStatOk)
        return fail("preview AddXform (destination, forward) failed");
      if (addXform(previewCmm, dstBytes, dstIntent) != icCmmStatOk)
        return fail("preview AddXform (destination, back-to-PCS) failed");
    } else {
      // DeviceLink: re-enter PCS with the link itself (inverse direction).
      if (addXform(previewCmm, srcIccBytes, srcIntent) != icCmmStatOk)
        return fail("preview AddXform (link, back-to-PCS) failed");
    }
    if (addXform(previewCmm, sRgbBytes, icRelativeColorimetric) != icCmmStatOk)
      return fail("preview AddXform (sRGB soft-proof) failed");
    if (previewCmm.Begin() != icCmmStatOk)
      return fail("preview CMM chain failed to begin");
    previewReady = true;
  }

  // 4. Apply pixels ----------------------------------------------------------
  std::size_t nPixels = static_cast<std::size_t>(width) * height;
  std::vector<std::uint8_t> dstPixels(nPixels * nDstSamples);
  std::vector<std::uint8_t> previewRgba(nPixels * 4);

  CIccPixelBuf srcPix(nSrcSamples + 16);
  CIccPixelBuf dstPix(nDstSamples + 16);
  CIccPixelBuf previewPix(4 + 16);  // RGB/Gray

  for (std::size_t i = 0; i < nPixels; ++i) {
    const std::uint8_t* s = &srcPixels[i * sps];
    // Normalize 8-bit → float [0,1], matching IccApplyProfiles.cpp.
    for (int k = 0; k < nSrcSamples; ++k) {
      static_cast<icFloatNumber*>(srcPix)[k] = static_cast<icFloatNumber>(s[k]) / 255.0f;
    }

    outCmm.Apply(dstPix, srcPix);

    std::uint8_t* d = &dstPixels[i * nDstSamples];
    for (int k = 0; k < nDstSamples; ++k) {
      d[k] = static_cast<std::uint8_t>(unitClip(static_cast<icFloatNumber*>(dstPix)[k]) * 255.0f + 0.5f);
    }

    // Preview: either soft-proof through sRGB or just widen dst to RGBA.
    std::uint8_t* p = &previewRgba[i * 4];
    if (previewReady) {
      previewCmm.Apply(previewPix, srcPix);
      p[0] = static_cast<std::uint8_t>(unitClip(static_cast<icFloatNumber*>(previewPix)[0]) * 255.0f + 0.5f);
      p[1] = static_cast<std::uint8_t>(unitClip(static_cast<icFloatNumber*>(previewPix)[1]) * 255.0f + 0.5f);
      p[2] = static_cast<std::uint8_t>(unitClip(static_cast<icFloatNumber*>(previewPix)[2]) * 255.0f + 0.5f);
    } else if (outDstSpace == icSigRgbData && nDstSamples >= 3) {
      p[0] = d[0]; p[1] = d[1]; p[2] = d[2];
    } else if (outDstSpace == icSigGrayData && nDstSamples >= 1) {
      p[0] = p[1] = p[2] = d[0];
    } else {
      // Shouldn't happen given the needSoftProof branch above.
      p[0] = p[1] = p[2] = 128;
    }
    p[3] = 255;
  }

  // 5. Encode destination TIFF ----------------------------------------------
  const char* dstPath = "/tmp/iccflow_dst.tif";
  TIFF* dstTif = TIFFOpen(dstPath, "w");
  if (!dstTif) return fail("MEMFS TIFF open (write) failed");

  std::uint16_t dstPhoto = (outDstSpace == icSigCmykData) ? PHOTOMETRIC_SEPARATED
                         : (outDstSpace == icSigRgbData)  ? PHOTOMETRIC_RGB
                         : (outDstSpace == icSigLabData)  ? PHOTOMETRIC_CIELAB
                         : PHOTOMETRIC_MINISBLACK;

  TIFFSetField(dstTif, TIFFTAG_IMAGEWIDTH,      width);
  TIFFSetField(dstTif, TIFFTAG_IMAGELENGTH,     height);
  TIFFSetField(dstTif, TIFFTAG_BITSPERSAMPLE,   (std::uint16_t)8);
  TIFFSetField(dstTif, TIFFTAG_SAMPLESPERPIXEL, (std::uint16_t)nDstSamples);
  TIFFSetField(dstTif, TIFFTAG_PHOTOMETRIC,     dstPhoto);
  TIFFSetField(dstTif, TIFFTAG_PLANARCONFIG,    PLANARCONFIG_CONTIG);
  TIFFSetField(dstTif, TIFFTAG_ORIENTATION,     ORIENTATION_TOPLEFT);
  TIFFSetField(dstTif, TIFFTAG_COMPRESSION,     COMPRESSION_LZW);
  TIFFSetField(dstTif, TIFFTAG_XRESOLUTION,     xres);
  TIFFSetField(dstTif, TIFFTAG_YRESOLUTION,     yres);
  TIFFSetField(dstTif, TIFFTAG_RESOLUTIONUNIT,  resUnit);
  TIFFSetField(dstTif, TIFFTAG_ROWSPERSTRIP,    TIFFDefaultStripSize(dstTif, 0));

  // Embed the destination profile in the output TIFF — mirrors
  // iccApplyProfiles.cpp's "embed last profile" behaviour. For DeviceLink
  // source we embed the source (it *is* the last profile in the chain).
  const std::vector<std::uint8_t>& embedBytes =
      srcIsLink ? srcIccBytes : dstBytes;
  if (!embedBytes.empty()) {
    TIFFSetField(dstTif, TIFFTAG_ICCPROFILE,
                 (std::uint32_t)embedBytes.size(),
                 const_cast<std::uint8_t*>(embedBytes.data()));
  }

  std::size_t dstRowBytes = static_cast<std::size_t>(width) * nDstSamples;
  for (std::uint32_t y = 0; y < height; ++y) {
    if (TIFFWriteScanline(dstTif, dstPixels.data() + y * dstRowBytes, y) < 0) {
      TIFFClose(dstTif); std::remove(dstPath);
      return fail("TIFF write failed at row " + std::to_string(y));
    }
  }
  TIFFClose(dstTif);

  std::vector<std::uint8_t> dstTiffBytes;
  bool readOk = readFile(dstPath, dstTiffBytes);
  std::remove(dstPath);
  if (!readOk) return fail("failed to read back encoded TIFF");

  // ── Assemble return object ────────────────────────────────────────────────
  json meta = {
    {"status",        "ok"},
    {"width",         width},
    {"height",        height},
    {"srcChannels",   sps},
    {"dstChannels",   nDstSamples},
    {"srcSpace",      colorSpaceName(outSrcSpace)},
    {"dstSpace",      colorSpaceName(outDstSpace)},
    {"srcIsDeviceLink", srcIsLink},
    {"softProofed",   previewReady},
    {"dstBytes",      static_cast<std::uint32_t>(dstTiffBytes.size())},
  };

  emscripten::val obj = valFromJson(meta);
  obj.set("dstTiffBytes", makeUint8Array(dstTiffBytes.data(), dstTiffBytes.size()));
  obj.set("previewRgba",  makeUint8ClampedArray(previewRgba.data(), previewRgba.size()));
  return obj;
}

EMSCRIPTEN_BINDINGS(iccflow) {
  emscripten::function("inspectProfile", &inspectProfile);
  emscripten::function("inspectTiff",    &inspectTiff);
  emscripten::function("applyFlow",      &applyFlow);
}

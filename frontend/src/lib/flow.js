/**
 * Lazy-loaded iccflow WASM wrapper.
 *
 * Three embind functions: inspectTiff, inspectProfile, applyFlow.
 * Same fetch+blob+import trick as icctools/icceval.
 */

const WASM_DIR = '/wasm/'
let modulePromise = null
let sRgbPromise   = null

// Mirror the C++ caps so the user gets a clearer error before we pay for
// an ArrayBuffer→Uint8Array→wasm memcpy. Keep these in sync with
// flow-wrapper.cpp's kMaxTiffBytes / kMaxIccBytes.
export const MAX_TIFF_BYTES = 200 * 1024 * 1024   // 200 MB
export const MAX_ICC_BYTES  =  16 * 1024 * 1024   // 16 MB

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccflow.mjs')
      if (!res.ok) throw new Error(`Failed to load flow module: HTTP ${res.status}`)
      const source = await res.text()
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      try {
        const factory = (await import(/* @vite-ignore */ blobUrl)).default
        return await factory({ locateFile: (p) => WASM_DIR + p })
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
    })()
    modulePromise.catch(() => { modulePromise = null })
  }
  return modulePromise
}

/** Pre-fetch the soft-proof sRGB profile. */
export async function loadSRgbProfile() {
  if (!sRgbPromise) {
    sRgbPromise = (async () => {
      const res = await fetch(WASM_DIR + 'sRGB.icc')
      if (!res.ok) throw new Error(`Failed to load sRGB profile: HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      return new Uint8Array(buf)
    })()
    sRgbPromise.catch(() => { sRgbPromise = null })
  }
  return sRgbPromise
}

export function preloadFlow() {
  loadModule().catch(() => {})
  loadSRgbProfile().catch(() => {})
}

function toError(mod, e) {
  if (mod && mod.getExceptionMessage) {
    try {
      const msg = mod.getExceptionMessage(e)
      const err = new Error(Array.isArray(msg) ? (msg[1] || msg[0]) : String(msg))
      // getExceptionMessage bumps embind's exception refcount — release it
      // so repeated errors (e.g. the user dropping malformed files in a loop)
      // don't leak wasm heap.
      try { mod.decrementExceptionRefcount?.(e) } catch {}
      return err
    } catch {}
  }
  return e instanceof Error ? e : new Error(String(e))
}

export async function inspectTiff(bytes) {
  const mod = await loadModule()
  try { return mod.inspectTiff(bytes) }
  catch (e) { throw toError(mod, e) }
}

export async function inspectProfile(bytes) {
  const mod = await loadModule()
  try { return mod.inspectProfile(bytes) }
  catch (e) { throw toError(mod, e) }
}

/**
 * @param {Uint8Array} tiffBytes
 * @param {Uint8Array} srcProfileBytes  Uint8Array (empty length = use embedded)
 * @param {Uint8Array} dstProfileBytes  Uint8Array (empty for DeviceLink src)
 * @param {number}     srcIntent
 * @param {number}     dstIntent
 */
export async function applyFlow(tiffBytes, srcProfileBytes, dstProfileBytes, srcIntent, dstIntent) {
  const mod = await loadModule()
  const sRgb = await loadSRgbProfile()
  try {
    return mod.applyFlow(
      tiffBytes,
      srcProfileBytes ?? new Uint8Array(0),
      dstProfileBytes ?? new Uint8Array(0),
      srcIntent,
      dstIntent,
      sRgb,
    )
  } catch (e) {
    throw toError(mod, e)
  }
}

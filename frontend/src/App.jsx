import { useCallback, useEffect, useMemo, useState } from 'react'
import SourceImagePanel  from './components/SourceImagePanel.jsx'
import ProfileStackPanel from './components/ProfileStackPanel.jsx'
import OutputImagePanel  from './components/OutputImagePanel.jsx'
import {
  preloadFlow, inspectTiff, inspectProfile, applyFlow,
  MAX_TIFF_BYTES, MAX_ICC_BYTES,
} from './lib/flow.js'
import styles from './App.module.css'

/**
 * State model — explicit because the validation matrix is non-trivial.
 *
 * image       : null | { file, bytes (Uint8Array), info (from inspectTiff) }
 * useEmbedded : bool  — only meaningful when image.info.hasEmbeddedIcc
 * srcProfile  : null | { file, bytes, info (from inspectProfile) }
 * dstProfile  : null | { file, bytes, info (from inspectProfile) }
 * srcIntent   : 0..3  (default 1 = Relative Colorimetric)
 * dstIntent   : 0..3
 * result      : null | { dstTiffBytes (Uint8Array), previewRgba (Uint8ClampedArray),
 *                        width, height, dstChannels, dstSpace, softProofed, ... }
 * busy        : bool  — processing in flight
 *
 * Validation (derived in render):
 *   - image must be CMYK (v1 gate)
 *   - srcProfile (either supplied or embedded) must exist and dataSpace must match image
 *   - srcProfile can be a DeviceLink → dstProfile becomes ghost, intents disabled
 *   - otherwise dstProfile must exist
 */

export default function App() {
  const [image,       setImage]       = useState(null)
  const [useEmbedded, setUseEmbedded] = useState(true)
  const [srcProfile,  setSrcProfile]  = useState(null)
  const [dstProfile,  setDstProfile]  = useState(null)
  const [srcIntent,   setSrcIntent]   = useState(1)
  const [dstIntent,   setDstIntent]   = useState(1)
  const [result,      setResult]      = useState(null)
  const [busy,        setBusy]        = useState(false)
  const [topError,    setTopError]    = useState(null)

  useEffect(() => { preloadFlow() }, [])

  // ── Drop handlers ─────────────────────────────────────────────────────

  const handleImageFile = useCallback(async (file) => {
    setResult(null); setTopError(null)
    if (!file) { setImage(null); return }
    if (file.size > MAX_TIFF_BYTES) {
      setTopError(`Image: file is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${MAX_TIFF_BYTES / 1024 / 1024} MB.`)
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const info = await inspectTiff(bytes)
      if (info.status !== 'ok') {
        setTopError(`Image: ${info.message}`); setImage(null); return
      }
      setImage({ file, bytes, info })
      setUseEmbedded(!!info.hasEmbeddedIcc)
    } catch (e) {
      setTopError(`Image: ${e.message || String(e)}`); setImage(null)
    }
  }, [])

  const handleSrcFile = useCallback(async (file) => {
    setResult(null); setTopError(null)
    if (!file) { setSrcProfile(null); return }
    if (file.size > MAX_ICC_BYTES) {
      setTopError(`Source profile: file is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${MAX_ICC_BYTES / 1024 / 1024} MB.`)
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const info = await inspectProfile(bytes)
      if (info.status !== 'ok') {
        setTopError(`Source profile: ${info.message}`); setSrcProfile(null); return
      }
      setSrcProfile({ file, bytes, info })
    } catch (e) {
      setTopError(`Source profile: ${e.message || String(e)}`); setSrcProfile(null)
    }
  }, [])

  const handleDstFile = useCallback(async (file) => {
    setResult(null); setTopError(null)
    if (!file) { setDstProfile(null); return }
    if (file.size > MAX_ICC_BYTES) {
      setTopError(`Destination profile: file is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${MAX_ICC_BYTES / 1024 / 1024} MB.`)
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const info = await inspectProfile(bytes)
      if (info.status !== 'ok') {
        setTopError(`Destination profile: ${info.message}`); setDstProfile(null); return
      }
      setDstProfile({ file, bytes, info })
    } catch (e) {
      setTopError(`Destination profile: ${e.message || String(e)}`); setDstProfile(null)
    }
  }, [])

  // ── Derived validation ────────────────────────────────────────────────

  const activeSrcInfo = useMemo(() => {
    if (useEmbedded && image?.info?.hasEmbeddedIcc) return image.info.embedded
    return srcProfile?.info ?? null
  }, [useEmbedded, image, srcProfile])

  const srcIsDeviceLink = !!activeSrcInfo?.isDeviceLink

  const validation = useMemo(() => {
    if (!image) return { ok: false, reason: 'Drop a source image to begin.' }
    if (image.info.colorSpace !== 'CMYK') {
      return { ok: false, reason: `v1 supports CMYK images only — this one is ${image.info.colorSpace}.` }
    }
    if (!activeSrcInfo) {
      return { ok: false, reason: useEmbedded
        ? 'Image has no embedded profile — drop a source profile or uncheck "use embedded".'
        : 'Drop a source ICC profile.' }
    }
    if (activeSrcInfo.dataSpace !== image.info.colorSpace) {
      return {
        ok: false,
        reason: `Source profile's colorant space is ${activeSrcInfo.dataSpace}, but image is ${image.info.colorSpace}. Pick a matching profile.`,
      }
    }
    if (!srcIsDeviceLink && !dstProfile) {
      return { ok: false, reason: 'Drop a destination ICC profile.' }
    }
    return { ok: true }
  }, [image, activeSrcInfo, useEmbedded, srcIsDeviceLink, dstProfile])

  // ── Process ───────────────────────────────────────────────────────────

  const handleProcess = useCallback(async () => {
    if (!validation.ok) return
    setBusy(true); setTopError(null); setResult(null)
    try {
      // Empty Uint8Array tells wasm to use the embedded profile from the image.
      const srcBytes = (useEmbedded && image.info.hasEmbeddedIcc)
        ? new Uint8Array(0)
        : srcProfile.bytes
      const dstBytes = srcIsDeviceLink ? new Uint8Array(0) : dstProfile.bytes

      const r = await applyFlow(image.bytes, srcBytes, dstBytes, srcIntent, dstIntent)
      if (r.status !== 'ok') {
        setTopError(r.message || 'Processing failed')
        return
      }
      setResult(r)
    } catch (e) {
      setTopError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [validation, useEmbedded, image, srcProfile, dstProfile, srcIntent, dstIntent, srcIsDeviceLink])

  const handleSave = useCallback((r, srcFilename) => {
    const blob = new Blob([r.dstTiffBytes], { type: 'image/tiff' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stem = (srcFilename || 'image').replace(/\.(tiff?|icc|icm)$/i, '')
    // Strip anything other than filename-safe characters. Browsers already
    // sanitize `a.download`, but belt-and-braces: ensures tidy output names
    // when users drop files with spaces / slashes / HTML-ish characters,
    // and stays correct if a future browser loosens its sanitizer.
    const safe = stem.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'image'
    a.download = `${safe}-flowed.tif`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }, [])

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <span className={styles.logo}>International Color Consortium</span>
        <span className={styles.subtitle}>Profile Flow</span>
      </header>

      <div className={styles.banner}>
        Drop a CMYK TIFF plus a source and destination ICC profile.{' '}
        <strong>iccflow</strong> applies the profile chain via the{' '}
        <a href="https://github.com/InternationalColorConsortium/iccDEV" target="_blank" rel="noreferrer">iccDEV</a>{' '}
        reference CMM and soft-proofs the result through sRGB so you can see it.
      </div>

      <main className={styles.main}>
        {topError && (
          <div className={styles.errorBanner}>
            <strong>Error:</strong> {topError}
          </div>
        )}
        {!topError && !validation.ok && (
          <div className={styles.infoBanner}>{validation.reason}</div>
        )}

        <div className={styles.columns}>
          <SourceImagePanel
            image={image}
            useEmbedded={useEmbedded}
            onUseEmbeddedChange={setUseEmbedded}
            onFile={handleImageFile}
            busy={busy}
          />
          <ProfileStackPanel
            useEmbedded={useEmbedded}
            hasEmbedded={!!image?.info?.hasEmbeddedIcc}
            srcProfile={srcProfile}
            dstProfile={dstProfile}
            srcIntent={srcIntent}
            dstIntent={dstIntent}
            onSrcFile={handleSrcFile}
            onDstFile={handleDstFile}
            onSrcIntentChange={setSrcIntent}
            onDstIntentChange={setDstIntent}
            srcIsDeviceLink={srcIsDeviceLink}
            busy={busy}
          />
          <OutputImagePanel
            result={result}
            onSave={handleSave}
            busy={busy}
            srcFilename={image?.file?.name}
          />
        </div>

        <div className={styles.runRow}>
          <button
            type="button"
            className="btn-primary"
            onClick={handleProcess}
            disabled={!validation.ok || busy}
          >
            {busy ? 'Processing…' : 'Process'}
          </button>
          {busy && <span className={styles.busyHint}>applying CMM pipeline…</span>}
        </div>
      </main>

      <footer className={styles.footer}>
        ICC Profile Flow · powered by IccProfLib + libtiff
      </footer>
    </div>
  )
}

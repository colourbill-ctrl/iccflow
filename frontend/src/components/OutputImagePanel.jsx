import { useEffect, useRef } from 'react'
import styles from './Panel.module.css'

/**
 * Right column: renders the soft-proofed RGBA preview on a canvas and
 * offers a Save button that downloads the raw (pre-soft-proof) destination
 * TIFF bytes.
 */
export default function OutputImagePanel({ result, onSave, busy, srcFilename }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (!result || !canvasRef.current) return
    const { width, height, previewRgba } = result
    const canvas = canvasRef.current

    const maxW = 300, maxH = 240
    const s = Math.min(maxW / width, maxH / height, 1)
    canvas.width = Math.max(1, Math.round(width * s))
    canvas.height = Math.max(1, Math.round(height * s))
    const ctx = canvas.getContext('2d')

    // Draw the full-resolution preview into an offscreen canvas, then
    // scale via drawImage. ImageData has to match the target canvas
    // size exactly, so we can't putImageData directly at a smaller size.
    const off = document.createElement('canvas')
    off.width = width
    off.height = height
    const offCtx = off.getContext('2d')
    const imageData = new ImageData(previewRgba, width, height)
    offCtx.putImageData(imageData, 0, 0)

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height)
  }, [result])

  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>Output Image</header>

      {!result ? (
        <div className={styles.outputPlaceholder}>
          <div className={styles.icon}>📤</div>
          <p>Destination image will appear here after processing.</p>
          <p className={styles.muted}>
            CMYK destinations are soft-proofed through sRGB so your browser
            can display them. The saved TIFF contains the raw destination
            pixels (not the preview).
          </p>
        </div>
      ) : (
        <>
          <div className={styles.imageHolder}>
            <canvas ref={canvasRef} className={styles.thumb} />
          </div>
          <dl className={styles.meta}>
            <dt>Dimensions</dt>
            <dd className={styles.mono}>{result.width} × {result.height}</dd>
            <dt>Destination space</dt>
            <dd>
              <strong>{result.dstSpace}</strong>{' '}
              <span className={styles.muted}>{result.dstChannels}-channel</span>
            </dd>
            <dt>Preview</dt>
            <dd>
              {result.softProofed
                ? <span className={styles.muted}>soft-proofed via sRGB</span>
                : <span className={styles.muted}>direct (RGB/Gray destination)</span>}
            </dd>
            <dt>TIFF size</dt>
            <dd className={styles.mono}>{formatBytes(result.dstTiffBytes.length)}</dd>
          </dl>
          <button
            type="button"
            className="btn-primary"
            onClick={() => onSave(result, srcFilename)}
            disabled={busy}
          >
            Save TIFF…
          </button>
        </>
      )}
    </section>
  )
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

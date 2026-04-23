import { useEffect, useRef } from 'react'
import DropZone from './DropZone.jsx'
import styles from './Panel.module.css'

/**
 * Left column: source image drop + preview + metadata read-outs.
 *
 * For the preview we only show the pixel *shape* — a placeholder canvas
 * — because a browser canvas can't display CMYK. Users are meant to look
 * at the output panel (which soft-proofs to sRGB). The thumbnail here is
 * a scaled rendering of the raw channel 0 ("K" if PHOTOMETRIC_SEPARATED)
 * just to confirm something was loaded.
 */
export default function SourceImagePanel({
  image,                 // { file, bytes, info } | null
  useEmbedded,
  onUseEmbeddedChange,
  onFile,
  busy,
}) {
  const canvasRef = useRef(null)
  const hasEmbedded = image?.info?.hasEmbeddedIcc

  // Show a rough monochrome thumbnail so the user can verify the file.
  // We draw channel 0 (K for CMYK) downscaled onto a 240px canvas.
  useEffect(() => {
    if (!image || !canvasRef.current) return
    drawRawThumbnail(canvasRef.current, image)
  }, [image])

  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>Source Image</header>

      {!image && (
        <DropZone
          onFile={onFile}
          disabled={busy}
          accept=".tif,.tiff"
          headline="Drop a CMYK TIFF here"
          buttonLabel="Select TIFF…"
          hint=".tif and .tiff files · 8-bit CMYK"
          icon="🖼️"
        />
      )}

      {image && (
        <>
          <div className={styles.imageHolder}>
            <canvas ref={canvasRef} className={styles.thumb} />
          </div>
          <dl className={styles.meta}>
            <dt>File</dt>
            <dd className={styles.mono} title={image.file.name}>{image.file.name}</dd>
            <dt>Dimensions</dt>
            <dd className={styles.mono}>
              {image.info.width} × {image.info.height}, {image.info.channels} ch · {image.info.bitsPerSample}-bit
            </dd>
            <dt>Color space</dt>
            <dd>
              <strong>{image.info.colorSpace}</strong>{' '}
              <span className={styles.muted}>({image.info.photometricName})</span>
            </dd>
            <dt>Embedded ICC</dt>
            <dd>
              {hasEmbedded ? (
                <span className={styles.badgeYes}>
                  ✓ {image.info.embedded?.description || 'present'}
                </span>
              ) : (
                <span className={styles.badgeNo}>— none —</span>
              )}
            </dd>
          </dl>

          {hasEmbedded && (
            <label className={styles.embeddedToggle}>
              <input
                type="checkbox"
                checked={useEmbedded}
                onChange={(e) => onUseEmbeddedChange(e.target.checked)}
                disabled={busy}
              />
              <span>Use embedded ICC profile as source</span>
            </label>
          )}

          <button
            type="button"
            className={styles.replaceBtn}
            onClick={() => onFile(null)}
            disabled={busy}
          >
            Replace image…
          </button>
        </>
      )}
    </section>
  )
}

// Draw the first channel of the raw TIFF pixel bytes to a small canvas as a
// quick confirmation that the file loaded. We don't re-decode the TIFF — the
// wasm side already did that when building `info`; we skip a second decode
// by just reading `info.width/height/channels` and using the first channel.
// For this v1 we render a grey placeholder with the image dimensions instead,
// because a raw-channel draw requires passing pixels back from wasm (which
// applyFlow does, but inspectTiff doesn't). If you want a real thumbnail,
// inspect the output panel after a Process run.
function drawRawThumbnail(canvas, image) {
  const { width, height } = image.info
  const maxW = 240, maxH = 180
  const s = Math.min(maxW / width, maxH / height, 1)
  const cw = Math.max(1, Math.round(width * s))
  const ch = Math.max(1, Math.round(height * s))
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  // diagonal stripe placeholder — the output panel shows the real preview
  const g = ctx.createLinearGradient(0, 0, cw, ch)
  g.addColorStop(0, '#E0E3E5')
  g.addColorStop(1, '#CACED1')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, cw, ch)
  ctx.fillStyle = '#555'
  ctx.font = '11px Verdana, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${width} × ${height} · ${image.info.colorSpace}`, cw / 2, ch / 2)
}

import { useRef, useState } from 'react'
import styles from './DropZone.module.css'

/**
 * Generic drop zone. Accepts props so the same component can host
 * image-vs-profile drops across iccflow's three panels:
 *   accept        — file-picker accept string (e.g. ".icc,.icm" or ".tif,.tiff")
 *   headline      — "Drop an ICC profile here" / "Drop a CMYK TIFF here"
 *   buttonLabel   — "Select ICC profile…"
 *   hint          — secondary text below the button
 *   icon          — emoji / glyph (optional)
 *   variant       — 'default' | 'compact' | 'ghost' (disabled look, not blocking)
 */
export default function DropZone({
  onFile,
  disabled,
  accept = '.icc,.icm',
  headline = 'Drop a file here',
  buttonLabel = 'Select file…',
  hint,
  icon = '📄',
  variant = 'default',
}) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  function handleDragOver(e) {
    e.preventDefault()
    if (!disabled) setDragging(true)
  }
  function handleDragLeave() { setDragging(false) }
  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }
  function handleChange(e) {
    const file = e.target.files[0]
    if (file) onFile(file)
    e.target.value = ''
  }

  const classes = [
    styles.zone,
    dragging ? styles.dragging : '',
    disabled ? styles.disabled : '',
    variant === 'compact' ? styles.compact : '',
    variant === 'ghost' ? styles.ghost : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={classes}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label={headline}
    >
      {icon && <div className={styles.icon}>{icon}</div>}
      <p className={styles.headline}>{headline}</p>
      {!disabled && <p className={styles.sub}>or</p>}
      <button
        className="btn-primary"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        type="button"
      >
        {buttonLabel}
      </button>
      {hint && <p className={styles.hint}>{hint}</p>}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className={styles.hidden}
        onChange={handleChange}
        disabled={disabled}
      />
    </div>
  )
}

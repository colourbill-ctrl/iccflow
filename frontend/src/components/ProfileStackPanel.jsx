import DropZone from './DropZone.jsx'
import styles from './Panel.module.css'

const INTENTS = [
  { value: 0, label: 'Perceptual' },
  { value: 1, label: 'Relative Colorimetric' },
  { value: 2, label: 'Saturation' },
  { value: 3, label: 'Absolute Colorimetric' },
]

/**
 * Middle column: stacked source + destination profile slots, with rendering
 * intent for each. Handles three distinct states per slot:
 *
 *   - ghost         : greyed out, not actively used (e.g. "use embedded"
 *                     mode → source slot is ghost; DeviceLink source →
 *                     destination slot is ghost)
 *   - empty         : ready for drop
 *   - loaded        : filled with filename + metadata
 */
export default function ProfileStackPanel({
  useEmbedded,
  hasEmbedded,
  srcProfile,
  dstProfile,
  srcIntent,
  dstIntent,
  onSrcFile,
  onDstFile,
  onSrcIntentChange,
  onDstIntentChange,
  srcIsDeviceLink,
  busy,
}) {
  const srcGhost = useEmbedded && hasEmbedded
  const dstGhost = srcIsDeviceLink

  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>ICC Profile Chain</header>

      <ProfileSlot
        title="Source profile"
        profile={srcProfile}
        onFile={onSrcFile}
        ghostReason={srcGhost ? 'Using embedded profile from image' : null}
        busy={busy}
      />
      <IntentSelect
        label="Source intent"
        value={srcIntent}
        disabled={busy || srcGhost || srcIsDeviceLink}
        onChange={onSrcIntentChange}
      />

      <div className={styles.stackDivider}>↓</div>

      <ProfileSlot
        title="Destination profile"
        profile={dstProfile}
        onFile={onDstFile}
        ghostReason={dstGhost ? 'Source is a DeviceLink — destination is baked in' : null}
        busy={busy}
      />
      <IntentSelect
        label="Destination intent"
        value={dstIntent}
        disabled={busy || dstGhost}
        onChange={onDstIntentChange}
      />
    </section>
  )
}

function ProfileSlot({ title, profile, onFile, ghostReason, busy }) {
  return (
    <div className={styles.profileSlot}>
      <div className={styles.profileSlotTitle}>{title}</div>
      {ghostReason ? (
        <div className={styles.ghostNote}>
          <DropZone
            onFile={() => {}}
            disabled
            variant="ghost"
            headline={ghostReason}
            buttonLabel="—"
            icon="👻"
          />
        </div>
      ) : !profile ? (
        <DropZone
          onFile={onFile}
          disabled={busy}
          accept=".icc,.icm"
          headline="Drop an ICC profile"
          buttonLabel="Select profile…"
          variant="compact"
          icon="🎨"
        />
      ) : (
        <div className={styles.profileCard}>
          <div className={styles.profileName} title={profile.file.name}>
            {profile.file.name}
          </div>
          <div className={styles.profileMeta}>
            <strong>{profile.info.dataSpace}</strong>{' '}
            <span className={styles.muted}>({profile.info.deviceClassName})</span>
            {profile.info.description && (
              // description is pulled from the user-supplied ICC profile's
              // tag content — untrusted. Safe via JSX string escaping; do
              // NOT swap to dangerouslySetInnerHTML here.
              <div className={styles.profileDesc}>{profile.info.description}</div>
            )}
          </div>
          <button
            type="button"
            className={styles.replaceInlineBtn}
            onClick={() => onFile(null)}
            disabled={busy}
          >
            Replace
          </button>
        </div>
      )}
    </div>
  )
}

function IntentSelect({ label, value, disabled, onChange }) {
  return (
    <label className={`${styles.intentRow} ${disabled ? styles.intentDisabled : ''}`}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
      >
        {INTENTS.map((i) => (
          <option key={i.value} value={i.value}>{i.label}</option>
        ))}
      </select>
    </label>
  )
}

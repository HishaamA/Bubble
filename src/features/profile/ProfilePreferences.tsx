import { useEffect, useRef, useState } from 'react'
import {
  readProfilePreferences,
  updateProfilePreferences,
  type ProfilePreferences as SavedPreferences,
  type ProfilePreferencesPatch,
} from '../../services/persistence'
import {
  beginWidgetPrivacyChange,
  confirmWidgetPrivacyChange,
  readPendingWidgetOptOut,
  writeWidgetPrivacy,
} from '../widgets/widgetStorage'

type PreferenceField = keyof ProfilePreferencesPatch

const preferences = [
  { field: 'notificationsEnabled', id: 'family-notifications', label: 'Family updates', description: 'New moments, plans, and messages', initial: true },
  { field: 'quietHoursEnabled', id: 'quiet-hours', label: 'Quiet evenings', description: 'Pause non-urgent updates from 10 PM to 8 AM', initial: true },
  { field: 'widgetPreviewsEnabled', id: 'widget-previews', label: 'Widget previews', description: 'Show task names and family photos on your Home Screen.', initial: false },
] satisfies Array<{ field: PreferenceField; id: string; label: string; description: string; initial: boolean }>

/** Keeps each switch responsive while saving its latest choice in order. */
function PreferenceToggle({
  preference,
  initialValue,
  widgetStorageSubject,
  userId,
}: {
  preference: typeof preferences[number]
  initialValue?: boolean
  widgetStorageSubject: string
  userId: string | null
}) {
  const { field, id, label, description, initial } = preference
  const [localOptOut, setLocalOptOut] = useState(() => (
    field === 'widgetPreviewsEnabled' && readPendingWidgetOptOut(widgetStorageSubject) !== null
  ))
  const hydratedValue = localOptOut ? false : initialValue
  const [checked, setChecked] = useState(initialValue ?? initial)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(localOptOut
    ? 'Widget previews are hidden on this phone until your choice syncs.'
    : '')
  // undefined follows initial hydration; null waits for an explicit opt-in.
  const [widgetPrivacy, setWidgetPrivacy] = useState<boolean | null | undefined>(undefined)
  const active = useRef(false)
  const state = useRef({
    desired: hydratedValue ?? initial,
    confirmed: hydratedValue ?? initial,
    touched: false,
    saved: false,
    pending: false,
    privacyToken: null as string | null,
  })

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  useEffect(() => {
    if (hydratedValue === undefined) return
    // A slow initial read must never undo a choice made after opening Settings.
    if (!state.current.saved) state.current.confirmed = hydratedValue
    if (!state.current.touched) {
      state.current.desired = hydratedValue
    }
  }, [hydratedValue])

  useEffect(() => {
    const privacy = widgetPrivacy === undefined ? hydratedValue : widgetPrivacy
    if (field !== 'widgetPreviewsEnabled' || privacy == null || !userId) return
    writeWidgetPrivacy(widgetStorageSubject, privacy ? 'full' : 'hidden')
  }, [field, hydratedValue, userId, widgetPrivacy, widgetStorageSubject])

  async function saveLatestChoice() {
    if (state.current.pending) return
    state.current.pending = true
    setSaving(true)
    try {
      // Navigation may unmount the row while a newer choice is queued. Finish
      // that bounded queue with its original account; the service rejects a
      // changed session before any write, and never targets a new account.
      while (userId) {
        const requested = state.current.desired
        try {
          const saved = await updateProfilePreferences({ [field]: requested }, { expectedSubject: userId })
          state.current.confirmed = saved[field]
          state.current.saved = true
          if (state.current.desired !== requested) continue
          let confirmed = saved[field]
          if (field === 'widgetPreviewsEnabled') {
            const applied = confirmWidgetPrivacyChange(
              widgetStorageSubject, confirmed ? 'full' : 'hidden', state.current.privacyToken,
            )
            if (!applied) confirmed = false
          }
          state.current.desired = confirmed
          if (active.current) {
            setChecked(confirmed)
            if (field === 'widgetPreviewsEnabled') {
              setLocalOptOut(readPendingWidgetOptOut(widgetStorageSubject) !== null)
              setWidgetPrivacy(confirmed)
            }
          }
          return
        } catch {
          // The user may have changed their mind while this request failed.
          if (state.current.desired !== requested) continue
          if (!active.current) return
          if (field === 'widgetPreviewsEnabled' && !requested) {
            // Privacy opt-out fails closed even if the remote save is offline.
            setChecked(false)
            setWidgetPrivacy(false)
            setError('Widget previews are hidden on this phone, but the setting could not be synced.')
            return
          }
          const restored = field === 'widgetPreviewsEnabled' && readPendingWidgetOptOut(widgetStorageSubject) !== null
            ? false
            : state.current.confirmed
          state.current.desired = restored
          setChecked(restored)
          setError(`${label} could not be saved.`)
          return
        }
      }
    } finally {
      state.current.pending = false
      if (active.current) setSaving(false)
    }
  }

  function toggle() {
    const next = !state.current.desired
    state.current.desired = next
    state.current.touched = true
    setTouched(true)
    setChecked(next)
    setError('')
    if (field === 'widgetPreviewsEnabled') {
      // Hide immediately on opt-out. An in-flight, older opt-in must not reveal
      // details again; only confirmation of the latest opt-in can do that.
      setWidgetPrivacy(next ? null : false)
      state.current.privacyToken = beginWidgetPrivacyChange(widgetStorageSubject, next ? 'full' : 'hidden')
      setLocalOptOut(readPendingWidgetOptOut(widgetStorageSubject) !== null)
    }
    void saveLatestChoice()
  }

  const displayedChecked = touched ? checked : hydratedValue ?? checked

  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong id={`${id}-label`}>{label}</strong>
        <span id={`${id}-description`}>{description}</span>
        {error ? <p className="profile-page__preference-error" role="status">{error}</p> : null}
      </div>
      <button
        className="ks-toggle"
        type="button"
        role="switch"
        aria-checked={displayedChecked}
        aria-busy={saving}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={!userId}
        onClick={toggle}
      >
        <span className="screen-reader-only">{displayedChecked ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}

/** Isolates preference updates from the profile, family panel, and page artwork. */
export function ProfilePreferences({ userId, widgetStorageSubject }: {
  userId: string | null
  widgetStorageSubject: string
}) {
  const [initialPreferences, setInitialPreferences] = useState<SavedPreferences | null>(null)
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    let active = true
    if (!userId) return
    void readProfilePreferences().then((value) => {
      if (active) setInitialPreferences(value)
    }).catch(() => {
      if (active) setLoadError('Preferences could not be synced right now.')
    })
    return () => { active = false }
  }, [userId])

  return (
    <section className="ks-section" aria-labelledby="preferences-title">
      <div className="ks-section__heading"><h2 id="preferences-title">Preferences</h2></div>
      <div className="ks-card settings-card">
        {preferences.map((preference) => (
          <PreferenceToggle
            key={`${preference.field}:${widgetStorageSubject}`}
            preference={preference}
            initialValue={initialPreferences?.[preference.field]}
            widgetStorageSubject={widgetStorageSubject}
            userId={userId}
          />
        ))}
      </div>
      {loadError ? <p className="profile-page__preference-error" role="status">{loadError}</p> : null}
    </section>
  )
}

import { useEffect, useState } from 'react'
import {
  readProfilePreferences,
  type ProfilePreferences as SavedPreferences,
  type ProfilePreferencesPatch,
} from '../../services/persistence'
import { usePreferenceChoice } from './usePreferenceChoice'

type PreferenceField = keyof ProfilePreferencesPatch

const preferences = [
  { field: 'notificationsEnabled', id: 'family-notifications', label: 'Family updates', description: 'New moments, plans, and messages', initial: true },
  { field: 'quietHoursEnabled', id: 'quiet-hours', label: 'Quiet evenings', description: 'Pause non-urgent updates from 10 PM to 8 AM', initial: true },
  { field: 'widgetPreviewsEnabled', id: 'widget-previews', label: 'Widget previews', description: 'Show task names and family photos on your Home Screen.', initial: false },
] satisfies Array<{ field: PreferenceField; id: string; label: string; description: string; initial: boolean }>

/** Presents a controlled switch; its scoped hook owns saving and privacy. */
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
  const { id, label, description } = preference
  const { checked: displayedChecked, saving, error, toggle } = usePreferenceChoice({
    preference,
    initialValue,
    widgetStorageSubject,
    userId,
  })

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
  const [loadedPreferences, setLoadedPreferences] = useState<{
    userId: string
    value: SavedPreferences
  } | null>(null)
  const [failedUserId, setFailedUserId] = useState<string | null>(null)
  const initialPreferences = loadedPreferences?.userId === userId
    ? loadedPreferences.value
    : null
  const loadError = failedUserId !== null && failedUserId === userId
    ? 'Preferences could not be synced right now.'
    : ''

  useEffect(() => {
    let active = true
    if (!userId) return
    const requestedUserId = userId
    void readProfilePreferences().then((value) => {
      if (!active) return
      setLoadedPreferences({ userId: requestedUserId, value })
      setFailedUserId(null)
    }).catch(() => {
      if (active) setFailedUserId(requestedUserId)
    })
    return () => { active = false }
  }, [userId])

  return (
    <section className="ks-section" aria-labelledby="preferences-title">
      <div className="ks-section__heading"><h2 id="preferences-title">Preferences</h2></div>
      <div className="ks-card settings-card">
        {preferences.map((preference) => (
          <PreferenceToggle
            key={`${preference.field}:${userId ?? 'signed-out'}:${widgetStorageSubject}`}
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

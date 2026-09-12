import { useEffect, useRef, useState } from 'react'
import {
  updateProfilePreferences,
  type ProfilePreferencesPatch,
} from '../../services/persistence'
import {
  beginWidgetPrivacyChange,
  confirmWidgetPrivacyChange,
  readPendingWidgetOptOut,
  writeWidgetPrivacy,
} from '../widgets/widgetStorage'

type PreferenceChoiceOptions = {
  preference: {
    field: keyof ProfilePreferencesPatch
    label: string
    initial: boolean
  }
  initialValue?: boolean
  widgetStorageSubject: string
  userId: string | null
}

type PreferenceChoice = {
  checked: boolean
  saving: boolean
  error: string
  toggle: () => void
}

/**
 * Owns one switch's latest-intent queue and fail-closed widget privacy.
 * Mount in a row keyed by field, account and family. An unmounted row finishes
 * its queue with the original account guard, never with a new row's identity.
 */
export function usePreferenceChoice({
  preference,
  initialValue,
  widgetStorageSubject,
  userId,
}: PreferenceChoiceOptions): PreferenceChoice {
  const { field, label, initial } = preference
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

  return { checked: displayedChecked, saving, error, toggle }
}

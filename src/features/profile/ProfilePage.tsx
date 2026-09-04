import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppWhimsy } from '../../app/AppWhimsy'
import {
  readProfilePreferences,
  updateProfilePreferences,
} from '../../services/persistence'
import { useAppTheme } from '../../theme/AppTheme'
import { useAuth } from '../auth'
import '../FeaturePages.css'
import { FamilySyncPanel, type FamilySyncSnapshot } from './family-sync'

type ToggleRowProps = {
  id: string
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
}

/** Renders an accessible settings switch with stable label relationships. */
function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: ToggleRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong id={`${id}-label`}>{label}</strong>
        <span id={`${id}-description`}>{description}</span>
      </div>
      <button
        className="ks-toggle"
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onClick={onChange}
      >
        <span className="screen-reader-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}

/** Reduces the full family snapshot to the copy shown in the settings row. */
function getFamilySummary(snapshot: FamilySyncSnapshot | null) {
  if (!snapshot) {
    return {
      title: 'Checking family group',
      detail: 'Loading your secure family details',
    }
  }

  if (snapshot?.kind === 'connected') {
    return {
      title: snapshot.circle.name,
      detail: `${snapshot.circle.memberCount} ${snapshot.circle.memberCount === 1 ? 'person' : 'people'} · ${snapshot.circle.role === 'owner' ? 'You created this group' : 'Family member'}`,
    }
  }

  if (snapshot?.kind === 'unjoined' && snapshot.pendingRequest) {
    return {
      title: 'Waiting for your family',
      detail: 'Your request still needs the owner’s approval',
    }
  }

  if (snapshot?.kind === 'local-only') {
    return {
      title: 'Family group',
      detail: 'Connect Bubble to create or join securely',
    }
  }

  return {
    title: 'Create or join a family',
    detail: 'Share a private code with the people you love',
  }
}

/** Renders account, family, appearance, and notification settings. */
export function SettingsPage() {
  const navigate = useNavigate()
  const { signOut, user } = useAuth()
  const { theme: selectedTheme, setTheme, themes } = useAppTheme()
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(true)
  const [savingPreference, setSavingPreference] = useState<
    'notifications' | 'quiet-hours' | null
  >(null)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const [showProfileSettings, setShowProfileSettings] = useState(false)
  const [showFamilySync, setShowFamilySync] = useState(false)
  // The compact settings row needs the same authoritative snapshot as the full
  // panel. Keep one panel mounted (but hidden) so it can resolve that identity once,
  // then preserve its forms and request state when the disclosure is toggled.
  const [familySnapshot, setFamilySnapshot] =
    useState<FamilySyncSnapshot | null>(null)
  const familySummary = getFamilySummary(familySnapshot)
  const displayName = user?.displayName || 'Family member'
  const profileInitial = displayName.slice(0, 1).toUpperCase()
  const accountIdentity = user?.email || user?.phone || 'Signed in'
  const userId = user?.id ?? null

  useEffect(() => {
    let requestActive = true
    if (!userId) return () => undefined

    void readProfilePreferences()
      .then((profilePreferences) => {
        if (!requestActive) return
        setNotificationsEnabled(profilePreferences.notificationsEnabled)
        setQuietHoursEnabled(profilePreferences.quietHoursEnabled)
        setPreferenceError(null)
      })
      .catch(() => {
        if (requestActive) {
          setPreferenceError('Preferences could not be synced right now.')
        }
      })

    return () => {
      requestActive = false
    }
  }, [userId])

  /** Optimistically toggles family updates and rolls back a failed save. */
  async function handleNotificationsChange() {
    const nextNotificationsEnabled = !notificationsEnabled
    setNotificationsEnabled(nextNotificationsEnabled)
    setPreferenceError(null)
    setSavingPreference('notifications')
    try {
      const savedPreferences = await updateProfilePreferences({
        notificationsEnabled: nextNotificationsEnabled,
      })
      setNotificationsEnabled(savedPreferences.notificationsEnabled)
    } catch {
      setNotificationsEnabled(!nextNotificationsEnabled)
      setPreferenceError('Family updates could not be saved.')
    } finally {
      setSavingPreference(null)
    }
  }

  /** Optimistically toggles quiet hours and restores the prior value on failure. */
  async function handleQuietHoursChange() {
    const nextQuietHoursEnabled = !quietHoursEnabled
    setQuietHoursEnabled(nextQuietHoursEnabled)
    setPreferenceError(null)
    setSavingPreference('quiet-hours')
    try {
      const savedPreferences = await updateProfilePreferences({
        quietHoursEnabled: nextQuietHoursEnabled,
      })
      setQuietHoursEnabled(savedPreferences.quietHoursEnabled)
    } catch {
      setQuietHoursEnabled(!nextQuietHoursEnabled)
      setPreferenceError('Quiet evenings could not be saved.')
    } finally {
      setSavingPreference(null)
    }
  }

  /** Completes sign-out before replacing the protected settings route. */
  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <section className="ks-feature profile-page" aria-labelledby="settings-title">
      <AppWhimsy page="settings" />
      <header className="ks-feature__header app-page-header">
        <div className="ks-feature__header-copy">
          <p className="eyebrow app-page-header__eyebrow">Our family</p>
          <h1 id="settings-title">Settings</h1>
          <p className="profile-page__identity app-page-header__subtitle">
            Profile, family, and preferences
          </p>
        </div>
        <div className="profile-card__avatar">
          {user?.imageUrl ? (
            <img src={user.imageUrl} alt={`${displayName} profile`} />
          ) : (
            <span aria-hidden="true">{profileInitial}</span>
          )}
        </div>
      </header>

      <section className="ks-section" aria-labelledby="profile-settings-title">
        <div className="ks-section__heading">
          <h2 id="profile-settings-title">Profile</h2>
        </div>
        <button
          className="profile-action-row"
          type="button"
          aria-label={
            showProfileSettings
              ? 'Close profile settings'
              : 'Manage profile settings'
          }
          aria-expanded={showProfileSettings}
          aria-controls="profile-account-panel"
          onClick={() =>
            setShowProfileSettings((wasProfileSettingsOpen) =>
              !wasProfileSettingsOpen
            )
          }
        >
          <span className="profile-account-mark" aria-hidden="true">
            {user?.imageUrl ? (
              <img src={user.imageUrl} alt="" />
            ) : (
              profileInitial
            )}
          </span>
          <span className="profile-family-copy">
            <strong>{displayName}</strong>
            <small>{accountIdentity}</small>
          </span>
          <span aria-hidden="true">{showProfileSettings ? '−' : '›'}</span>
        </button>
        {showProfileSettings ? (
          <div
            id="profile-account-panel"
            className="profile-account-details"
            role="region"
            aria-label="Profile details"
          >
            <dl>
              <div>
                <dt>Name</dt>
                <dd>{displayName}</dd>
              </div>
              {user?.email ? (
                <div>
                  <dt>Email</dt>
                  <dd>{user.email}</dd>
                </div>
              ) : null}
              {user?.phone ? (
                <div>
                  <dt>Phone</dt>
                  <dd>{user.phone}</dd>
                </div>
              ) : null}
              <div>
                <dt>Account</dt>
                <dd>Signed in</dd>
              </div>
            </dl>
            <p>Your profile details come from your secure sign-in account.</p>
          </div>
        ) : null}
      </section>

      <section className="ks-section" aria-labelledby="family-sharing-title">
        <div className="ks-section__heading">
          <h2 id="family-sharing-title">Family group</h2>
        </div>
        <button
          className="profile-action-row"
          type="button"
          aria-label={showFamilySync ? 'Close family sharing' : 'Manage family sharing'}
          aria-expanded={showFamilySync}
          aria-controls="profile-family-group-panel"
          onClick={() =>
            setShowFamilySync((wasFamilySyncOpen) => !wasFamilySyncOpen)
          }
        >
          <span className="profile-family-mark" aria-hidden="true">♥</span>
          <span className="profile-family-copy">
            <strong>{familySummary.title}</strong>
            <small>{familySummary.detail}</small>
          </span>
          <span aria-hidden="true">{showFamilySync ? '−' : '›'}</span>
        </button>
        <div id="profile-family-group-panel" hidden={!showFamilySync}>
          <FamilySyncPanel onSnapshotChange={setFamilySnapshot} />
        </div>
      </section>

      <section className="ks-section" aria-labelledby="appearance-title">
        <div className="ks-section__heading">
          <h2 id="appearance-title">Appearance</h2>
        </div>
        <fieldset className="theme-picker">
          <legend className="theme-picker__legend">Colour scheme</legend>
          <div
            className="theme-picker__options"
            role="radiogroup"
            aria-labelledby="appearance-title"
          >
            {themes.map((theme) => (
              <button
                key={theme.id}
                className="theme-option"
                type="button"
                role="radio"
                aria-checked={selectedTheme === theme.id}
                aria-label={`${theme.name}: ${theme.description}`}
                onClick={() => setTheme(theme.id)}
              >
                <span className="theme-option__swatches" aria-hidden="true">
                  {theme.swatches.map((swatch) => (
                    <span key={swatch} style={{ backgroundColor: swatch }} />
                  ))}
                </span>
                <strong>{theme.name}</strong>
                <small>{theme.description}</small>
              </button>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="ks-section" aria-labelledby="preferences-title">
        <div className="ks-section__heading">
          <h2 id="preferences-title">Preferences</h2>
        </div>
        <div className="ks-card settings-card">
          <ToggleRow
            id="family-notifications"
            label="Family updates"
            description="New moments, plans, and messages"
            checked={notificationsEnabled}
            disabled={savingPreference !== null}
            onChange={() => void handleNotificationsChange()}
          />
          <ToggleRow
            id="quiet-hours"
            label="Quiet evenings"
            description="Pause non-urgent updates from 10 PM to 8 AM"
            checked={quietHoursEnabled}
            disabled={savingPreference !== null}
            onChange={() => void handleQuietHoursChange()}
          />
        </div>
        {preferenceError ? (
          <p className="profile-page__preference-error" role="status">
            {preferenceError}
          </p>
        ) : null}
      </section>

      <button
        className="profile-page__sign-out"
        type="button"
        onClick={() => void handleSignOut()}
      >
        Sign out
      </button>
    </section>
  )
}

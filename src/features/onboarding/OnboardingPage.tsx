import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { getSafeReturnPath } from '../auth/returnPath'
import { useFamilyOnboarding } from './familyOnboardingContext'
import type { FamilyMembership } from './types'
import './OnboardingPage.css'

type FamilyChoice = 'create' | 'join'

const ONBOARDING_BLOCKED_ROUTES = ['/login', '/onboarding'] as const

/** Copies text on older web views and always removes its temporary control. */
function copyWithTemporaryTextarea(textToCopy: string) {
  const textarea = document.createElement('textarea')
  textarea.value = textToCopy
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try {
    return document.execCommand?.('copy') ?? false
  } finally {
    textarea.remove()
  }
}

/** Lets an authenticated person create or join their required family space. */
export function OnboardingPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signOut, user } = useAuth()
  const {
    createFamily,
    error,
    joinFamily,
    refresh,
    refreshing,
    snapshot,
    status,
  } = useFamilyOnboarding()
  const returnTo = getSafeReturnPath(
    (location.state as { returnTo?: unknown } | null)?.returnTo,
    ONBOARDING_BLOCKED_ROUTES,
  )
  const [choice, setChoice] = useState<FamilyChoice>('create')
  const [familyName, setFamilyName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [formError, setFormError] = useState('')
  const [creatingFamily, setCreatingFamily] = useState(false)
  const [createdFamily, setCreatedFamily] =
    useState<FamilyMembership | null>(null)
  const [shareStatus, setShareStatus] = useState('')
  const formPending = status === 'loading' || refreshing || creatingFamily
  const firstName = user?.displayName.split(' ')[0] || 'there'

  if (status === 'member' && !creatingFamily && !createdFamily) {
    return <Navigate to={returnTo} replace />
  }

  /** Runs the selected setup flow after applying choice-specific validation. */
  async function submitFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError('')
    setShareStatus('')

    if (choice === 'create') {
      const normalizedFamilyName = familyName.trim()
      if (normalizedFamilyName.length < 2) {
        setFormError('Give your family a name everyone will recognize.')
        return
      }

      setCreatingFamily(true)
      try {
        const familyResult = await createFamily(normalizedFamilyName)
        if (familyResult?.kind === 'member') {
          setCreatedFamily(familyResult.membership)
        }
      } catch {
        // The provider exposes a safe message beside the form.
      } finally {
        setCreatingFamily(false)
      }
      return
    }

    const normalizedInviteCode = inviteCode.trim().toUpperCase()
    if (normalizedInviteCode.length < 6) {
      setFormError('Enter the complete code your family shared with you.')
      return
    }

    try {
      const familyResult = await joinFamily(normalizedInviteCode)
      if (familyResult?.kind === 'member') {
        navigate(returnTo, { replace: true })
      }
    } catch {
      // The provider exposes a safe message beside the form.
    }
  }

  /** Shares the owner's persistent code, with a clipboard fallback for WebViews. */
  async function shareFamilyCode() {
    const familyCode = createdFamily?.shareCode
    if (!familyCode) return
    const shareText = `Join ${createdFamily.familyName} on Bubble with this private family code: ${familyCode}`

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'Join my family on Bubble',
          text: shareText,
        })
        setShareStatus('Family code shared.')
        return
      } catch (shareError) {
        if (
          shareError instanceof DOMException &&
          shareError.name === 'AbortError'
        ) {
          return
        }
      }
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(familyCode)
      } else if (!copyWithTemporaryTextarea(familyCode)) {
        throw new Error('copy_failed')
      }
      setShareStatus('Family code copied.')
    } catch {
      setShareStatus('Press and hold the code to copy it.')
    }
  }

  /** Signs out without allowing a rejected request to strand the onboarding UI. */
  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  if (status === 'idle' || (status === 'loading' && !creatingFamily)) {
    return (
      <section className="onboarding-loading" role="status">
        <span aria-hidden="true" />
        Finding your family
      </section>
    )
  }

  return (
    <section className="onboarding-page" aria-labelledby="onboarding-title">
      <div className="onboarding-page__aura" aria-hidden="true" />
      <header className="onboarding-header">
        <span className="onboarding-brand">Bubble</span>
        <button type="button" onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </header>

      <main className="onboarding-main">
        {createdFamily ? (
          <article className="onboarding-ready">
            <div className="onboarding-ready__mark" aria-hidden="true">
              <span>✓</span>
            </div>
            <p className="onboarding-eyebrow">Your family is ready</p>
            <h1 id="onboarding-title">
              {createdFamily.familyName} is on Bubble.
            </h1>
            <p className="onboarding-copy">
              Share this private code with the people you want to invite. It
              will always be available in Settings.
            </p>
            {createdFamily.shareCode ? (
              <output
                className="onboarding-ready__code"
                aria-label="Family share code"
              >
                {createdFamily.shareCode}
              </output>
            ) : (
              <p className="onboarding-family__notice" role="status">
                Your family was created. Open Settings to load its share code.
              </p>
            )}
            <div className="onboarding-ready__actions">
              {createdFamily.shareCode ? (
                <button
                  type="button"
                  className="onboarding-action onboarding-action--secondary"
                  onClick={() => void shareFamilyCode()}
                >
                  Share family code
                </button>
              ) : null}
              <button
                type="button"
                className="onboarding-action onboarding-action--primary"
                onClick={() => navigate(returnTo, { replace: true })}
              >
                Enter Bubble
              </button>
            </div>
            <p className="onboarding-ready__status" aria-live="polite">
              {shareStatus}
            </p>
          </article>
        ) : (
          <article className="onboarding-family">
            <div className="onboarding-family__intro">
            <p className="onboarding-eyebrow">Welcome, {firstName}</p>
              <h1 id="onboarding-title">Find your family.</h1>
              <span>
                Make a private family space, or enter the code someone shared
                with you.
              </span>
            </div>

            {status === 'pending' ? (
              <div className="onboarding-pending" role="status">
                <div>
                  <strong>Your request is waiting</strong>
                  <p>
                    {snapshot?.kind === 'pending' && snapshot.familyName
                      ? `${snapshot.familyName} still needs to approve it.`
                      : 'This older invite needs approval from the family owner.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={formPending}
                  onClick={() => void refresh()}
                >
                  {formPending ? 'Checking' : 'Check again'}
                </button>
              </div>
            ) : (
              <>
                <div
                  className="onboarding-family__choices"
                  role="group"
                  aria-label="Family setup choice"
                >
                  <button
                    type="button"
                    aria-pressed={choice === 'create'}
                    onClick={() => setChoice('create')}
                  >
                    <span aria-hidden="true">＋</span>
                    <strong>Create a family</strong>
                    <small>Start a private space for your people.</small>
                  </button>
                  <button
                    type="button"
                    aria-pressed={choice === 'join'}
                    onClick={() => setChoice('join')}
                  >
                    <span aria-hidden="true">⌁</span>
                    <strong>Join with a code</strong>
                    <small>Connect to a family that already exists.</small>
                  </button>
                </div>

                <form className="onboarding-family__form" onSubmit={submitFamily}>
                  {choice === 'create' ? (
                    <label>
                      <span>Family name</span>
                      <input
                        value={familyName}
                        onChange={(event) => setFamilyName(event.target.value)}
                        placeholder="The Ahmed family"
                        maxLength={80}
                        autoComplete="off"
                        enterKeyHint="go"
                        disabled={formPending || status === 'unavailable'}
                      />
                    </label>
                  ) : (
                    <label>
                      <span>Private family code</span>
                      <input
                        className="onboarding-family__code"
                        value={inviteCode}
                        onChange={(event) => setInviteCode(event.target.value)}
                        placeholder="BUB-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                        autoCapitalize="characters"
                        autoComplete="off"
                        enterKeyHint="go"
                        spellCheck={false}
                        disabled={formPending || status === 'unavailable'}
                      />
                    </label>
                  )}
                  <button
                    className="onboarding-family__submit"
                    type="submit"
                    disabled={formPending || status === 'unavailable'}
                  >
                    {formPending
                      ? 'Connecting'
                      : choice === 'create'
                        ? 'Create family'
                        : 'Join family'}
                  </button>
                </form>
              </>
            )}

            {status === 'unavailable' ? (
              <p className="onboarding-family__notice" role="status">
                Family setup is not connected in this build. Sign in again
                after the private database is configured.
              </p>
            ) : null}
            {formError || error ? (
              <p
                className="onboarding-family__notice onboarding-family__notice--error"
                role="alert"
              >
                {formError || error}
              </p>
            ) : null}
          </article>
        )}
      </main>
    </section>
  )
}

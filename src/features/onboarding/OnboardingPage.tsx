import { useMemo, useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { useFamilyOnboarding } from './FamilyOnboardingProvider'
import './OnboardingPage.css'

const slides = [
  {
    eyebrow: 'Moments',
    title: 'Feel close to the moments that matter.',
    description:
      'Move through a living space of family memories. Bring one close, then step inside its full 360° view.',
    mark: '◌',
  },
  {
    eyebrow: 'A small daily ritual',
    title: 'One honest moment. Shared together.',
    description:
      'At a gentle time each day, one person captures what life looks like right now. Everyone receives it at once.',
    mark: '◎',
  },
  {
    eyebrow: 'Capsule',
    title: 'A week of little moments, opened together.',
    description:
      'Add everyday photos to your family Capsule. At week’s end, they unlock as a quick recap, with separate Capsules for the occasions you never want to forget.',
    mark: '∞',
  },
] as const

type FamilyChoice = 'create' | 'join'

function safeReturnTo(value: unknown) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value !== '/login' &&
    value !== '/onboarding'
    ? value
    : '/'
}

export function OnboardingPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signOut, user } = useAuth()
  const {
    completeTutorial,
    createFamily,
    error,
    joinFamily,
    refresh,
    refreshing,
    snapshot,
    status,
  } = useFamilyOnboarding()
  const returnTo = safeReturnTo(
    (location.state as { returnTo?: unknown } | null)?.returnTo,
  )
  const [step, setStep] = useState<number | null>(null)
  const [choice, setChoice] = useState<FamilyChoice>('create')
  const [familyName, setFamilyName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [formError, setFormError] = useState('')
  const inferredStep =
    status === 'tutorial'
      ? 0
      : status === 'needs-family' ||
          status === 'pending' ||
          status === 'unavailable' ||
          status === 'error'
        ? slides.length
        : null
  const activeStep = step ?? inferredStep
  const resolvedStep = activeStep ?? 0
  const finalStep = resolvedStep === slides.length
  const slide = slides[Math.min(resolvedStep, slides.length - 1)]
  const busy = status === 'loading' || refreshing
  const displayName = user?.displayName.split(' ')[0] || 'there'

  const progressLabel = useMemo(
    () => `Step ${resolvedStep + 1} of ${slides.length + 1}`,
    [resolvedStep],
  )

  if (status === 'member') {
    return <Navigate to={returnTo} replace />
  }

  async function submitFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError('')
    try {
      if (choice === 'create') {
        const name = familyName.trim()
        if (name.length < 2) {
          setFormError('Give your family a name everyone will recognize.')
          return
        }
        await createFamily(name)
      } else {
        const code = inviteCode.trim().toUpperCase()
        if (code.length < 6) {
          setFormError('Enter the complete code your family shared with you.')
          return
        }
        await joinFamily(code)
      }
    } catch {
      // The provider exposes a safe message next to the form.
    }
  }

  async function continueTutorial() {
    if (resolvedStep < slides.length - 1) {
      setStep(resolvedStep + 1)
      return
    }

    setFormError('')
    try {
      const completed = await completeTutorial()
      if (completed) setStep(slides.length)
    } catch {
      // The provider exposes a safe durable-persistence error on this screen.
    }
  }

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  if (activeStep === null) {
    return (
      <section className="onboarding-loading" role="status">
        <span aria-hidden="true" />
        Preparing your family space…
      </section>
    )
  }

  return (
    <section className="onboarding-page" aria-labelledby="onboarding-title">
      <div className="onboarding-page__aura" aria-hidden="true" />
      <header className="onboarding-header">
        <div className="onboarding-brand" aria-label="Bubble">
          <span aria-hidden="true">K</span>
          Bubble
        </div>
        <button type="button" onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </header>

      <div className="onboarding-progress" aria-label={progressLabel}>
        {Array.from({ length: slides.length + 1 }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            data-active={index === resolvedStep ? 'true' : 'false'}
            data-complete={index < resolvedStep ? 'true' : 'false'}
          />
        ))}
      </div>

      {!finalStep ? (
        <article className="onboarding-story">
          <div className="onboarding-story__mark" aria-hidden="true">
            <span>{slide.mark}</span>
          </div>
          <div>
            <p>{slide.eyebrow}</p>
            <h1 id="onboarding-title">{slide.title}</h1>
            <p className="onboarding-story__description">{slide.description}</p>
          </div>
        </article>
      ) : (
        <article className="onboarding-family">
          <div className="onboarding-family__intro">
            <p>Welcome, {displayName}</p>
            <h1 id="onboarding-title">Who are you coming home to?</h1>
            <span>
              Create a new private family space, or join one with the code they
              sent you.
            </span>
          </div>

          {status === 'pending' ? (
            <div className="onboarding-pending" role="status">
              <span aria-hidden="true">⌛</span>
              <div>
                <strong>Waiting for your family</strong>
                <p>
                  {snapshot?.kind === 'pending' && snapshot.familyName
                    ? `${snapshot.familyName} needs to approve your request.`
                    : 'The family owner needs to approve your request.'}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {busy ? 'Checking…' : 'Check again'}
              </button>
            </div>
          ) : (
            <>
              <div className="onboarding-family__choices" role="group" aria-label="Family setup choice">
                <button
                  type="button"
                  aria-pressed={choice === 'create'}
                  onClick={() => setChoice('create')}
                >
                  <span aria-hidden="true">＋</span>
                  <strong>Create family</strong>
                  <small>Start a private space and invite your people.</small>
                </button>
                <button
                  type="button"
                  aria-pressed={choice === 'join'}
                  onClick={() => setChoice('join')}
                >
                  <span aria-hidden="true">⌁</span>
                  <strong>Join with code</strong>
                  <small>Enter the code a family owner shared with you.</small>
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
                      disabled={busy || status === 'unavailable'}
                    />
                  </label>
                ) : (
                  <label>
                    <span>Private family code</span>
                    <input
                      className="onboarding-family__code"
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value)}
                      placeholder="KS-••••••"
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy || status === 'unavailable'}
                    />
                  </label>
                )}
                <button
                  className="onboarding-family__submit"
                  type="submit"
                  disabled={busy || status === 'unavailable'}
                >
                  {busy
                    ? 'Connecting…'
                    : choice === 'create'
                      ? 'Create our family space'
                      : 'Ask to join family'}
                </button>
              </form>
            </>
          )}

          {status === 'unavailable' ? (
            <p className="onboarding-family__notice" role="status">
              Family setup is not connected in this build. Configure the
              durable family membership adapter to continue. Access remains
              locked until then.
            </p>
          ) : null}
          {formError || error ? (
            <p className="onboarding-family__notice onboarding-family__notice--error" role="alert">
              {formError || error}
            </p>
          ) : null}
        </article>
      )}

      <footer className="onboarding-footer">
        <button
          type="button"
          className="onboarding-footer__back"
          disabled={resolvedStep === 0 || busy}
          onClick={() => setStep(Math.max(0, resolvedStep - 1))}
        >
          Back
        </button>
        {!finalStep ? (
          <button
            type="button"
            className="onboarding-footer__next"
            disabled={busy}
            onClick={() => void continueTutorial()}
          >
            {busy ? 'Saving…' : 'Continue'}
            <span aria-hidden="true">→</span>
          </button>
        ) : null}
      </footer>
    </section>
  )
}

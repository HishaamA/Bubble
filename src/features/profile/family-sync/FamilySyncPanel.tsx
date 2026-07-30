import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  announceFamilySyncChange,
  familySyncAdapter,
  toFamilySyncErrorMessage,
} from './familySyncAdapter'
import type {
  CreatedCircleInvite,
  FamilySyncAdapter,
  FamilySyncSnapshot,
} from './types'
import './FamilySyncPanel.css'

type FamilySyncPanelProps = {
  adapter?: FamilySyncAdapter
}

type ChangeResult<T> =
  | { ok: true; value: T }
  | { ok: false; value?: never }

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Recently'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function LocalOnlyState() {
  return (
    <div className="family-sync__state family-sync__state--local">
      <span className="family-sync__state-icon" aria-hidden="true">∞</span>
      <div>
        <p className="family-sync__eyebrow">Local-only mode</p>
        <h3>Your moments stay on this device</h3>
        <p>
          Family Sync is not connected to a backend yet. Add the Supabase URL
          and publishable key to enable accounts, invitations, and family delivery.
        </p>
      </div>
    </div>
  )
}

export function FamilySyncPanel({
  adapter = familySyncAdapter,
}: FamilySyncPanelProps) {
  const headingId = useId()
  const messageId = useId()
  const loadVersion = useRef(0)
  const [snapshot, setSnapshot] = useState<FamilySyncSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [circleName, setCircleName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [generatedInvite, setGeneratedInvite] =
    useState<CreatedCircleInvite | null>(null)

  const refresh = useCallback(
    async (showLoading: boolean) => {
      const version = ++loadVersion.current
      if (showLoading) setLoading(true)
      try {
        const nextSnapshot = await adapter.loadSnapshot()
        if (version !== loadVersion.current) return
        setSnapshot(nextSnapshot)
        setGeneratedInvite((current) =>
          nextSnapshot.kind === 'connected' &&
          current?.circleId === nextSnapshot.circle.id
            ? current
            : null,
        )
        setError('')
      } catch (reason) {
        if (version !== loadVersion.current) return
        setError(toFamilySyncErrorMessage(reason))
      } finally {
        if (version === loadVersion.current) setLoading(false)
      }
    },
    [adapter],
  )

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refresh(false), 0)
    const unsubscribe = adapter.subscribeToAuthChanges?.(() => {
      void refresh(false)
    })
    return () => {
      window.clearTimeout(initialLoad)
      loadVersion.current += 1
      unsubscribe?.()
    }
  }, [adapter, refresh])

  async function runChange<T>(
    operation: () => Promise<T>,
    successMessage: string | ((value: T) => string),
  ): Promise<ChangeResult<T>> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const value = await operation()
      announceFamilySyncChange()
      await refresh(false)
      setMessage(
        typeof successMessage === 'function'
          ? successMessage(value)
          : successMessage,
      )
      return { ok: true, value }
    } catch (reason) {
      setError(toFamilySyncErrorMessage(reason))
      return { ok: false }
    } finally {
      setBusy(false)
    }
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (authMode === 'sign-up' && !displayName.trim()) {
      setError('Add the name your family will recognize.')
      return
    }

    const result =
      authMode === 'sign-in'
        ? await runChange(
            () => adapter.signIn(normalizedEmail, password),
            'You are signed in.',
          )
        : await runChange(
            () => adapter.signUp(normalizedEmail, password, displayName),
            ({ requiresEmailConfirmation }) =>
              requiresEmailConfirmation
                ? 'Check your email to confirm your account, then sign in.'
                : 'Your account is ready.',
          )

    if (result.ok) setPassword('')
  }

  async function handleCreateCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = circleName.trim()
    if (!name) {
      setError('Give your family circle a name.')
      return
    }
    const result = await runChange(
      () => adapter.createCircle(name),
      `${name} is ready for family members.`,
    )
    if (result.ok) setCircleName('')
  }

  async function handleJoinCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = inviteCode.trim()
    if (!/^ks1_[0-9a-f]{64}$/.test(code)) {
      setError('Enter the complete KinSphere invite code.')
      return
    }
    const result = await runChange(
      () => adapter.requestCircleJoin(code),
      'Your request was sent to the family circle owner.',
    )
    if (result.ok) setInviteCode('')
  }

  async function handleCreateInvite(circleId: string) {
    setBusy(true)
    setError('')
    setMessage('')
    setGeneratedInvite(null)
    try {
      const created = await adapter.createCircleInvite(circleId)
      setGeneratedInvite(created)
      setMessage('A one-use invite is ready. Share it privately.')
    } catch (reason) {
      setError(toFamilySyncErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function handleDecision(
    requestId: string,
    decision: 'approved' | 'rejected',
  ) {
    await runChange(
      () => adapter.decideJoinRequest(requestId, decision),
      decision === 'approved'
        ? 'The family member is now connected.'
        : 'The join request was declined.',
    )
  }

  const describedBy = error || message ? messageId : undefined

  return (
    <section
      className="family-sync"
      aria-labelledby={headingId}
      aria-describedby={describedBy}
      aria-busy={busy || loading}
    >
      <header className="family-sync__header">
        <div>
          <p className="family-sync__eyebrow">Private family space</p>
          <h2 id={headingId}>Family Sync</h2>
        </div>
        {snapshot?.kind === 'connected' ? (
          <span className="family-sync__connected-badge">
            <span aria-hidden="true" /> Connected
          </span>
        ) : null}
      </header>

      {error || message ? (
        <div
          id={messageId}
          className={`family-sync__notice${error ? ' family-sync__notice--error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error || message}
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="family-sync__loading" role="status">
          <span aria-hidden="true" /> Checking secure connection…
        </div>
      ) : null}

      {!loading && snapshot?.kind === 'local-only' ? <LocalOnlyState /> : null}

      {snapshot?.kind === 'signed-out' ? (
        <div className="family-sync__auth">
          <div className="family-sync__intro">
            <h3>Connect your family</h3>
            <p>
              Sign in to receive private 360° moments from your approved family
              circle.
            </p>
          </div>

          <div className="family-sync__segmented" aria-label="Account action">
            <button
              type="button"
              aria-pressed={authMode === 'sign-in'}
              onClick={() => {
                setAuthMode('sign-in')
                setError('')
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              aria-pressed={authMode === 'sign-up'}
              onClick={() => {
                setAuthMode('sign-up')
                setError('')
              }}
            >
              Create account
            </button>
          </div>

          <form className="family-sync__form" onSubmit={handleAuthSubmit}>
            {authMode === 'sign-up' ? (
              <label>
                <span>Your name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  maxLength={80}
                  required
                  disabled={busy}
                  placeholder="The name your family knows"
                />
              </label>
            ) : null}
            <label>
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
                disabled={busy}
                placeholder="you@example.com"
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={
                  authMode === 'sign-in' ? 'current-password' : 'new-password'
                }
                minLength={authMode === 'sign-up' ? 8 : undefined}
                required
                disabled={busy}
                placeholder="At least 8 characters"
              />
            </label>
            <button className="family-sync__primary" type="submit" disabled={busy}>
              {busy
                ? 'Connecting…'
                : authMode === 'sign-in'
                  ? 'Sign in securely'
                  : 'Create account'}
            </button>
          </form>
          <p className="family-sync__privacy-note">
            Membership is private. A circle owner must approve every new member.
          </p>
        </div>
      ) : null}

      {snapshot?.kind === 'unjoined' ? (
        <div className="family-sync__unjoined">
          <div className="family-sync__identity">
            <span aria-hidden="true">
              {snapshot.person.displayName.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{snapshot.person.displayName}</strong>
              <small>{snapshot.person.email}</small>
            </div>
          </div>

          {snapshot.pendingRequest ? (
            <div className="family-sync__pending-card">
              <span className="family-sync__pending-pulse" aria-hidden="true" />
              <div>
                <h3>Waiting for family approval</h3>
                <p>
                  Your request was sent {formatDate(snapshot.pendingRequest.createdAt)}.
                  Moments will sync after the circle owner approves you.
                </p>
              </div>
              <button
                className="family-sync__secondary"
                type="button"
                onClick={() => void refresh(false)}
                disabled={busy}
              >
                Check again
              </button>
            </div>
          ) : (
            <div className="family-sync__choice-grid">
              <form className="family-sync__option" onSubmit={handleCreateCircle}>
                <span className="family-sync__option-number" aria-hidden="true">01</span>
                <h3>Start a family circle</h3>
                <p>You become the owner and approve each person who joins.</p>
                <label>
                  <span>Circle name</span>
                  <input
                    value={circleName}
                    onChange={(event) => setCircleName(event.target.value)}
                    maxLength={80}
                    required
                    disabled={busy}
                    placeholder="Ahmed family"
                  />
                </label>
                <button className="family-sync__primary" type="submit" disabled={busy}>
                  Create circle
                </button>
              </form>

              <div className="family-sync__or" aria-hidden="true"><span>or</span></div>

              <form className="family-sync__option" onSubmit={handleJoinCircle}>
                <span className="family-sync__option-number" aria-hidden="true">02</span>
                <h3>Join your family</h3>
                <p>Paste the private, one-use code sent by your circle owner.</p>
                <label>
                  <span>Invite code</span>
                  <input
                    className="family-sync__code-input"
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    disabled={busy}
                    placeholder="ks1_…"
                  />
                </label>
                <button className="family-sync__primary" type="submit" disabled={busy}>
                  Request to join
                </button>
              </form>
            </div>
          )}

          <button
            className="family-sync__text-button"
            type="button"
            disabled={busy}
            onClick={() => void runChange(() => adapter.signOut(), 'Signed out.')}
          >
            Sign out of {snapshot.person.email}
          </button>
        </div>
      ) : null}

      {snapshot?.kind === 'connected' ? (
        <div className="family-sync__connected">
          <article className="family-sync__circle-card">
            <div className="family-sync__circle-mark" aria-hidden="true">∞</div>
            <div className="family-sync__circle-copy">
              <span>{snapshot.circle.role === 'owner' ? 'Your circle' : 'Connected circle'}</span>
              <h3>{snapshot.circle.name}</h3>
              <p>
                {snapshot.circle.memberCount}{' '}
                {snapshot.circle.memberCount === 1 ? 'member' : 'members'} ·{' '}
                {snapshot.circle.role === 'owner' ? 'Owner' : 'Member'}
              </p>
            </div>
            <div className="family-sync__mini-avatar" aria-label={`Signed in as ${snapshot.person.displayName}`}>
              {snapshot.person.displayName.slice(0, 1).toUpperCase()}
            </div>
          </article>

          {snapshot.circle.role === 'owner' ? (
            <section className="family-sync__owner-tools" aria-labelledby={`${headingId}-invite`}>
              <div className="family-sync__subheading">
                <div>
                  <h3 id={`${headingId}-invite`}>Invite a family member</h3>
                  <p>Each code works once and expires after 7 days.</p>
                </div>
                <button
                  className="family-sync__secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleCreateInvite(snapshot.circle.id)}
                >
                  {busy ? 'Creating…' : 'Create invite'}
                </button>
              </div>

              {generatedInvite ? (
                <div className="family-sync__invite" role="status">
                  <span>Private one-use code</span>
                  <output>{generatedInvite.code}</output>
                  <small>
                    Expires {formatDate(generatedInvite.expiresAt)}. Share it only
                    with the person you want to admit.
                  </small>
                </div>
              ) : null}
            </section>
          ) : (
            <p className="family-sync__member-note">
              Your circle owner manages invitations and new member approvals.
            </p>
          )}

          {snapshot.circle.role === 'owner' ? (
            <section className="family-sync__requests" aria-labelledby={`${headingId}-requests`}>
              <div className="family-sync__subheading">
                <div>
                  <h3 id={`${headingId}-requests`}>Join requests</h3>
                  <p>Approve only people you recognize.</p>
                </div>
                <span className="family-sync__count" aria-label={`${snapshot.pendingRequests.length} pending`}>
                  {snapshot.pendingRequests.length}
                </span>
              </div>

              {snapshot.pendingRequests.length ? (
                <ul>
                  {snapshot.pendingRequests.map((request) => (
                    <li key={request.id}>
                      <div>
                        <strong>Family member</strong>
                        <span>
                          Requested {formatDate(request.createdAt)} · ID{' '}
                          {request.requesterId.slice(0, 8)}
                        </span>
                      </div>
                      <div className="family-sync__decision-buttons">
                        <button
                          className="family-sync__reject"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDecision(request.id, 'rejected')}
                          aria-label={`Reject request from member ${request.requesterId.slice(0, 8)}`}
                        >
                          Reject
                        </button>
                        <button
                          className="family-sync__approve"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDecision(request.id, 'approved')}
                          aria-label={`Approve request from member ${request.requesterId.slice(0, 8)}`}
                        >
                          Approve
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="family-sync__empty-requests">
                  <span aria-hidden="true">✓</span>
                  <p>No one is waiting for approval.</p>
                </div>
              )}
            </section>
          ) : null}

          <div className="family-sync__account-row">
            <div>
              <strong>{snapshot.person.displayName}</strong>
              <span>{snapshot.person.email}</span>
            </div>
            <button
              className="family-sync__text-button"
              type="button"
              disabled={busy}
              onClick={() => void runChange(() => adapter.signOut(), 'Signed out.')}
            >
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

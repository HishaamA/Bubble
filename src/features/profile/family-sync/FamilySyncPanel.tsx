import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Link } from 'react-router-dom'
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
import {
  shareFamilyInvite,
  type ShareFamilyInvite,
} from './shareFamilyInvite'
import './FamilySyncPanel.css'

type FamilySyncPanelProps = {
  adapter?: FamilySyncAdapter
  onSnapshotChange?: (snapshot: FamilySyncSnapshot) => void
  shareInvite?: ShareFamilyInvite
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
      <div>
        <h3>Family groups need a connection</h3>
        <p>Connect KinSphere to securely create a group and share invite codes.</p>
        <Link
          className="family-sync__auth-link"
          to="/login"
          state={{ returnTo: '/profile' }}
        >
          Open secure sign-in
        </Link>
      </div>
    </div>
  )
}

export function FamilySyncPanel({
  adapter = familySyncAdapter,
  onSnapshotChange,
  shareInvite = shareFamilyInvite,
}: FamilySyncPanelProps) {
  const headingId = useId()
  const messageId = useId()
  const loadVersion = useRef(0)
  const [snapshot, setSnapshot] = useState<FamilySyncSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
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
        onSnapshotChange?.(nextSnapshot)
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
    [adapter, onSnapshotChange],
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

  async function handleCreateCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = circleName.trim()
    if (!name) {
      setError('Give your family group a name.')
      return
    }
    const result = await runChange(
      () => adapter.createCircle(name),
      `${name} is ready. Create a private code to invite someone.`,
    )
    if (result.ok) setCircleName('')
  }

  async function handleJoinCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = inviteCode.trim().toLowerCase()
    if (!/^ks1_[0-9a-f]{64}$/.test(code)) {
      setError('Enter the complete private family code.')
      return
    }
    const result = await runChange(
      () => adapter.requestCircleJoin(code),
      'Your request was sent to the family group owner.',
    )
    if (result.ok) setInviteCode('')
  }

  async function handleShareInvite(circleName: string) {
    if (!generatedInvite) return

    setSharing(true)
    setError('')
    setMessage('')
    try {
      const result = await shareInvite(generatedInvite, circleName)
      if (result === 'shared') {
        setMessage('The private family code is ready in your share sheet.')
      } else if (result === 'copied') {
        setMessage('The private family code was copied. Send it to someone you trust.')
      }
    } catch {
      setError('Sharing is unavailable here. Select the code and copy it manually.')
    } finally {
      setSharing(false)
    }
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
        <h2 className="screen-reader-only" id={headingId}>Family Sync</h2>
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
            <h3>Keep your family close</h3>
            <p>Sign in with Google, Apple, or your phone to create or join a family.</p>
          </div>
          <Link
            className="family-sync__auth-link"
            to="/login"
            state={{ returnTo: '/profile' }}
          >
            Sign in or create an account
          </Link>
          <p className="family-sync__privacy-note">
            Only people your family approves can join.
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
                <h3>Waiting for your family</h3>
                <p>
                  Sent {formatDate(snapshot.pendingRequest.createdAt)}. Moments will
                  appear once the circle owner lets you in.
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
                <h3>Create a family group</h3>
                <p>Make a private home for your moments. You decide who joins.</p>
                <label>
                  <span>Family group name</span>
                  <input
                    value={circleName}
                    onChange={(event) => setCircleName(event.target.value)}
                    maxLength={80}
                    required
                    disabled={busy}
                    placeholder="The Ahmed family"
                  />
                </label>
                <button className="family-sync__primary" type="submit" disabled={busy}>
                  Create family group
                </button>
              </form>

              <form className="family-sync__option" onSubmit={handleJoinCircle}>
                <h3>Join with a code</h3>
                <p>Enter the private code your family group owner sent you.</p>
                <label>
                  <span>Family code</span>
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
                  Ask to join
                </button>
              </form>
            </div>
          )}

        </div>
      ) : null}

      {snapshot?.kind === 'connected' ? (
        <div className="family-sync__connected">
          <article className="family-sync__circle-card">
            <div className="family-sync__circle-mark" aria-hidden="true">∞</div>
            <div className="family-sync__circle-copy">
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
                  <h3 id={`${headingId}-invite`}>Invite someone you love</h3>
                  <p>Create a private code for one family member.</p>
                </div>
                <button
                  className="family-sync__secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleCreateInvite(snapshot.circle.id)}
                >
                  {busy ? 'Creating…' : 'Create code'}
                </button>
              </div>

              {generatedInvite ? (
                <div className="family-sync__invite">
                  <span id={`${headingId}-invite-code`}>Private family code</span>
                  <output aria-labelledby={`${headingId}-invite-code`}>
                    {generatedInvite.code}
                  </output>
                  <button
                    className="family-sync__share"
                    type="button"
                    disabled={busy || sharing}
                    aria-label={`Share invite code for ${snapshot.circle.name}`}
                    onClick={() => void handleShareInvite(snapshot.circle.name)}
                  >
                    <span aria-hidden="true">↗</span>
                    {sharing ? 'Opening…' : 'Share code'}
                  </button>
                  <small>
                    One person can use it before {formatDate(generatedInvite.expiresAt)}.
                    You approve them before any moments are shared.
                  </small>
                </div>
              ) : null}
            </section>
          ) : (
            <p className="family-sync__member-note">
              Your circle owner can invite and approve family members.
            </p>
          )}

          {snapshot.circle.role === 'owner' ? (
            <section className="family-sync__requests" aria-labelledby={`${headingId}-requests`}>
              <div className="family-sync__subheading">
                <div>
                  <h3 id={`${headingId}-requests`}>Join requests</h3>
                  <p>Only approve people you know.</p>
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
                        <strong>Someone wants to join</strong>
                        <span>
                          {formatDate(request.createdAt)} · Request{' '}
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
                  <p>No one is waiting to join.</p>
                </div>
              )}
            </section>
          ) : null}

          <div className="family-sync__account-row">
            <div>
              <strong>{snapshot.person.displayName}</strong>
              <span>{snapshot.person.email}</span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

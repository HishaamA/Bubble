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
  FamilySyncAdapter,
  FamilySyncSnapshot,
} from './types'
import {
  shareFamilyCode,
  type ShareFamilyCode,
} from './shareFamilyInvite'
import './FamilySyncPanel.css'

type FamilySyncPanelProps = {
  adapter?: FamilySyncAdapter
  onSnapshotChange?: (snapshot: FamilySyncSnapshot) => void
  shareCode?: ShareFamilyCode
  copyCode?: (code: string) => Promise<void>
}

type ChangeResult<T> =
  | { ok: true; value: T }
  | { ok: false; value?: never }

/** Formats server timestamps defensively for request activity copy. */
function formatDate(dateValue: string) {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return 'Recently'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

/** Identifies the account/family pair whose destructive UI state is visible. */
function getSnapshotIdentity(snapshot: FamilySyncSnapshot) {
  if (snapshot.kind === 'connected') {
    return `${snapshot.person.id}:${snapshot.circle.id}`
  }
  if (snapshot.kind === 'unjoined') return `${snapshot.person.id}:unjoined`
  return snapshot.kind
}

/** Explains why family sync is unavailable without implying data is connected. */
function LocalOnlyState() {
  return (
    <div className="family-sync__state family-sync__state--local">
      <div>
        <h3>Family groups need a connection</h3>
        <p>Connect Bubble to securely create a group and share its family code.</p>
        <Link
          className="family-sync__auth-link"
          to="/login"
          state={{ returnTo: '/settings' }}
        >
          Open secure sign-in
        </Link>
      </div>
    </div>
  )
}

/**
 * Renders family membership, invitation, and owner workflows from one snapshot.
 * Adapters and sharing functions are injectable so the UI can be tested without
 * browser capabilities or a live backend.
 */
export function FamilySyncPanel({
  adapter = familySyncAdapter,
  onSnapshotChange,
  shareCode = shareFamilyCode,
  copyCode = async (code) => {
    if (!navigator.clipboard) throw new Error('clipboard_unavailable')
    await navigator.clipboard.writeText(code)
  },
}: FamilySyncPanelProps) {
  const headingId = useId()
  const messageId = useId()
  const snapshotRequestVersionRef = useRef(0)
  const loadedIdentityRef = useRef<string | null>(null)
  const manualRefreshInFlightRef = useRef(false)
  const [snapshot, setSnapshot] = useState<FamilySyncSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [mutationPending, setMutationPending] = useState(false)
  const [sharePending, setSharePending] = useState(false)
  const [confirmingRotation, setConfirmingRotation] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [circleName, setCircleName] = useState('')
  const [inviteCode, setInviteCode] = useState('')

  // A monotonically increasing request version prevents a superseded auth or
  // manual refresh response from overwriting the latest family snapshot.
  const refreshSnapshot = useCallback(
    async () => {
      const requestVersion = ++snapshotRequestVersionRef.current
      try {
        const nextSnapshot = await adapter.loadSnapshot()
        if (requestVersion !== snapshotRequestVersionRef.current) return
        const nextIdentity = getSnapshotIdentity(nextSnapshot)
        if (
          loadedIdentityRef.current !== null &&
          loadedIdentityRef.current !== nextIdentity
        ) {
          setConfirmingRotation(false)
        }
        loadedIdentityRef.current = nextIdentity
        setSnapshot(nextSnapshot)
        onSnapshotChange?.(nextSnapshot)
        setError('')
      } catch (reason) {
        if (requestVersion !== snapshotRequestVersionRef.current) return
        setError(toFamilySyncErrorMessage(reason))
      } finally {
        if (requestVersion === snapshotRequestVersionRef.current) {
          setLoading(false)
        }
      }
    },
    [adapter, onSnapshotChange],
  )

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshSnapshot(), 0)
    const unsubscribe = adapter.subscribeToAuthChanges?.(() => {
      void refreshSnapshot()
    })
    return () => {
      window.clearTimeout(initialLoad)
      snapshotRequestVersionRef.current += 1
      unsubscribe?.()
    }
  }, [adapter, refreshSnapshot])

  /** Runs a mutation, revalidates the snapshot, and owns shared result messaging. */
  async function runMutation<T>(
    operation: () => Promise<T>,
    successMessage: string | ((value: T) => string),
  ): Promise<ChangeResult<T>> {
    setMutationPending(true)
    setError('')
    setMessage('')
    try {
      const operationResult = await operation()
      announceFamilySyncChange()
      await refreshSnapshot()
      setMessage(
        typeof successMessage === 'function'
          ? successMessage(operationResult)
          : successMessage,
      )
      return { ok: true, value: operationResult }
    } catch (reason) {
      setError(toFamilySyncErrorMessage(reason))
      return { ok: false }
    } finally {
      setMutationPending(false)
    }
  }

  /** Validates the display name before delegating family creation. */
  async function handleCreateCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = circleName.trim()
    if (!name) {
      setError('Give your family group a name.')
      return
    }
    const mutationResult = await runMutation(
      () => adapter.createCircle(name),
      `${name} is ready. Your family code is saved below.`,
    )
    if (mutationResult.ok) setCircleName('')
  }

  /** Normalizes and validates both current and legacy family-code formats. */
  async function handleJoinCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const enteredCode = inviteCode.trim()
    const persistentCode = enteredCode.toUpperCase()
    const legacyCode = enteredCode.toLowerCase()
    const isPersistentCode = /^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$/.test(
      persistentCode,
    )
    const isLegacyCode = /^ks1_[0-9a-f]{64}$/.test(legacyCode)
    if (!isPersistentCode && !isLegacyCode) {
      setError('Enter the complete family code, including the dashes.')
      return
    }
    const code = isPersistentCode ? persistentCode : legacyCode
    const mutationResult = await runMutation(
      () => adapter.requestCircleJoin(code),
      isPersistentCode
        ? 'You are now connected to your family.'
        : 'Your request was sent. A family owner can approve it in Settings.',
    )
    if (mutationResult.ok) setInviteCode('')
  }

  /** Owns pending and result state around native-share or clipboard fallback. */
  async function handleShareCode(code: string, circleName: string) {
    setSharePending(true)
    setError('')
    setMessage('')
    try {
      const shareResult = await shareCode(code, circleName)
      if (shareResult === 'shared') {
        setMessage('Your family code is ready in the share sheet.')
      } else if (shareResult === 'copied') {
        setMessage('Your family code was copied.')
      }
    } catch {
      setError('Sharing is unavailable here. Select the code and copy it manually.')
    } finally {
      setSharePending(false)
    }
  }

  /** Copies a code directly when the person chooses the explicit copy action. */
  async function handleCopyCode(code: string) {
    setSharePending(true)
    setError('')
    setMessage('')
    try {
      await copyCode(code)
      setMessage('Your family code was copied.')
    } catch {
      setError('Copying is unavailable here. Press and hold the code to copy it.')
    } finally {
      setSharePending(false)
    }
  }

  /** Rotates a confirmed family code and closes the confirmation on success. */
  async function handleRotateCode(circleId: string) {
    const mutationResult = await runMutation(
      () => adapter.rotateFamilyCode(circleId),
      'A new family code is ready. The previous code no longer works.',
    )
    if (mutationResult.ok) setConfirmingRotation(false)
  }

  /** Applies an owner decision to one pending family request. */
  async function handleDecision(
    requestId: string,
    decision: 'approved' | 'rejected',
  ) {
    await runMutation(
      () => adapter.decideJoinRequest(requestId, decision),
      decision === 'approved'
        ? 'The family member is now connected.'
        : 'The join request was declined.',
    )
  }

  /** Coalesces rapid refresh activation into one in-flight snapshot request. */
  async function handleManualRefresh() {
    if (mutationPending || manualRefreshInFlightRef.current) return
    // State alone does not close the tiny gap between two rapid taps and React's
    // next render. The ref is the synchronous request latch; the state exists so
    // assistive technology and the button label expose the pending refresh.
    manualRefreshInFlightRef.current = true
    setRefreshing(true)
    try {
      await refreshSnapshot()
    } finally {
      manualRefreshInFlightRef.current = false
      setRefreshing(false)
    }
  }

  const describedBy = error || message ? messageId : undefined

  return (
    <section
      className="family-sync"
      aria-labelledby={headingId}
      aria-describedby={describedBy}
      aria-busy={mutationPending || loading || refreshing}
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
            <p>Sign in securely to create or join a family.</p>
          </div>
          <Link
            className="family-sync__auth-link"
            to="/login"
            state={{ returnTo: '/settings' }}
          >
            Sign in or create an account
          </Link>
          <p className="family-sync__privacy-note">
            Your account keeps your family details connected across devices.
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
                  A previous invite was sent {formatDate(snapshot.pendingRequest.createdAt)}.
                  Check again to see whether it was approved.
                </p>
              </div>
              <button
                className="family-sync__secondary"
                type="button"
                onClick={() => void handleManualRefresh()}
                disabled={mutationPending || refreshing}
              >
                {refreshing ? 'Checking…' : 'Check again'}
              </button>
            </div>
          ) : (
            <div className="family-sync__choice-grid">
              <form className="family-sync__option" onSubmit={handleCreateCircle}>
                <h3>Create a family group</h3>
                <p>Make a private home and share its saved code with your family.</p>
                <label>
                  <span>Family group name</span>
                  <input
                    value={circleName}
                    onChange={(event) => setCircleName(event.target.value)}
                    maxLength={80}
                    enterKeyHint="go"
                    required
                    disabled={mutationPending}
                    placeholder="The Ahmed family"
                  />
                </label>
                <button
                  className="family-sync__primary"
                  type="submit"
                  disabled={mutationPending}
                >
                  Create family group
                </button>
              </form>

              <form className="family-sync__option" onSubmit={handleJoinCircle}>
                <h3>Join with a code</h3>
                <p>Enter the code shown in a family member's Bubble settings.</p>
                <label>
                  <span>Family code</span>
                  <input
                    className="family-sync__code-input"
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    enterKeyHint="go"
                    spellCheck={false}
                    required
                    disabled={mutationPending}
                    placeholder="BUB-1234-ABCD-5678-90EF-1234-ABCD"
                  />
                </label>
                <button
                  className="family-sync__primary"
                  type="submit"
                  disabled={mutationPending}
                >
                  Join family
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

          <section className="family-sync__owner-tools" aria-labelledby={`${headingId}-invite`}>
            <div className="family-sync__subheading">
              <div>
                <h3 id={`${headingId}-invite`}>Invite your family</h3>
                <p>This code stays in Settings, ready whenever you need it.</p>
              </div>
            </div>

            <div className="family-sync__invite">
              <span id={`${headingId}-invite-code`}>Family code</span>
              <output aria-labelledby={`${headingId}-invite-code`}>
                {snapshot.circle.shareCode}
              </output>
              <div className="family-sync__code-actions">
                <button
                  className="family-sync__secondary"
                  type="button"
                  disabled={mutationPending || sharePending}
                  onClick={() => void handleCopyCode(snapshot.circle.shareCode)}
                >
                  Copy code
                </button>
                <button
                  className="family-sync__share"
                  type="button"
                  disabled={mutationPending || sharePending}
                  aria-label={`Share family code for ${snapshot.circle.name}`}
                  onClick={() =>
                    void handleShareCode(
                      snapshot.circle.shareCode,
                      snapshot.circle.name,
                    )
                  }
                >
                  <span aria-hidden="true">↗</span>
                  {sharePending ? 'Opening…' : 'Share code'}
                </button>
              </div>
              {snapshot.circle.role === 'owner' ? (
                confirmingRotation ? (
                  <div
                    className="family-sync__rotation-confirmation"
                    role="group"
                    aria-label="Confirm family code rotation"
                  >
                    <p>
                      Replace this code? The old code will stop working immediately.
                    </p>
                    <div>
                      <button
                        className="family-sync__text-button"
                        type="button"
                        disabled={mutationPending || sharePending}
                        onClick={() => setConfirmingRotation(false)}
                      >
                        Keep current code
                      </button>
                      <button
                        className="family-sync__secondary"
                        type="button"
                        disabled={mutationPending || sharePending}
                        onClick={() => void handleRotateCode(snapshot.circle.id)}
                      >
                        Create new code
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="family-sync__rotate-code"
                    type="button"
                    disabled={mutationPending || sharePending}
                    onClick={() => setConfirmingRotation(true)}
                  >
                    Replace family code
                  </button>
                )
              ) : null}
              <small>
                Anyone with this code can join. Share it only with your family.
              </small>
            </div>
          </section>

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
                          disabled={mutationPending}
                          onClick={() => void handleDecision(request.id, 'rejected')}
                          aria-label={`Reject request from member ${request.requesterId.slice(0, 8)}`}
                        >
                          Reject
                        </button>
                        <button
                          className="family-sync__approve"
                          type="button"
                          disabled={mutationPending}
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

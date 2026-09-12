import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useFamilySyncController,
  type FamilySyncControllerOptions,
} from './useFamilySyncController'
import './FamilySyncPanel.css'

type FamilySyncPanelProps = FamilySyncControllerOptions

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'
}

/** A failed/missing portrait still has a useful, non-identifying fallback. */
function MemberAvatar({ name, url }: { name: string; url: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return (
    <span className="family-sync__member-avatar" aria-hidden="true">
      {url && url !== failedUrl ? (
        <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
      ) : initials(name)}
    </span>
  )
}

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
 * Presents membership, invitations, and owner controls from one family snapshot.
 * The controller owns asynchronous workflows while this component owns markup,
 * accessible labels, and the small display-only avatar/date helpers.
 */
export function FamilySyncPanel(props: FamilySyncPanelProps) {
  const headingId = useId()
  const messageId = useId()
  const {
    snapshot,
    status,
    membership,
    invitation,
    refresh: handleManualRefresh,
  } = useFamilySyncController(props)
  const {
    loading,
    refreshing,
    pendingAction,
    mutationPending,
    sharePending,
    error,
    message,
  } = status
  const {
    circleName,
    inviteCode,
    setCircleName,
    setInviteCode,
    createCircle: handleCreateCircle,
    joinCircle: handleJoinCircle,
    decideRequest: handleDecision,
  } = membership
  const {
    copy: handleCopyCode,
    share: handleShareCode,
    rotation,
  } = invitation
  const {
    confirming: confirmingRotation,
    pending: rotationPending,
    error: rotationError,
    message: rotationMessage,
    request: requestCodeRotation,
    cancel: cancelCodeRotation,
    confirm: handleRotateCode,
  } = rotation

  const describedBy = error || message ? messageId : undefined

  return (
    <section
      className="family-sync"
      aria-labelledby={headingId}
      aria-describedby={describedBy}
      aria-busy={loading}
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

      {error && !loading && !mutationPending ? (
        <button className="family-sync__secondary" type="button" onClick={() => void handleManualRefresh()} disabled={refreshing || sharePending}>
          {refreshing ? 'Checking…' : 'Check again'}
        </button>
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

          <section className="family-sync__members" aria-labelledby={`${headingId}-members`}>
            <div className="family-sync__subheading">
              <div>
                <h3 id={`${headingId}-members`}>Your family</h3>
                <p>People connected to this private group.</p>
              </div>
              <button className="family-sync__text-button" type="button" disabled={mutationPending || sharePending || refreshing} onClick={() => void handleManualRefresh()}>
                {refreshing ? 'Checking…' : 'Refresh'}
              </button>
            </div>
            {snapshot.members.length ? (
              <ul className="family-sync__member-list">
                {snapshot.members.map((member) => (
                  <li key={member.id}>
                    <MemberAvatar name={member.displayName} url={member.avatarUrl} />
                    <div className="family-sync__member-details">
                      <strong>{member.displayName}</strong>
                      <div className="family-sync__member-badges">
                        <span>{member.role === 'owner' ? 'Owner' : 'Member'}</span>
                        {member.isCurrentUser ? <span className="family-sync__you-badge">You</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="family-sync__roster-empty">The member list is unavailable. Refresh to try again.</p>
            )}
          </section>

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
                  disabled={mutationPending || sharePending || refreshing}
                  onClick={() => void handleCopyCode(snapshot.circle.shareCode)}
                >
                  {pendingAction === 'copy' ? 'Copying…' : 'Copy code'}
                </button>
                <button
                  className="family-sync__share"
                  type="button"
                  disabled={mutationPending || sharePending || refreshing}
                  aria-label={`Share family code for ${snapshot.circle.name}`}
                  onClick={() =>
                    void handleShareCode(
                      snapshot.circle.shareCode,
                      snapshot.circle.name,
                    )
                  }
                >
                  <span aria-hidden="true">↗</span>
                  {pendingAction === 'share' ? 'Opening…' : 'Share code'}
                </button>
              </div>
              {snapshot.circle.role === 'owner' ? (
                confirmingRotation ? (
                  <div
                    className="family-sync__rotation-confirmation"
                    role="group"
                    aria-label="Confirm family code rotation"
                    aria-busy={rotationPending}
                  >
                    <p>
                      Create a new family code? The old one will stop working. Your family members will stay connected.
                    </p>
                    <div>
                      <button
                        className="family-sync__secondary"
                        type="button"
                        disabled={mutationPending || sharePending || refreshing}
                        onClick={cancelCodeRotation}
                      >
                        Keep code
                      </button>
                      <button
                        className="family-sync__primary"
                        type="button"
                        disabled={mutationPending || sharePending || refreshing}
                        onClick={() => void handleRotateCode(snapshot.circle.id)}
                      >
                        {rotationPending ? 'Creating…' : 'Create new code'}
                      </button>
                    </div>
                    {rotationError ? <p className="family-sync__rotation-error" role="alert">{rotationError}</p> : null}
                    {rotationPending ? <p className="family-sync__rotation-status" role="status">Creating your new code. This may take a moment.</p> : null}
                  </div>
                ) : (
                  <button
                    className="family-sync__rotate-code"
                    type="button"
                    disabled={mutationPending || sharePending || refreshing}
                    onClick={requestCodeRotation}
                  >
                    Replace family code
                  </button>
                )
              ) : null}
              {rotationMessage ? <p className="family-sync__rotation-status" role="status">{rotationMessage}</p> : null}
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

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  announceFamilySyncChange,
  familySyncAdapter,
  toFamilySyncErrorMessage,
} from './familySyncAdapter'
import type { FamilySyncAdapter, FamilySyncSnapshot } from './types'
import { shareFamilyCode, type ShareFamilyCode } from './shareFamilyInvite'

export type FamilySyncControllerOptions = {
  adapter?: FamilySyncAdapter
  onSnapshotChange?: (snapshot: FamilySyncSnapshot) => void
  shareCode?: ShareFamilyCode
  copyCode?: (code: string) => Promise<void>
}

type ChangeResult<T> =
  | { ok: true; value: T }
  | { ok: false; value?: never }

type PendingAction = 'mutation' | 'rotation' | 'copy' | 'share'
type ActionToken = { epoch: number; kind: PendingAction }
type SnapshotResult =
  | { status: 'loaded'; snapshot: FamilySyncSnapshot }
  | { status: 'failed' | 'superseded' }

function getPersonId(snapshot: FamilySyncSnapshot | null) {
  return snapshot?.kind === 'connected' || snapshot?.kind === 'unjoined'
    ? snapshot.person.id
    : null
}

/** Network errors may retain a snapshot; rejected access must never do so. */
function isFamilyAccessError(reason: unknown) {
  if (!reason || typeof reason !== 'object') return false
  const { code, message, status } = reason as { code?: unknown; message?: unknown; status?: unknown }
  return code === '42501' || status === 401 || status === 403 ||
    (typeof message === 'string' && /account_changed|family_access_changed|owner_required|permission denied|row.level security|not authenticated/i.test(message))
}

/** Identifies the account/family pair whose destructive UI state is visible. */
function getSnapshotIdentity(snapshot: FamilySyncSnapshot) {
  if (snapshot.kind === 'connected') {
    return `${snapshot.person.id}:${snapshot.circle.id}`
  }
  if (snapshot.kind === 'unjoined') return `${snapshot.person.id}:unjoined`
  return snapshot.kind
}

/** Public view state and commands; request tokens and account guards stay private. */
export type FamilySyncController = {
  snapshot: FamilySyncSnapshot | null
  status: {
    loading: boolean
    refreshing: boolean
    pendingAction: PendingAction | null
    mutationPending: boolean
    sharePending: boolean
    error: string
    message: string
  }
  refresh: () => Promise<void>
  membership: {
    circleName: string
    inviteCode: string
    setCircleName: (value: string) => void
    setInviteCode: (value: string) => void
    createCircle: (event: FormEvent<HTMLFormElement>) => Promise<void>
    joinCircle: (event: FormEvent<HTMLFormElement>) => Promise<void>
    decideRequest: (requestId: string, decision: 'approved' | 'rejected') => Promise<void>
  }
  invitation: {
    copy: (code: string) => Promise<void>
    share: (code: string, circleName: string) => Promise<void>
    rotation: {
      confirming: boolean
      pending: boolean
      error: string
      message: string
      request: () => void
      cancel: () => void
      confirm: (circleId: string) => Promise<void>
    }
  }
}

/**
 * Owns one account/family scope and its asynchronous membership workflows.
 * Scope epochs reject late account responses; request versions reject stale
 * reads; synchronous action latches prevent duplicate writes between renders.
 */
export function useFamilySyncController({
  adapter = familySyncAdapter,
  onSnapshotChange,
  shareCode = shareFamilyCode,
  copyCode = async (code) => {
    if (!navigator.clipboard) throw new Error('clipboard_unavailable')
    await navigator.clipboard.writeText(code)
  },
}: FamilySyncControllerOptions): FamilySyncController {
  const snapshotRequestVersionRef = useRef(0)
  const mountedRef = useRef(false)
  const scopeEpochRef = useRef(0)
  const snapshotRef = useRef<FamilySyncSnapshot | null>(null)
  const actionRef = useRef<ActionToken | null>(null)
  const onSnapshotChangeRef = useRef(onSnapshotChange)
  const loadedIdentityRef = useRef<string | null>(null)
  const manualRefreshInFlightRef = useRef(false)
  const [snapshot, setSnapshot] = useState<FamilySyncSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [confirmingRotation, setConfirmingRotation] = useState(false)
  const [rotationError, setRotationError] = useState('')
  const [rotationMessage, setRotationMessage] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [circleName, setCircleName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const mutationPending = pendingAction === 'mutation' || pendingAction === 'rotation'
  const sharePending = pendingAction === 'copy' || pendingAction === 'share'
  const rotationPending = pendingAction === 'rotation'

  useEffect(() => {
    onSnapshotChangeRef.current = onSnapshotChange
  }, [onSnapshotChange])

  const publishSnapshot = useCallback((nextSnapshot: FamilySyncSnapshot) => {
    loadedIdentityRef.current = getSnapshotIdentity(nextSnapshot)
    snapshotRef.current = nextSnapshot
    setSnapshot(nextSnapshot)
    onSnapshotChangeRef.current?.(nextSnapshot)
  }, [])

  const clearActionState = useCallback(() => {
    scopeEpochRef.current += 1
    actionRef.current = null
    manualRefreshInFlightRef.current = false
    setPendingAction(null)
    setRefreshing(false)
    setConfirmingRotation(false)
    setRotationError('')
    setRotationMessage('')
    setError('')
    setMessage('')
    setCircleName('')
    setInviteCode('')
  }, [])

  const discardRejectedSnapshot = useCallback((reason: unknown) => {
    if (!isFamilyAccessError(reason)) return false
    clearActionState()
    loadedIdentityRef.current = null
    snapshotRef.current = null
    setSnapshot(null)
    return true
  }, [clearActionState])

  // A monotonically increasing request version prevents a superseded auth or
  // manual refresh response from overwriting the latest family snapshot.
  const refreshSnapshot = useCallback(
    async (allowMembershipChangeForPerson?: string): Promise<SnapshotResult> => {
      const requestVersion = ++snapshotRequestVersionRef.current
      const epoch = scopeEpochRef.current
      try {
        const nextSnapshot = await adapter.loadSnapshot()
        if (!mountedRef.current || epoch !== scopeEpochRef.current || requestVersion !== snapshotRequestVersionRef.current) {
          return { status: 'superseded' }
        }
        const nextIdentity = getSnapshotIdentity(nextSnapshot)
        if (
          loadedIdentityRef.current !== null &&
          loadedIdentityRef.current !== nextIdentity
        ) {
          setConfirmingRotation(false)
          if (!allowMembershipChangeForPerson || getPersonId(nextSnapshot) !== allowMembershipChangeForPerson) {
            clearActionState()
          }
        }
        publishSnapshot(nextSnapshot)
        setError('')
        return { status: 'loaded', snapshot: nextSnapshot }
      } catch (reason) {
        if (!mountedRef.current || epoch !== scopeEpochRef.current || requestVersion !== snapshotRequestVersionRef.current) {
          return { status: 'superseded' }
        }
        discardRejectedSnapshot(reason)
        setError(toFamilySyncErrorMessage(reason))
        return { status: 'failed' }
      } finally {
        if (mountedRef.current && requestVersion === snapshotRequestVersionRef.current) {
          setLoading(false)
        }
      }
    },
    [adapter, clearActionState, discardRejectedSnapshot, publishSnapshot],
  )

  useEffect(() => {
    mountedRef.current = true
    const resetScope = () => {
      snapshotRequestVersionRef.current += 1
      clearActionState()
      loadedIdentityRef.current = null
      snapshotRef.current = null
      setSnapshot(null)
      setLoading(true)
    }
    resetScope()
    const initialLoad = window.setTimeout(() => void refreshSnapshot(), 0)
    const unsubscribe = adapter.subscribeToAuthChanges?.(() => {
      window.clearTimeout(initialLoad)
      // Hide the previous account's code immediately, before the next load.
      resetScope()
      void refreshSnapshot()
    })
    return () => {
      mountedRef.current = false
      window.clearTimeout(initialLoad)
      snapshotRequestVersionRef.current += 1
      scopeEpochRef.current += 1
      actionRef.current = null
      unsubscribe?.()
    }
  }, [adapter, clearActionState, refreshSnapshot])

  function beginAction(kind: PendingAction): ActionToken | null {
    // A state-only disabled button does not protect the gap between rapid taps.
    if (!mountedRef.current || actionRef.current || manualRefreshInFlightRef.current || !snapshotRef.current) return null
    const token = { epoch: scopeEpochRef.current, kind }
    actionRef.current = token
    snapshotRequestVersionRef.current += 1
    setPendingAction(kind)
    setError('')
    setMessage('')
    return token
  }

  function isCurrentAction(token: ActionToken) {
    return mountedRef.current && token.epoch === scopeEpochRef.current && actionRef.current === token
  }

  function finishAction(token: ActionToken) {
    if (!isCurrentAction(token)) return
    actionRef.current = null
    setPendingAction(null)
  }

  /** Runs a mutation, revalidates the snapshot, and owns shared result messaging. */
  async function runMutation<T>(
    operation: () => Promise<T>,
    successMessage: string | ((value: T) => string),
    isExpectedSnapshot: (next: FamilySyncSnapshot) => boolean,
  ): Promise<ChangeResult<T>> {
    const token = beginAction('mutation')
    if (!token) return { ok: false }
    const personId = getPersonId(snapshotRef.current)
    try {
      const operationResult = await operation()
      if (!isCurrentAction(token)) return { ok: false }
      const refreshed = await refreshSnapshot(personId ?? undefined)
      if (!isCurrentAction(token)) return { ok: false }
      if (refreshed.status !== 'loaded') {
        setError('Your change was sent, but we could not refresh your family. Check again before retrying.')
        announceFamilySyncChange()
        return { ok: false }
      }
      if (!isExpectedSnapshot(refreshed.snapshot)) {
        setError('Your family details have not updated yet. Check again before retrying.')
        announceFamilySyncChange()
        return { ok: false }
      }
      setMessage(
        typeof successMessage === 'function'
          ? successMessage(operationResult)
          : successMessage,
      )
      // Refresh our snapshot once, then notify other app readers. Announcing
      // before this read can replace this panel while it is still reconciling.
      announceFamilySyncChange()
      return { ok: true, value: operationResult }
    } catch (reason) {
      if (isCurrentAction(token)) {
        discardRejectedSnapshot(reason)
        setError(toFamilySyncErrorMessage(reason))
      }
      return { ok: false }
    } finally {
      finishAction(token)
    }
  }

  /** Validates the display name before delegating family creation. */
  async function handleCreateCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (snapshotRef.current?.kind !== 'unjoined' || snapshotRef.current.pendingRequest) return
    const name = circleName.trim()
    if (!name) {
      setError('Give your family group a name.')
      return
    }
    const mutationResult = await runMutation(
      () => adapter.createCircle(name),
      `${name} is ready. Your family code is saved below.`,
      (next) => next.kind === 'connected' && next.circle.role === 'owner',
    )
    if (mutationResult.ok) setCircleName('')
  }

  /** Normalizes and validates both current and legacy family-code formats. */
  async function handleJoinCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (snapshotRef.current?.kind !== 'unjoined' || snapshotRef.current.pendingRequest) return
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
      (next) => next.kind === 'connected' || (!isPersistentCode && next.kind === 'unjoined' && next.pendingRequest !== null),
    )
    if (mutationResult.ok) setInviteCode('')
  }

  /** Owns pending and result state around native-share or clipboard fallback. */
  async function handleShareCode(code: string, circleName: string) {
    const current = snapshotRef.current
    if (current?.kind !== 'connected' || current.circle.shareCode !== code) return
    const token = beginAction('share')
    if (!token) return
    try {
      const shareResult = await shareCode(code, circleName)
      if (!isCurrentAction(token)) return
      if (shareResult === 'shared') {
        setMessage('Your family code is ready in the share sheet.')
      } else if (shareResult === 'copied') {
        setMessage('Your family code was copied.')
      }
    } catch {
      if (isCurrentAction(token)) setError('Sharing is unavailable here. Select the code and copy it manually.')
    } finally {
      finishAction(token)
    }
  }

  /** Copies a code directly when the person chooses the explicit copy action. */
  async function handleCopyCode(code: string) {
    const current = snapshotRef.current
    if (current?.kind !== 'connected' || current.circle.shareCode !== code) return
    const token = beginAction('copy')
    if (!token) return
    try {
      await copyCode(code)
      if (isCurrentAction(token)) setMessage('Your family code was copied.')
    } catch {
      if (isCurrentAction(token)) setError('Copying is unavailable here. Press and hold the code to copy it.')
    } finally {
      finishAction(token)
    }
  }

  /** Rotates a confirmed family code and closes the confirmation on success. */
  async function handleRotateCode(circleId: string) {
    const current = snapshotRef.current
    if (!confirmingRotation || current?.kind !== 'connected' || current.circle.role !== 'owner' || current.circle.id !== circleId) return
    const token = beginAction('rotation')
    if (!token) return
    setRotationError('')
    setRotationMessage('')
    try {
      const newCode = await adapter.rotateFamilyCode(circleId)
      if (!isCurrentAction(token)) return
      if (!/^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$/.test(newCode) || newCode === current.circle.shareCode) {
        throw new Error('rotation_not_confirmed')
      }
      // The mutation returns the committed code. A second membership read can
      // lag behind the write and incorrectly put the old code back on screen.
      snapshotRequestVersionRef.current += 1
      publishSnapshot({ ...current, circle: { ...current.circle, shareCode: newCode } })
      setConfirmingRotation(false)
      setRotationMessage('A new family code is ready. The previous code no longer works.')
      announceFamilySyncChange()
    } catch (reason) {
      if (isCurrentAction(token)) {
        if (discardRejectedSnapshot(reason)) {
          setError(toFamilySyncErrorMessage(reason))
        } else {
          setRotationError(reason instanceof Error && reason.message === 'rotation_not_confirmed'
            ? 'The new code could not be confirmed. Check your connection and try again.'
            : toFamilySyncErrorMessage(reason))
        }
      }
    } finally {
      finishAction(token)
    }
  }

  /** Applies an owner decision to one pending family request. */
  async function handleDecision(
    requestId: string,
    decision: 'approved' | 'rejected',
  ) {
    const current = snapshotRef.current
    if (current?.kind !== 'connected' || current.circle.role !== 'owner' || !current.pendingRequests.some((request) => request.id === requestId)) return
    await runMutation(
      () => adapter.decideJoinRequest(requestId, decision),
      decision === 'approved'
        ? 'The family member is now connected.'
        : 'The join request was declined.',
      (next) => next.kind === 'connected' && next.circle.id === current.circle.id && !next.pendingRequests.some((request) => request.id === requestId),
    )
  }

  /** Coalesces rapid refresh activation into one in-flight snapshot request. */
  async function handleManualRefresh() {
    if (actionRef.current || manualRefreshInFlightRef.current || !mountedRef.current) return
    // State alone does not close the tiny gap between two rapid taps and React's
    // next render. The ref is the synchronous request latch; the state exists so
    // assistive technology and the button label expose the pending refresh.
    manualRefreshInFlightRef.current = true
    const epoch = scopeEpochRef.current
    setRefreshing(true)
    try {
      await refreshSnapshot()
    } finally {
      if (mountedRef.current && epoch === scopeEpochRef.current) {
        manualRefreshInFlightRef.current = false
        setRefreshing(false)
      }
    }
  }

  function requestCodeRotation() {
    setConfirmingRotation(true)
    setRotationError('')
    setRotationMessage('')
  }

  function cancelCodeRotation() {
    setConfirmingRotation(false)
    setRotationError('')
  }

  return {
    snapshot,
    status: {
      loading,
      refreshing,
      pendingAction,
      mutationPending,
      sharePending,
      error,
      message,
    },
    refresh: handleManualRefresh,
    membership: {
      circleName,
      inviteCode,
      setCircleName,
      setInviteCode,
      createCircle: handleCreateCircle,
      joinCircle: handleJoinCircle,
      decideRequest: handleDecision,
    },
    invitation: {
      copy: handleCopyCode,
      share: handleShareCode,
      rotation: {
        confirming: confirmingRotation,
        pending: rotationPending,
        error: rotationError,
        message: rotationMessage,
        request: requestCodeRotation,
        cancel: cancelCodeRotation,
        confirm: handleRotateCode,
      },
    },
  }
}

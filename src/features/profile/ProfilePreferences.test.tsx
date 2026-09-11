import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfilePreferences as SavedPreferences } from '../../services/persistence'
import { eventStorageKey } from '../events/eventStorage'
import { readPendingWidgetOptOut, readWidgetPrivacy, writeWidgetPrivacy } from '../widgets/widgetStorage'

const persistence = vi.hoisted(() => ({
  readProfilePreferences: vi.fn(),
  updateProfilePreferences: vi.fn(),
}))
vi.mock('../../services/persistence', () => persistence)

import { ProfilePreferences } from './ProfilePreferences'

const initial: SavedPreferences = {
  notificationsEnabled: true,
  quietHoursEnabled: true,
  quietHoursStart: '22:00:00',
  quietHoursEnd: '08:00:00',
  widgetPreviewsEnabled: false,
}
const storageSubject = 'alice:family:family-1'
const privacyKey = eventStorageKey('bubble-widget-privacy:v1', storageSubject)

function deferredPreferences() {
  let resolve!: (value: SavedPreferences) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<SavedPreferences>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function renderPreferences() {
  return render(<ProfilePreferences userId="alice" widgetStorageSubject={storageSubject} />)
}

async function waitForInitialPreferences() {
  await waitFor(() => expect(localStorage.getItem(privacyKey)).toBe('hidden'))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  persistence.readProfilePreferences.mockResolvedValue(initial)
  persistence.updateProfilePreferences.mockImplementation(async (patch) => ({ ...initial, ...patch }))
})

describe('ProfilePreferences responsive saves', () => {
  it('keeps every switch responsive while another preference is saving', async () => {
    const user = userEvent.setup()
    const updatesSave = deferredPreferences()
    persistence.updateProfilePreferences.mockImplementation((patch) =>
      'notificationsEnabled' in patch ? updatesSave.promise : Promise.resolve({ ...initial, ...patch }),
    )
    renderPreferences()
    await waitForInitialPreferences()
    const updates = screen.getByRole('switch', { name: 'Family updates' })
    const quiet = screen.getByRole('switch', { name: 'Quiet evenings' })
    const widget = screen.getByRole('switch', { name: 'Widget previews' })

    await user.click(updates)
    expect(updates).toHaveAttribute('aria-checked', 'false')
    expect(updates).toHaveAttribute('aria-busy', 'true')
    expect(updates).toBeEnabled()
    expect(quiet).toBeEnabled()
    expect(widget).toBeEnabled()
    await user.click(quiet)
    expect(quiet).toHaveAttribute('aria-checked', 'false')
    expect(persistence.updateProfilePreferences).toHaveBeenCalledWith({ quietHoursEnabled: false }, { expectedSubject: 'alice' })

    await act(async () => { updatesSave.resolve({ ...initial, notificationsEnabled: false }) })
    expect(updates).toHaveAttribute('aria-busy', 'false')
    expect(quiet).toHaveAttribute('aria-checked', 'false')
  })

  it('serializes rapid changes and does not let an old reply undo the latest position', async () => {
    const user = userEvent.setup()
    const first = deferredPreferences()
    const second = deferredPreferences()
    persistence.updateProfilePreferences.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    renderPreferences()
    await waitForInitialPreferences()
    const updates = screen.getByRole('switch', { name: 'Family updates' })

    await user.click(updates)
    await user.click(updates)
    expect(updates).toHaveAttribute('aria-checked', 'true')
    expect(persistence.updateProfilePreferences).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve({ ...initial, notificationsEnabled: false }) })
    expect(updates).toHaveAttribute('aria-checked', 'true')
    expect(persistence.updateProfilePreferences.mock.calls).toEqual([
      [{ notificationsEnabled: false }, { expectedSubject: 'alice' }],
      [{ notificationsEnabled: true }, { expectedSubject: 'alice' }],
    ])
    await act(async () => { second.resolve(initial) })
    expect(updates).toHaveAttribute('aria-busy', 'false')
    expect(updates).toHaveAttribute('aria-checked', 'true')
  })

  it('coalesces intermediate taps when the latest choice is already being saved', async () => {
    const user = userEvent.setup()
    const save = deferredPreferences()
    persistence.updateProfilePreferences.mockReturnValueOnce(save.promise)
    renderPreferences()
    await waitForInitialPreferences()
    const quiet = screen.getByRole('switch', { name: 'Quiet evenings' })
    await user.click(quiet)
    await user.click(quiet)
    await user.click(quiet)
    expect(quiet).toHaveAttribute('aria-checked', 'false')
    await act(async () => { save.resolve({ ...initial, quietHoursEnabled: false }) })
    expect(quiet).toHaveAttribute('aria-checked', 'false')
    expect(persistence.updateProfilePreferences).toHaveBeenCalledTimes(1)
  })

  it('ignores stale initial preferences after the member has made and saved a choice', async () => {
    const user = userEvent.setup()
    const read = deferredPreferences()
    persistence.readProfilePreferences.mockReturnValueOnce(read.promise)
    renderPreferences()
    const updates = screen.getByRole('switch', { name: 'Family updates' })
    await user.click(updates)
    expect(updates).toHaveAttribute('aria-checked', 'false')
    await act(async () => { read.resolve(initial) })
    expect(updates).toHaveAttribute('aria-checked', 'false')
  })

  it('rolls back only the failed preference and leaves other saved changes intact', async () => {
    const user = userEvent.setup()
    const save = deferredPreferences()
    persistence.updateProfilePreferences.mockImplementation((patch) =>
      'notificationsEnabled' in patch ? save.promise : Promise.resolve({ ...initial, ...patch }),
    )
    renderPreferences()
    await waitForInitialPreferences()
    const updates = screen.getByRole('switch', { name: 'Family updates' })
    const quiet = screen.getByRole('switch', { name: 'Quiet evenings' })
    await user.click(updates)
    await user.click(quiet)
    await act(async () => { save.reject(new Error('offline')) })
    expect(updates).toHaveAttribute('aria-checked', 'true')
    expect(updates).toBeEnabled()
    expect(quiet).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Family updates could not be saved.')).toBeInTheDocument()
  })

  it('never reveals widget content when a stale opt-in confirms after a newer opt-out', async () => {
    const user = userEvent.setup()
    const optIn = deferredPreferences()
    const optOut = deferredPreferences()
    persistence.updateProfilePreferences.mockReturnValueOnce(optIn.promise).mockReturnValueOnce(optOut.promise)
    renderPreferences()
    await waitForInitialPreferences()
    const widget = screen.getByRole('switch', { name: 'Widget previews' })

    await user.click(widget)
    expect(widget).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem(privacyKey)).toBe('hidden')
    await user.click(widget)
    expect(widget).toHaveAttribute('aria-checked', 'false')
    await act(async () => { optIn.resolve({ ...initial, widgetPreviewsEnabled: true }) })
    expect(widget).toHaveAttribute('aria-checked', 'false')
    expect(localStorage.getItem(privacyKey)).toBe('hidden')
    expect(persistence.updateProfilePreferences).toHaveBeenLastCalledWith({ widgetPreviewsEnabled: false }, { expectedSubject: 'alice' })
    await act(async () => { optOut.resolve(initial) })
    expect(localStorage.getItem(privacyKey)).toBe('hidden')
    expect(widget).toHaveAttribute('aria-busy', 'false')
  })

  it('keeps widget opt-out off with a sync error when the save fails', async () => {
    const user = userEvent.setup()
    const save = deferredPreferences()
    persistence.readProfilePreferences.mockResolvedValueOnce({ ...initial, widgetPreviewsEnabled: true })
    persistence.updateProfilePreferences.mockReturnValueOnce(save.promise)
    renderPreferences()
    await waitFor(() => expect(localStorage.getItem(privacyKey)).toBe('full'))
    const widget = screen.getByRole('switch', { name: 'Widget previews' })

    await user.click(widget)
    expect(widget).toHaveAttribute('aria-checked', 'false')
    expect(localStorage.getItem(privacyKey)).toBe('hidden')
    await act(async () => { save.reject(new Error('offline')) })

    expect(widget).toHaveAttribute('aria-checked', 'false')
    expect(widget).toHaveAttribute('aria-busy', 'false')
    expect(widget).toBeEnabled()
    expect(localStorage.getItem(privacyKey)).toBe('hidden')
    expect(screen.getByText('Widget previews are hidden on this phone, but the setting could not be synced.')).toBeInTheDocument()
  })

  it('restores an offline opt-out after remount and reveals only after an explicit saved opt-in', async () => {
    const user = userEvent.setup()
    persistence.readProfilePreferences.mockResolvedValue({ ...initial, widgetPreviewsEnabled: true })
    persistence.updateProfilePreferences.mockRejectedValueOnce(new Error('offline'))
    const firstView = renderPreferences()
    await waitFor(() => expect(readWidgetPrivacy(storageSubject)).toBe('full'))
    await user.click(screen.getByRole('switch', { name: 'Widget previews' }))
    expect(await screen.findByText('Widget previews are hidden on this phone, but the setting could not be synced.')).toBeInTheDocument()
    expect(readPendingWidgetOptOut(storageSubject)).not.toBeNull()
    firstView.unmount()

    renderPreferences()
    await waitFor(() => expect(persistence.readProfilePreferences).toHaveBeenCalledTimes(2))
    const widget = screen.getByRole('switch', { name: 'Widget previews' })
    expect(widget).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Widget previews are hidden on this phone until your choice syncs.')).toBeInTheDocument()
    writeWidgetPrivacy(storageSubject, 'full')
    expect(readWidgetPrivacy(storageSubject)).toBe('hidden')

    // A rejected attempt to turn it back on cannot remove the persisted opt-out.
    persistence.updateProfilePreferences.mockRejectedValueOnce(new Error('offline'))
    await user.click(widget)
    expect(await screen.findByText('Widget previews could not be saved.')).toBeInTheDocument()
    expect(widget).toHaveAttribute('aria-checked', 'false')
    expect(readPendingWidgetOptOut(storageSubject)).not.toBeNull()
    expect(readWidgetPrivacy(storageSubject)).toBe('hidden')

    const confirmedOptIn = deferredPreferences()
    persistence.updateProfilePreferences.mockReturnValueOnce(confirmedOptIn.promise)
    await user.click(widget)
    expect(widget).toHaveAttribute('aria-checked', 'true')
    expect(readWidgetPrivacy(storageSubject)).toBe('hidden')
    await act(async () => { confirmedOptIn.resolve({ ...initial, widgetPreviewsEnabled: true }) })
    expect(readPendingWidgetOptOut(storageSubject)).toBeNull()
    expect(readWidgetPrivacy(storageSubject)).toBe('full')
    expect(widget).toHaveAttribute('aria-checked', 'true')
  })

  it('protects a pending opt-out on navigation before its remote save finishes', async () => {
    const user = userEvent.setup()
    const save = deferredPreferences()
    persistence.readProfilePreferences.mockResolvedValue({ ...initial, widgetPreviewsEnabled: true })
    persistence.updateProfilePreferences.mockReturnValueOnce(save.promise)
    const firstView = renderPreferences()
    await waitFor(() => expect(readWidgetPrivacy(storageSubject)).toBe('full'))
    await user.click(screen.getByRole('switch', { name: 'Widget previews' }))
    expect(readPendingWidgetOptOut(storageSubject)).not.toBeNull()
    firstView.unmount()

    renderPreferences()
    await waitFor(() => expect(persistence.readProfilePreferences).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('switch', { name: 'Widget previews' })).toHaveAttribute('aria-checked', 'false')
    expect(readWidgetPrivacy(storageSubject)).toBe('hidden')
    await act(async () => { save.resolve(initial) })
    expect(readPendingWidgetOptOut(storageSubject)).toBeNull()
    expect(readWidgetPrivacy(storageSubject)).toBe('hidden')
  })

  it('finishes the last queued choice after navigating away from Settings', async () => {
    const user = userEvent.setup()
    const first = deferredPreferences()
    const second = deferredPreferences()
    persistence.updateProfilePreferences.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = renderPreferences()
    await waitForInitialPreferences()
    const updates = screen.getByRole('switch', { name: 'Family updates' })

    await user.click(updates)
    await user.click(updates)
    view.unmount()
    await act(async () => { first.resolve({ ...initial, notificationsEnabled: false }) })

    expect(persistence.updateProfilePreferences.mock.calls).toEqual([
      [{ notificationsEnabled: false }, { expectedSubject: 'alice' }],
      [{ notificationsEnabled: true }, { expectedSubject: 'alice' }],
    ])
    await act(async () => { second.resolve(initial) })
    expect(persistence.updateProfilePreferences).toHaveBeenCalledTimes(2)
  })

  it('keeps the old account guard on queued changes when the account view is replaced', async () => {
    const user = userEvent.setup()
    const save = deferredPreferences()
    persistence.updateProfilePreferences.mockReturnValueOnce(save.promise)
      .mockRejectedValueOnce(new Error('The account changed before your preferences could be saved.'))
    const view = render(
      <ProfilePreferences key="alice" userId="alice" widgetStorageSubject={storageSubject} />,
    )
    await waitForInitialPreferences()
    const updates = screen.getByRole('switch', { name: 'Family updates' })
    await user.click(updates)
    await user.click(updates)
    view.rerender(<ProfilePreferences key="bob" userId="bob" widgetStorageSubject="bob:family:family-2" />)
    await act(async () => { save.resolve({ ...initial, notificationsEnabled: false }) })
    expect(screen.getByRole('switch', { name: 'Family updates' })).toHaveAttribute('aria-checked', 'true')
    expect(persistence.updateProfilePreferences.mock.calls).toEqual([
      [{ notificationsEnabled: false }, { expectedSubject: 'alice' }],
      [{ notificationsEnabled: true }, { expectedSubject: 'alice' }],
    ])
    expect(screen.queryByText('Family updates could not be saved.')).not.toBeInTheDocument()
  })
})

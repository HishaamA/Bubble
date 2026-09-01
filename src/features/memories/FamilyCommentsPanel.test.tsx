import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FamilyCommentsPanel } from './FamilyCommentsPanel'

const voicePoint = {
  id: 'voice-point',
  kind: 'voice' as const,
  pitch: 4,
  yaw: 12,
  message: 'Grandma remembers this corner.',
  audioUrl: null,
}

function renderPanel(overrides: Partial<ComponentProps<typeof FamilyCommentsPanel>> = {}) {
  const props: ComponentProps<typeof FamilyCommentsPanel> = {
    open: true,
    comments: [],
    annotations: [voicePoint],
    targetAnnotationId: null,
    onClose: vi.fn(),
    onTargetChange: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  return { props, ...render(<FamilyCommentsPanel {...props} />) }
}

describe('FamilyCommentsPanel controls', () => {
  it('traps keyboard focus, closes with Escape, and exposes point targeting', async () => {
    const user = userEvent.setup()
    const { props } = renderPanel()
    const dialog = screen.getByRole('dialog', { name: 'Family comments' })
    const composer = screen.getByRole('textbox', {
      name: /comment on this whole moment/i,
    })

    await waitFor(() => expect(composer).toHaveFocus())
    const post = within(dialog).getByRole('button', { name: 'Post' })
    post.focus()
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Close comments' }))
      .toHaveFocus()

    await user.click(within(dialog).getByRole('button', {
      name: /Voice: Grandma remembers this corner/,
    }))
    expect(props.onTargetChange).toHaveBeenCalledWith('voice-point')

    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('submits trimmed text once when two activations land in the same turn', async () => {
    let finishSubmit: () => void = () => undefined
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      finishSubmit = resolve
    }))
    renderPanel({ onSubmit })
    await userEvent.type(
      screen.getByRole('textbox', { name: /comment on this whole moment/i }),
      '  Save this once.  ',
    )
    const post = screen.getByRole('button', { name: 'Post' })

    act(() => {
      fireEvent.click(post)
      fireEvent.click(post)
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('Save this once.', null)

    await act(async () => finishSubmit())
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('keeps failed text available for a deliberate retry', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error('offline'))
    renderPanel({ onSubmit })
    const composer = screen.getByRole('textbox', {
      name: /comment on this whole moment/i,
    })

    await user.type(composer, 'Try again later')
    await user.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(composer).toHaveValue('Try again later')
  })
})

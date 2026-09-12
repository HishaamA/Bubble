import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanCard } from './PlanCard'
import type { FamilyEvent } from './familyPlanTypes'

const event: FamilyEvent = {
  id: 'picnic', title: 'Family picnic', date: '2026-09-12', time: '09:00',
  startsAt: new Date(2026, 8, 12, 9).toISOString(), location: 'Park', category: 'other',
}
const checklist = [{ id: 'snacks', label: 'Pack snacks' }, { id: 'water', label: 'Bring water' }]

function props() {
  return {
    event, revealed: false, checklist, completedChecklistItems: new Set(['snacks']),
    reminder: { enabled: false, busy: false }, completionBusy: false,
    composerInputRef: createRef<HTMLInputElement>(),
    composer: {
      open: false, value: '', onValueChange: vi.fn(), onToggle: vi.fn(),
      onCancel: vi.fn(), onSubmit: vi.fn((submitEvent) => submitEvent.preventDefault()),
    },
    onToggleReminder: vi.fn(), onToggleTask: vi.fn(), onComplete: vi.fn(),
  }
}

describe('PlanCard', () => {
  it('renders controlled completion and delegates checklist changes without persisting them', () => {
    const input = props()
    render(<PlanCard {...input} />)
    expect(screen.getByRole('heading', { name: 'Family picnic' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Pack snacks' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Bring water' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bring water' }))
    expect(input.onToggleTask).toHaveBeenCalledExactlyOnceWith(checklist[1])
    expect(screen.getByRole('checkbox', { name: 'Bring water' })).not.toBeChecked()
    expect(input.completedChecklistItems).toEqual(new Set(['snacks']))
  })

  it('respects reminder and completion locks while leaving mutation ownership in the parent', () => {
    const input = props()
    const view = render(<PlanCard {...input} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remind me about Family picnic' }))
    fireEvent.click(screen.getByRole('button', { name: 'Complete task: Family picnic' }))
    expect(input.onToggleReminder).toHaveBeenCalledTimes(1)
    expect(input.onComplete).toHaveBeenCalledTimes(1)
    view.rerender(<PlanCard {...input} reminder={{ enabled: true, busy: true }} completionBusy />)
    const reminder = screen.getByRole('button', { name: 'Remove reminder for Family picnic' })
    expect(reminder).toBeDisabled()
    expect(reminder).toHaveAttribute('aria-pressed', 'true')
    expect(reminder).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Complete task: Family picnic' })).toBeDisabled()
  })

  it('forwards the existing composer ref and delegates editing, submit, Escape and cancel', () => {
    const input = props()
    render(<PlanCard {...input} composer={{ ...input.composer, open: true, value: 'Bring dessert' }} />)
    const field = screen.getByRole('textbox', { name: 'New task' })
    expect(input.composerInputRef.current).toBe(field)
    expect(field).toHaveValue('Bring dessert')
    fireEvent.change(field, { target: { value: 'Bring fruit' } })
    expect(input.composer.onValueChange).toHaveBeenCalledExactlyOnceWith('Bring fruit')
    fireEvent.submit(screen.getByRole('form', { name: 'Add task to Family picnic' }))
    expect(input.composer.onSubmit).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(input.composer.onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(input.composer.onToggle).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not show a task input until the parent selects that card', () => {
    const input = props()
    render(<PlanCard {...input} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(input.composerInputRef.current).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    expect(input.composer.onToggle).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('preserves demo-only attendee and time presentation without adding photo media', () => {
    const input = props()
    const view = render(<PlanCard {...input} revealed event={{ ...event, demoPresentation: {
      attendees: [{ name: 'Mum', initials: 'MU' }], additionalAttendees: 2,
      checklist: [], doodle: 'sun', timeStyle: 'next-weekend',
    } }} />)
    expect(screen.getByText('Next weekend')).toBeInTheDocument()
    expect(screen.getByLabelText('Going: Mum, plus 2 more')).toBeInTheDocument()
    expect(view.container.querySelector('article')).toHaveClass('journal-events__event--revealed')
    expect(view.container.querySelector('img')).toBeNull()
  })
})

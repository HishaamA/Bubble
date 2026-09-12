import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanWeekPicker } from './PlanWeekPicker'
import type { FamilyEvent } from './familyPlanTypes'

const event: FamilyEvent = {
  id: 'picnic', title: 'Family picnic', date: '2026-09-12', time: '09:00',
  startsAt: new Date(2026, 8, 12, 9).toISOString(), location: 'Park', category: 'other',
}

describe('PlanWeekPicker', () => {
  it('renders the selected local week and announces which dates contain plans', () => {
    render(<PlanWeekPicker selectedPlanDay="2026-09-12" events={[event]} onChoosePlanDay={vi.fn()} />)
    expect(screen.getByRole('navigation', { name: 'Family plans, Sep 7 – Sep 13' })).toBeInTheDocument()
    const selected = screen.getByRole('button', { name: 'Saturday, September 12, has plans' })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(selected).toHaveAttribute('data-has-plans', 'true')
    expect(screen.getByRole('button', { name: 'Sunday, September 13' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('delegates day and week selection without changing its controlled selected date', () => {
    const onChoose = vi.fn()
    render(<PlanWeekPicker selectedPlanDay="2026-09-12" events={[]} onChoosePlanDay={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Monday, September 7' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    expect(onChoose.mock.calls).toEqual([['2026-09-07'], ['2026-09-05'], ['2026-09-19']])
    expect(screen.getByRole('button', { name: 'Saturday, September 12' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('updates selection, month boundaries and plan markers when parent props change', () => {
    const view = render(<PlanWeekPicker selectedPlanDay="2026-09-12" events={[event]} onChoosePlanDay={vi.fn()} />)
    view.rerender(<PlanWeekPicker selectedPlanDay="2027-01-01" events={[]} onChoosePlanDay={vi.fn()} />)
    expect(screen.getByRole('navigation', { name: 'Family plans, Dec 28 – Jan 3' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Friday, January 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /has plans/ })).not.toBeInTheDocument()
  })
})

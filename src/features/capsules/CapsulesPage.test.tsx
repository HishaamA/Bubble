import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CapsulesPage } from './CapsulesPage'

describe('CapsulesPage', () => {
  it('adds a capsule to the local preview', async () => {
    const user = userEvent.setup()
    render(<CapsulesPage />)

    await user.click(screen.getByRole('button', { name: 'Create a capsule' }))
    await user.type(screen.getByRole('textbox', { name: 'Capsule name' }), 'For the next adventure')
    await user.click(screen.getByRole('button', { name: 'Save local preview' }))

    expect(screen.getByRole('heading', { name: 'For the next adventure' })).toBeInTheDocument()
    expect(screen.getByText('4 capsules')).toBeInTheDocument()
  })
})

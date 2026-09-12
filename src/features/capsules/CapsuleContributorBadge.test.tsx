import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CapsuleContributorBadge } from './CapsuleContributorBadge'
import { capsuleContributorAvatarUrl, capsuleContributorInitials } from './capsuleContributor'

describe('Capsule contributor attribution', () => {
  it('shows the actual uploader photo with an accessible credit', () => {
    const view = render(<CapsuleContributorBadge name="Simreen Siraj" avatarUrl="https://images.example/simreen.jpg" />)
    expect(screen.getByRole('img', { name: 'Uploaded by Simreen Siraj' })).toBeInTheDocument()
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://images.example/simreen.jpg')
    expect(view.container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer')
  })

  it('uses initials for an absent or unavailable avatar and retries a changed source', () => {
    const view = render(<CapsuleContributorBadge name="Simreen Siraj" />)
    expect(screen.getByText('SS')).toBeInTheDocument()
    view.rerender(<CapsuleContributorBadge name="Simreen Siraj" avatarUrl="https://images.example/old.jpg" />)
    fireEvent.error(view.container.querySelector('img')!)
    expect(screen.getByText('SS')).toBeInTheDocument()
    view.rerender(<CapsuleContributorBadge name="Simreen Siraj" avatarUrl="https://images.example/new.jpg" />)
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://images.example/new.jpg')
  })

  it.each(['javascript:alert(1)', 'file:///private/avatar.jpg', 'http://images.example/a.jpg', 'https://user:secret@images.example/a.jpg', 'avatars/private.jpg', ''])('rejects unsafe/non-public avatar source %s', (value) => {
    expect(capsuleContributorAvatarUrl(value)).toBeUndefined()
    const view = render(<CapsuleContributorBadge name="Family" avatarUrl={value} />)
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('keeps initials compact without splitting a Unicode character', () => {
    expect(capsuleContributorInitials('  Simreen   Siraj  ')).toBe('SS')
    expect(capsuleContributorInitials('')).toBe('♡')
    expect(capsuleContributorInitials('😊 Family')).toBe('😊F')
  })
})

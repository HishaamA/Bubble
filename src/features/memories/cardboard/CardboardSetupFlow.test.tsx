import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CardboardSetupFlow,
  type CardboardMemoryChoice,
} from './CardboardSetupFlow'

const orientationMock = vi.hoisted(() => ({ landscape: false }))

vi.mock('./useLandscapeOrientation', () => ({
  useLandscapeOrientation: () => orientationMock.landscape,
}))

const choices: readonly CardboardMemoryChoice[] = [
  {
    id: 'dinner',
    label: 'Sunday dinner',
    sender: 'Mum',
    thumbnailUrl: '/dinner.jpg',
  },
  {
    id: 'beach',
    label: 'Beach day',
    sender: 'Hishaam',
    thumbnailUrl: '/beach.jpg',
  },
]

function SetupHarness({
  onGo = vi.fn(),
}: {
  onGo?: (options?: { forceLandscape?: boolean }) => void
}) {
  const [selectedMemoryId, setSelectedMemoryId] = useState('dinner')
  return (
    <CardboardSetupFlow
      open
      choices={choices}
      selectedMemoryId={selectedMemoryId}
      onSelectMemory={setSelectedMemoryId}
      onGo={onGo}
      onClose={vi.fn()}
    />
  )
}

describe('CardboardSetupFlow', () => {
  beforeEach(() => {
    orientationMock.landscape = false
  })

  it('keeps memory selection, rotation, and Cardboard insertion in that order', async () => {
    const user = userEvent.setup()
    const onGo = vi.fn()
    render(<SetupHarness onGo={onGo} />)

    expect(
      screen.getByRole('heading', { name: 'Choose a moment' }),
    ).toBeVisible()
    expect(
      screen.getByRole('radiogroup', {
        name: 'Choose from available memories',
      }),
    ).toBeVisible()
    expect(screen.getByText('Available memories')).toBeVisible()
    expect(
      screen.getByRole('radio', { name: /sunday dinner, mum/i }),
    ).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('radio', { name: /beach day, hishaam/i }))
    expect(
      screen.getByRole('radio', { name: /beach day, hishaam/i }),
    ).toHaveAttribute('aria-checked', 'true')

    await user.click(
      screen.getByRole('button', { name: 'Continue with Beach day' }),
    )

    expect(
      screen.getByRole('heading', { name: 'Turn your phone sideways' }),
    ).toBeVisible()
    expect(onGo).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: 'Use split view anyway' }),
    )

    expect(
      screen.getByRole('heading', { name: 'Place your phone in Cardboard' }),
    ).toBeVisible()
    expect(onGo).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onGo).toHaveBeenCalledWith({ forceLandscape: true })
  })

  it('lets the user return to the chooser before starting VR', async () => {
    const user = userEvent.setup()
    render(<SetupHarness />)

    await user.click(
      screen.getByRole('button', { name: 'Continue with Sunday dinner' }),
    )
    await user.click(
      screen.getByRole('button', { name: 'Use split view anyway' }),
    )
    await user.click(
      screen.getByRole('button', { name: 'Choose another memory' }),
    )

    expect(
      screen.getByRole('heading', { name: 'Choose a moment' }),
    ).toBeVisible()
  })

  it('advances automatically after the phone reaches landscape', async () => {
    orientationMock.landscape = true
    const user = userEvent.setup()
    const onGo = vi.fn()
    render(<SetupHarness onGo={onGo} />)

    await user.click(
      screen.getByRole('button', { name: 'Continue with Sunday dinner' }),
    )

    expect(
      screen.getByRole('heading', { name: 'Place your phone in Cardboard' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Use split view anyway' }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onGo).toHaveBeenCalledWith({ forceLandscape: false })
  })
})

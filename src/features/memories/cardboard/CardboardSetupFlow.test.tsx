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
  allowMemorySelection = true,
  busy = false,
  error,
}: {
  onGo?: (options?: { forceLandscape?: boolean }) => void
  allowMemorySelection?: boolean
  busy?: boolean
  error?: string | null
}) {
  const [selectedMemoryId, setSelectedMemoryId] = useState('dinner')
  return (
    <CardboardSetupFlow
      open
      choices={choices}
      selectedMemoryId={selectedMemoryId}
      allowMemorySelection={allowMemorySelection}
      busy={busy}
      error={error}
      onSelectMemory={setSelectedMemoryId}
      onGo={onGo}
      onClose={vi.fn()}
    />
  )
}

function ClosableSetupHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open VR setup
      </button>
      <CardboardSetupFlow
        open={open}
        choices={choices}
        selectedMemoryId="dinner"
        onSelectMemory={vi.fn()}
        onGo={vi.fn()}
        onClose={() => setOpen(false)}
      />
    </>
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

  it('contains focus, closes with Escape, and returns focus to its opener', async () => {
    const user = userEvent.setup()
    render(<ClosableSetupHarness />)
    const opener = screen.getByRole('button', { name: 'Open VR setup' })

    await user.click(opener)
    let close = screen.getByRole('button', { name: 'Close VR setup' })
    expect(close).toHaveFocus()

    await user.click(close)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()

    await user.click(opener)
    close = screen.getByRole('button', { name: 'Close VR setup' })
    expect(close).toHaveFocus()

    await user.tab({ shift: true })
    expect(
      screen.getByRole('button', { name: 'Continue with Sunday dinner' }),
    ).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
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

  it('starts with the current memory when selection is disabled', async () => {
    const user = userEvent.setup()
    const onGo = vi.fn()
    render(<SetupHarness allowMemorySelection={false} onGo={onGo} />)

    expect(
      screen.queryByRole('heading', { name: 'Choose a moment' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('radiogroup', {
        name: 'Choose from available memories',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Turn your phone sideways' }),
    ).toBeVisible()
    expect(screen.getByText('Sunday dinner')).toBeVisible()
    expect(screen.getByText('1 of 2')).toBeVisible()

    await user.click(
      screen.getByRole('button', { name: 'Use split view anyway' }),
    )

    expect(
      screen.queryByRole('button', { name: 'Choose another memory' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onGo).toHaveBeenCalledWith({ forceLandscape: true })
  })

  it('announces a launch error and disables Go while retrying', async () => {
    const user = userEvent.setup()
    render(
      <SetupHarness
        allowMemorySelection={false}
        busy
        error="The panorama is still preparing."
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Use split view anyway' }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The panorama is still preparing.',
    )
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  })
})

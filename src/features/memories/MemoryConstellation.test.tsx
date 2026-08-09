import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryConstellation } from './MemoryConstellation'
import { BUBBLE_PLACEMENT_STORAGE_KEY } from './bubblePlacement'
import { memories } from './memories'
import type { PanoramaMoment } from './shared'
import {
  getSharedMomentPositions,
  getSharedMomentWorldHeightPercent,
} from './sharedMomentLayout'

const testNow = new Date(2026, 7, 26, 12)

const sharedMoment: PanoramaMoment = {
  id: 'family-balcony',
  blob: new Blob(['panorama'], { type: 'image/jpeg' }),
  objectUrl: 'blob:family-balcony',
  label: 'Family balcony',
  caption: 'Everyone made it.',
  createdAt: '2026-08-26T10:00:00.000Z',
  width: 4000,
  height: 2000,
  source: 'manual',
  uploaderDisplayName: 'Maya',
  annotations: [
    {
      id: 'balcony-note',
      kind: 'text',
      pitch: 3,
      yaw: 18,
      message: 'Grandma planted this jasmine.',
      audioUrl: null,
    },
  ],
}

const ownedSharedMoment: PanoramaMoment = {
  ...sharedMoment,
  id: 'owned-family-balcony',
  objectUrl: 'blob:owned-family-balcony',
  uploaderDisplayName: 'You',
  ownedByCurrentUser: true,
  familySynced: true,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.localStorage.removeItem(BUBBLE_PLACEMENT_STORAGE_KEY)
})

describe('MemoryConstellation', () => {
  it('reschedules its center layout after Strict Mode effect cleanup', () => {
    let frameId = 0
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => ++frameId)
    const cancelFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined)

    render(
      <StrictMode>
        <MemoryRouter>
          <MemoryConstellation now={testNow} />
        </MemoryRouter>
      </StrictMode>,
    )

    expect(cancelFrame).toHaveBeenCalledWith(1)
    expect(requestFrame).toHaveBeenCalledTimes(2)
  })

  it('exposes the memory bubbles as descriptive controls', () => {
    render(
      <MemoryRouter>
        <MemoryConstellation now={testNow} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'Moments' })).toBeInTheDocument()
    expect(screen.getByText('Wednesday, August 26')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open sunday dinner memory/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /open .* memory/i })).toHaveLength(10)
    expect(screen.queryByText('Today’s Relay')).not.toBeInTheDocument()
    expect(document.querySelector('.memory-bubble--featured')).not.toBeInTheDocument()
    const dinner = screen.getByRole('button', {
      name: /open sunday dinner memory from mum/i,
    })
    expect(dinner.querySelector('.memory-bubble__arc-title')).toHaveTextContent(
      'Sunday dinner',
    )
    expect(dinner.querySelector('.memory-bubble__arc-sender')).toHaveTextContent(
      /^Mum$/,
    )

    const arcPathIds = Array.from(
      document.querySelectorAll<SVGPathElement>('.memory-bubble__arc-path'),
      ({ id }) => id,
    )
    expect(arcPathIds).toHaveLength(20)
    expect(new Set(arcPathIds)).toHaveProperty('size', arcPathIds.length)
    expect(
      memories.every(
        (memory) =>
          !('featured' in memory) && !('size' in memory.position),
      ),
    ).toBe(true)
  })

  it('opens the selected memory route', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<p>Panorama opened</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: /open sunday dinner memory/i }))
    expect(screen.getByText('Panorama opened')).toBeInTheDocument()
  })

  it('opens a focused bubble with the keyboard', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<p>Keyboard panorama opened</p>} />
        </Routes>
      </MemoryRouter>,
    )

    screen.getByRole('button', { name: /open sunday dinner memory/i }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Keyboard panorama opened')).toBeInTheDocument()
  })

  it('blocks the native image preview and drag ghost inside a bubble', () => {
    render(
      <MemoryRouter>
        <MemoryConstellation now={testNow} />
      </MemoryRouter>,
    )

    const dinner = screen.getByRole('button', {
      name: /open sunday dinner memory/i,
    })
    const image = dinner.querySelector('img')
    expect(image).not.toBeNull()

    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    })
    const dragStart = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
    })

    expect(image?.dispatchEvent(contextMenu)).toBe(false)
    expect(contextMenu).toHaveProperty('defaultPrevented', true)
    expect(image?.dispatchEvent(dragStart)).toBe(false)
    expect(dragStart).toHaveProperty('defaultPrevented', true)
  })

  it('surfaces the newest received 360 as a memory bubble', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={<MemoryConstellation sharedMoments={[sharedMoment]} />}
          />
          <Route path="/memory/:memoryId" element={<p>Shared panorama opened</p>} />
        </Routes>
      </MemoryRouter>,
    )

    const sharedBubble = screen.getByRole('button', {
      name: /open family balcony shared by maya/i,
    })
    expect(
      sharedBubble.querySelector('.memory-bubble__arc-title'),
    ).toHaveTextContent('Family balcony')
    expect(
      sharedBubble.querySelector('.memory-bubble__arc-sender'),
    ).toHaveTextContent(/^Maya$/)
    expect(sharedBubble).toHaveAccessibleName(/1 memory point/i)
    expect(
      sharedBubble.querySelector('.memory-bubble__point-count'),
    ).toHaveTextContent('+1')

    await user.click(sharedBubble)
    expect(screen.getByText('Shared panorama opened')).toBeInTheDocument()
  })

  it('never swaps a built-in memory in or out when a family upload is removed', () => {
    const view = render(
      <MemoryRouter>
        <MemoryConstellation sharedMoments={[sharedMoment]} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('button', {
      name: /open sunset walk memory/i,
    })).toBeInTheDocument()
    expect(document.querySelectorAll('.memory-bubble')).toHaveLength(11)

    view.rerender(
      <MemoryRouter>
        <MemoryConstellation sharedMoments={[]} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('button', {
      name: /open sunset walk memory/i,
    })).toBeInTheDocument()
    expect(document.querySelectorAll('.memory-bubble')).toHaveLength(10)
  })

  it('keeps a touch tap targeted at the shared open button during pointer capture', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={<MemoryConstellation sharedMoments={[sharedMoment]} />}
          />
          <Route path="/memory/:memoryId" element={<p>Touch panorama opened</p>} />
        </Routes>
      </MemoryRouter>,
    )

    const sharedSurface = screen.getByRole('button', {
      name: /open family balcony shared by maya/i,
    })
    const sharedShell = sharedSurface.closest<HTMLElement>('.memory-bubble')
    if (!sharedShell) throw new Error('Shared bubble shell was not rendered')
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(sharedSurface, {
      setPointerCapture: capture,
      releasePointerCapture: release,
    })
    Object.assign(sharedShell, { setPointerCapture: vi.fn() })

    fireEvent.pointerDown(sharedSurface, {
      pointerId: 21,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 120,
      clientY: 180,
    })
    expect(capture).toHaveBeenCalledWith(21)
    expect(sharedShell.setPointerCapture).not.toHaveBeenCalled()

    fireEvent.pointerUp(sharedSurface, {
      pointerId: 21,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 120,
      clientY: 180,
    })
    expect(release).toHaveBeenCalledWith(21)
    fireEvent.click(sharedSurface, { detail: 1 })

    expect(screen.getByText('Touch panorama opened')).toBeInTheDocument()
  })

  it('reveals removal only after a sustained hold on your own 360, then requires the X', () => {
    vi.useFakeTimers()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onDelete360 = vi.fn(async () => undefined)
    render(
      <MemoryRouter>
        <MemoryConstellation
          sharedMoments={[ownedSharedMoment, sharedMoment]}
          onDelete360={onDelete360}
        />
      </MemoryRouter>,
    )

    const ownedBubble = screen.getByRole('button', {
      name: /open family balcony shared by you/i,
    })
    const receivedBubble = screen.getByRole('button', {
      name: /open family balcony shared by maya/i,
    })
    const ownedBubbleShell = ownedBubble.closest<HTMLElement>('.memory-bubble')
    const receivedBubbleShell = receivedBubble.closest<HTMLElement>('.memory-bubble')
    const removeButton = screen.getByRole('button', {
      name: 'Remove Family balcony from your family',
    })
    expect(removeButton).toHaveAttribute('data-visible', 'false')
    expect(screen.getAllByRole('button', { name: /remove family balcony/i })).toHaveLength(1)

    fireEvent.pointerDown(receivedBubble, {
      pointerId: 11,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    })
    act(() => vi.advanceTimersByTime(1_300))
    expect(receivedBubbleShell).toHaveAttribute('data-delete-mode', 'false')
    expect(receivedBubbleShell).toHaveAttribute('data-picked-up', 'true')
    expect(removeButton).toHaveAttribute('data-visible', 'false')
    fireEvent.pointerUp(receivedBubble, {
      pointerId: 11,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    })
    expect(receivedBubbleShell).toHaveAttribute('data-picked-up', 'false')

    fireEvent.pointerDown(ownedBubble, {
      pointerId: 12,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 120,
      clientY: 120,
    })
    // A real thumb shifts slightly while being held. That jitter must not
    // cancel the iPhone-style edit gesture.
    fireEvent.pointerMove(ownedBubble, {
      pointerId: 12,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 132,
      clientY: 120,
    })
    act(() => vi.advanceTimersByTime(1_300))
    expect(confirm).not.toHaveBeenCalled()
    expect(ownedBubble).toHaveAccessibleName(
      'Family balcony selected for removal',
    )
    expect(ownedBubbleShell).toHaveAttribute('data-delete-mode', 'true')
    expect(ownedBubbleShell).toHaveAttribute('data-picked-up', 'true')
    expect(removeButton).toHaveAttribute('data-visible', 'true')
    expect(removeButton.parentElement).toHaveClass('memory-bubble__drift')
    expect(removeButton.closest('.memory-bubble__motion')).toBeNull()

    fireEvent.pointerMove(ownedBubble, {
      pointerId: 12,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 145,
      clientY: 145,
    })
    fireEvent.pointerUp(ownedBubble, {
      pointerId: 12,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 145,
      clientY: 145,
    })
    expect(ownedBubbleShell).toHaveAttribute('data-picked-up', 'false')
    fireEvent.click(ownedBubble, { detail: 1 })
    expect(confirm).not.toHaveBeenCalled()
    expect(onDelete360).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(500))
    fireEvent.click(ownedBubble, { detail: 1 })
    expect(confirm).not.toHaveBeenCalled()

    fireEvent.pointerDown(removeButton, {
      pointerId: 13,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 92,
      clientY: 92,
    })
    fireEvent.pointerUp(removeButton, {
      pointerId: 13,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 92,
      clientY: 92,
    })
    fireEvent.click(removeButton, { detail: 1 })
    expect(confirm).toHaveBeenCalledWith(
      'Remove “Family balcony” from your phone and your family’s phones?',
    )
    expect(onDelete360).toHaveBeenCalledWith(ownedSharedMoment.id)
  })

  it('lets a keyboard user enter remove mode without exposing it on received posts', () => {
    render(
      <MemoryRouter>
        <MemoryConstellation
          sharedMoments={[ownedSharedMoment, sharedMoment]}
          onDelete360={vi.fn(async () => undefined)}
        />
      </MemoryRouter>,
    )

    const ownedBubble = screen.getByRole('button', {
      name: /open family balcony shared by you/i,
    })
    const receivedBubble = screen.getByRole('button', {
      name: /open family balcony shared by maya/i,
    })
    const removeButton = screen.getByRole('button', {
      name: 'Remove Family balcony from your family',
    })
    fireEvent.keyDown(receivedBubble, { key: 'Delete' })
    expect(receivedBubble).toHaveAccessibleName(/open family balcony/i)
    expect(removeButton).toHaveAttribute('data-visible', 'false')

    fireEvent.keyDown(ownedBubble, { key: 'Delete' })
    expect(ownedBubble).toHaveAccessibleName(
      'Family balcony selected for removal',
    )
    expect(removeButton).toHaveAttribute('data-visible', 'true')
  })

  it('offers an assistive-technology remove action without requiring a gesture', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onDelete360 = vi.fn(async () => undefined)
    render(
      <MemoryRouter>
        <MemoryConstellation
          sharedMoments={[ownedSharedMoment]}
          onDelete360={onDelete360}
        />
      </MemoryRouter>,
    )

    const removeButton = screen.getByRole('button', {
      name: 'Remove Family balcony from your family',
    })
    expect(removeButton).toHaveAttribute('data-visible', 'false')

    fireEvent.click(removeButton)

    expect(confirm).toHaveBeenCalledOnce()
    expect(onDelete360).toHaveBeenCalledWith(ownedSharedMoment.id)
  })

  it('gives every cached shared moment a distinct position and grows the world', () => {
    const sharedMoments = Array.from({ length: 45 }, (_, index) => ({
      ...sharedMoment,
      id: `shared-${index}`,
      objectUrl: `blob:shared-${index}`,
      label: `Shared moment ${index}`,
    }))
    render(
      <MemoryRouter>
        <MemoryConstellation sharedMoments={sharedMoments} />
      </MemoryRouter>,
    )

    const sharedBubbles = Array.from(
      document.querySelectorAll<HTMLElement>('[data-shared-moment-id]'),
    )
    const positions = sharedBubbles.map(
      (bubble) =>
        `${bubble.style.getPropertyValue('--bubble-top')}:${bubble.style.getPropertyValue('--bubble-left')}`,
    )

    expect(sharedBubbles).toHaveLength(45)
    expect(new Set(positions)).toHaveProperty('size', 45)
    expect(screen.getByTestId('memory-constellation-space')).toHaveStyle({
      '--constellation-world-height': '268.57%',
    })

    const longArchivePositions = getSharedMomentPositions(205).map((position) =>
      position.join(':'),
    )
    expect(new Set(longArchivePositions)).toHaveProperty('size', 205)

    const worldHeightScale = getSharedMomentWorldHeightPercent(45) / 100
    const numericSharedPositions = sharedBubbles.map((bubble) => ({
        top: Number.parseFloat(bubble.style.getPropertyValue('--bubble-top')),
        left: Number.parseFloat(bubble.style.getPropertyValue('--bubble-left')),
      }))
    const renderedDistance = (
      first: { top: number; left: number },
      second: { top: number; left: number },
    ) => {
      const horizontal = ((first.left - second.left) * 1.4 * 320) / 100
      const vertical =
        ((first.top - second.top) * worldHeightScale * 560) / 100
      return Math.hypot(horizontal, vertical)
    }

    numericSharedPositions.forEach((sharedPosition, index) => {
      numericSharedPositions.slice(0, index).forEach((otherSharedPosition) => {
        expect(
          renderedDistance(sharedPosition, otherSharedPosition),
        ).toBeGreaterThanOrEqual(81.5)
      })
      memories.forEach(({ position }) => {
          expect(
            renderedDistance(sharedPosition, {
              top: Number.parseFloat(position.top),
              left: Number.parseFloat(position.left),
            }),
          ).toBeGreaterThanOrEqual(
            81.5,
          )
        })
    })
  })

  it('clamps the pan when a large shared world shrinks after deletion', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const sharedMoments = Array.from({ length: 60 }, (_, index) => ({
      ...sharedMoment,
      id: `shrinking-shared-${index}`,
      objectUrl: `blob:shrinking-shared-${index}`,
      label: `Shrinking shared moment ${index}`,
    }))
    const view = render(
      <MemoryRouter>
        <MemoryConstellation sharedMoments={sharedMoments} />
      </MemoryRouter>,
    )

    const field = screen.getByLabelText('Family memory constellation')
    const space = screen.getByTestId('memory-constellation-space')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    Object.defineProperties(space, {
      clientWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 1_176 },
    })
    document.querySelectorAll<HTMLElement>('.memory-bubble').forEach((bubble) => {
      Object.defineProperties(bubble, {
        offsetLeft: { configurable: true, value: 20 },
        offsetTop: { configurable: true, value: 20 },
        offsetWidth: { configurable: true, value: 80 },
        offsetHeight: { configurable: true, value: 80 },
      })
    })
    const lastShared = screen
      .getByRole('button', {
        name: /open shrinking shared moment 59 shared by maya/i,
      })
      .closest<HTMLElement>('.memory-bubble')
    if (!lastShared) throw new Error('Last shared bubble was not rendered')
    Object.defineProperties(lastShared, {
      offsetLeft: { configurable: true, value: 320 },
      offsetTop: { configurable: true, value: 1_000 },
    })

    vi.advanceTimersByTime(20)
    expect(field).toHaveStyle({ '--constellation-pan-y': '-760px' })

    Object.defineProperty(space, 'clientHeight', {
      configurable: true,
      value: 896,
    })
    view.rerender(
      <MemoryRouter>
        <MemoryConstellation sharedMoments={[]} />
      </MemoryRouter>,
    )
    vi.advanceTimersByTime(20)

    expect(field).toHaveStyle({ '--constellation-pan-y': '-616px' })
  })

  it('keeps a long-pressed bubble in the constellation while it is dragged', () => {
    vi.useFakeTimers()
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<p>Unexpected panorama</p>} />
        </Routes>
      </MemoryRouter>,
    )

    const field = screen.getByLabelText('Family memory constellation')
    const space = screen.getByTestId('memory-constellation-space')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    Object.defineProperties(space, {
      clientWidth: { configurable: true, value: 594 },
      clientHeight: { configurable: true, value: 896 },
    })
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 360,
      bottom: 560,
      left: 0,
      width: 360,
      height: 560,
      toJSON: () => ({}),
    })

    const dinner = screen.getByRole('button', {
      name: /open sunday dinner memory/i,
    })
    Object.defineProperties(dinner, {
      offsetLeft: { configurable: true, value: 86 },
      offsetTop: { configurable: true, value: 196 },
      offsetWidth: { configurable: true, value: 180 },
      offsetHeight: { configurable: true, value: 180 },
    })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(dinner, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: {
        configurable: true,
        value: releasePointerCapture,
      },
    })
    const dinnerImage = dinner.querySelector('img')
    expect(dinnerImage).not.toBeNull()

    vi.advanceTimersByTime(20)
    const initialPanX = field.style.getPropertyValue('--constellation-pan-x')
    const initialPanY = field.style.getPropertyValue('--constellation-pan-y')

    fireEvent.pointerDown(dinnerImage as HTMLImageElement, {
      pointerId: 91,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 180,
      clientY: 280,
    })
    vi.advanceTimersByTime(20)

    const dinnerMotion = dinner.querySelector<HTMLElement>(
      '.memory-bubble__motion',
    )
    expect(
      Number(dinnerMotion?.style.getPropertyValue('--bubble-motion-scale')),
    ).toBeGreaterThan(
      Number(dinnerMotion?.style.getPropertyValue('--bubble-center-scale')),
    )

    fireEvent.pointerUp(dinnerImage as HTMLImageElement, {
      pointerId: 91,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 180,
      clientY: 280,
    })
    vi.advanceTimersByTime(20)
    expect(dinnerMotion?.style.getPropertyValue('--bubble-motion-scale')).toBe(
      dinnerMotion?.style.getPropertyValue('--bubble-center-scale'),
    )

    fireEvent.pointerDown(dinnerImage as HTMLImageElement, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 110,
      clientY: 180,
    })
    vi.advanceTimersByTime(700)
    fireEvent.pointerMove(dinnerImage as HTMLImageElement, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 145,
      clientY: 220,
    })
    fireEvent.pointerUp(dinnerImage as HTMLImageElement, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 145,
      clientY: 220,
    })
    vi.advanceTimersByTime(20)

    expect(setPointerCapture).toHaveBeenCalledWith(1)
    expect(releasePointerCapture).toHaveBeenCalledWith(1)
    expect(field.style.getPropertyValue('--constellation-pan-x')).toBe(
      initialPanX,
    )
    expect(field.style.getPropertyValue('--constellation-pan-y')).toBe(
      initialPanY,
    )
    expect(field).toHaveAttribute('data-space-moved', 'false')
    expect(dinner).toHaveAttribute('data-picked-up', 'false')
    expect(parseFloat(dinner.style.getPropertyValue('--bubble-left'))).toBeCloseTo(
      (121 / 594) * 100,
    )
    expect(parseFloat(dinner.style.getPropertyValue('--bubble-top'))).toBeCloseTo(
      (236 / 896) * 100,
    )

    vi.advanceTimersByTime(350)
    fireEvent.click(dinner, { detail: 1 })

    expect(screen.queryByText('Unexpected panorama')).not.toBeInTheDocument()

    fireEvent.pointerDown(dinner, {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 145,
      clientY: 220,
    })
    fireEvent.pointerUp(dinner, {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 145,
      clientY: 220,
    })
    fireEvent.click(dinner, { detail: 1 })

    expect(screen.getByText('Unexpected panorama')).toBeInTheDocument()
  })

  it('restores an individually moved bubble on the next Moments visit', () => {
    window.localStorage.setItem(
      BUBBLE_PLACEMENT_STORAGE_KEY,
      JSON.stringify({ dinner: { top: 23.5, left: 31.25 } }),
    )

    render(
      <MemoryRouter>
        <MemoryConstellation />
      </MemoryRouter>,
    )

    const dinner = screen.getByRole('button', {
      name: /open sunday dinner memory/i,
    })
    expect(dinner.style.getPropertyValue('--bubble-top')).toBe('23.5%')
    expect(dinner.style.getPropertyValue('--bubble-left')).toBe('31.25%')
  })

  it('opens with a random memory already enlarged at the center', () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.21)
    render(
      <MemoryRouter>
        <MemoryConstellation />
      </MemoryRouter>,
    )

    const field = screen.getByLabelText('Family memory constellation')
    const space = screen.getByTestId('memory-constellation-space')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    Object.defineProperties(space, {
      clientWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 896 },
    })

    const bubbleButtons = screen.getAllByRole('button', {
      name: /open .* memory/i,
    })
    bubbleButtons.forEach((bubble) => {
      Object.defineProperties(bubble, {
        offsetLeft: { configurable: true, value: 20 },
        offsetTop: { configurable: true, value: 20 },
        offsetWidth: { configurable: true, value: 80 },
        offsetHeight: { configurable: true, value: 80 },
      })
    })
    const beach = screen.getByRole('button', {
      name: /open beach day memory/i,
    })
    Object.defineProperties(beach, {
      offsetLeft: { configurable: true, value: 500 },
      offsetTop: { configurable: true, value: 408 },
    })

    vi.advanceTimersByTime(20)

    expect(random).toHaveBeenCalledTimes(1)
    expect(beach).toHaveAttribute('data-center-focus', 'true')
    expect(
      Number(
        beach
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    ).toBeGreaterThanOrEqual(2.5)
    expect(field).toHaveStyle({
      '--constellation-pan-x': '-360px',
      '--constellation-pan-y': '-168px',
    })
  })

  it('centers and enlarges a random memory after navigating back to Moments', () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.21)
    render(
      <MemoryRouter initialEntries={['/journal']}>
        <Routes>
          <Route path="/journal" element={<Link to="/">Open Moments</Link>} />
          <Route path="/" element={<MemoryConstellation now={testNow} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      screen.queryByLabelText('Family memory constellation'),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: 'Open Moments' }))

    const field = screen.getByLabelText('Family memory constellation')
    const space = screen.getByTestId('memory-constellation-space')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    Object.defineProperties(space, {
      clientWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 896 },
    })

    const bubbles = screen.getAllByRole('button', {
      name: /open .* memory/i,
    })
    bubbles.forEach((bubble) => {
      Object.defineProperties(bubble, {
        offsetLeft: { configurable: true, value: 20 },
        offsetTop: { configurable: true, value: 20 },
        offsetWidth: { configurable: true, value: 80 },
        offsetHeight: { configurable: true, value: 80 },
      })
    })
    const beach = screen.getByRole('button', {
      name: /open beach day memory/i,
    })
    Object.defineProperties(beach, {
      offsetLeft: { configurable: true, value: 500 },
      offsetTop: { configurable: true, value: 408 },
    })

    vi.advanceTimersByTime(20)

    const bubbleScales = bubbles.map((bubble) =>
      Number(
        bubble
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    )
    // React Router may also use Math.random while creating the new history key.
    expect(random).toHaveBeenCalled()
    expect(beach).toHaveAttribute('data-center-focus', 'true')
    expect(bubbleScales.some((scale) => scale > 1)).toBe(true)
    expect(
      Number(
        beach
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    ).toBeGreaterThanOrEqual(2.5)
    expect(field).toHaveStyle({
      '--constellation-pan-x': '-360px',
      '--constellation-pan-y': '-168px',
    })
  })

  it('can randomly bring the newest received moment forward on entry', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    render(
      <MemoryRouter>
        <MemoryConstellation sharedMoments={[sharedMoment]} />
      </MemoryRouter>,
    )

    const field = screen.getByLabelText('Family memory constellation')
    const space = screen.getByTestId('memory-constellation-space')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    Object.defineProperties(space, {
      clientWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 896 },
    })
    document.querySelectorAll<HTMLElement>('.memory-bubble').forEach((bubble) => {
      Object.defineProperties(bubble, {
        offsetLeft: { configurable: true, value: 20 },
        offsetTop: { configurable: true, value: 20 },
        offsetWidth: { configurable: true, value: 80 },
        offsetHeight: { configurable: true, value: 80 },
      })
    })
    const sharedBubble = screen.getByRole('button', {
      name: /open family balcony shared by maya/i,
    })
    const sharedBubbleShell = sharedBubble.closest<HTMLElement>('.memory-bubble')
    if (!sharedBubbleShell) throw new Error('Shared bubble shell was not rendered')
    Object.defineProperties(sharedBubbleShell, {
      offsetLeft: { configurable: true, value: 500 },
      offsetTop: { configurable: true, value: 408 },
    })

    vi.advanceTimersByTime(20)

    expect(sharedBubbleShell).toHaveAttribute('data-center-focus', 'true')
    expect(
      Number(
        sharedBubbleShell
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    ).toBeGreaterThanOrEqual(2.5)
  })

  it('transfers center focus from the random entry bubble after panning', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.45)
    render(
      <MemoryRouter>
        <MemoryConstellation />
      </MemoryRouter>,
    )

    const field = screen.getByLabelText('Family memory constellation')
    const space = screen.getByTestId('memory-constellation-space')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    Object.defineProperties(space, {
      clientWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 896 },
    })
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 360,
      bottom: 560,
      left: 0,
      width: 360,
      height: 560,
      toJSON: () => ({}),
    })

    const bubbleButtons = screen.getAllByRole('button', {
      name: /open .* memory/i,
    })
    bubbleButtons.forEach((bubble) => {
      Object.defineProperties(bubble, {
        offsetLeft: { configurable: true, value: 20 },
        offsetTop: { configurable: true, value: 20 },
        offsetWidth: { configurable: true, value: 80 },
        offsetHeight: { configurable: true, value: 80 },
      })
    })
    const dinner = screen.getByRole('button', {
      name: /open sunday dinner memory/i,
    })
    const beach = screen.getByRole('button', {
      name: /open beach day memory/i,
    })
    Object.defineProperties(dinner, {
      offsetLeft: { configurable: true, value: 320 },
      offsetTop: { configurable: true, value: 408 },
    })
    Object.defineProperties(beach, {
      offsetLeft: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 408 },
    })

    vi.advanceTimersByTime(20)
    expect(dinner).toHaveAttribute('data-center-focus', 'true')
    expect(beach).toHaveAttribute('data-center-focus', 'false')
    expect(dinner.style.getPropertyValue('--bubble-size')).toBe(
      beach.style.getPropertyValue('--bubble-size'),
    )
    expect(
      Number(
        dinner
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    ).toBeGreaterThanOrEqual(2.5)

    fireEvent.pointerDown(field, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 180,
      clientY: 280,
    })
    fireEvent.pointerMove(field, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      clientX: -20,
      clientY: 280,
    })
    vi.advanceTimersByTime(20)

    expect(dinner).toHaveAttribute('data-center-focus', 'false')
    expect(beach).toHaveAttribute('data-center-focus', 'true')
    expect(
      Number(
        beach
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    ).toBeGreaterThanOrEqual(2.5)
    expect(
      Number(
        dinner
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    ).toBeLessThan(0.8)
  })

  it('restores and enlarges the originating memory instead of choosing randomly', () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.21)
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/', state: { restoreMemoryId: 'dinner' } },
        ]}
      >
        <MemoryConstellation />
      </MemoryRouter>,
    )

    const field = screen.getByLabelText('Family memory constellation')
    const space = screen.getByTestId('memory-constellation-space')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    Object.defineProperties(space, {
      clientWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 896 },
    })
    screen.getAllByRole('button', { name: /open .* memory/i }).forEach((bubble) => {
      Object.defineProperties(bubble, {
        offsetLeft: { configurable: true, value: 20 },
        offsetTop: { configurable: true, value: 20 },
        offsetWidth: { configurable: true, value: 80 },
        offsetHeight: { configurable: true, value: 80 },
      })
    })
    const dinner = screen.getByRole('button', {
      name: /open sunday dinner memory/i,
    })
    Object.defineProperties(dinner, {
      offsetLeft: { configurable: true, value: 320 },
      offsetTop: { configurable: true, value: 408 },
    })

    vi.advanceTimersByTime(20)

    expect(random).not.toHaveBeenCalled()
    expect(dinner).toHaveFocus()
    expect(dinner).toHaveAttribute('data-center-focus', 'true')
    expect(
      Number(
        dinner
          .querySelector<HTMLElement>('.memory-bubble__motion')
          ?.style.getPropertyValue('--bubble-center-scale'),
      ),
    ).toBeGreaterThanOrEqual(2.5)
  })
})

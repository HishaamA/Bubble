import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryConstellation } from './MemoryConstellation'
import { memories } from './memories'
import type { PanoramaMoment } from './shared'

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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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
    expect(field).toHaveStyle({
      '--constellation-pan-x': '39px',
      '--constellation-pan-y': '34px',
    })
    expect(field).toHaveAttribute('data-space-moved', 'true')

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
    Object.defineProperties(sharedBubble, {
      offsetLeft: { configurable: true, value: 500 },
      offsetTop: { configurable: true, value: 408 },
    })

    vi.advanceTimersByTime(20)

    expect(sharedBubble).toHaveAttribute('data-center-focus', 'true')
    expect(
      Number(
        sharedBubble
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

import { render, screen } from '@testing-library/react'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { LegacyRouteRedirect } from './LegacyRouteRedirect'

function LocationProbe() {
  const location = useLocation()

  return (
    <>
      <output aria-label="Current location">
        {location.pathname}
        {location.search}
        {location.hash}
      </output>
      <output aria-label="Route state">
        {JSON.stringify(location.state)}
      </output>
    </>
  )
}

describe('LegacyRouteRedirect', () => {
  it('preserves Capsule suffixes, query strings, hashes, and route state', () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/capsules/family-trip',
            search: '?view=recap',
            hash: '#photos',
            state: { source: 'legacy-link' },
          },
        ]}
      >
        <Routes>
          <Route
            path="/capsules/*"
            element={
              <LegacyRouteRedirect
                fromBase="/capsules"
                toBase="/capsule"
                preservePathSuffix
              />
            }
          />
          <Route path="/capsule/*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/capsule/family-trip?view=recap#photos',
    )
    expect(screen.getByLabelText('Route state')).toHaveTextContent(
      '{"source":"legacy-link"}',
    )
  })

  it('moves old Event links to Journal while retaining their context', () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/events/family-dinner',
            search: '?view=week',
            state: { selectedEvent: 'family-dinner' },
          },
        ]}
      >
        <Routes>
          <Route
            path="/events/*"
            element={
              <LegacyRouteRedirect fromBase="/events" toBase="/journal" />
            }
          />
          <Route path="/journal" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/journal?view=week',
    )
    expect(screen.getByLabelText('Route state')).toHaveTextContent(
      '{"selectedEvent":"family-dinner"}',
    )
  })
})

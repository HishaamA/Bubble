import type { PropsWithChildren } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Capture360Shortcut } from '../features/capture'
import { AppTabBar } from './AppTabBar'

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation()
  const navigate = useNavigate()
  const showCaptureShortcut =
    !location.pathname.startsWith('/capture') &&
    !location.pathname.startsWith('/memory/')

  return (
    <div className="app-viewport">
      <main className="app-content">{children}</main>
      {showCaptureShortcut ? (
        <Capture360Shortcut
          onClick={() =>
            navigate('/capture?mode=manual', { viewTransition: true })
          }
        />
      ) : null}
      <AppTabBar />
    </div>
  )
}

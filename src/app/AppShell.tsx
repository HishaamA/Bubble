import { Capacitor } from '@capacitor/core'
import type { PropsWithChildren } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../features/auth/authContext'
import { Capture360Shortcut } from '../features/capture'
import { AppTabBar } from './AppTabBar'

export function AppShell({ children }: PropsWithChildren) {
  const { status: authStatus } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const showPrimaryChrome =
    location.pathname !== '/login' &&
    location.pathname !== '/onboarding' &&
    authStatus === 'signed-in'
  const showPrimaryNavigation =
    showPrimaryChrome && !location.pathname.startsWith('/capture')
  const showCaptureShortcut = showPrimaryChrome && location.pathname === '/'
  const nativeApp = Capacitor.isNativePlatform()

  return (
    <div
      className={`app-viewport${nativeApp ? ' app-viewport--native' : ''}`}
      data-app-shell={nativeApp ? 'native' : 'web'}
    >
      <main className="app-content">{children}</main>
      {showCaptureShortcut ? (
        <Capture360Shortcut
          onClick={() =>
            navigate('/capture?mode=manual', { viewTransition: true })
          }
        />
      ) : null}
      {showPrimaryNavigation ? <AppTabBar /> : null}
    </div>
  )
}

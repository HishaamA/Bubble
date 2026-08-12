import { Capacitor } from '@capacitor/core'
import { useEffect, useRef, type PropsWithChildren } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../features/auth/authContext'
import { Capture360Shortcut } from '../features/capture'
import {
  blurActiveTextControl,
  installAppViewportGeometrySync,
  synchronizeAppViewportGeometry,
} from './appViewportGeometry'
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
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    return installAppViewportGeometrySync(viewport)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    blurActiveTextControl()
    synchronizeAppViewportGeometry(viewport)
    const frame = window.requestAnimationFrame(() => {
      synchronizeAppViewportGeometry(viewport)
    })
    const settled = window.setTimeout(() => {
      synchronizeAppViewportGeometry(viewport)
    }, 350)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settled)
    }
  }, [location.pathname, location.search])

  return (
    <div
      ref={viewportRef}
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

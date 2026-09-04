import { Capacitor } from '@capacitor/core'
import { useEffect, useRef, type PropsWithChildren } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { useAuth } from '../features/auth/authContext'
import { Capture360Shortcut } from '../features/capture/Capture360Shortcut'
import {
  blurActiveTextControl,
  installAppViewportGeometrySync,
  synchronizeAppViewportGeometry,
} from './appViewportGeometry'
import { AppTabBar } from './AppTabBar'

/** Owns persistent viewport geometry, primary navigation, and global shortcuts. */
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
  const showMomentsShortcuts = showPrimaryChrome && location.pathname === '/'
  const nativeApp = Capacitor.isNativePlatform()
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    // Capacitor keeps one WebView alive across routes. Mirror the native safe
    // area and visual viewport onto that persistent shell instead of sizing
    // every screen independently.
    return installAppViewportGeometrySync(viewport)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    // iOS can keep the software keyboard attached to an input after a route
    // change. Blurring first prevents the next page from inheriting its height.
    blurActiveTextControl()
    synchronizeAppViewportGeometry(viewport)
    const frame = window.requestAnimationFrame(() => {
      synchronizeAppViewportGeometry(viewport)
    })
    // A final pass catches the delayed viewport animation after the keyboard
    // or native navigation chrome finishes moving.
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
      {showMomentsShortcuts ? (
        <div
          className="moments-shortcuts"
          role="toolbar"
          aria-label="Moments shortcuts"
          aria-orientation="vertical"
        >
          <button
            className="round-control moments-vr-shortcut"
            type="button"
            aria-label="Set up Cardboard VR"
            onClick={() =>
              navigate('/memory/dinner', {
                state: { sourceMemoryId: 'dinner', openVr: true },
              })
            }
          >
            <Icon name="vr" size={24} />
          </button>
          <Capture360Shortcut
            onClick={() =>
              navigate('/capture?mode=manual', { viewTransition: true })
            }
          />
          <button
            className="moments-settings-shortcut"
            type="button"
            aria-label="Open settings"
            onClick={() => navigate('/settings', { viewTransition: true })}
          >
            <Icon name="settings" size={22} />
          </button>
        </div>
      ) : null}
      {showPrimaryNavigation ? <AppTabBar /> : null}
    </div>
  )
}

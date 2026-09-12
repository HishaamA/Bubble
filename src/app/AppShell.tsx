import { Capacitor } from '@capacitor/core'
import { useEffect, type PropsWithChildren } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { useAuth } from '../features/auth/authContext'
import { Capture360Shortcut } from '../features/capture/Capture360Shortcut'
import {
  blurActiveTextControl,
  synchronizeAppViewportGeometry,
} from './appViewportGeometry'
import { AppTabBar } from './AppTabBar'
import { loadJournalPreparation, loadJournalRoute, preloadPrimaryRoute, schedulePrimaryRoutePreloads } from './primaryRoutePreload'

/** Owns member-route navigation, global shortcuts, and route focus cleanup. */
export function AppShell({ children, memberCacheNamespace }: PropsWithChildren<{ memberCacheNamespace?: string }>) {
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

  useEffect(() => {
    if (!showPrimaryNavigation) return
    let active = true
    const cancel = schedulePrimaryRoutePreloads(location.pathname, async (route) => {
      if (route !== '/journal' || !memberCacheNamespace) {
        await preloadPrimaryRoute(route)
        return
      }
      const [, journal] = await Promise.all([loadJournalRoute(), loadJournalPreparation()])
      // The import can finish after sign-out/navigation. Only a still-active
      // member shell may warm its private, local People metadata; no face scan
      // or remote synchronization is started by this preparation.
      if (active) await journal.preloadPeopleTimelineSession(memberCacheNamespace)
    })
    return () => { active = false; cancel() }
  }, [location.pathname, memberCacheNamespace, showPrimaryNavigation])

  useEffect(() => {
    // iOS can keep the software keyboard attached to an input after a route
    // change. Blurring first prevents the next page from inheriting its height.
    blurActiveTextControl()
    synchronizeAppViewportGeometry(document.documentElement)
    const frame = window.requestAnimationFrame(() => {
      synchronizeAppViewportGeometry(document.documentElement)
    })
    // A final pass catches the delayed viewport animation after the keyboard
    // or native navigation chrome finishes moving.
    const settled = window.setTimeout(() => {
      synchronizeAppViewportGeometry(document.documentElement)
    }, 350)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settled)
    }
  }, [location.pathname, location.search])

  return (
    <div
      className={`app-viewport${nativeApp ? ' app-viewport--native' : ''}`}
      data-app-shell={nativeApp ? 'native' : 'web'}
    >
      <main className="app-content">{children}</main>
      {nativeApp && showPrimaryNavigation ? (
        <div className="app-status-bar-backdrop" aria-hidden="true" />
      ) : null}
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

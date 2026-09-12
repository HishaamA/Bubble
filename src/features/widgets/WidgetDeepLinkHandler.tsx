import { useEffect, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useNavigate } from 'react-router-dom'
import { parseBubbleWidgetDeepLink } from './widgetDeepLink'

/** Opens only widget destinations that match Bubble's bounded local routes. */
export function WidgetDeepLinkHandler({
  storageSubject,
}: {
  storageSubject: string
}) {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  const launchUrlPromiseRef = useRef<ReturnType<typeof CapacitorApp.getLaunchUrl> | null>(null)
  const launchUrlSubjectRef = useRef<string | null>(null)
  const launchUrlHandledRef = useRef(false)
  const liveOpenRevisionRef = useRef(0)

  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let active = true
    let stop = () => undefined

    function open(url: string) {
      if (!active) return false
      const destination = parseBubbleWidgetDeepLink(url)
      if (!destination) return false
      navigateRef.current(destination.to, {
        ...(destination.state ? { state: destination.state } : {}),
      })
      return true
    }

    // Capacitor retains the process launch URL. Read it only once for this
    // mounted handler so an account/family change cannot replay an old widget
    // destination. A newer live widget tap also wins over a slow launch read.
    if (!launchUrlPromiseRef.current) {
      launchUrlSubjectRef.current = storageSubject
      launchUrlPromiseRef.current = CapacitorApp.getLaunchUrl()
        .catch(() => undefined)
    }
    if (launchUrlSubjectRef.current !== storageSubject) {
      // A launch belongs to the account/family active when it was requested.
      // Once that scope changes, never replay it if the member later returns.
      launchUrlHandledRef.current = true
    } else if (!launchUrlHandledRef.current && launchUrlPromiseRef.current) {
      const liveRevision = liveOpenRevisionRef.current
      const launchUrlPromise = launchUrlPromiseRef.current
      void launchUrlPromise.then((launch) => {
        // Strict Mode runs effect setup, cleanup, then setup again. Let only
        // the currently active same-subject scope claim the cached result.
        if (!active || launchUrlHandledRef.current) return
        launchUrlHandledRef.current = true
        if (
          launch?.url &&
          liveOpenRevisionRef.current === liveRevision
        ) open(launch.url)
      })
    }
    void CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      if (open(url)) liveOpenRevisionRef.current += 1
    })
      .then((listener) => {
        if (active) stop = () => void listener.remove()
        else void listener.remove()
      })
      .catch(() => undefined)

    return () => {
      active = false
      stop()
    }
    // HashRouter gives useNavigate a new identity as the pathname changes.
    // Re-subscribing for that change would replay getLaunchUrl's persistent
    // launch URL on Back/Close and trap the member in the widget destination.
  }, [storageSubject])

  return null
}

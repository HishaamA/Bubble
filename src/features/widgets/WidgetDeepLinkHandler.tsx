import { useEffect } from 'react'
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

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let active = true
    let stop = () => undefined

    function open(url: string) {
      if (!active) return
      const destination = parseBubbleWidgetDeepLink(url)
      if (!destination) return
      navigate(destination.to, {
        ...(destination.state ? { state: destination.state } : {}),
      })
    }

    void CapacitorApp.getLaunchUrl()
      .then((launch) => {
        if (launch?.url) open(launch.url)
      })
      .catch(() => undefined)
    void CapacitorApp.addListener('appUrlOpen', ({ url }) => open(url))
      .then((listener) => {
        if (active) stop = () => void listener.remove()
        else void listener.remove()
      })
      .catch(() => undefined)

    return () => {
      active = false
      stop()
    }
  }, [navigate, storageSubject])

  return null
}

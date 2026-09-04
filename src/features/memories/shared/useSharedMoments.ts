import { useContext } from 'react'
import { SharedMomentsContext } from './context'

/** Returns the current device's hydrated panorama collection and mutations. */
export function useSharedMoments() {
  const context = useContext(SharedMomentsContext)

  if (!context) {
    throw new Error('useSharedMoments must be used within SharedMomentsProvider')
  }

  return context
}

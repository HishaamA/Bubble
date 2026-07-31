import { useContext } from 'react'
import { SharedMomentsContext } from './context'

export function useSharedMoments() {
  const context = useContext(SharedMomentsContext)

  if (!context) {
    throw new Error('useSharedMoments must be used within SharedMomentsProvider')
  }

  return context
}
